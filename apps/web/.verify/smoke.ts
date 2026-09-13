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
import { numericDraft, parseStoredNumber } from '../src/app/hooks.ts';
import { safeHref } from '../src/app/safeHref.ts';
import {
  POSTURE_HINT,
  TIERS,
  modelProvenance,
  planProgress,
  planStepMark,
  providerSourceCopy,
  routeServeCopy,
  statusTone,
} from '../src/app/vocabulary.ts';
import { sameStyle } from '../src/app/styleEqual.ts';
import {
  AA_NORMAL_TEXT,
  SURFACES,
  blendOver,
  contrast,
  declaredOpacity,
  readStylesheet,
  readTokens,
  tokenAgainstSurfaces,
} from './cssContrast.ts';
import { REPLY_PATIENCE_MS, pendingEcho } from '../src/app/chat.ts';
import { sceneSignature } from '../src/office/sceneSync.ts';
import { toolConsent } from '../src/console/plugins/format.ts';
import { formatUsage, reasoningShare } from '../src/app/format.ts';
import { panelTokenStyle } from '../src/console/plugins/panelTokens.ts';
import { paneCeiling } from '../src/app/paneGeometry.ts';
import { FLOOR_STEP, floorOffset, floorVisibility, resolveFloorId } from '../src/office/floors.ts';
import { Liveliness, MAX_BUBBLE_CHARS, SMALL_TALK_OPENERS, SMALL_TALK_REPLIES } from '../src/office/liveliness.ts';
import type { LivelinessMember, LivelinessSpot } from '../src/office/liveliness.ts';
import { buildNavGrid } from '../src/office/navgrid.ts';
import type { ObstacleBox } from '../src/office/navgrid.ts';
import { createAvatar, roundRectPath } from '../src/office/avatar.ts';
import { exteriorEdges, glazingFor, lintelNodeName, wallNodeName } from '../src/office/glazing.ts';
import {
  STYLE_ROLES,
  activeTextureLibrary,
  applyStyle,
  disposeMaterials,
  dressMaterials,
  roleForMaterial,
  setTextureLibrary,
} from '../src/office/theme.ts';
import { DEFAULT_STYLE_PRESET, PLUGIN_API_VERSION, STYLE_PRESETS, STYLE_PRESET_ORDER, apiCompatible, namespacedToolName } from '@dev3d/core';
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
  contributions: { providers: 0, models: 1, skills: 1, roleTemplates: 0, pipelines: 0, routingRules: 2, tools: 1, uiPanels: 0 },
  // The host publishes the *namespaced* names it actually registered, not the
  // bare names the manifest declared: id `dev3d.cost-guard` + tool `echo`.
  registeredToolNames: ['dev3d_cost_guard_echo'],
  // The host this plugin would send prompts to. A contributed provider is a
  // destination for everything the model sees, so the card names it.
  contributedProviderHosts: [{ id: 'local', label: 'Local runtime', host: '127.0.0.1:1234', keyless: true }],
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

function officeState(roles: Role[], runs: Run[], employees?: EmployeeState[], approvals: Approval[] = []): OfficeState {
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
    approvals,
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
        local: false,
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

// Moved to the bench, which the event spells as `toSeatId: null`. The store used to
// keep the *previous* room in that case (`toRoomId ?? employee.roomId`) while the feed
// line said "bench", so the record and the state it described disagreed, and the 3D
// scene went on facing the benched avatar at the desk it had left.
{
  const seated = store.state?.employees.find((entry) => entry.id === 'frontend-dev-2');
  check('the employee is in a room before the bench move', seated?.roomId === 'Anchor_Room_Meeting', seated?.roomId);
  feed({
    type: 'employee.moved',
    employeeId: 'frontend-dev-2',
    fromSeatId: 'Seat_Meeting_03',
    toSeatId: null,
    toRoomId: null,
    at: 2015,
  });
  const benched = store.state?.employees.find((entry) => entry.id === 'frontend-dev-2');
  check('a bench move clears the seat', benched?.seatId === null);
  check('and clears the room, rather than keeping the one it left', benched?.roomId === null, benched?.roomId);
  const line = store.feed.find((item) => item.kind === 'move' && item.text.includes('bench'));
  check('the feed says bench', line !== undefined, line?.text);
  check('and the room it moved to is not still named in the same line', (line?.text ?? '').includes('bench → bench') || (line?.text ?? '') === 'Omar moved Seat_Meeting_03 → bench', line?.text);
}

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
  registeredToolNames: [],
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

// ------------------------------------------------- approvals resync on connect
// An approval blocks the office, and before this it could only be learned from
// the two live events — so a refresh, a reconnect or a second tab showed nothing
// while the run sat waiting and its timeout ran down. The state frame now
// carries the pending list, and adopting a frame replaces it outright so an
// approval decided elsewhere disappears here rather than lingering as a stale
// prompt.
{
  const pending: Approval = {
    id: 'approval-resync',
    runId: 'run_1',
    turnId: null,
    employeeId: 'frontend-dev-1',
    kind: 'shell',
    summary: 'run the tests',
    detail: '',
    status: 'pending',
    requestedAt: 5_000,
    decidedAt: null,
  };
  const resynced = new OfficeStore();
  resynced.apply({ type: 'hello', state: officeState([roleA], [], undefined, [pending]), at: 5_000 });
  check(
    'a cold console learns about a pending approval from the state frame alone',
    resynced.approvals.length === 1 && resynced.approvals[0]?.id === 'approval-resync',
    resynced.approvals.length,
  );
  // A later frame without it means it was decided elsewhere: it must vanish.
  resynced.apply({ type: 'office.updated', state: officeState([roleA], [], undefined, []), at: 6_000 });
  check('and a frame without it clears a stale prompt', resynced.approvals.length === 0, resynced.approvals.length);
}

// ------------------------------------------------- stored numbers and the scene guard
// A preference read from localStorage is untrusted input. `Number.parseFloat` was
// used, and it stops at the first unusable character — so `"420px"` read as 420
// and `"420.5.5"` as 420.5, turning a corrupt value into one that looked
// deliberate.
check('a clean stored number parses', parseStoredNumber('420') === 420);
check('and a negative one', parseStoredNumber('-1') === -1);
check('and a decimal one', parseStoredNumber('420.5') === 420.5);
check('and surrounding whitespace is tolerated', parseStoredNumber('  420  ') === 420);
check('trailing garbage is refused, not truncated', parseStoredNumber('420px') === null);
check('a doubled decimal point is refused', parseStoredNumber('420.5.5') === null);
check('a non-number is refused', parseStoredNumber('auto') === null);
check('an empty string is refused', parseStoredNumber('') === null);
check('exponent notation is a number', parseStoredNumber('1e3') === 1000);
check('and Infinity is not', parseStoredNumber('Infinity') === null);

// A cleared numeric settings field must not become a zero. Emptying the
// soft-spend box used to write `0`, which the field's own hint defines as
// "disables the gate" — so select-all-and-delete silently turned off the control
// that asks a human before a run keeps spending. A run budget of 0 means "no
// ceiling", so the same guard covers it.
check('clearing a numeric field keeps the previous value', numericDraft('', undefined, 5) === 5);
check('and a draft already in progress wins', numericDraft('', 7, 5) === 7);
check('a real number is taken', numericDraft('2.5', 7, 5) === 2.5);
check('a zero the operator typed on purpose is kept', numericDraft('0', 7, 5) === 0);
check('unparseable text keeps the previous value rather than becoming NaN', numericDraft('abc', 7, 5) === 7);
check('and whitespace is treated as empty', numericDraft('   ', 7, 5) === 7);

// Links in model output. Transcripts, artifacts and stage summaries are all
// untrusted text, and a link is the one place that text becomes a clickable
// navigation target — the tokenizer accepted `javascript:` straight into `<a
// href>`, and there is no CSP behind it.
check('https is a link', safeHref('https://example.test/x') === 'https://example.test/x');
check('http is a link', safeHref('http://example.test/x') === 'http://example.test/x');
check('an in-page anchor is a link', safeHref('#section') === '#section');
check('a relative path is a link', safeHref('/docs/a.md') === '/docs/a.md');
check('mailto is a link', safeHref('mailto:a@b.test') === 'mailto:a@b.test');
check('javascript: is refused', safeHref('javascript:alert(1)') === null);
check('a mixed-case javascript: is refused', safeHref('JaVaScRiPt:alert(1)') === null);
check('data: is refused', safeHref('data:text/html,<script>x</script>') === null);
check('vbscript: is refused', safeHref('vbscript:msgbox') === null);
check('file: is refused', safeHref('file:///C:/Windows/win.ini') === null);
check('a control character cannot smuggle a scheme', safeHref('java\nscript:alert(1)') === null);
check('an empty target is not a link', safeHref('') === null);
check('surrounding whitespace does not hide a scheme', safeHref('  javascript:alert(1)  ') === null);

// Style comparison, by value. The server hands out a brand-new `office.style`
// object on every full-state frame, so an identity check can never tell "the
// server agreed with what I sent" from "somebody else changed this" — and the
// style editor needs that to avoid reverting a change that is still in flight.
{
  const base = { preset: 'studio', environment: { exposure: 1 }, materials: { floor: { color: '#fff' } } };
  const equal = { preset: 'studio', environment: { exposure: 1 }, materials: { floor: { color: '#fff' } } };
  check('a structurally equal style compares equal', sameStyle(base as never, equal as never));
  check('the same reference is equal', sameStyle(base as never, base as never));
  check('undefined never equals a style', sameStyle(base as never, undefined) === false);
  check('two undefineds are equal', sameStyle(undefined, undefined));
  check(
    'a changed scalar is a difference',
    sameStyle(base as never, { ...base, preset: 'nordic' } as never) === false,
  );
  check(
    'a changed nested field is a difference',
    sameStyle(base as never, { ...base, environment: { exposure: 1.4 } } as never) === false,
  );
  check(
    'a changed per-role material is a difference',
    sameStyle(base as never, { ...base, materials: { floor: { color: '#000' } } } as never) === false,
  );
  check(
    'an added key is a difference',
    sameStyle(base as never, { ...base, extra: 1 } as never) === false,
  );
  check(
    'a missing key is a difference',
    sameStyle({ ...base, extra: 1 } as never, base as never) === false,
  );
}

// The 3D scene must not re-sync for an event that cannot affect it. The store
// hands out a fresh array on every office event, so the guard is a content
// signature rather than an identity check.
{
  const base = {
    employees: [
      {
        id: 'e1', roleId: 'r1', seatId: 'seat-1', status: 'working' as const,
        displayName: 'Ada', activity: 'writing', workspaceId: 'default',
      },
    ],
    roles: [{ id: 'r1', displayName: 'Dev', seatId: 'seat-1', appearance: { bodyColor: '#fff' } }],
    workspaces: [{ id: 'default', floor: 1, layout: { updatedAt: 1 } }],
    activeWorkspaceId: 'default',
    selectedId: null,
    vendors: [],
    selectedVendorId: null,
  } as unknown as Parameters<typeof sceneSignature>[0];

  const sig = sceneSignature(base);
  check('the same scene data gives the same signature', sceneSignature({ ...base }) === sig);
  // A budget tick or artifact must not change it — that is the whole point.
  const unrelated = { ...base, somethingElse: 42 } as typeof base;
  check('an unrelated field does not change the signature', sceneSignature(unrelated) === sig);
  // A real change must get through, or the scene would go stale.
  const moved = {
    ...base,
    employees: [{ ...base.employees[0]!, status: 'blocked' as const }],
  } as typeof base;
  check('an employee status change does change it', sceneSignature(moved) !== sig);
  const selected = { ...base, selectedId: 'e1' } as typeof base;
  check('a selection change does change it', sceneSignature(selected) !== sig);
  const otherFloor = { ...base, activeWorkspaceId: 'other' } as typeof base;
  check('a floor switch does change it', sceneSignature(otherFloor) !== sig);
}

// ------------------------------------------------- chat waiting indicator
// The socket path used to return before setting the "sending" flag, so the normal
// way of sending a direct message showed no feedback at all. The indicator is now
// derived from the thread, and these pin the derivation.
{
  const t = 1_000_000;
  const user = (id: string, at: number): DirectMessage => ({
    id, employeeId: 'e1', role: 'user', text: 'hello', at,
  });
  const reply = (id: string, at: number): DirectMessage => ({
    id, employeeId: 'e1', role: 'employee', text: 'hi', at,
  });

  check('no echo means nothing is pending', pendingEcho([], t) === false);
  check(
    'an unanswered echo is pending',
    pendingEcho([user('local-1', t)], t + 500) === true,
  );
  check(
    'a reply after the echo settles it',
    pendingEcho([user('local-1', t), reply('dm-2', t + 200)], t + 500) === false,
  );
  check(
    'a reply *before* the echo does not settle it',
    pendingEcho([reply('dm-0', t - 5_000), user('local-1', t)], t + 500) === true,
  );
  check(
    'a server-confirmed user message with no reply is still pending',
    pendingEcho([user('dm-1', t)], t + 500) === false,
    'only an optimistic local echo counts as unanswered',
  );
  check(
    'patience runs out rather than showing a stuck spinner',
    pendingEcho([user('local-1', t)], t + REPLY_PATIENCE_MS + 1) === false,
  );
  check(
    'and holds just inside the window',
    pendingEcho([user('local-1', t)], t + REPLY_PATIENCE_MS - 1) === true,
  );
}

// The HTTP fallback must be able to take back a message that never went out, or
// the thread would show something the office never received.
{
  const s = new OfficeStore();
  s.appendDirectMessage({ id: 'local-9', employeeId: 'e1', role: 'user', text: 'gone', at: 10 });
  check('an echo can be dropped', s.directMessages['e1']?.length === 1);
  s.dropDirectMessage('e1', 'local-9');
  check('and it is gone afterwards', (s.directMessages['e1'] ?? []).length === 0);
  // Dropping something that is not there is a no-op rather than an error.
  s.dropDirectMessage('e1', 'local-9');
  s.dropDirectMessage('nobody', 'x');
  check('dropping an unknown message is harmless', (s.directMessages['e1'] ?? []).length === 0);
}

// The stylesheet's own palette, measured. `--text-mute` was #6c7686 — 3.56:1 on
// the darkest surface and 4.03:1 on a panel, so below the 4.5:1 AA threshold for
// normal text on *every* surface it is used on, at 28 sites, and on labels rather
// than decorative chrome. Two consumers then multiplied it by `opacity`. This
// reads the real sheet so the check cannot drift from the palette.
{
  const tokens = readTokens(readStylesheet());
  check('the secondary-text token exists', tokens.has('--text-mute'), [...tokens.keys()].length);
  check('and so do the body and panel surfaces', tokens.has('--bg') && tokens.has('--surface'));

  for (const token of ['--text', '--text-dim', '--text-mute']) {
    const rows = tokenAgainstSurfaces(tokens, token);
    check(`${token} is measured against every surface`, rows.length === 3, rows.length);
    for (const row of rows) {
      check(
        `${token} clears AA on ${row.surface}`,
        row.ratio >= AA_NORMAL_TEXT,
        `${row.ratio.toFixed(2)}:1`,
      );
    }
  }
  // The muted tier must stay a *dimmer* tier: equal to --text-dim would mean the
  // palette lost a level rather than gaining contrast.
  check(
    'the muted token is still dimmer than the dim token',
    (tokens.get('--text-mute') ?? '') !== (tokens.get('--text-dim') ?? ''),
  );

  // A token that passes AA on its own does not stay passing once a rule multiplies
  // it by `opacity`. `.fact-inactive` declared `opacity: .62` over `--text-dim`,
  // which composited to 3.55:1 — below the threshold, on text whose whole purpose
  // is to be legible-but-historical. The declaration is read from the sheet rather
  // than copied here, so dimming it again fails this check.
  const sheet = readStylesheet();
  const fadedOpacity = declaredOpacity(sheet, '.fact-inactive');
  check('the faded-fact rule declares an opacity', fadedOpacity !== null, String(fadedOpacity));
  if (fadedOpacity !== null) {
    for (const surfaceToken of SURFACES) {
      const text = tokens.get('--text-dim');
      const surface = tokens.get(surfaceToken);
      if (text === undefined || surface === undefined) continue;
      const ratio = contrast(blendOver(text, surface, fadedOpacity), surface);
      check(
        `.fact-inactive clears AA on ${surfaceToken} at opacity ${fadedOpacity}`,
        ratio >= AA_NORMAL_TEXT,
        `${ratio.toFixed(2)}:1`,
      );
    }
  }
}

// ------------------------------------------------- shared display vocabulary
// These tables used to be two or three copies each, and had already drifted:
// `POSTURE_HINT` described the same setting in two different ways, and the
// transcript's `statusTone` had no `cancelled` case at all — it happened to be
// right by luck, and the next status added would not have been.
{
  check('the tier ladder is the canonical order', TIERS.join(',') === 'nano,small,standard,strong,max');
  check('every posture has a hint', ['cheap', 'balanced', 'quality'].every((p) => typeof POSTURE_HINT[p as 'cheap'] === 'string'));

  // Every status the console can meet, including the one that was missing.
  check('running is informational', statusTone('running') === 'info');
  check('done is good', statusTone('done') === 'ok');
  check('awaiting-approval warns', statusTone('awaiting-approval') === 'warn');
  check('failed is dangerous', statusTone('failed') === 'danger');
  check('cancelled is neutral, not a fault', statusTone('cancelled') === 'neutral');
  check('queued is neutral', statusTone('queued') === 'neutral');
  check('skipped is neutral', statusTone('skipped') === 'neutral');
  // An unknown status must not throw or return undefined: `Badge` reads this.
  check('an unknown status falls back rather than returning undefined', statusTone('whatever') === 'neutral');
}

// A provider whose model list could not be obtained reads differently depending on
// whether it is on this machine. `local` was reported by the registry and dropped by
// the state frame, so a local runtime that was simply not started rendered exactly
// like a remote provider that could not be reached — an ordinary state of an install
// presented as a fault to go and investigate.
{
  const base = { modelSource: 'degraded' as const, modelSourceDetail: null };
  const local = providerSourceCopy({ ...base, local: true });
  const remote = providerSourceCopy({ ...base, local: false });
  check('a local runtime that is not started says so', local.label === 'not running (local)', local.label);
  check('and warns rather than alarming', local.tone === 'warn', local.tone);
  check('a remote provider that does not answer is a fault', remote.label === 'unreachable' && remote.tone === 'danger');
  check('and the two are not the same wording', local.label !== remote.label);

  check('a listed provider is fine', providerSourceCopy({ modelSource: 'discovered', local: false, modelSourceDetail: null }).tone === 'ok');
  check('a never-asked provider is neutral', providerSourceCopy({ modelSource: 'seed', local: true, modelSourceDetail: null }).tone === 'neutral');
  // The provider's own explanation wins over ours when there is one.
  check(
    'a detail from the server is preferred to the built-in hint',
    providerSourceCopy({ modelSource: 'degraded', local: false, modelSourceDetail: 'connection refused' }).hint ===
      'connection refused',
  );
}

// Which model actually answered, as opposed to which one the router picked.
// `servedBy`/`attemptedRoutes` were recorded by the engine (its own comment says the
// console "should be able to say a turn ran on a fallback") and read by nothing, so
// the transcript named the chosen model even when a different one did the work.
{
  const route = { modelId: 'deepseek-flash', providerId: 'deepseek' };

  const plain = routeServeCopy({ route });
  check('a turn nobody rescued names the routed model', plain.modelId === 'deepseek-flash');
  check('and is not marked as a fallback', plain.fellBack === false);
  check('and has nothing to explain', plain.note === null);

  // A `servedBy` equal to the route is not a fallback: the field is written on every
  // turn, so treating "present" as "fell back" would mark all of them.
  const same = routeServeCopy({ route, servedBy: { providerId: 'deepseek', modelId: 'deepseek-flash' } });
  check('a server that agreed is not a fallback', same.fellBack === false);

  const rescued = routeServeCopy({
    route,
    servedBy: { providerId: 'openrouter', modelId: 'qwen/qwen3' },
    attemptedRoutes: ['deepseek/deepseek-flash'],
  });
  check('the model that served the turn is the one named', rescued.modelId === 'qwen/qwen3');
  check('and it is marked as a fallback', rescued.fellBack === true);
  check('the reason names both models', (rescued.note ?? '').includes('deepseek-flash') && (rescued.note ?? '').includes('qwen/qwen3'), rescued.note);
  check('and says what failed first', (rescued.note ?? '').includes('deepseek/deepseek-flash'), rescued.note);
  check('the attempted routes are carried for the caller', rescued.attempted.length === 1);

  // A fallback with no recorded attempts still explains itself rather than reading
  // as if the first choice had simply been used.
  const silent = routeServeCopy({ route, servedBy: { providerId: 'openrouter', modelId: 'other' } });
  check('a fallback with no attempt list still says the first choice failed', (silent.note ?? '').includes('first choice did not answer'), silent.note);
}

// The working plan an employee keeps on a run. `AgentPlanStep`'s own doc says it is
// run state precisely so it is "visible to the operator while the run proceeds" — and
// it was persisted on every `run.updated`, transmitted on every frame, and drawn
// nowhere.
{
  const steps = [
    { content: 'read the parser', status: 'completed' as const },
    { content: 'write the failing test', status: 'in_progress' as const },
    { content: 'fix it', status: 'pending' as const },
  ];
  check('each status has its own mark', planStepMark('completed') !== planStepMark('in_progress') && planStepMark('in_progress') !== planStepMark('pending'));
  check('a completed step is ticked', planStepMark('completed') === '✓', planStepMark('completed'));
  check('progress counts only what is done', planProgress(steps) === '1 of 3 done', planProgress(steps));
  check('an empty plan reads as none done rather than dividing by zero', planProgress([]) === '0 of 0 done', planProgress([]));
  check(
    'a plan where everything is finished says so',
    planProgress(steps.map((step) => ({ ...step, status: 'completed' as const }))) === '3 of 3 done',
  );
}

// The model provenance label, which is the *only* thing the console ever derived
// from `quality.opinions` — an 87 kB array of a 455-model catalog that the state
// frame no longer carries. The frame sends `quality.sources` instead, and the full
// catalog from `GET /api/models` still has the opinions, so both shapes must
// produce the same label.
{
  const base = {
    id: 'm',
    providerId: 'p',
    label: 'M',
    tier: 'standard' as const,
    contextWindow: 1,
    maxOutputTokens: 1,
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
    strengths: [],
  };
  const opinion = (source: 'curated' | 'learned' | 'pooled') => ({ source, quality: 0.5, fitness: {}, confidence: 0.5 });

  check('no quality at all reads as unrated', modelProvenance(base) === 'unrated');
  check(
    'the projected frame provides the label',
    modelProvenance({ ...base, quality: { quality: 0.5, fitness: {}, sources: ['curated', 'learned'] } }) ===
      'curated + learned',
  );
  check(
    'the full catalog provides the same label',
    modelProvenance({
      ...base,
      quality: { quality: 0.5, fitness: {}, opinions: [opinion('curated'), opinion('learned')] },
    }) === 'curated + learned',
  );
  // The projected shape repeats a source when several opinions share one, and the
  // label must not name it twice.
  check(
    'repeated sources are named once',
    modelProvenance({ ...base, quality: { quality: 0.5, fitness: {}, sources: ['curated'] } }) === 'curated',
  );
  check(
    'quality with no sources still reads as unrated',
    modelProvenance({ ...base, quality: { quality: 0.5, fitness: {}, sources: [] } }) === 'unrated',
  );
}

// A token count that came from the `chars/4` fallback used to be drawn exactly like
// one the provider reported, so an estimate was indistinguishable from a bill.
{
  check('a reported count is drawn plain', formatUsage({ tokensIn: 1_200, tokensOut: 900 }) === '1.2K in / 900 out');
  check(
    'an estimated count is marked',
    formatUsage({ tokensIn: 1_200, tokensOut: 900, estimated: true }).startsWith('~'),
    formatUsage({ tokensIn: 1_200, tokensOut: 900, estimated: true }),
  );
  check('and carries the same numbers', formatUsage({ tokensIn: 1_200, tokensOut: 900, estimated: true }).slice(1) === formatUsage({ tokensIn: 1_200, tokensOut: 900 }));

  // The reasoning split is only ever shown when the provider reported it: an
  // estimate of it would be a second guess stacked on the first.
  check('no reported split means no reasoning line', reasoningShare({ tokensIn: 1, tokensOut: 900 }) === null);
  check('a zero split is not a line either', reasoningShare({ tokensIn: 1, tokensOut: 900, reasoningTokens: 0 }) === null);
  check(
    'a reported split is named with its share of the output',
    reasoningShare({ tokensIn: 1, tokensOut: 900, reasoningTokens: 720 }) === '720 reasoning (80% of output)',
    reasoningShare({ tokensIn: 1, tokensOut: 900, reasoningTokens: 720 }),
  );
  // A zero-output turn must not divide by zero into `NaN%`.
  check(
    'a split with no output is not a percentage',
    reasoningShare({ tokensIn: 1, tokensOut: 0, reasoningTokens: 5 }) === '5 reasoning (0% of output)',
  );
}

// The compatibility rule is shared with the host rather than hand-written here.
// The console used to compare exact strings while the host compared majors, so a
// plugin declaring `apiVersion: "1.2"` loaded perfectly and its card was painted
// red with "host implements 1 — mismatch".
{
  check('the host API version is a major string', /^\d+$/.test(PLUGIN_API_VERSION));
  check('the host is compatible with itself', apiCompatible(PLUGIN_API_VERSION));
  check('a later minor of the same major is compatible', apiCompatible('1.2'));
  check('an exact match is compatible', apiCompatible('1'));
  check('a different major is not', apiCompatible('2') === false);
  check('a different major with a minor is not', apiCompatible('2.0') === false);
  check('an unparseable version is not compatible', apiCompatible('') === false);
  check('nor is rubbish', apiCompatible('vNext') === false);
}

// ------------------------------------------------------ the tool consent list
//
// `contributes.toolNames` was documented as "for the consent screen" and read by
// nothing, while the host tracked the real registrations and published only their
// count. An operator deciding whether to trust a plugin needs the names of the
// tools it now holds, and needs to see when the manifest's claim is not backed by
// a registration.
{
  const backed = toolConsent(pluginRecord);
  check('a loaded plugin reports the tools it actually holds', backed.registered.length === 1, backed.registered);
  check('the registered name is the namespaced one, not the declared one', backed.registered[0] === 'dev3d_cost_guard_echo');
  check('a declared tool that did register is not flagged', backed.unbacked.length === 0, backed.unbacked);
  check('and the card is not painted as a mismatch', backed.mismatch === false);
  check(
    'a claim that every declared tool backed is stated, not left to be inferred',
    (backed.hint ?? '').includes('did register'),
    backed.hint,
  );

  // The claim with no registration behind it: the manifest names a tool, the
  // plugin loads, and the host never sees it register. This is the whole point of
  // comparing the two lists rather than printing the declared one.
  const claimedOnly: PluginRecord = { ...pluginRecord, registeredToolNames: [], contributions: { ...pluginRecord.contributions, tools: 0 } };
  const gap = toolConsent(claimedOnly);
  check('a declared tool that never registered is flagged', gap.unbacked.join() === 'echo', gap.unbacked);
  check('and the card is painted as a mismatch', gap.mismatch === true);
  check('and it says what the manifest claimed', (gap.hint ?? '').includes('echo'), gap.hint);
  check('and it still reports that it holds nothing', gap.registered.length === 0);

  // A tool the host registered that the manifest never named is not a lie — the
  // manifest's list is a claim about some tools, not a contract that it is
  // exhaustive — so it must not be flagged in either direction.
  const undeclared: PluginRecord = {
    ...pluginRecord,
    manifest: { ...pluginRecord.manifest, contributes: {} },
    registeredToolNames: ['dev3d_cost_guard_echo', 'dev3d_cost_guard_zap'],
  };
  const extra = toolConsent(undeclared);
  check('a tool the manifest did not name is still reported as held', extra.registered.length === 2);
  check('an unnamed registration is not a mismatch', extra.mismatch === false);
  check('with no declared names there is nothing to explain', extra.hint === null);

  // A disabled plugin has registered nothing by definition. Calling that a
  // discrepancy would put a warning on every disabled row in the console.
  const off = toolConsent(disabledPluginRecord);
  check('a disabled plugin is not accused of a mismatch', off.mismatch === false);
  check('a disabled plugin is not accused of unbacked tools either', off.unbacked.length === 0);
  check('but its manifest claim is still surfaced', (off.hint ?? '').includes('not loaded'), off.hint);

  // Name matching has to survive the host's name cleaning: a declared
  // "Echo Tool!" registers as `..._echo_tool`, which is the same tool.
  const messy: PluginRecord = {
    ...pluginRecord,
    manifest: { ...pluginRecord.manifest, contributes: { toolNames: ['Echo Tool!'] } },
    registeredToolNames: ['dev3d_cost_guard_echo_tool'],
  };
  check('a declared name is matched against the host-cleaned registration', toolConsent(messy).mismatch === false);
  // Truncation: the host caps a registered name at 64 characters, so a long
  // plugin id plus a long tool name produces a name that is *not* a suffix of the
  // cleaned declared name. A tail-matching approximation would call this a
  // mismatch and accuse a correct plugin of a lie.
  const longId = `dev3d.${'department.'.repeat(4)}very-long-plugin`;
  const longName = 'an-extremely-long-tool-name-that-will-be-cut';
  const truncated: PluginRecord = {
    ...pluginRecord,
    manifest: { ...pluginRecord.manifest, id: longId, contributes: { toolNames: [longName] } },
    registeredToolNames: [namespacedToolName(longId, longName)],
  };
  check('a truncated registration is still recognised as backed', toolConsent(truncated).mismatch === false);
}

// ---------------------------------------------------- plugin panel tokens
//
// A panel asks for its card's colours with `tokens`. The host validates them, but
// they arrive over the socket, so the console writes only the three property
// names it knows and never a name the payload chose.
{
  check('no tokens means no style attribute at all', panelTokenStyle(undefined) === undefined);
  check('an empty token set is no style attribute either', panelTokenStyle({}) === undefined);
  check(
    'the three tokens map to the three custom properties',
    JSON.stringify(panelTokenStyle({ accent: '#38bdf8', surface: '#111', text: '#eee' })) ===
      JSON.stringify({ '--plugin-panel-accent': '#38bdf8', '--plugin-panel-surface': '#111', '--plugin-panel-text': '#eee' }),
    panelTokenStyle({ accent: '#38bdf8', surface: '#111', text: '#eee' }),
  );
  // A payload key that is not a known token must not become a property name.
  const injected = panelTokenStyle({ '--background-image': 'url(https://evil.test/beacon)', accent: 'red' });
  check('a payload-chosen property name is not written', Object.keys(injected ?? {}).join() === '--plugin-panel-accent', injected);
  // Only a non-empty string is a colour; anything else is left out rather than
  // stringified into the style attribute.
  const junk = panelTokenStyle({ accent: '' });
  check('an empty value is not a colour', junk === undefined, junk);
  const notString = panelTokenStyle({ accent: undefined, text: 'red' });
  check('an absent value is skipped rather than written as "undefined"', JSON.stringify(notString) === JSON.stringify({ '--plugin-panel-text': 'red' }));
}

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
  'M_Light_Panel',
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
check(
  'and the report also lands on the style object it was handed',
  styledFloor.unmapped.includes('Not_A_Real_Material'),
  styledFloor.unmapped,
);

// The canvas keeps a scratch carrier holding only a palette — it re-uses one object
// across dozens of module clones rather than allocating a whole style per clone. That
// carrier used to be fabricated with `{ materials } as AppliedStyle`, a cast that made
// the missing `unmapped` field look present, and the report was written into the
// throwaway instead of anywhere real. `dressMaterials` now takes only what it reads
// and writes the list back only when there is somewhere to write it.
{
  const scratch: { materials: typeof styledFloor.materials; unmapped?: string[] } = { materials: styledFloor.materials };
  const stray = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'Also_Not_Real' }));
  const reported = dressMaterials(stray, scratch);
  check('a scratch carrier gets the report returned', reported.includes('Also_Not_Real'), reported);
  check('and the list is written onto it too, so a caller can read it back later', scratch.unmapped?.includes('Also_Not_Real') === true, scratch.unmapped);
}

// Materials are owned per floor, so releasing one must not disturb a sibling.
const otherFloor = applyStyle({ preset: 'nordic' });
disposeMaterials(styledFloor.materials);
check('releasing a floor keeps a sibling floor intact',
  otherFloor.materials.wall.color.getHexString() === 'e9e6df',
  otherFloor.materials.wall.color.getHexString());

// ------------------------------------------------------------- surface relief
//
// A pattern used to do nothing but tint the surface it was on. It now also bakes
// a normal map and a roughness map from the same height field, which is what
// stops a floor reading as a *photograph* of a floor: the seams are drawn, but
// nothing about the surface answers the light.
//
// That baking is pure arithmetic over 16 384 texels, which is exactly the kind of
// thing that is wrong invisibly - a transposed axis or a mis-signed slope still
// produces a perfectly plausible-looking normal map, and only shows up as relief
// that is lit from the wrong side in a viewport nobody is looking at.

/** The bytes behind a DataTexture, so one can be inspected without a GPU. */
function texelBytes(texture: THREE.Texture | null): Uint8Array | null {
  if (texture === null) return null;
  const image = texture.image as { data?: Uint8Array } | undefined;
  return image?.data ?? null;
}

const reliefFloor = defaultApplied.materials.floor;
const floorTint = reliefFloor.map;
const floorNormal = reliefFloor.normalMap;

check(
  'a patterned role is given relief, not only a tint',
  floorTint !== null && floorNormal !== null && reliefFloor.roughnessMap !== null,
);
check(
  'a plain surface is given none, because paint over plaster is flat',
  defaultApplied.materials.wall.normalMap === null,
  String(defaultApplied.materials.wall.normalMap),
);
check(
  'the relief tiles in step with the tint it belongs to',
  floorTint !== null && floorNormal !== null
    && floorNormal.repeat.x === floorTint.repeat.x
    && floorNormal.repeat.y === floorTint.repeat.y,
);
check('the relief maps are linear data, not colour', floorNormal?.colorSpace === THREE.NoColorSpace);

// The strong one: decode the encoded normals and check they are actually normals.
// A unit vector is what the shader assumes, and a z that has gone negative is a
// texel lit as though the surface were inside out.
const normalBytes = texelBytes(floorNormal);
let offUnit = 0;
let facingIn = 0;
if (normalBytes) {
  for (let at = 0; at < normalBytes.length; at += 4) {
    const x = ((normalBytes[at] ?? 0) / 255) * 2 - 1;
    const y = ((normalBytes[at + 1] ?? 0) / 255) * 2 - 1;
    const z = ((normalBytes[at + 2] ?? 0) / 255) * 2 - 1;
    // 8-bit quantisation of each channel is worth about 0.007 of length, so this
    // is a tolerance on the encoding rather than on the maths.
    if (Math.abs(Math.hypot(x, y, z) - 1) > 0.02) offUnit += 1;
    if (z <= 0) facingIn += 1;
  }
}
check('every baked normal is a unit vector', normalBytes !== null && offUnit === 0, `${offUnit} texels off the unit sphere`);
check('every baked normal faces out of the surface', normalBytes !== null && facingIn === 0, `${facingIn} texels point inward`);

// A roughness map *multiplies* the style's roughness, so anything above 1 would
// silently make a surface rougher than the editor says it is.
const roughBytes = texelBytes(reliefFloor.roughnessMap);
let roughOutOfRange = 0;
if (roughBytes) {
  for (let at = 0; at < roughBytes.length; at += 4) {
    const value = roughBytes[at + 1] ?? 0;
    if (value < 191 || value > 255) roughOutOfRange += 1;
  }
}
check(
  'the roughness map only ever softens the style roughness',
  roughBytes !== null && roughOutOfRange === 0,
  `${roughOutOfRange} texels outside 0.75..1`,
);

// Relief is a knob rather than a consequence of picking a pattern, so a style can
// ask for a patterned surface that is still flat.
const flatFloor = applyStyle({ preset: 'studio', materials: { floor: { relief: 0 } } });
check(
  'a relief of zero leaves a patterned surface flat',
  flatFloor.materials.floor.map !== null && flatFloor.materials.floor.normalMap === null,
);
disposeMaterials(flatFloor.materials);

// ------------------------------------------------------- real material sets
//
// A role can be dressed with a real PBR set instead of a generated pattern -
// albedo, normal and roughness maps at a real world scale. The library is loaded
// by the canvas and handed in, so what is checked here is the wiring: that a set
// is used, that it is tiled by the size the set declares rather than by the
// pattern's guess, and that a role with no set keeps the pattern it always had.

function stubTexture(name: string): THREE.Texture {
  const texture = new THREE.Texture();
  texture.name = name;
  return texture;
}

setTextureLibrary({
  floor: {
    tileMetres: 2,
    // A mean of 1 makes the colour division a no-op, so these checks are about the
    // wiring; the division has a check of its own below.
    albedoMean: [1, 1, 1],
    map: stubTexture('stub-albedo'),
    normalMap: stubTexture('stub-normal'),
    roughnessMap: stubTexture('stub-rough'),
  },
});
const textured = applyStyle({ preset: 'studio' });
check(
  'a role with a real material wears its albedo',
  textured.materials.floor.map?.name === 'stub-albedo',
  textured.materials.floor.map?.name,
);
check(
  'and its normal and roughness maps',
  textured.materials.floor.normalMap?.name === 'stub-normal'
    && textured.materials.floor.roughnessMap?.name === 'stub-rough',
);
// tileMetres 2 means one tile per two metres, and the assets carry UVs in metres,
// so the repeat is 1/2 - an exact figure rather than the pattern's per-module one.
check(
  'tiled at the real-world size the set declares',
  Math.abs((textured.materials.floor.map?.repeat.x ?? 0) - 0.5) < 1e-6,
  textured.materials.floor.map?.repeat.x,
);
check(
  'a role with no real material keeps its generated pattern',
  textured.materials.desk.map?.name !== 'stub-albedo',
  textured.materials.desk.map?.name,
);
check('the theme reports the library it is dressing with', activeTextureLibrary() !== null);
disposeMaterials(textured.materials);

// An albedo carries a colour of its own, so the style's colour is divided by the
// material's average rather than multiplied by it. Without that, a preset colour of
// 0.44 lighting a concrete that already averages 0.44 renders at 0.19 - every
// textured surface darker than the Look panel says, and a dark preset black.
setTextureLibrary({
  floor: {
    tileMetres: 2,
    albedoMean: [0.5, 0.5, 0.5],
    map: stubTexture('mean-albedo'),
    normalMap: stubTexture('mean-normal'),
    roughnessMap: stubTexture('mean-rough'),
  },
});
const divided = applyStyle({ preset: 'studio' });
const wantedColour = new THREE.Color(STYLE_PRESETS['studio']?.materials.floor.color ?? '#ffffff');
const gotColour = divided.materials.floor.color;
check(
  'the preset colour is divided by the albedo mean, not multiplied by it',
  Math.abs(gotColour.r - wantedColour.r / 0.5) < 1e-4 && Math.abs(gotColour.b - wantedColour.b / 0.5) < 1e-4,
  [gotColour.r, wantedColour.r / 0.5],
);
disposeMaterials(divided.materials);

setTextureLibrary(null);
check(
  'clearing the library goes back to generated patterns',
  applyStyle({ preset: 'studio' }).materials.floor.map?.name !== 'stub-albedo',
  activeTextureLibrary() === null ? 'library cleared' : 'library still set',
);

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
// `regions` is the count `regionAt` summarises, and nothing read it: written on
// every build and never consulted. What is asserted here is the invariant that
// makes the count mean something — the ids are dense from zero, and one is
// assigned per connected piece — plus the relation sealing a room must produce.
// (The absolute counts are not asserted: the grid is dilated by the walker's
// radius, so an "open" room legitimately has pockets a person cannot squeeze
// between, and hardcoding today's number would pin the furniture, not the logic.)
{
  const idsIn = (grid: { bounds: { minX: number; maxX: number; minZ: number; maxZ: number }; cell: number; regionAt(x: number, z: number): number }): Set<number> => {
    const seen = new Set<number>();
    for (let x = grid.bounds.minX; x <= grid.bounds.maxX; x += grid.cell) {
      for (let z = grid.bounds.minZ; z <= grid.bounds.maxZ; z += grid.cell) {
        const id = grid.regionAt(x, z);
        if (id >= 0) seen.add(id);
      }
    }
    return seen;
  };

  for (const [label, grid] of [['the open room', openRoom], ['the sealed room', shutRoom]] as const) {
    const ids = idsIn(grid);
    check(
      `${label} assigns region ids densely from zero`,
      ids.size === grid.regions && [...ids].every((id) => id >= 0 && id < grid.regions),
      `${grid.regions} regions, ids ${[...ids].sort((a, b) => a - b).join(',')}`,
    );
  }
  check('an empty floor has no regions at all', buildNavGrid([]).regions === 0);
  check(
    'sealing a room can only add regions, never remove one',
    shutRoom.regions > openRoom.regions,
    `${openRoom.regions} → ${shutRoom.regions}`,
  );
}

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

// The away-count is computed once per frame now, rather than once per actor per
// frame — it was O(N²) `hypot` calls in the growing-office case this layer is
// built for. The optimisation is only safe if it is still the same number, so
// this recomputes it from the published motion and compares.
{
  const director = new Liveliness({ seed: 5, maxWanderers: 6 });
  const members = floor();
  director.configure({ members, spots: SPOTS, nav: openRoom, enabled: true });
  let mismatches = 0;
  for (let step = 0; step < 30 * 120; step += 1) {
    director.update(1 / 30, () => 'idle');
    const recomputed = members.filter((member) => {
      const motion = director.motionFor(member.id);
      if (motion === null || motion.mode === 'seated') return false;
      return Math.hypot(motion.x - member.home.x, motion.z - member.home.z) >= 0.4;
    }).length;
    if (recomputed !== director.wandering) mismatches += 1;
  }
  check('the away-count matches the definition it replaced', mismatches === 0, `${mismatches} mismatched frames`);
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

// The rounded plate both avatar kinds draw. It existed twice, and the vendor copy
// had two corners wrong — one aimed at a diagonal control point, one passed the same
// point twice (a degenerate `arcTo`, which draws a straight line and silently leaves
// that corner square). It is shared now, and this pins the geometry the sharing is
// supposed to guarantee: four arcs, each with two *distinct* control points, each
// tangent to the edges it joins.
{
  type Op = { op: string; args: number[] };
  const ops: Op[] = [];
  const recorder = {
    beginPath: () => ops.push({ op: 'beginPath', args: [] }),
    moveTo: (...args: number[]) => ops.push({ op: 'moveTo', args }),
    lineTo: (...args: number[]) => ops.push({ op: 'lineTo', args }),
    arcTo: (...args: number[]) => ops.push({ op: 'arcTo', args }),
    closePath: () => ops.push({ op: 'closePath', args: [] }),
  } as unknown as CanvasRenderingContext2D;

  roundRectPath(recorder, 0, 0, 100, 40, 10);
  const arcs = ops.filter((entry) => entry.op === 'arcTo');
  check('a rounded plate is drawn with four arcs', arcs.length === 4, arcs.length);
  check(
    'and every arc has two distinct control points',
    arcs.every((arc) => arc.args[0] !== arc.args[2] || arc.args[1] !== arc.args[3]),
    JSON.stringify(arcs.map((arc) => arc.args)),
  );
  check('and every arc has a positive radius', arcs.every((arc) => (arc.args[4] ?? 0) > 0));

  // Each corner is tangent to the two edges it joins: the first control point sits
  // on one edge, the second on the other. A diagonal control point — the vendor
  // avatar's bug — fails this.
  const corners = [
    { p: [100, 0], edges: ['x=100', 'y=0'] },
    { p: [100, 40], edges: ['x=100', 'y=40'] },
    { p: [0, 40], edges: ['x=0', 'y=40'] },
    { p: [0, 0], edges: ['x=0', 'y=0'] },
  ];
  arcs.forEach((arc, index) => {
    const corner = corners[index];
    if (corner === undefined) return;
    const [x1, y1, x2, y2] = arc.args;
    const onEdge = (x: number, y: number, edge: string): boolean =>
      edge === 'x=0' ? x === 0 : edge === 'x=100' ? x === 100 : edge === 'y=0' ? y === 0 : y === 40;
    check(
      `corner ${index + 1} is tangent to both edges it joins`,
      corner.edges.every((edge) => onEdge(x1 ?? 0, y1 ?? 0, edge) || onEdge(x2 ?? 0, y2 ?? 0, edge)) &&
        (x1 === x2) !== (y1 === y2),
      JSON.stringify(arc.args),
    );
  });
}

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

// The director produces a `yaw` on every path it drives — the direction of
// travel, the angle of a body standing about, and the turn towards a
// conversation partner — and nothing read it. `setFacing` is only called for
// employees the director does *not* know about, so after the first
// `applyLiveliness()` every body kept its seat's yaw for the whole session:
// walkers strafed sideways and two people in conversation never turned to face
// each other, which is the opposite of what the liveliness module promises.
{
  const directed = createAvatar('facing-1', 'Facing', { bodyColor: '#38bdf8', accentColor: '#075985', height: 1 });
  const targetYaw = Math.PI / 2;
  const directedPose = { x: 0, y: 0, z: 0, yaw: targetYaw, mode: 'walking' as const, speed: 1, phase: 0, bubble: null };
  for (let frame = 0; frame < 400; frame += 1) directed.update(1 / 30, frame / 30, false, directedPose);
  check(
    'a directed body faces the yaw the director produced',
    Math.abs(directed.group.rotation.y - targetYaw) < 0.01,
    directed.group.rotation.y,
  );
  // A change of direction is followed, not ignored.
  const turned = { ...directedPose, yaw: -targetYaw };
  for (let frame = 0; frame < 400; frame += 1) directed.update(1 / 30, frame / 30, false, turned);
  check(
    'and turns when the director changes it',
    Math.abs(directed.group.rotation.y + targetYaw) < 0.01,
    directed.group.rotation.y,
  );
  directed.dispose();
}

check('the pose survives being handed no motion at all', (() => {
  testAvatar.update(1 / 30, 1, false, null);
  return avatarBody?.position.y !== undefined;
})());

testAvatar.dispose();

// The same figure can come from the asset pipeline instead of the primitives in
// here, and the thing that has to hold either way is the *names*: `06_avatar.py`
// exports a `Body`, a `LegL`/`LegR`, a `SeatedLegs`, arms and a tablet, and the
// pose logic finds every one of them by name. So the contract is asserted against
// a stand-in template - no filesystem, no loader - and the pose is then driven
// exactly as it is above.
function stubAvatarTemplate(): THREE.Object3D {
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.name = 'Body';
  root.add(body);
  const surface = new THREE.MeshStandardMaterial();
  surface.name = 'A_Body';
  body.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.2), surface));
  for (const name of ['SeatedLegs', 'LegL', 'LegR', 'ArmL', 'ArmR', 'Tablet']) {
    const node = new THREE.Group();
    node.name = name;
    if (name.startsWith('Leg')) node.position.set(0, 0.5, 0);
    body.add(node);
  }
  return root;
}

const modelled = createAvatar(
  'model-1',
  'Modelled',
  { bodyColor: '#ff0000', accentColor: '#00ff00', height: 1 },
  stubAvatarTemplate(),
);
const modelledBody = modelled.group.getObjectByName('Body');
const modelledLeg = modelled.group.getObjectByName('LegR');
const modelledSeat = modelled.group.getObjectByName('SeatedLegs');
check(
  'an avatar built from the model keeps every named part the pose needs',
  modelledBody !== undefined && modelledLeg !== undefined && modelledSeat !== undefined,
);
let recoloured = false;
modelled.group.traverse((object) => {
  const mesh = object as THREE.Mesh;
  if (mesh.isMesh && mesh.material instanceof THREE.MeshStandardMaterial
    && mesh.material.color.getHexString() === 'ff0000') recoloured = true;
});
check('and takes the employee’s colour rather than the model’s', recoloured);

const modelledWalk = { x: 1, y: 0, z: 1, yaw: 0, mode: 'walking' as const, speed: 1, phase: 0, bubble: null };
for (let frame = 0; frame < 60; frame += 1) modelled.update(1 / 30, frame / 30, false, modelledWalk);
check('a modelled body rises onto its legs', (modelledBody?.position.y ?? 0) > 0.4, modelledBody?.position.y);
check(
  'and swaps its seat for legs, the same as a procedural one',
  modelledLeg?.visible === true && modelledSeat?.visible === false,
);
modelled.dispose();

// ------------------------------------------------------- glazing a grown wing
//
// Which of a module's walls face outside is decided by the layout engine, not by
// the kit, so the browser is the first place that knows — and this is planar
// geometry that a screenshot cannot check: a wing with windows on it looks the same
// whether the right walls were chosen or not. Hence the arithmetic, asserted.

const glazingSizes = new Map([
  ['pod4', { width: 8, depth: 6 }],
  ['duo2', { width: 4, depth: 6 }],
]);
const glazingSizeOf = (kind: string) => glazingSizes.get(kind) ?? null;
const farCore = { minX: 500, maxX: 520, minZ: 500, maxZ: 520 };

const lone = { id: 'a', kind: 'pod4', x: 0, z: 0, rotation: 0 };
check(
  'a module standing on its own has four outside walls',
  exteriorEdges(lone, [lone], glazingSizeOf, farCore).join(',') === 'n,e,s,w',
  exteriorEdges(lone, [lone], glazingSizeOf, farCore).join(','),
);

// Two 8 m modules meeting at x = 4. They share corners on their long walls, which
// is the case that a naive "is any sample blocked" test gets wrong.
const west = { id: 'a', kind: 'pod4', x: 0, z: 0, rotation: 0 };
const east = { id: 'b', kind: 'pod4', x: 8, z: 0, rotation: 0 };
const pair = [west, east];
check(
  'a wall shared with the next module is not an outside wall',
  !exteriorEdges(west, pair, glazingSizeOf, farCore).includes('e')
    && !exteriorEdges(east, pair, glazingSizeOf, farCore).includes('w'),
  `${exteriorEdges(west, pair, glazingSizeOf, farCore).join(',')} / ${exteriorEdges(east, pair, glazingSizeOf, farCore).join(',')}`,
);
check(
  'and the walls that merely share a corner still are',
  exteriorEdges(west, pair, glazingSizeOf, farCore).sort().join(',') === 'n,s,w',
  exteriorEdges(west, pair, glazingSizeOf, farCore).join(','),
);

// A module bolted to the core: the core is a neighbour, so the shared wall is not
// glazed and its rooms are not left open to the lobby.
const onCore = { id: 'a', kind: 'duo2', x: 13.3, z: 0, rotation: 0 };
const core = { minX: -11.3, maxX: 11.3, minZ: -8.3, maxZ: 8.3 };
check(
  'a wall against the core is not an outside wall',
  !exteriorEdges(onCore, [onCore], glazingSizeOf, core).includes('w'),
  exteriorEdges(onCore, [onCore], glazingSizeOf, core).join(','),
);

// The glazing itself. The sill is the load-bearing part: hiding a wall deletes an
// obstacle, so without something in the nav band a window becomes a way out.
const glazing = glazingFor(west, 'e', { width: 8, depth: 6 });
const sill = glazing.getObjectByName('a::Glaze_Sill') as THREE.Mesh | undefined;
const glass = glazing.getObjectByName('a::Glaze_Glass') as THREE.Mesh | undefined;
check('glazing a wall builds a sill, glass and frame', sill !== undefined && glass !== undefined);
if (sill) {
  sill.geometry.computeBoundingBox();
  const box = sill.geometry.boundingBox as THREE.Box3;
  check(
    'and the sill spans the band the walkability grid samples',
    box.min.y < 0.25 && box.max.y > 0.25,
    [box.min.y, box.max.y],
  );
  check(
    'and reaches the full length of the wall it replaced',
    Math.abs((box.max.z - box.min.z) - 6) < 1e-6,
    box.max.z - box.min.z,
  );
}
check(
  'the glazing is named so the floor can dress it by role',
  (glass?.material as THREE.Material | undefined)?.name === 'W_Glass',
  (glass?.material as THREE.Material | undefined)?.name,
);
check(
  'and the wall it replaces can be found by name',
  wallNodeName('pod4', 'e') === 'Block_pod4_Wall_E_0'
    && lintelNodeName('pod4', 'e') === 'Block_pod4_Wall_E_Lintel_0',
);

if (previousDocument === undefined) delete scope.document;
else scope.document = previousDocument;

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  throw new Error(`${failures} smoke check(s) failed`);
}
console.log('store smoke test passed');
