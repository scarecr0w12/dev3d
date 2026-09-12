/**
 * Runtime smoke test for the office store's reducer.
 *
 * Not part of the app bundle: it drives the real `src/app/store.ts` with one
 * synthetic frame per `ServerEvent` variant and asserts the state transitions
 * the console depends on. It is the check the typecheck cannot provide - that
 * the reducer actually produces the right state, keeps streamed text, and never
 * throws on an unknown frame.
 *
 * Node 24 runs TypeScript directly, so there is no build step:
 *
 *   node apps/web/.verify/smoke.ts
 *
 * (`apps/web/.verify/tsconfig.json` exists only to typecheck this file with
 * `tsc -p apps/web/.verify/tsconfig.json --noEmit`.)
 */

import type {
  Approval,
  Artifact,
  ClientCommand,
  Department,
  DirectMessage,
  EmployeeState,
  MemoryFact,
  ModelSpec,
  OfficeState,
  PluginRecord,
  Role,
  Run,
  ServerEvent,
  StageRun,
  TurnRecord,
} from '@dev3d/core';
import { toEmployeeState } from '@dev3d/core';

import { OfficeStore } from '../src/app/store.ts';
import { paneCeiling } from '../src/app/paneGeometry.ts';
import { FLOOR_STEP, floorOffset, floorVisibility, resolveFloorId } from '../src/office/floors.ts';
import { Liveliness, MAX_BUBBLE_CHARS, SMALL_TALK_OPENERS, SMALL_TALK_REPLIES } from '../src/office/liveliness.ts';
import type { LivelinessMember, LivelinessSpot } from '../src/office/liveliness.ts';
import { buildNavGrid } from '../src/office/navgrid.ts';
import type { ObstacleBox } from '../src/office/navgrid.ts';
import { createAvatar } from '../src/office/avatar.ts';
import { STYLE_ROLES, applyStyle, disposeMaterials, dressMaterials, roleForMaterial } from '../src/office/theme.ts';
import { DEFAULT_STYLE_PRESET, STYLE_PRESETS, STYLE_PRESET_ORDER } from '@dev3d/core';
import * as THREE from 'three';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
}

// --------------------------------------------------------------- fixtures

const department: Department = { id: 'frontend', name: 'Frontend', mission: 'build it', roomIds: ['Anchor_Room_DevFloor'], color: '#38bdf8' };

function role(id: string, displayName: string, seatId: string | null): Role {
  return {
    id,
    displayName,
    title: `${displayName} the engineer`,
    departmentId: 'frontend',
    seniority: 'mid',
    rank: 2,
    reportsTo: null,
    mission: 'ship',
    responsibilities: ['ship it'],
    skillIds: ['frontend-implementation'],
    allowedTools: ['read_file'],
    modelPolicy: { defaultTier: 'standard', minTier: 'small', maxTier: 'max' },
    seatId,
    roomId: 'Anchor_Room_DevFloor',
    canDelegate: false,
    maxDirectReports: 0,
    persona: { voice: 'terse', values: ['clarity'] },
    appearance: { bodyColor: '#38bdf8', accentColor: '#075985', height: 1 },
    maxTurnsPerStage: 2,
  };
}

const roleA = role('frontend-dev-1', 'Lena', 'Seat_Dev_02');
const roleB = role('frontend-dev-2', 'Omar', null);
const roleC = role('frontend-lead', 'Kai', 'Seat_Dev_01');

const model: ModelSpec = {
  id: 'mock-standard',
  providerId: 'mock',
  label: 'Mock Standard',
  tier: 'standard',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  costPerMTokIn: 1,
  costPerMTokOut: 2,
  capabilities: { tools: true, vision: false, reasoning: true, streaming: true },
  strengths: ['coding'],
};

const pluginRecord: PluginRecord = {
  manifest: {
    id: 'dev3d.cost-guard',
    name: 'Cost guard',
    version: '1.0.0',
    description: 'route mechanical work to cheap models',
    apiVersion: '1',
    author: 'dev3d',
    license: 'MIT',
    permissions: ['models', 'routing', 'skills', 'settings'],
    contributes: { toolNames: ['echo'] },
    settings: [{ key: 'aggressiveness', label: 'How hard', type: 'select', default: 'balanced', options: ['balanced'] }],
  },
  directory: '/plugins/dev3d.cost-guard',
  source: 'bundled',
  enabled: true,
  status: 'loaded',
  error: null,
  hasCode: false,
  contributions: { providers: 0, models: 1, skills: 1, roleTemplates: 0, pipelines: 0, routingRules: 2, tools: 0, uiPanels: 0 },
  settings: { aggressiveness: 'balanced' },
  installedAt: 1,
};

function stage(runId: string, id: string, status: StageRun['status']): StageRun {
  return {
    id,
    runId,
    spec: { kind: 'build', name: 'Build', roleIds: ['frontend-dev-1'], mode: 'parallel' },
    status,
    startedAt: 1,
    endedAt: null,
    turnIds: [],
    artifactIds: [],
    summary: null,
    participantRoleIds: ['frontend-dev-1'],
    error: null,
  };
}

function run(id: string, status: Run['status']): Run {
  return {
    id,
    brief: 'Add a dark mode toggle',
    pipelineId: 'product-build',
    status,
    createdAt: 1000,
    updatedAt: 1000,
    endedAt: null,
    stages: [stage(id, `${id}-s1`, 'pending')],
    budget: { limitUsd: 5, spentUsd: 0 },
    plan: [],
    workspaceId: 'default',
    workspacePath: '/workspace',
    objective: null,
    tags: ['ui'],
    outcome: null,
    error: null,
    submittedBy: null,
  };
}

function turn(id: string, runId: string, stageId: string, employeeId: string): TurnRecord {
  return {
    id,
    runId,
    stageId,
    employeeId,
    roleId: employeeId,
    purpose: 'implement the toggle',
    route: {
      providerId: 'mock',
      modelId: 'mock-standard',
      tier: 'standard',
      taskClass: 'coding',
      reason: 'coding work at standard tier',
      fallbacks: [],
      considered: [],
    },
    status: 'running',
    startedAt: 2000,
    endedAt: null,
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    text: '',
    reasoning: null,
    toolCalls: [],
    skills: [],
    wroteFiles: [],
    error: null,
  };
}

function officeState(roles: Role[], runs: Run[], employees?: EmployeeState[]): OfficeState {
  return {
    settings: {
      workspacesRoot: '/workspaces',
      allowExternalWorkspaces: true,
      defaultRoutingPosture: 'balanced',
      maxConcurrency: 4,
      softSpendApprovalUsd: 1.5,
      autoApproveShell: false,
      approvalTimeoutMs: 600000,
      logLevel: 'info',
      disabledModelIds: [],
      modelOverrides: {},
      updatedAt: 1,
    },
    activeWorkspaceId: 'default',
    company: {
      id: 'dev3d-labs',
      name: 'dev3d Labs',
      mission: 'ship',
      createdAt: 1,
    },
    departments: [department],
    roles,
    workspaces: [
      {
        id: 'default',
        name: 'Default project',
        path: '/workspace',
        isDefault: true,
        floor: 1,
        roleCount: roles.length,
        skillCount: 15,
        activeRuns: 0,
        spentUsd: 0,
        layout: { blocks: [] },
        capacity: 21,
        createdAt: 1,
      },
    ],
    skillIds: ['api-design'],
    budget: { defaultRunUsd: 5, spentUsd: 0 },
    style: { preset: 'nordic' },
    floor: {
      layout: { blocks: [] },
      coreSeats: 21,
      capacity: 21,
      seatIds: ['Seat_Dev_01', 'Seat_CEO'],
      modules: [
        { id: 'pod4', name: 'Open pod', kind: 'open', width: 8, depth: 6, doors: ['w', 'e'], seats: ['Seat_POD4_01'], node: 'Kit_pod4' },
        { id: 'portal', name: 'Doorway', kind: 'portal', width: 1.9, depth: 0.5, doors: [], seats: [], fitting: true },
      ],
      describe: 'core only',
      problem: null,
      style: { preset: 'nordic' },
    },
    plugins: {
      apiVersion: '1',
      pluginsRoot: '/plugins',
      allowInstall: true,
      records: [pluginRecord],
      sources: [
        {
          id: 'official',
          label: 'dev3d marketplace',
          url: 'https://example.test/catalog.json',
          enabled: true,
          lastFetchedAt: 999,
          lastError: null,
          pluginCount: 3,
        },
      ],
    },
    employees: employees ?? roles.map((role) => toEmployeeState(role, 'default')),
    mcp: {
      enabled: false,
      configPath: null,
      grantRoles: [],
      servers: [],
    },
    memory: {
      facts: [],
      counts: { installation: 0, workspace: 0, role: 0 },
      searchable: true,
      semantic: false,
      vectorCount: 0,
      vectorCoverage: 0,
    },
    vendorBay: { enabled: false, configPath: null, grantRoles: [], requireCanDelegate: true, vendors: [] },
    pipelines: [
      {
        id: 'product-build',
        name: 'Product build',
        description: 'full pipeline',
        stages: [{ kind: 'build', name: 'Build', roleIds: ['frontend-dev-1'], mode: 'parallel' }],
      },
    ],
    runs,
    activeRunIds: runs.filter((entry) => entry.status === 'running').map((entry) => entry.id),
    models: [model],
    providers: [
      {
        id: 'mock',
        label: 'Mock',
        configured: true,
        ok: true,
        detail: null,
        modelCount: 1,
        pluginId: null,
        modelSource: 'seed',
        modelSourceDetail: null,
        discoveredAt: null,
      },
    ],
    modelSignals: {
      benchmarks: {
        enabled: false,
        entries: 0,
        models: 0,
        measured: 0,
        fetchedAt: null,
        attribution: 'Artificial Analysis',
        detail: 'not enabled in this fixture',
      },
      health: { enabled: false, known: 0, fetchedAt: null },
      learned: { models: 0, samples: 0 },
    },
    llmMode: 'mock',
    llmModeReason: 'the harness has no provider keys',
    configStale: null,
    routingPosture: 'balanced',
    version: '0.1.0',
    startedAt: 500,
  };
}

// ------------------------------------------------------------------- driving

const store = new OfficeStore();
const commands: ClientCommand[] = [];
store.attachTransport((command) => commands.push(command));

const run1 = run('run-1', 'running');
const turn1 = turn('turn-1', 'run-1', 'run-1-s1', 'frontend-dev-1');
const escalatedRoute = { ...turn1.route, reason: 'escalated for complexity' };

/** Frames fed so far, so the event counter can be asserted without magic numbers. */
let fed = 0;

function apply(event: ServerEvent): void {
  fed += 1;
  try {
    store.apply(event);
  } catch (error) {
    check(`applying ${event.type} does not throw`, false, error instanceof Error ? error.message : String(error));
  }
}

function feed(...events: ServerEvent[]): void {
  for (const event of events) apply(event);
}

// TEMP: trace echo reconciliation while diagnosing.
(globalThis as { DEV3D_TRACE?: boolean }).DEV3D_TRACE = true;

console.log('office store reducer');

// ---------------------------------------------------------------- phase 1
feed(
  { type: 'hello', state: officeState([roleA, roleB, roleC], [run1]), at: 1000 },
  { type: 'log', level: 'info', scope: 'engine', message: 'engine ready', at: 1001 },
  { type: 'stage.started', runId: 'run-1', stage: { ...stage('run-1', 'run-1-s1', 'running'), startedAt: 1500 }, at: 1500 },
  { type: 'turn.started', turn: turn1, at: 2000 },
);

check('hello adopted the office state', store.state?.roles.length === 3);
check('connection reports open + hello', store.connected && store.hasHello());
check('hello auto-selected the active run', store.selectedRunId === 'run-1', store.selectedRunId);
check('turn.started registered the turn', store.getTurns()['run-1']?.['turn-1'] !== undefined);
check('turn.started linked the turn into its stage', store.state?.runs[0]?.stages[0]?.turnIds.includes('turn-1') === true);

feed({ type: 'routing.decision', runId: 'run-1', turnId: 'turn-1', route: escalatedRoute, at: 2001 });
check('routing.decision updated the live turn', store.getTurns()['run-1']?.['turn-1']?.route.reason === 'escalated for complexity');
check('routing.decision updated the employee lastRoute', store.state?.employees.find((entry) => entry.id === 'frontend-dev-1')?.lastRoute?.reason === 'escalated for complexity');

feed(
  { type: 'turn.delta', runId: 'run-1', turnId: 'turn-1', text: 'Writing ', at: 2002 },
  { type: 'turn.delta', runId: 'run-1', turnId: 'turn-1', text: 'the toggle…', at: 2003 },
  { type: 'turn.reasoning', runId: 'run-1', turnId: 'turn-1', text: 'The user wants persistence. ', at: 2004 },
  { type: 'turn.reasoning', runId: 'run-1', turnId: 'turn-1', text: 'Use localStorage.', at: 2005 },
);
check('turn.delta accumulated in order', store.streaming['turn-1'] === 'Writing the toggle…', store.streaming['turn-1']);
check('turn.reasoning accumulated in order', store.getReasoning()['turn-1'] === 'The user wants persistence. Use localStorage.');

feed({
  type: 'tool.result',
  runId: 'run-1',
  turnId: 'turn-1',
  call: {
    id: 'call-1',
    turnId: 'turn-1',
    name: 'write_file',
    argumentsJson: '{"path":"src/theme.ts"}',
    status: 'ok',
    resultPreview: 'wrote 41 lines',
    durationMs: 12,
    affectsPaths: ['src/theme.ts'],
  },
  at: 2006,
});
check('tool.result attached the call to the live turn', store.getTurns()['run-1']?.['turn-1']?.toolCalls[0]?.name === 'write_file');

feed({
  type: 'speech',
  runId: 'run-1',
  stageId: 'run-1-s1',
  fromEmployeeId: 'frontend-dev-1',
  toEmployeeIds: ['frontend-lead'],
  text: 'The toggle is in, but dark mode inherits the system preference.',
  kind: 'report',
  at: 2007,
});

feed({
  type: 'artifact.created',
  artifact: {
    id: 'art-1',
    runId: 'run-1',
    stageId: 'run-1-s1',
    employeeId: 'frontend-dev-1',
    kind: 'code',
    title: 'Theme module',
    body: '# theme.ts\n\n```ts\nexport const theme = "dark";\n```\n',
    path: 'src/theme.ts',
    createdAt: 2008,
  },
  at: 2008,
});
check('artifact.created indexed the artifact per run', (store.getArtifacts()['run-1'] ?? []).length === 1);
check('artifact.created linked the artifact into its stage', store.state?.runs[0]?.stages[0]?.artifactIds.includes('art-1') === true);

const approval: Approval = {
  id: 'appr-1',
  runId: 'run-1',
  turnId: 'turn-1',
  employeeId: 'frontend-dev-1',
  kind: 'shell',
  summary: 'run pnpm test',
  detail: 'pnpm --filter web test',
  status: 'pending',
  requestedAt: 2009,
  decidedAt: null,
};
feed(
  { type: 'approval.requested', approval, at: 2009 },
  { type: 'budget.updated', runId: 'run-1', limitUsd: 5, spentUsd: 4.8, at: 2010 },
  { type: 'employee.moved', employeeId: 'frontend-dev-2', fromSeatId: null, toSeatId: 'Seat_Meeting_03', toRoomId: 'Anchor_Room_Meeting', at: 2012 },
  { type: 'employee.updated', employee: { ...toEmployeeState(roleA, 'default'), status: 'blocked', activity: 'waiting for approval' }, at: 2013 },
  // Usage lands after the employee snapshot, as the engine reports it late.
  { type: 'usage', employeeId: 'frontend-dev-1', lifetime: { turns: 1, tokensIn: 900, tokensOut: 300, costUsd: 0.012 }, at: 2013 },
);

check('approval.requested queued a pending approval', store.approvals.length === 1 && store.approvals[0]?.status === 'pending');
check('budget.updated applied to the run', store.state?.runs.find((entry) => entry.id === 'run-1')?.budget.spentUsd === 4.8);
check('usage applied to the employee', store.state?.employees.find((entry) => entry.id === 'frontend-dev-1')?.lifetime.tokensIn === 900);
check('employee.moved re-seated the employee', store.state?.employees.find((entry) => entry.id === 'frontend-dev-2')?.seatId === 'Seat_Meeting_03');
check('employee.updated applied status', store.state?.employees.find((entry) => entry.id === 'frontend-dev-1')?.status === 'blocked');

feed({
  type: 'direct.message',
  employeeId: 'frontend-dev-2',
  messages: [
    { id: 'dm-2', employeeId: 'frontend-dev-2', role: 'user', text: 'ship it?', at: 2013 },
    { id: 'dm-3', employeeId: 'frontend-dev-2', role: 'employee', text: 'Yes, ship it.', at: 2014, route: turn1.route },
  ],
  at: 2014,
});
check('direct.message created the thread', (store.directMessages?.['frontend-dev-2'] ?? []).length === 2);
check('direct.message fed the activity feed', store.feed.some((item) => item.kind === 'direct'));

// A planning turn is queued rather than applied: only the surface holding the
// conversation knows which session the answer belongs to.
feed({ type: 'plan.reply', employeeId: 'ceo', requestId: 'req-1', text: 'What does done mean here?', route: turn1.route, at: 2015 });
check('plan.reply queued one reply', store.planReplies.length === 1);
check('plan.reply kept its requestId', store.planReplies[0]?.requestId === 'req-1');
check('plan.reply did not touch the direct threads', (store.directMessages?.['ceo'] ?? []).length === 0);
const taken = store.takePlanReply('req-1');
check('takePlanReply returned the reply', taken?.text === 'What does done mean here?');
check('takePlanReply emptied the queue', store.planReplies.length === 0);
check('takePlanReply consumed it exactly once', store.takePlanReply('req-1') === null);

/**
 * The optimistic echo and the server's copy of the same message carry different
 * ids by construction - `local-<at>` versus whatever the server minted - so
 * merging by id alone leaves the operator's own message in the thread twice,
 * which reads as the console having sent it twice.
 */
const echoAt = 5000;
store.appendDirectMessage({ id: 'local-5000', employeeId: 'ceo', role: 'user', text: 'ship it?', at: echoAt });
check('the optimistic echo shows immediately', (store.directMessages['ceo'] ?? []).length === 1);

const serverCopy: DirectMessage[] = [
  { id: 'dm-server-1', employeeId: 'ceo', role: 'user', text: 'ship it?', at: echoAt + 40 },
  { id: 'dm-server-2', employeeId: 'ceo', role: 'employee', text: 'Yes — once QA signs off.', at: echoAt + 60 },
];
feed({ type: 'direct.message', employeeId: 'ceo', messages: serverCopy, at: echoAt + 60 });

const ceoThread = store.directMessages['ceo'] ?? [];
check('the confirmed turn is not duplicated', ceoThread.length === 2, ceoThread.map((m) => m.id).join(','));
check('the echo id is the one kept, so React keys stay stable', ceoThread[0]?.id === 'local-5000');
check('the reply landed with it', ceoThread[1]?.text === 'Yes — once QA signs off.');

// Re-delivering the identical batch must still land on exactly two messages.
feed({ type: 'direct.message', employeeId: 'ceo', messages: serverCopy, at: echoAt + 61 });
check('a re-delivered batch does not double up', (store.directMessages['ceo'] ?? []).length === 2);
check('the echo is still the one kept after a re-delivery', (store.directMessages['ceo'] ?? [])[0]?.id === 'local-5000');

// A deliberate repeat is matched against its own echo, not the earlier one.
store.appendDirectMessage({ id: 'local-9000', employeeId: 'ceo', role: 'user', text: 'ship it?', at: 9000 });
feed({ type: 'direct.message', employeeId: 'ceo', messages: [{ id: 'dm-server-3', employeeId: 'ceo', role: 'user', text: 'ship it?', at: 9000 }], at: 9000 });
const repeated = store.directMessages['ceo'] ?? [];
check('a later repeat reconciles against its own echo', repeated.length === 3, repeated.map((m) => m.id).join(','));
check('the later echo is the one kept', repeated[2]?.id === 'local-9000');

// A terse closing record: no text, no tool calls. The streamed evidence must survive.
feed({ type: 'turn.finished', turn: { ...turn1, status: 'done', endedAt: 2100, usage: { tokensIn: 900, tokensOut: 300, costUsd: 0.012 } }, at: 2100 });
const finished = store.getTurns()['run-1']?.['turn-1'];
check('turn.finished cleared the streaming entry', store.streaming['turn-1'] === undefined);
check('turn.finished cleared the reasoning entry', store.getReasoning()['turn-1'] === undefined);
check('streamed text preserved into the finished turn', finished?.text === 'Writing the toggle…', finished?.text);
check('streamed reasoning preserved', finished?.reasoning === 'The user wants persistence. Use localStorage.', finished?.reasoning);
check('streamed tool calls preserved', finished?.toolCalls[0]?.name === 'write_file', finished?.toolCalls);
check('turn.finished kept the usage numbers', finished?.usage.costUsd === 0.012);

feed(
  {
    type: 'stage.finished',
    runId: 'run-1',
    stage: { ...stage('run-1', 'run-1-s1', 'done'), startedAt: 1500, endedAt: 2200, turnIds: ['turn-1'], artifactIds: ['art-1'], summary: 'Toggle shipped.' },
    at: 2200,
  },
  {
    type: 'run.updated',
    run: {
      ...run1,
      status: 'done',
      endedAt: 2300,
      updatedAt: 2300,
      outcome: 'Done: toggle added.',
      stages: [{ ...stage('run-1', 'run-1-s1', 'done'), startedAt: 1500, endedAt: 2200, turnIds: ['turn-1'], artifactIds: ['art-1'], summary: 'Toggle shipped.' }],
    },
    at: 2300,
  },
  { type: 'approval.decided', approval: { ...approval, status: 'approved', decidedAt: 2400 }, at: 2400 },
);

check('stage.finished recorded the summary', store.state?.runs[0]?.stages[0]?.summary === 'Toggle shipped.');
check('run.updated moved the run out of activeRunIds', store.state?.activeRunIds.length === 0, store.state?.activeRunIds);
check('approval.decided updated the queue', store.approvals[0]?.status === 'approved');
check('feed captured log + stage + speech + tool + artifact + approval + run', ['log', 'stage', 'speech.report', 'tool', 'artifact', 'approval', 'run'].every((kind) => store.feed.some((item) => item.kind === kind)));
check('feed is newest first', (store.feed[0]?.at ?? 0) >= (store.feed[store.feed.length - 1]?.at ?? 0));

// ---------------------------------------------------------------- phase 2
feed({ type: 'org.updated', workspaceId: 'default', org: { company: officeState([roleA], []).company, departments: [department], roles: [roleA, roleC], pipelineIds: ['product-build'], routingPosture: 'quality', updatedAt: 2500 }, at: 2500 });
const benched = store.state?.employees.find((entry) => entry.roleId === 'frontend-dev-2');
check('org.updated synthesised a bench entry for the fired role', benched?.status === 'offline' && benched?.seatId === null, benched?.status);
check('org.updated applied the routing posture', store.state?.routingPosture === 'quality', store.state?.routingPosture);
check('org.updated kept the live employee state', store.state?.employees.find((entry) => entry.id === 'frontend-dev-1')?.status === 'blocked');
check('org.updated kept the runs', store.state?.runs.length === 1);

// A chart change on another floor must not disturb the one being viewed.
const beforeForeign = store.state?.roles.length ?? 0;
feed({ type: 'org.updated', workspaceId: 'some-other-floor', org: { company: officeState([roleA], []).company, departments: [department], roles: [roleA], pipelineIds: ['product-build'], updatedAt: 2600 }, at: 2600 });
check('an org.updated for another floor is ignored', store.state?.roles.length === beforeForeign, `${store.state?.roles.length} vs ${beforeForeign}`);

// Settings are installation-wide, so they apply wherever you are standing.
feed({ type: 'settings.updated', settings: { ...officeState([roleA], []).settings, maxConcurrency: 9 }, at: 2700 });
check('settings.updated replaced the installation settings', store.state?.settings.maxConcurrency === 9, store.state?.settings.maxConcurrency);
check('org.updated kept the live employee state', store.state?.employees.find((entry) => entry.id === 'frontend-dev-1')?.status === 'blocked');
check('org.updated kept the runs', store.state?.runs.length === 1);

// Plugin state arrives whole, and must not disturb anything else about the floor.
const disabledPluginRecord: PluginRecord = {
  ...pluginRecord,
  enabled: false,
  status: 'disabled',
  contributions: { providers: 0, models: 0, skills: 0, roleTemplates: 0, pipelines: 0, routingRules: 0, tools: 0, uiPanels: 0 },
};
feed({
  type: 'plugins.updated',
  state: { ...officeState([roleA], []).plugins, records: [disabledPluginRecord], allowInstall: false },
  at: 2750,
});
check('plugins.updated replaced the plugin state', store.state?.plugins.records.length === 1);
check('plugins.updated carries the enable/disable decision', store.state?.plugins.records[0]?.status === 'disabled');
check('plugins.updated carries the install gate', store.state?.plugins.allowInstall === false);
check('plugins.updated left the floor alone', store.state?.roles.length === beforeForeign && store.state?.runs.length === 1);
check('plugins.updated reported the change in the feed', store.feed.some((item) => item.text.includes('plugins updated · 0 loaded · 1 installed')));

// Memory. Writing and correcting are separate frames, and a correction must
// arrive as one: the new fact and the fact it replaced are applied together, so
// the console can never hold two active facts contradicting each other.
const oldFact: MemoryFact = {
  id: 'fact_old',
  scope: 'workspace',
  scopeId: 'default',
  kind: 'convention',
  text: 'Tests run with --test-isolation=none.',
  origin: 'operator',
  tags: ['testing'],
  source: null,
  confidence: 0.6,
  createdAt: 100,
  updatedAt: 100,
  validFrom: 100,
  invalidFrom: null,
  supersededBy: null,
  supersedes: null,
  readCount: 0,
  lastReadAt: null,
};
const newFact: MemoryFact = {
  ...oldFact,
  id: 'fact_new',
  text: 'Tests run with --test-isolation=none on Node 24.',
  supersedes: 'fact_old',
};
const supersededFact: MemoryFact = { ...oldFact, invalidFrom: 300, supersededBy: 'fact_new', updatedAt: 300 };

feed({ type: 'memory.created', fact: oldFact, superseded: null, at: 2900 });
check('memory.created added the fact', store.getMemory().facts.length === 1);
check('memory.created counted it against its scope', store.getMemory().counts.workspace === 1, store.getMemory().counts);
check('memory.created reported it in the feed', store.feed.some((item) => item.kind === 'memory' && item.text.startsWith('remembered')));

feed({ type: 'memory.created', fact: newFact, superseded: supersededFact, at: 3000 });
check(
  'a correction leaves exactly one current belief',
  store.getMemory().facts.filter((fact) => fact.invalidFrom === null && fact.supersededBy === null).length === 1,
  store.getMemory().facts.length,
);
check('the replacement is the current one', store.getMemory().facts.some((fact) => fact.id === 'fact_new'));
check('the original is kept, marked superseded', store.getMemory().facts.find((fact) => fact.id === 'fact_old')?.supersededBy === 'fact_new');
check('a superseded fact is no longer counted as current', store.getMemory().counts.workspace === 1, store.getMemory().counts);
check('the correction was reported as a correction', store.feed.some((item) => item.text.startsWith('corrected')));

feed({ type: 'memory.retracted', fact: { ...newFact, invalidFrom: 3100 }, at: 3100 });
check('a retracted fact stops being current', store.getMemory().facts.find((fact) => fact.id === 'fact_new')?.invalidFrom === 3100);
check('retraction empties the current count', store.getMemory().counts.workspace === 0, store.getMemory().counts);
check('retraction was reported', store.feed.some((item) => item.text.startsWith('retracted')));

feed({
  type: 'memory.updated',
  state: {
    facts: [oldFact],
    counts: { installation: 0, workspace: 1, role: 0 },
    searchable: false,
    semantic: true,
    vectorCount: 4,
    vectorCoverage: 3,
  },
  at: 3200,
});
check('memory.updated replaced the whole slice', store.getMemory().facts.length === 1 && store.getMemory().counts.workspace === 1);
check('memory.updated carries whether search ranks', store.getMemory().searchable === false);
// Semantic recall is a capability the console must not infer: only the server
// knows whether the index loaded and how much of the store has been embedded.
check('memory.updated carries whether semantic ranking is in force', store.getMemory().semantic === true);
check('memory.updated carries the embedding coverage', store.getMemory().vectorCount === 4, store.getMemory().vectorCount);
// And a subsequent frame without those fields must not silently keep the old ones.
feed({
  type: 'memory.updated',
  state: { facts: [], counts: { installation: 0, workspace: 0, role: 0 }, searchable: true, semantic: false, vectorCount: 0, vectorCoverage: 0 },
  at: 3250,
});
check('a later memory.updated clears semantic when the server says so', store.getMemory().semantic === false);

// A full snapshot is also a memory resync, which is how a console that missed
// every memory frame while it was away becomes correct again in one step.
feed({
  type: 'office.updated',
  state: {
    ...officeState([roleA], []),
    memory: {
      facts: [oldFact, newFact],
      counts: { installation: 0, workspace: 2, role: 0 },
      searchable: true,
      semantic: true,
      vectorCount: 2,
      vectorCoverage: 2,
    },
  },
  at: 3300,
});
check('a full snapshot reseeds memory', store.getMemory().facts.length === 2);
check('a full snapshot carries the ranked-search flag', store.getMemory().searchable === true);
// ---------------------------------------------------------------- phase 3
feed(
  { type: 'office.updated', state: officeState([roleA, roleB, roleC], []), at: 2600 },
  { type: 'error', message: 'provider hiccup', runId: 'run-1', at: 2700 },
  { type: 'unknown.future.event', at: 2800 } as unknown as ServerEvent,
  { type: 'run.created', run: run('run-2', 'queued'), at: 2900 },
);

check('office.updated replaced state wholesale', store.state?.runs.length === 1 && store.state?.runs[0]?.id === 'run-2');
check('a full snapshot resets lifetime usage', store.state?.employees.find((entry) => entry.id === 'frontend-dev-1')?.lifetime.tokensIn === 0);
check('error frame raised a notice', store.getNotices().some((notice) => notice.text.includes('provider hiccup')));
check('unknown event ignored safely', store.feed.some((item) => item.kind === 'unknown'));
check('run.created queued the run and kept the selection', store.state?.activeRunIds.includes('run-2') === true && store.state?.runs.length === 1);
check('every event was counted', store.getConnection().events === fed, { events: store.getConnection().events, fed });

const turnIndexAfterSnapshot = store.getTurns();
check('run snapshots do not discard turn history', turnIndexAfterSnapshot['run-1']?.['turn-1']?.status === 'done');

// ---------------------------------------------------------------- phase 4
const beforeHello = fed;
apply({ type: 'hello', state: officeState([roleA, roleC], [run('run-9', 'running')]), at: 3000 });
check('hello replaced state wholesale', store.state?.runs.length === 1 && store.state?.runs[0]?.id === 'run-9');
check('hello pruned turns for unknown runs', store.getTurns()['run-1'] === undefined);
check('hello pruned artifacts for unknown runs', store.getArtifacts()['run-1'] === undefined);
check('hello cleared streaming', Object.keys(store.streaming).length === 0);
check('hello kept the events counter', store.getConnection().events === beforeHello + 1, store.getConnection().events);

store.selectEmployee('frontend-dev-1');
store.selectRun('run-9');
check('selection updated', store.selectedEmployeeId === 'frontend-dev-1' && store.selectedRunId === 'run-9');
check('selectRun sent loadRun', commands.some((command) => command.type === 'loadRun'));
store.send({ type: 'submit', brief: 'do a thing' });
check('send reached the transport', commands.some((command) => command.type === 'submit'));
store.attachTransport(null);
check('send without a transport warns instead of throwing', store.send({ type: 'ping' }) === false);
check('an unsent command is reported in the notices', store.getNotices().some((notice) => notice.text.includes('not connected')));

let officeEmits = 0;
let streamingEmits = 0;
const offOffice = store.subscribeOffice(() => (officeEmits += 1));
const offStreaming = store.subscribeStreaming(() => (streamingEmits += 1));
apply({ type: 'turn.delta', runId: 'run-9', turnId: 'turn-x', text: 'hi', at: 3100 });
check('a delta emits streaming only', streamingEmits === 1 && officeEmits === 0, { streamingEmits, officeEmits });
apply({ type: 'usage', employeeId: 'frontend-dev-1', lifetime: { turns: 2, tokensIn: 1, tokensOut: 1, costUsd: 0.5 }, at: 3200 });
check('employee state changes emit office', officeEmits === 1, officeEmits);
offOffice();
offStreaming();

// ----------------------------------------------------------- cold fallback
const cold = new OfficeStore();
cold.applyColdState(officeState([roleA], []), 'cold');
check('cold state adopted when nothing has arrived', cold.state !== null);
cold.apply({ type: 'hello', state: officeState([roleA, roleC], []), at: 1 });
cold.applyColdState(officeState([roleB], []), 'cold');
check('cold state ignored after hello', cold.state?.roles.length === 2, cold.state?.roles.length);

// ------------------------------------------------- HTTP chat fallback merge
const msgs = new OfficeStore();
msgs.ingestDirectMessages('frontend-dev-1', [
  { id: 'm1', employeeId: 'frontend-dev-1', role: 'user', text: 'status?', at: 1 },
  { id: 'm2', employeeId: 'frontend-dev-1', role: 'employee', text: 'done', at: 2, route: turn1.route },
]);
msgs.ingestDirectMessages('frontend-dev-1', [
  { id: 'm1', employeeId: 'frontend-dev-1', role: 'user', text: 'status?', at: 1 },
  { id: 'm2', employeeId: 'frontend-dev-1', role: 'employee', text: 'done', at: 2 },
]);
check('messages merge by id without duplicating', (msgs.directMessages?.['frontend-dev-1'] ?? []).length === 2);

// ------------------------------------------------- inspector pane geometry
//
// This arithmetic was wrong in a way only a measurement caught: the pane was
// positioned by `top` *and* `bottom` while a third computed height competed with
// both, and the height depended on the dock, whose width depended on the pane -
// so the two oscillated and overlapped at every window size. The ceiling is now
// a function of the stage and the dock only, and the property that matters is
// that the pane's bottom never passes the dock's top.

/** The stage is the viewport minus the header. What the pane measures against. */
function ceilingFor(viewportHeight: number, headerHeight: number, dockHeight: number) {
  const stageHeight = viewportHeight - headerHeight;
  return { ...paneCeiling({ stageHeight, paneTop: 92, dockHeight }), stageHeight, headerHeight, dockHeight };
}

/** Where the pane's bottom edge lands, in viewport coordinates. */
function paneBottom(viewportHeight: number, headerHeight: number, dockHeight: number): number {
  const c = ceilingFor(viewportHeight, headerHeight, dockHeight);
  return headerHeight + 92 + c.maxHeight;
}

// The window sizes actually measured in the browser, and the composer height it
// had at each. If the pane's bottom passes the dock's top, the pane is over the
// field you are typing into.
const MEASURED: ReadonlyArray<[number, number, number]> = [
  [1083, 140, 150],
  [1000, 140, 146],
  [800, 102, 122],
  [720, 194, 130],
];

for (const [viewportHeight, headerHeight, dockHeight] of MEASURED) {
  const bottom = paneBottom(viewportHeight, headerHeight, dockHeight);
  const dockTop = viewportHeight - dockHeight;
  check(
    `the pane clears the dock at ${viewportHeight}x${headerHeight}`,
    bottom <= dockTop,
    { paneBottom: bottom, dockTop },
  );
}

// A taller dock - the composer wrapping onto more rows - shortens the pane
// rather than being floated over.
check(
  'a taller dock lowers the pane ceiling',
  ceilingFor(1083, 140, 200).maxHeight < ceilingFor(1083, 140, 120).maxHeight,
);

// A short window keeps the floor and reports that it overruns, rather than
// silently producing a negative height.
const short = paneCeiling({ stageHeight: 380, paneTop: 92, dockHeight: 150 });
check('a short window keeps the pane usable', short.maxHeight === 280, short.maxHeight);
check('a short window reports the overrun instead of pretending', short.overruns === true);

// A roomy window does not overrun.
check('a roomy window does not overrun', ceilingFor(1083, 140, 150).overruns === false);

// ------------------------------------------------------- bounded growth

// ------------------------------------------------------- bounded growth
for (let index = 0; index < 900; index += 1) {
  apply({ type: 'log', level: 'debug', scope: 'loop', message: `line ${index}`, at: 4000 + index });
}
check('feed is capped', store.feed.length <= 500, store.feed.length);
check('the counter still tracks every frame', store.getConnection().events === fed, { events: store.getConnection().events, fed });

// ------------------------------------------------------- run detail backfill
const backfill = new OfficeStore();
backfill.apply({ type: 'hello', state: officeState([roleA], [run('run-7', 'done')]), at: 1 });
const artifact: Artifact = { id: 'art-9', runId: 'run-7', stageId: null, employeeId: null, kind: 'report', title: 'Report', body: 'all good', createdAt: 2 };
backfill.ingestRunDetail({ run: { ...run('run-7', 'done'), outcome: 'from /api/runs/:id' }, turns: [turn('turn-9', 'run-7', 'run-7-s1', 'frontend-dev-1')], artifacts: [artifact] });
check('backfill merged the run', store_hasRun(backfill, 'run-7'));
check('backfill merged historical turns', backfill.getTurns()['run-7']?.['turn-9'] !== undefined);
check('backfill merged historical artifacts', (backfill.getArtifacts()['run-7'] ?? []).length === 1);

function store_hasRun(instance: OfficeStore, id: string): boolean {
  return instance.state?.runs.some((entry) => entry.id === id) === true;
}

// ------------------------------------------------------------------ the building
// Where each floor sits and what is drawn for it. This is the part of the 3D
// office that can be checked without a WebGL context, and the part most likely
// to be quietly wrong: an off-by-one here puts a floor underground or stacks two
// organisations on top of each other.

check('floor 1 sits at ground level', floorOffset(1) === 0, floorOffset(1));
check('each floor rises by exactly one storey', floorOffset(2) === FLOOR_STEP && floorOffset(3) === FLOOR_STEP * 2);
check('a nonsense floor number is clamped, not placed underground', floorOffset(0) === 0 && floorOffset(-4) === 0);
check('a fractional floor number rounds down to a real storey', floorOffset(2.9) === FLOOR_STEP);
check('a non-finite floor number falls back to the ground floor', floorOffset(Number.NaN) === 0);

const building = [
  { id: 'default', floor: 1 },
  { id: 'payments', floor: 2 },
  { id: 'portal', floor: 3 },
];
check('the requested floor is the one shown', resolveFloorId(building, 'payments') === 'payments');
check(
  'an unknown floor falls back to the lowest one, not to nothing',
  resolveFloorId(building, 'closed-last-week') === 'default',
  String(resolveFloorId(building, 'closed-last-week')),
);
check('the fallback is the lowest floor even when the list is unordered', resolveFloorId([...building].reverse(), 'gone') === 'default');
check('an empty building resolves to no floor at all', resolveFloorId([], 'anything') === null);

const shown = floorVisibility('payments', 'payments');
const other = floorVisibility('portal', 'payments');
check('the floor being looked at shows its walls', shown.walls === true);
check('another floor keeps only its plate', other.walls === false && other.plate === true);
check('the active floor hides its plate so it cannot z-fight the real slab', shown.plate === false);

// ------------------------------------------------------------------ the dressing
// A floor's style is a sparse patch over a preset, and the renderer dresses a
// clone by looking each material's *name* up in a role table. Both halves can be
// wrong in ways a typecheck cannot see: a preset missing a role leaves a surface
// grey, and a material the table has never heard of ships unstyled no matter what
// the user picks. Neither is visible without a viewport, so both are pinned here.

check('there is a role for every surface a floor can show', STYLE_ROLES.length >= 14, STYLE_ROLES.length);

for (const presetId of STYLE_PRESET_ORDER) {
  const applied = applyStyle({ preset: presetId });
  const missing = STYLE_ROLES.filter((role) => applied.materials[role] === undefined);
  check(`${presetId}: every role resolves to a material`, missing.length === 0, missing);
  check(`${presetId}: the wall takes the preset's own colour`,
    applied.materials.wall.color.getHexString() === STYLE_PRESETS[presetId]?.materials.wall.color.slice(1),
    applied.materials.wall.color.getHexString());
}

// The default must be exactly the look the office shipped with, or "unstyled"
// would have been a redesign rather than a no-op.
const defaultApplied = applyStyle(undefined);
check('an unstyled floor resolves to the default preset', defaultApplied.presetId === DEFAULT_STYLE_PRESET);
check(
  'the default preset paints the walls the pre-style grey',
  defaultApplied.materials.wall.color.getHexString() === '9a9ba1',
  defaultApplied.materials.wall.color.getHexString(),
);

// Every material the two GLBs actually carry, so a new one cannot slip through.
// Kept as a list rather than read from the assets because this runs without a
// filesystem; `blender/scripts/verify-blocks-glb.mjs` reads the real files.
const ASSET_MATERIALS = [
  // blocks.glb - the generated kit's surfaces
  'W_Slab', 'W_Floor', 'W_Carpet', 'W_Wall', 'W_AccentWall', 'W_Partition', 'W_Glass', 'W_Trim',
  'F_Frame', 'F_Rail', 'F_Desk', 'F_DeskTop', 'F_Soft', 'F_SoftDeep', 'F_Rug', 'F_Plant',
  'F_Board', 'F_Cork', 'F_Storage', 'F_Art', 'F_Fixture', 'F_Neon', 'F_Screen', 'F_ScreenOff',
  // office.glb - the hand-authored core
  'M_Floor_Concrete', 'M_Carpet_DevFloor', 'M_Wall_Paint', 'M_Wall_Accent', 'M_Glass_Partition',
  'M_Metal_Frame', 'M_Accent_Orange', 'M_Desk_Oak', 'M_Desk_Top', 'M_Table_Meeting',
  'M_Chair_Shell', 'M_Chair_Pad', 'M_Soft_Furnishing', 'M_Rug', 'M_Plant', 'M_Screen_Emissive',
];
const unmappedNames = ASSET_MATERIALS.filter((name) => roleForMaterial(name) === null);
check('every material in both GLBs maps to a role', unmappedNames.length === 0, unmappedNames);

// A dressing pass must actually swap the materials, and must name anything it
// could not place - a silently unstyled mesh is what this table exists to prevent.
const styledFloor = applyStyle({ preset: 'neonlab', materials: { wall: { color: '#123456' } } });
const wallMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'W_Wall' }));
const leftover = dressMaterials(wallMesh, styledFloor);
check('dressing a mesh swaps its material for the styled one', wallMesh.material === styledFloor.materials.wall);
check('a known material leaves nothing unmapped', leftover.length === 0, leftover);
check(
  'a colour override reaches the material the renderer uses',
  styledFloor.materials.wall.color.getHexString() === '123456',
  styledFloor.materials.wall.color.getHexString(),
);

const strayMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'Not_A_Real_Material' }));
const strayLeftover = dressMaterials(strayMesh, styledFloor);
check('an unrecognised material is named in the report', strayLeftover.includes('Not_A_Real_Material'), strayLeftover);

// Materials are owned per floor, so releasing one must not disturb a sibling.
const otherFloor = applyStyle({ preset: 'nordic' });
disposeMaterials(styledFloor.materials);
check('releasing a floor keeps a sibling floor intact',
  otherFloor.materials.wall.color.getHexString() === 'e9e6df',
  otherFloor.materials.wall.color.getHexString());

// ------------------------------------------------------------ walking around
//
// Liveliness is two pieces of pure logic - a grid sampled from obstacle boxes,
// and the director that decides who gets up - and neither needs a WebGL context
// to be wrong. What follows pins the properties the office actually leans on: a
// route never leaves the floor, a wall is a wall, and nobody who is working
// leaves their desk.

/**
 * An 18 x 12 room with a desk in it, a door in the south wall, and a small
 * annexe beyond the door. With the door shut the annexe is sealed, which is the
 * case a real floor hits whenever it grows a room the plan has not caught up
 * with - and the case that must not be walked through.
 */
function roomBoxes(openDoor: boolean): ObstacleBox[] {
  return [
    { minX: -9, maxX: 9, minZ: -6, maxZ: -5.8 }, // north wall
    { minX: -9, maxX: -8.8, minZ: -6, maxZ: 6 }, // west wall
    { minX: 8.8, maxX: 9, minZ: -6, maxZ: 6 }, // east wall
    ...(openDoor
      ? [
          { minX: -9, maxX: -0.7, minZ: 5.8, maxZ: 6 },
          { minX: 0.7, maxX: 9, minZ: 5.8, maxZ: 6 },
        ]
      : [{ minX: -9, maxX: 9, minZ: 5.8, maxZ: 6 }]),
    // the annexe, reachable only through that door
    { minX: -3, maxX: 3, minZ: 9, maxZ: 9.2 },
    { minX: -3, maxX: -2.8, minZ: 6, maxZ: 9 },
    { minX: 2.8, maxX: 3, minZ: 6, maxZ: 9 },
    // two desks to walk around
    { minX: -3.5, maxX: -1.5, minZ: 1.6, maxZ: 2.4 },
    { minX: 1.5, maxX: 3.5, minZ: 1.6, maxZ: 2.4 },
  ];
}

const openRoom = buildNavGrid(roomBoxes(true), { cell: 0.25, radius: 0.3 });
const shutRoom = buildNavGrid(roomBoxes(false), { cell: 0.25, radius: 0.3 });

check('a room is mostly walkable', openRoom.walkableCells > 1000, openRoom.walkableCells);
check('the wall beside the door is solid', openRoom.isWalkable(4, 5.9) === false);
check('and the doorway itself is not', openRoom.isWalkable(0, 5.9) === true);
check('the annexe beyond the door is not', openRoom.isWalkable(0, 7) === true);

const throughDoor = openRoom.path({ x: 0, z: 0 }, { x: 0, z: 8 });
check('a route reaches the room on the other side of a door', throughDoor !== null && throughDoor.length > 0);
check(
  'the route ends where it was asked to',
  throughDoor !== null && Math.hypot((throughDoor[throughDoor.length - 1]?.z ?? 0) - 8, 0) < 0.5,
  throughDoor?.[throughDoor.length - 1],
);

// The strongest statement available without re-walking the path by hand: it
// exists, and every point on it is on the floor. The only way through is the
// doorway, so a route that exists went through the doorway.
let offFloor = 0;
let longestGap = 0;
for (const [index, point] of (throughDoor ?? []).entries()) {
  if (!openRoom.isWalkable(point.x, point.z)) offFloor += 1;
  const previous = throughDoor?.[index - 1];
  if (previous) longestGap = Math.max(longestGap, Math.hypot(point.x - previous.x, point.z - previous.z));
}
check('every waypoint of a route is on walkable floor', offFloor === 0, offFloor);
check('a route is pulled taut rather than stepped cell by cell', longestGap > 1, longestGap);

check('a sealed room cannot be reached', shutRoom.path({ x: 0, z: 0 }, { x: 0, z: 8 }) === null);
check(
  'and it is a different region, so nobody is sent looking',
  shutRoom.regionAt(0, 0) !== shutRoom.regionAt(0, 8),
);

// Bounds are the built extent by default. A margin here is how a walker ends up
// strolling around the outside of the building.
check('the walkable extent is exactly what the geometry covers', openRoom.bounds.minX === -9 && openRoom.bounds.maxX === 9, openRoom.bounds);
check('nothing beyond the built extent is walkable', openRoom.isWalkable(0, 20) === false && openRoom.isWalkable(20, 0) === false);
check('an empty floor yields a grid that answers every question safely', (() => {
  const barren = buildNavGrid([]);
  return barren.walkableCells === 0 && barren.path({ x: 0, z: 0 }, { x: 1, z: 1 }) === null && barren.resolve(0, 0) === null;
})());

// A destination inside a desk is snapped to the floor beside it; one in the
// middle of nowhere is refused rather than guessed at.
const onDesk = openRoom.resolve(-2.5, 2);
check('a blocked destination is snapped to walkable floor', onDesk !== null && openRoom.isWalkable(onDesk.x, onDesk.z), onDesk);
check('a destination outside the building is refused', openRoom.resolve(0, 40) === null);
check('a walkable destination is left alone', (() => {
  const here = openRoom.resolve(0, 0);
  return here !== null && Math.abs(here.x) <= 0.2 && Math.abs(here.z) <= 0.2;
})());

// ------------------------------------------------------------------- the floor

const SPOTS: LivelinessSpot[] = [
  { id: 'north', x: 0, z: -4, weight: 1 },
  { id: 'east', x: 7, z: 3, weight: 1 },
  { id: 'annexe', x: 0, z: 8, weight: 2 },
];

const SEATS: ReadonlyArray<[number, number, number]> = [
  [-6, 3, Math.PI],
  [-2, 3, Math.PI],
  [2, 3, Math.PI],
  [6, 3, Math.PI],
  [-4, -3, 0],
  [4, -3, 0],
];

function floor(): LivelinessMember[] {
  return SEATS.map(([x, z, yaw], index) => ({
    id: `emp-${index}`,
    name: `Emp ${index}`,
    home: { x, y: 0, z, yaw },
  }));
}

/** What every body looked like on one frame, for the determinism check. */
function trace(seed: number, seconds: number): string {
  const director = new Liveliness({ seed, maxWanderers: 3 });
  const members = floor();
  director.configure({ members, spots: SPOTS, nav: openRoom, enabled: true });
  const parts: string[] = [];
  for (let step = 0; step < seconds * 30; step += 1) {
    director.update(1 / 30, () => 'idle');
    for (const member of members) {
      const motion = director.motionFor(member.id);
      parts.push(motion ? `${motion.mode}@${motion.x.toFixed(2)},${motion.z.toFixed(2)}` : '-');
    }
  }
  return parts.join('|');
}

check('the same seed replays the same office', trace(5, 45) === trace(5, 45));
check('a different seed is a different office', trace(5, 45) !== trace(6, 45));

// A working office is a still office: the whole point of the layer is that a
// status colour still tells you where to look.
{
  const director = new Liveliness({ seed: 7, maxWanderers: 2 });
  const members = floor();
  director.configure({ members, spots: SPOTS, nav: openRoom, enabled: true });
  let strayed = 0;
  for (let step = 0; step < 30 * 120; step += 1) {
    director.update(1 / 30, () => 'working');
    for (const member of members) {
      const motion = director.motionFor(member.id);
      if (!motion) continue;
      if (motion.mode !== 'seated') strayed += 1;
      if (Math.hypot(motion.x - member.home.x, motion.z - member.home.z) > 0.05) strayed += 1;
    }
  }
  check('nobody who is working ever leaves their desk', strayed === 0, strayed);
  check('and a working office has no conversations in it', director.conversations === 0);
}

// An idle office is a lived-in one.
{
  const director = new Liveliness({ seed: 7, maxWanderers: 2 });
  const members = floor();
  director.configure({ members, spots: SPOTS, nav: openRoom, enabled: true });
  const away = new Set<string>();
  const said = new Set<string>();
  let peakAway = 0;
  let peakUp = 0;
  let chats = 0;
  let walkedOff = 0;
  let laidOut = 0;
  for (let step = 0; step < 30 * 300; step += 1) {
    director.update(1 / 30, () => 'idle');
    peakAway = Math.max(peakAway, director.wandering);
    chats = Math.max(chats, director.conversations);
    let onFeet = 0;
    for (const member of members) {
      const motion = director.motionFor(member.id);
      if (!motion) continue;
      if (motion.mode !== 'seated') onFeet += 1;
      if (!openRoom.isWalkable(motion.x, motion.z)) walkedOff += 1;
      if (motion.bubble) {
        said.add(motion.bubble);
        if (motion.bubble.length > MAX_BUBBLE_CHARS) laidOut += 1;
      }
      if (Math.hypot(motion.x - member.home.x, motion.z - member.home.z) > 0.5) away.add(member.id);
    }
    peakUp = Math.max(peakUp, onFeet);
  }
  check('idle employees get up and go somewhere', away.size >= 3, [...away].join(','));
  check('most of the floor is at its desk at any moment', peakAway <= 2, peakAway);
  // The cap counts people away from their desk; a conversation also stands the
  // person being talked to, so the room holds at most twice the cap on its feet.
  check('and the room never fills with standing people', peakUp <= 4, peakUp);
  check('nobody ever walks off the floor', walkedOff === 0, walkedOff);
  check('colleagues end up talking to each other', chats > 0, chats);
  check('a conversation is said out loud', said.size > 0, said.size);
  check('and no line overflows the bubble it is drawn in', laidOut === 0, laidOut);
}

// Work arriving mid-stroll is the case that matters most.
{
  const director = new Liveliness({ seed: 11, maxWanderers: 4 });
  const members = floor();
  director.configure({ members, spots: SPOTS, nav: openRoom, enabled: true });
  let subject: LivelinessMember | null = null;
  let caught: { x: number; z: number } | null = null;
  for (let step = 0; step < 30 * 300 && subject === null; step += 1) {
    director.update(1 / 30, () => 'idle');
    for (const member of members) {
      const motion = director.motionFor(member.id);
      if (motion && motion.mode === 'walking' && Math.hypot(motion.x - member.home.x, motion.z - member.home.z) > 1.5) {
        subject = member;
        caught = { x: motion.x, z: motion.z };
        break;
      }
    }
  }
  check('somebody was caught away from their desk', subject !== null, caught);

  if (subject) {
    const walker = subject;
    let seatedAfter = -1;
    for (let step = 0; step < 30 * 30; step += 1) {
      director.update(1 / 30, (id) => (id === walker.id ? 'working' : 'idle'));
      const motion = director.motionFor(walker.id);
      if (motion && motion.mode === 'seated' && Math.hypot(motion.x - walker.home.x, motion.z - walker.home.z) < 0.01) {
        seatedAfter = step / 30;
        break;
      }
    }
    check('work brings them straight back to their desk', seatedAfter >= 0 && seatedAfter < 25, seatedAfter);
  }

  // Switching the layer off has to be immediate and complete: reduced motion
  // means a still office, not an office that finishes its walk first.
  director.configure({ members, spots: SPOTS, nav: openRoom, enabled: false });
  const seated = members.every((member) => {
    const motion = director.motionFor(member.id);
    return (
      motion !== null &&
      motion.mode === 'seated' &&
      Math.abs(motion.x - member.home.x) < 0.001 &&
      Math.abs(motion.z - member.home.z) < 0.001
    );
  });
  check('switching liveliness off seats everybody at once', seated);
  check('and leaves nobody mid-conversation', director.conversations === 0 && director.wandering === 0);
}

// A real seat is inside its chair. The walkable grid says so — a chair is an
// obstacle — which means a body at its desk is standing in blocked space and has
// to be able to walk *out* of it. Getting this wrong is invisible in a test whose
// seats stand on open floor, and total in the office: every walker steps into the
// edge of its own chair, gets nowhere, and gives up.
{
  const chairBoxes: ObstacleBox[] = [...roomBoxes(true), { minX: -6.9, maxX: -5.1, minZ: 2.5, maxZ: 3.5 }];
  const chairRoom = buildNavGrid(chairBoxes, { cell: 0.25, radius: 0.3 });
  check('a seat inside a chair is not walkable floor', chairRoom.isWalkable(-6, 3) === false);

  const director = new Liveliness({ seed: 7, maxWanderers: 2 });
  const members = floor();
  const first = members[0];
  director.configure({ members, spots: SPOTS, nav: chairRoom, enabled: true });
  let escaped = false;
  for (let step = 0; step < 30 * 300 && !escaped; step += 1) {
    director.update(1 / 30, () => 'idle');
    const motion = director.motionFor('emp-0');
    if (motion && first && Math.hypot(motion.x - first.home.x, motion.z - first.home.z) > 1) escaped = true;
  }
  check('and its occupant gets up and walks out of it anyway', escaped);
}

// A seat that moves takes its person with it, which is what sending somebody to
// the meeting room looks like from here.
{
  const director = new Liveliness({ seed: 3, maxWanderers: 4 });
  const members = floor();
  director.configure({ members, spots: SPOTS, nav: openRoom, enabled: true });
  for (let step = 0; step < 30 * 60; step += 1) director.update(1 / 30, () => 'idle');
  const moved = members.map((member, index) =>
    index === 0 ? { ...member, home: { x: 6, y: 0, z: -4, yaw: 0 } } : member,
  );
  director.configure({ members: moved, spots: SPOTS, nav: openRoom, enabled: true });
  const motion = director.motionFor('emp-0');
  check(
    'a person whose seat moved is standing at the new one',
    motion !== null && Math.abs(motion.x - 6) < 0.001 && Math.abs(motion.z + 4) < 0.001,
    motion,
  );
}

// Every line has to survive a bubble 448 pixels wide without being clipped, and
// a name long enough to matter must not be what breaks it.
{
  const speaker = { id: 'a', name: 'Bartholomew' };
  const listener = { id: 'b', name: 'Konstantinos' };
  const lines = [
    ...SMALL_TALK_OPENERS.map((line) => line(speaker, listener)),
    ...SMALL_TALK_REPLIES.map((line) => line(speaker, listener)),
  ];
  const overlong = lines.filter((line) => line.length > MAX_BUBBLE_CHARS);
  check('no line of office small talk overflows its bubble', overlong.length === 0, overlong);
  check('and none of them is empty', lines.every((line) => line.trim().length > 0));
}

// ------------------------------------------------------------------ the poses
//
// The avatar layer is the one piece of this that a screenshot usually has to
// judge, and a screenshot cannot say *why* a figure is the height it is. So the
// pose is asserted directly: the director's motion goes in, the scene graph
// comes out, and the arithmetic in between - standing up, walking on legs,
// showing a line, sitting back down - is checked rather than eyeballed.
//
// What this does not prove is that any of it is drawn correctly, which is what
// the screenshot tooling is for. It proves the pose is the one that was asked
// for, and that it goes back to the desk afterwards.

/** The two methods the avatar's canvas drawing actually uses. */
function stubCanvas(width: number, height: number): HTMLCanvasElement {
  const context = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === 'measureText') return (text: string) => ({ width: String(text).length * 14 });
        return () => undefined;
      },
      set: () => true,
    },
  );
  return { width, height, getContext: () => context } as unknown as HTMLCanvasElement;
}

const scope = globalThis as { document?: { createElement: (tag: string) => HTMLCanvasElement } };
const previousDocument = scope.document;
scope.document = { createElement: () => stubCanvas(1, 1) };

const testAvatar = createAvatar('harness-1', 'Nadia', { bodyColor: '#38bdf8', accentColor: '#075985', height: 1 });
const avatarBody = testAvatar.group.getObjectByName('Body');
const avatarLeg = testAvatar.group.getObjectByName('LegR');
const avatarSeat = testAvatar.group.getObjectByName('SeatedLegs');
const avatarBubble = testAvatar.group.getObjectByName('Bubble') as THREE.Sprite | undefined;

const walkPose = { x: 2, y: 0, z: 3, yaw: 0.5, mode: 'walking' as const, speed: 1.1, phase: 0.4, bubble: 'coffee?' };
for (let frame = 0; frame < 40; frame += 1) testAvatar.update(1 / 30, frame / 30, false, walkPose);

check(
  'a walking body is drawn where the director asked for it',
  Math.abs(testAvatar.group.position.x - 2) < 0.001 && Math.abs(testAvatar.group.position.z - 3) < 0.001,
  testAvatar.group.position.toArray(),
);
check('and it rises from its chair onto its legs', (avatarBody?.position.y ?? 0) > 0.4, avatarBody?.position.y);
check('the legs are shown and the seat is not', avatarLeg?.visible === true && avatarSeat?.visible === false);
check(
  'the line it is saying is on screen',
  avatarBubble?.visible === true && (avatarBubble.material as THREE.SpriteMaterial).opacity > 0.5,
);

// Somewhere else entirely: a body that sits down is placed by the director in
// every mode, including this one. Placing only the bodies on their feet leaves an
// employee sent to the meeting room standing at the desk they left, which is a
// bug that looks like nothing at all until somebody is moved.
const sitPose = { ...walkPose, x: -4, z: -1, mode: 'seated' as const, speed: 0, bubble: null };
for (let frame = 0; frame < 150; frame += 1) testAvatar.update(1 / 30, frame / 30, false, sitPose);

check(
  'a seated body is still put where the director says it is',
  Math.abs(testAvatar.group.position.x + 4) < 0.001 && Math.abs(testAvatar.group.position.z + 1) < 0.001,
  testAvatar.group.position.toArray(),
);
check('and it settles back down at its desk', (avatarBody?.position.y ?? 1) < 0.05, avatarBody?.position.y);
check('the legs are put away and the seat is back', avatarLeg?.visible === false && avatarSeat?.visible === true);
check('and the bubble has faded off the screen', avatarBubble?.visible === false);
check('the pose survives being handed no motion at all', (() => {
  testAvatar.update(1 / 30, 1, false, null);
  return avatarBody?.position.y !== undefined;
})());

testAvatar.dispose();
if (previousDocument === undefined) delete scope.document;
else scope.document = previousDocument;

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  throw new Error(`${failures} smoke check(s) failed`);
}
console.log('store smoke test passed');
