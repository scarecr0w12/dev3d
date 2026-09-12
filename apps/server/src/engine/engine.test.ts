/**
 * Engine tests.
 *
 * These drive the real engine - real pipelines, real router, real tool loop,
 * real skill selection - against the scripted mock provider and a scratch
 * workspace, so a whole run is exercised without a network call, an API key, or
 * a cent of spend. The only things faked are the two side effects a test cannot
 * own: the event sink and the human answering approvals.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  EmployeeState,
  OrgChart,
  Pipeline,
  Role,
  ServerEvent,
  Skill,
  UsageRecord,
  Workspace,
} from '@dev3d/core';
import { toEmployeeState } from '@dev3d/core';
import { loadConfig } from '../config.ts';
import { createProviderRegistry } from '../llm/registry.ts';
import { allSkillIds, defaultOrgChart, defaultWorkspace } from '../org/defaultCompany.ts';
import { defaultPipelines } from '../org/defaultPipelines.ts';
import { loadSkills } from '../skills/loader.ts';
import { createDefaultTools, createToolRegistry } from '../tools/registry.ts';
import { estimateComplexity } from './complexity.ts';
import { parseTags, pickPipelineId, createRunEngine, type RunEngine } from './runEngine.ts';
import { reviewApproved, reviewRaisedObjections } from './stages.ts';
import type { EmployeeTracker, EngineDeps, EventSink } from './types.ts';

const skillsDir = fileURLToPath(new URL('../../../../skills', import.meta.url));

interface Harness {
  engine: RunEngine;
  events: ServerEvent[];
  approvalRequests: Array<{ kind: string; summary: string }>;
  workspace: string;
  chart: OrgChart;
  /** Every organisation in the test's building; push to add a floor. */
  workspaces: Workspace[];
  cleanup(): void;
}

async function makeHarness(
  opts: { autoApprove?: boolean; softSpendApprovalUsd?: number; rejectReviews?: boolean } = {},
): Promise<Harness> {
  const workspace = mkdtempSync(join(tmpdir(), 'dev3d-engine-'));
  const base = loadConfig();
  const config = {
    ...base,
    workspace,
    dbPath: join(workspace, '.dev3d.sqlite'),
    llmMode: 'mock' as const,
    autoApproveShell: true,
    logLevel: 'error' as const,
    ...(opts.softSpendApprovalUsd !== undefined
      ? { softSpendApprovalUsd: opts.softSpendApprovalUsd }
      : {}),
  };

  const registry = createProviderRegistry(config);

  /**
   * A chair that objects and never relents.
   *
   * The scripted provider approves every review, so the "a review ended with an
   * objection nobody could resolve" path is unreachable through it. This wraps
   * the registry so the stage's verdict turn comes back as an explicit rejection,
   * which is what a review-loop looks like when it genuinely fails.
   */
  if (opts.rejectReviews === true) {
    const realChat = registry.chat.bind(registry);
    registry.chat = async (primary, fallbacks, req) => {
      const prompt = req.messages.map((m) => m.content).join('\n');
      if (prompt.includes('Synthesise review pass')) {
        return {
          result: {
            text:
              '## Review\n\nThis is not acceptable. There is a blocking objection: the change ' +
              'dereferences a null session and must be fixed. Changes required before approval.',
            reasoning: null,
            toolCalls: [],
            finishReason: 'stop',
            usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
          },
          used: primary,
          attempted: [],
        };
      }
      void fallbacks;
      return realChat(primary, fallbacks, req);
    };
  }
  const skills: Skill[] = await loadSkills(skillsDir);
  const tools = createToolRegistry();
  for (const tool of createDefaultTools()) tools.register(tool);

  // One organisation to start with. Tests that need a second floor push another
  // workspace onto `workspaces`, which is the same list the engine reads.
  const HOME = 'default';
  const org = defaultOrgChart();
  const workspaces: Workspace[] = [
    {
      id: HOME,
      name: 'Default project',
      path: workspace,
      floor: 1,
      isDefault: true,
      skillIds: allSkillIds(),
      budget: { defaultRunUsd: 5, spentUsd: 0 },
      org,
      createdAt: Date.now(),
    },
  ];
  const pipelines: Pipeline[] = defaultPipelines();

  const events: ServerEvent[] = [];
  const sink: EventSink = {
    emit(event) {
      events.push(event);
    },
  };

  const orgOf = (workspaceId: string | undefined): OrgChart =>
    workspaces.find((entry) => entry.id === (workspaceId ?? HOME))?.org ?? org;

  const states = new Map<string, EmployeeState>();
  const key = (workspaceId: string, employeeId: string): string => `${workspaceId}:${employeeId}`;

  const employees: EmployeeTracker = {
    get: (workspaceId, employeeId) => states.get(key(workspaceId, employeeId)),
    update(workspaceId, employeeId, patch) {
      const role = orgOf(workspaceId).roles.find((candidate) => candidate.id === employeeId);
      assert.ok(role, `test tracker asked for unknown role "${employeeId}" in "${workspaceId}"`);
      const current = states.get(key(workspaceId, employeeId)) ?? toEmployeeState(role as Role, workspaceId);
      const next: EmployeeState = {
        ...current,
        ...patch,
        id: current.id,
        roleId: current.roleId,
        workspaceId: current.workspaceId,
      };
      states.set(key(workspaceId, employeeId), next);
      sink.emit({ type: 'employee.updated', employee: { ...next }, at: Date.now() });
      return next;
    },
    addUsage(workspaceId, employeeId, usage: UsageRecord) {
      const role = orgOf(workspaceId).roles.find((candidate) => candidate.id === employeeId);
      assert.ok(role, `test tracker asked for unknown role "${employeeId}" in "${workspaceId}"`);
      const current = states.get(key(workspaceId, employeeId)) ?? toEmployeeState(role as Role, workspaceId);
      const next: EmployeeState = {
        ...current,
        lifetime: {
          turns: current.lifetime.turns + 1,
          tokensIn: current.lifetime.tokensIn + usage.tokensIn,
          tokensOut: current.lifetime.tokensOut + usage.tokensOut,
          costUsd: current.lifetime.costUsd + usage.costUsd,
        },
      };
      states.set(key(workspaceId, employeeId), next);
      sink.emit({ type: 'usage', employeeId, lifetime: { ...next.lifetime }, at: Date.now() });
      return next;
    },
  };

  const approvalRequests: Array<{ kind: string; summary: string }> = [];

  const deps: EngineDeps = {
    config,
    registry,
    tools,
    skills: () => skills,
    org: {
      chart: (workspaceId) => orgOf(workspaceId),
      role: (roleId, workspaceId) => orgOf(workspaceId).roles.find((candidate) => candidate.id === roleId),
      workspace: (workspaceId) => workspaces.find((entry) => entry.id === workspaceId),
      workspaces: () => workspaces,
    },
    pipelines: (workspaceId) => {
      const ids = orgOf(workspaceId).pipelineIds;
      const all = [...pipelines, ...extraPipelines];
      const enabled = all.filter((pipeline) => ids.includes(pipeline.id));
      return enabled.length > 0 ? enabled : all;
    },
    employees,
    sink,
    approvals: {
      request: async (input) => {
        approvalRequests.push({ kind: input.kind, summary: input.summary });
        return opts.autoApprove !== false;
      },
    },
  };

  return {
    engine: createRunEngine(deps),
    events,
    approvalRequests,
    workspace,
    chart: org,
    workspaces,
    cleanup: () => rmSync(workspace, { recursive: true, force: true }),
  };
}

function eventsOfType<T extends ServerEvent['type']>(
  events: ServerEvent[],
  type: T,
): Array<Extract<ServerEvent, { type: T }>> {
  return events.filter((e) => e.type === type) as Array<Extract<ServerEvent, { type: T }>>;
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('pickPipelineId sends questions to the cheap pipeline and builds to the full one', () => {
  const pipelines = defaultPipelines();
  assert.equal(pickPipelineId('What does this error mean?', pipelines), 'quick-answer');
  assert.equal(pickPipelineId('why is the router picking nano here', pipelines), 'quick-answer');
  assert.equal(pickPipelineId('Fix the null deref in the session lookup', pipelines), 'code-change');
  assert.equal(
    pickPipelineId(
      'Build a customer-facing onboarding flow with a wizard, email verification, and an admin review queue, wired to our API.',
      pipelines,
    ),
    'product-build',
  );
});

test('parseTags reads the intake tag line and tolerates backticks and bullets', () => {
  assert.deepEqual(parseTags('lots of prose\n\nTAGS: ui, api\n'), ['ui', 'api']);
  assert.deepEqual(parseTags('TAGS: `ui`, `data`'), ['ui', 'data']);
  assert.deepEqual(parseTags('- TAGS: frontend | backend'), ['frontend', 'backend']);
  assert.deepEqual(parseTags('no tags line here'), []);
});

test('complexity separates hard work from trivial work', () => {
  const chart = defaultOrgChart();
  const role = chart.roles.find((r) => r.id === 'backend-dev-1');
  assert.ok(role);
  const common = {
    stageKind: 'build' as const,
    taskClass: 'coding' as const,
    role: role as Role,
    turnIndex: 0,
    fileCount: 0,
    involvesFiles: true,
  };
  const trivial = estimateComplexity({ ...common, text: 'fix a typo in the label' });
  const hard = estimateComplexity({
    ...common,
    text: 'untangle a race condition in the concurrent scheduler and keep backward compatibility for the protocol schema',
  });
  assert.ok(hard > trivial, `expected ${hard} > ${trivial}`);
  assert.ok(trivial >= 0 && trivial <= 1);
  assert.ok(hard >= 0 && hard <= 1);
});

test('the review heuristics separate blocking language from advice', () => {
  assert.equal(reviewApproved('Approved. This is good enough to ship.'), true);

  // Advice is not a refusal. A review that names a risk and suggests a change is
  // how a passing review reads; treating that as an objection made every stage of
  // a system with caveats look unreviewed.
  const advisory =
    '## Review\n- **Sound** — scoped clearly.\n- **Risk** — edge cases must not crash.\n' +
    '- **Suggestion** — add a fallback.';
  assert.equal(reviewRaisedObjections(advisory), false);
  assert.equal(reviewRaisedObjections('⚠️ Risk — edge cases crash.'), false);

  // Explicit blocking language is an objection, however it is phrased.
  assert.equal(reviewRaisedObjections('This is not acceptable. Changes required.'), true);
  assert.equal(reviewRaisedObjections('❌ Blocking: the null deref is still there.'), true);
  assert.equal(reviewRaisedObjections('I must fix the session lookup first.'), true);

  // A denial of objections is an approval, not a detection of the word.
  assert.equal(reviewRaisedObjections('Looks good, no objections.'), false);
});

// ---------------------------------------------------------------------------
// whole runs
// ---------------------------------------------------------------------------

test('a question runs the quick-answer pipeline end to end', async () => {
  const h = await makeHarness();
  try {
    const run = h.engine.submit({ brief: 'What does the routing posture "cheap" actually do?' });
    assert.equal(run.pipelineId, 'quick-answer');
    // The engine starts working before `submit` returns, so the snapshot it
    // hands back is already in flight rather than queued.
    assert.ok(['queued', 'running'].includes(run.status), `unexpected status ${run.status}`);

    const settled = await h.engine.whenSettled(run.id);
    assert.ok(settled);
    assert.equal(settled.status, 'done', `run failed: ${settled.error ?? ''}`);
    assert.equal(settled.stages.length, 3);
    for (const stage of settled.stages) {
      assert.equal(stage.status, 'done', `stage ${stage.spec.name} was ${stage.status}`);
      assert.ok(stage.turnIds.length > 0, `stage ${stage.spec.name} ran no turns`);
    }

    // The intake stage defines the objective and the run's tags.
    assert.ok(settled.objective !== null && settled.objective.length > 0);
    assert.ok(settled.tags.length > 0, 'intake should have produced tags');
    // The report stage defines the outcome the user actually reads.
    assert.ok(settled.outcome !== null && settled.outcome.length > 0);
    assert.ok(settled.endedAt !== null);
    assert.ok(settled.budget.spentUsd > 0, 'the run should have cost something');
  } finally {
    h.cleanup();
  }
});

test('a build run writes real files into the workspace and reports them', async () => {
  const h = await makeHarness();
  try {
    const run = h.engine.submit({
      brief: 'Add a retry wrapper around the provider calls',
      pipelineId: 'code-change',
    });
    const settled = await h.engine.whenSettled(run.id);
    assert.ok(settled);
    assert.equal(settled.status, 'done', `run failed: ${settled.error ?? ''}`);

    // The build stage's employees have write_file, so the mock provider uses it.
    const finishedTurns = eventsOfType(h.events, 'turn.finished').map((e) => e.turn);
    const writers = finishedTurns.filter((t) => t.wroteFiles.length > 0);
    assert.ok(writers.length > 0, 'no turn wrote a file');

    for (const turn of writers) {
      for (const rel of turn.wroteFiles) {
        const abs = join(h.workspace, rel);
        assert.ok(existsSync(abs), `turn claimed to write ${rel} but it is not on disk`);
        assert.ok(readFileSync(abs, 'utf8').length > 0, `${rel} is empty`);
      }
    }

    // Tool calls are recorded with their outcome, not just their request.
    const toolCalls = finishedTurns.flatMap((t) => t.toolCalls);
    assert.ok(toolCalls.length > 0, 'the run made no tool calls');
    const writes = toolCalls.filter((c) => c.name === 'write_file');
    assert.ok(writes.length > 0, 'expected at least one write_file call');
    for (const call of writes) {
      assert.equal(call.status, 'ok', `write_file failed: ${call.resultPreview}`);
      assert.ok(call.affectsPaths.length > 0);
      assert.ok(call.durationMs >= 0);
    }

    // A build stage is emitted as artifacts, and its files are addressable.
    const artifacts = eventsOfType(h.events, 'artifact.created').map((e) => e.artifact);
    assert.ok(artifacts.some((a) => a.kind === 'code'), 'expected code artifacts for written files');
    assert.ok(artifacts.some((a) => a.path !== undefined && a.path !== null));
  } finally {
    h.cleanup();
  }
});

test('every turn is routed, priced, and attributed to an employee', async () => {
  const h = await makeHarness();
  try {
    const run = h.engine.submit({ brief: 'Explain the model router tiers', pipelineId: 'quick-answer' });
    const settled = await h.engine.whenSettled(run.id);
    assert.ok(settled);
    assert.equal(settled.status, 'done');

    const turns = eventsOfType(h.events, 'turn.finished').map((e) => e.turn);
    assert.ok(turns.length >= 3);
    for (const turn of turns) {
      assert.notEqual(turn.route.modelId, '', `turn for ${turn.roleId} had no model routed`);
      assert.ok(turn.route.reason.length > 0, 'a routing decision must explain itself');
      assert.ok(turn.usage.tokensIn > 0 && turn.usage.tokensOut > 0);
      assert.ok(turn.usage.costUsd >= 0);
      assert.equal(turn.status, 'done');
      assert.equal(turn.employeeId, turn.roleId);
      assert.ok(turn.text.length > 0, 'a finished turn should have text');
      assert.ok(turn.endedAt !== null && turn.endedAt >= turn.startedAt);
    }

    // Routing decisions are broadcast separately, for the routing UI.
    const decisions = eventsOfType(h.events, 'routing.decision');
    assert.equal(decisions.length, turns.length);

    // Every turn costs money, and the budget event must track it.
    const budgets = eventsOfType(h.events, 'budget.updated');
    assert.equal(budgets.length, turns.length);
    const last = budgets[budgets.length - 1];
    assert.ok(last);
    assert.equal(last.spentUsd, settled.budget.spentUsd);
  } finally {
    h.cleanup();
  }
});

test('skills are selected per turn and recorded with a reason', async () => {
  const h = await makeHarness();
  try {
    const run = h.engine.submit({ brief: 'Research how other tools do model routing', pipelineId: 'quick-answer' });
    const settled = await h.engine.whenSettled(run.id);
    assert.ok(settled);
    assert.equal(settled.status, 'done');

    const turns = eventsOfType(h.events, 'turn.finished').map((e) => e.turn);
    const withSkills = turns.filter((t) => t.skills.length > 0);
    assert.ok(withSkills.length > 0, 'no turn selected any skill');
    for (const turn of withSkills) {
      for (const selection of turn.skills) {
        assert.ok(selection.reason.length > 0, 'a skill selection must say why');
        assert.ok(
          ['role-default', 'keyword', 'model-choice', 'task-class'].includes(selection.via),
          `unexpected selection route "${selection.via}"`,
        );
        // Selection may only ever pick from the employee's own skill ids.
        const role = h.chart.roles.find((r) => r.id === turn.roleId);
        assert.ok(role);
        assert.ok(role.skillIds.includes(selection.skillId), `${selection.skillId} was not granted to ${turn.roleId}`);
      }
    }
  } finally {
    h.cleanup();
  }
});

test('a debate stage produces a verdict and attributed speeches', async () => {
  const h = await makeHarness();
  try {
    const run = h.engine.submit({
      brief: 'Design and build a notification preferences screen for the admin console, end to end.',
    });
    assert.equal(run.pipelineId, 'product-build');
    const settled = await h.engine.whenSettled(run.id);
    assert.ok(settled);
    assert.equal(settled.status, 'done', `run failed: ${settled.error ?? ''}`);

    const debateSpec = settled.stages.find((s) => s.spec.kind === 'debate');
    assert.ok(debateSpec, 'product-build should contain a debate stage');
    assert.equal(debateSpec.status, 'done');
    // Two rounds over four participants, plus the facilitator's ruling.
    assert.ok(debateSpec.turnIds.length >= 4, `debate ran only ${debateSpec.turnIds.length} turns`);
    assert.ok(debateSpec.summary !== null && debateSpec.summary.length > 0);

    const speeches = eventsOfType(h.events, 'speech');
    assert.ok(speeches.length >= 4, 'a debate must emit speeches');
    for (const speech of speeches) {
      assert.ok(speech.text.length > 0);
      assert.equal(speech.runId, run.id);
    }
  } finally {
    h.cleanup();
  }
});

test('a run that exceeds its budget stops and says so', async () => {
  const h = await makeHarness();
  try {
    const run = h.engine.submit({
      brief: 'Build a full settings area with roles and audit history',
      pipelineId: 'product-build',
      budgetUsd: 0.00000001,
    });
    const settled = await h.engine.whenSettled(run.id);
    assert.ok(settled);
    assert.equal(settled.status, 'failed');
    assert.match(settled.error ?? '', /budget/i);
    assert.ok(settled.budget.spentUsd >= settled.budget.limitUsd);

    // It must stop rather than run the remaining stages.
    const ranStages = settled.stages.filter((s) => s.status === 'done');
    assert.ok(ranStages.length < settled.stages.length, 'the run should not have finished the pipeline');

    const errors = eventsOfType(h.events, 'error');
    assert.ok(errors.some((e) => /budget/i.test(e.message)));
  } finally {
    h.cleanup();
  }
});

test('cancelling a run stops it and marks it cancelled', async () => {
  const h = await makeHarness();
  try {
    const run = h.engine.submit({ brief: 'Write a long design document', pipelineId: 'product-build' });
    // Cancel immediately: the engine has already started, so this races the
    // first turn - which is exactly the case that has to be safe.
    assert.equal(h.engine.cancel(run.id), true);
    const settled = await h.engine.whenSettled(run.id);
    assert.ok(settled);
    assert.equal(settled.status, 'cancelled');
    assert.equal(settled.stages.some((s) => s.status === 'running'), false);
    assert.equal(h.engine.cancel(run.id), false, 'cancelling twice should report nothing to cancel');
  } finally {
    h.cleanup();
  }
});

test('a run stops when the operator refuses to keep spending', async () => {
  // A soft-spend threshold of effectively zero means the gate trips as soon as
  // the first stage costs anything at all.
  const h = await makeHarness({ autoApprove: false, softSpendApprovalUsd: 0.0000001 });
  try {
    const run = h.engine.submit({ brief: 'Explain how the tool loop terminates', pipelineId: 'quick-answer' });
    const settled = await h.engine.whenSettled(run.id);
    assert.ok(settled);
    assert.equal(settled.status, 'cancelled');
    assert.match(settled.error ?? '', /declin/i);
    assert.ok(
      h.approvalRequests.some((r) => r.kind === 'spend'),
      'the engine should have asked before spending more',
    );
    // It must stop early rather than complete the pipeline anyway.
    assert.ok(settled.stages.some((s) => s.status !== 'done' || s.turnIds.length === 0));
  } finally {
    h.cleanup();
  }
});

test('a run continues once the operator approves the spend', async () => {
  const h = await makeHarness({ autoApprove: true, softSpendApprovalUsd: 0.0000001 });
  try {
    const run = h.engine.submit({ brief: 'Explain how the tool loop terminates', pipelineId: 'quick-answer' });
    const settled = await h.engine.whenSettled(run.id);
    assert.ok(settled);
    assert.equal(settled.status, 'done', `run failed: ${settled.error ?? ''}`);
    assert.ok(
      h.approvalRequests.some((r) => r.kind === 'spend'),
      'the gate should still have asked, even though it was approved',
    );
    // The gate must ask once per run, not once per stage.
    const spendAsks = h.approvalRequests.filter((r) => r.kind === 'spend');
    assert.equal(spendAsks.length, 1, `asked ${spendAsks.length} times`);
  } finally {
    h.cleanup();
  }
});

test('a run is confined to the workspace it was submitted to', async () => {
  const h = await makeHarness();
  const projectDir = mkdtempSync(join(tmpdir(), 'dev3d-project-'));
  try {
    // A second organisation on its own floor, with its own staff.
    const portal = defaultWorkspace({
      id: 'portal',
      name: 'Portal',
      path: projectDir,
      floor: 2,
      skillIds: allSkillIds(),
    });
    h.workspaces.push(portal);

    const run = h.engine.submit({
      brief: 'Add a health endpoint to the service',
      pipelineId: 'code-change',
      workspaceId: 'portal',
    });
    assert.equal(run.workspaceId, 'portal');
    assert.equal(run.workspacePath, projectDir);

    const settled = await h.engine.whenSettled(run.id);
    assert.ok(settled);
    assert.equal(settled.status, 'done', `run failed: ${settled.error ?? ''}`);
    assert.equal(settled.workspacePath, projectDir, 'the path is frozen onto the run');

    const turns = eventsOfType(h.events, 'turn.finished').map((e) => e.turn);
    const written = turns.flatMap((t) => t.wroteFiles);
    assert.ok(written.length > 0, 'the run should have written something');
    for (const rel of written) {
      assert.ok(existsSync(join(projectDir, rel)), `${rel} should be inside the project`);
    }
    // Nothing may leak into the office's default workspace.
    assert.equal(
      existsSync(join(h.workspace, 'src')),
      false,
      'the default workspace should be untouched by a run in another project',
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    h.cleanup();
  }
});

test('submitting into a workspace that does not exist is refused', async () => {
  const h = await makeHarness();
  try {
    assert.throws(
      () => h.engine.submit({ brief: 'do a thing', pipelineId: 'quick-answer', workspaceId: 'nope' }),
      /no workspace/i,
    );
  } finally {
    h.cleanup();
  }
});

test('a direct message gets an answer from that employee alone', async () => {  const h = await makeHarness();
  try {
    const messages = await h.engine.directMessage('cto', 'What would you cut from this plan?');
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, 'user');
    assert.equal(messages[1]?.role, 'employee');
    assert.equal(messages[1]?.employeeId, 'cto');
    assert.ok((messages[1]?.text ?? '').length > 0);
    assert.ok(messages[1]?.route !== undefined && messages[1]?.route.modelId !== '');

    await assert.rejects(() => h.engine.directMessage('nobody', 'hello'), /no employee/i);
  } finally {
    h.cleanup();
  }
});

test('run knowledge accumulates across stages', async () => {
  const h = await makeHarness();
  try {
    const run = h.engine.submit({
      brief: 'Refactor the pricing helper and prove it with a test',
      pipelineId: 'code-change',
    });
    const settled = await h.engine.whenSettled(run.id);
    assert.ok(settled);

    // Later stages must be able to see what earlier stages produced; the engine
    // proves it by threading a summary forward and naming files in artifacts.
    const stageStarts = eventsOfType(h.events, 'stage.started').map((e) => e.stage);
    assert.ok(stageStarts.length >= 5);

    const artifacts = eventsOfType(h.events, 'artifact.created').map((e) => e.artifact);
    // One stage artifact per completed stage, at minimum.
    assert.ok(artifacts.length >= stageStarts.length - 1, 'each stage should leave an artifact');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// maxTurnsPerStage
//
// The field was declared, populated for all thirteen shipped roles and read by
// nothing. These are the tests that keep it wired: an operator can see the limit
// in the org chart, so it has to do something.
// ---------------------------------------------------------------------------

/** A one-stage pipeline, so a cap is the only thing that can stop a role. */
function singleStagePipeline(
  id: string,
  spec: {
    roleIds: string[];
    mode: Pipeline['stages'][number]['mode'];
    kind?: Pipeline['stages'][number]['kind'];
    rounds?: number;
    maxIterations?: number;
  },
): Pipeline {
  const { roleIds, mode, kind, rounds, maxIterations } = spec;
  return {
    id,
    name: id,
    description: 'test pipeline',
    stages: [
      {
        name: 'Deliberate',
        kind: kind ?? 'debate',
        roleIds,
        mode,
        ...(rounds !== undefined ? { rounds } : {}),
        ...(maxIterations !== undefined ? { maxIterations } : {}),
      },
    ],
  };
}

function withPipeline(h: Harness, pipeline: Pipeline): void {
  h.workspaces[0]!.org.pipelineIds.push(pipeline.id);
  // The harness reads `defaultPipelines()` once, so the pipeline is appended to
  // the enabled set through the org chart's own id list plus the shared array.
  extraPipelines.push(pipeline);
}

/** Pipelines added by `withPipeline`, read by the harness's pipeline supplier. */
const extraPipelines: Pipeline[] = [];

test('a role may not exceed maxTurnsPerStage, and the refusal is logged', async () => {
  const h = await makeHarness();
  try {
    // The CEO ships with a cap of 2; lowering it to 1 makes the second turn of a
    // two-round debate one the cap has to refuse.
    const ceo = h.chart.roles.find((role) => role.id === 'ceo');
    assert.ok(ceo);
    ceo.maxTurnsPerStage = 1;
    withPipeline(h, singleStagePipeline('cap-debate', { roleIds: ['ceo'], mode: 'debate', rounds: 2 }));

    const run = h.engine.submit({ brief: 'Decide the approach', pipelineId: 'cap-debate' });
    const settled = await h.engine.whenSettled(run.id);
    assert.ok(settled);

    const turns = eventsOfType(h.events, 'turn.finished').map((e) => e.turn);
    const byCeo = turns.filter((t) => t.roleId === 'ceo');
    assert.equal(byCeo.length, 1, `the CEO spoke ${byCeo.length} times despite a cap of 1`);

    const warnings = eventsOfType(h.events, 'log').filter(
      (e) => e.level === 'warn' && e.message.includes('reached its limit'),
    );
    assert.ok(warnings.length > 0, 'a refusal must be visible, not silent');
    assert.match(warnings[0]!.message, /maxTurnsPerStage/);
  } finally {
    h.cleanup();
  }
});

test('a stage that asks for more turns than the cap allows still completes', async () => {
  const h = await makeHarness();
  try {
    withPipeline(h, singleStagePipeline('cap-debate-long', { roleIds: ['ceo'], mode: 'debate', rounds: 5 }));

    const run = h.engine.submit({ brief: 'Decide the approach', pipelineId: 'cap-debate-long' });
    const settled = await h.engine.whenSettled(run.id);
    assert.ok(settled);

    // Truncating the deliberation is the cap working, not the stage breaking:
    // a stage must never be left mid-flight because somebody ran out of turns.
    assert.notEqual(settled.status, 'running');
    assert.ok(settled.endedAt !== null);
    const stage = settled.stages[0]!;
    assert.notEqual(stage.status, 'running', 'the stage must reach a terminal state');
  } finally {
    h.cleanup();
  }
});

test('the shipped caps allow the shipped pipelines to finish', async () => {
  // A guard on the default values: if someone lowers a cap below what a shipped
  // pipeline needs, the office silently truncates its own deliberation. This
  // runs the real pipelines and asserts every role stayed within its cap without
  // ever being refused.
  const h = await makeHarness();
  try {
    const run = h.engine.submit({ brief: 'Add a dark mode toggle to the settings page' });
    const settled = await h.engine.whenSettled(run.id);
    assert.ok(settled);

    const refusals = eventsOfType(h.events, 'log').filter((e) => e.message.includes('reached its limit'));
    assert.deepEqual(
      refusals.map((e) => e.message),
      [],
      'no shipped role should hit its cap while running a shipped pipeline',
    );
  } finally {
    h.cleanup();
  }
});

test('a review that ends on an objection fails the stage instead of passing it on', async () => {
  // The chair reviews the work, objects in explicit blocking language, and has no
  // producer outside the stage to send it back to, so the loop ends with the
  // objection open. Previously that objection text became the summary, and the
  // next stage read a rejection as the decision.
  const h = await makeHarness({ rejectReviews: true });
  try {
    withPipeline(
      h,
      singleStagePipeline('cap-review', {
        roleIds: ['qa-lead', 'cto'],
        mode: 'review-loop',
        kind: 'review',
        maxIterations: 1,
      }),
    );

    const run = h.engine.submit({ brief: 'Review the parser change', pipelineId: 'cap-review' });
    const settled = await h.engine.whenSettled(run.id);
    assert.ok(settled);

    const stage = settled.stages[0]!;
    assert.equal(stage.error, 'The review ended with objections unresolved; the work was not approved.');
    assert.equal(stage.status, 'failed', 'an unresolved review must not report as done');
    assert.equal(settled.status, 'failed', 'a non-optional stage failing must fail the run');
    assert.match(stage.summary ?? '', /UNRESOLVED REVIEW/);
    // The objection is still recorded — it is the reason the stage failed.
    assert.match(stage.summary ?? '', /blocking objection/);

    const warnings = eventsOfType(h.events, 'log').filter((e) => e.message.includes('unresolved objections'));
    assert.ok(warnings.length > 0, 'the failure should name itself in the log');
  } finally {
    h.cleanup();
  }
});

test('an approving review passes and is not mistaken for an objection', async () => {
  // The scripted review offers a risk and a suggestion, which is advice rather
  // than a refusal. It must not be read as one.
  const h = await makeHarness();
  try {
    withPipeline(
      h,
      singleStagePipeline('ok-review', {
        roleIds: ['qa-lead', 'cto'],
        mode: 'review-loop',
        kind: 'review',
        maxIterations: 1,
      }),
    );

    const run = h.engine.submit({ brief: 'Review the parser change', pipelineId: 'ok-review' });
    const settled = await h.engine.whenSettled(run.id);
    assert.ok(settled);

    const stage = settled.stages[0]!;
    assert.equal(stage.error, null);
    assert.equal(stage.status, 'done');
    assert.doesNotMatch(stage.summary ?? '', /UNRESOLVED REVIEW/);
  } finally {
    h.cleanup();
  }
});
