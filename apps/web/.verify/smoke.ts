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
  directory: 'E:/Development/dev3d/plugins/dev3d.cost-guard',
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
    workspaceId: 'default',
    workspacePath: 'E:/Development/dev3d/workspace',
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
      workspacesRoot: 'E:/Development/dev3d/workspaces',
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
        path: 'E:/Development/dev3d/workspace',
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
    },
    plugins: {
      apiVersion: '1',
      pluginsRoot: 'E:/Development/dev3d/plugins',
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
    providers: [{ id: 'mock', label: 'Mock', configured: true, ok: true, detail: null, modelCount: 1, pluginId: null }],
    llmMode: 'mock',
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

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  throw new Error(`${failures} smoke check(s) failed`);
}
console.log('store smoke test passed');
