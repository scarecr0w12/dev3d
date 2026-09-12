/**
 * End-to-end smoke test for the dev3d live protocol.
 *
 * This connects to a *running* orchestrator as a real client, drives work
 * through the WebSocket exactly the way the office UI does, and checks that the
 * wire protocol behaves: a full office state arrives on connect, a submitted run
 * streams turn deltas and finishes, a finished run can be replayed from the
 * persisted event log, a direct message gets an answer, and the org commands
 * come back as `org.updated`.
 *
 * It uses only Node's built-in `fetch` and `WebSocket`, so it needs no
 * dependencies and no build step.
 *
 *   node scripts/smoke-ws.mjs                       # against http://127.0.0.1:8787
 *   node scripts/smoke-ws.mjs http://127.0.0.1:9999  # some other port
 *
 * Exits non-zero if any check fails, so it can gate a release.
 */

const HTTP_BASE = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const WS_URL = `${HTTP_BASE.replace(/^http/, 'ws')}/ws`;
const RUN_TIMEOUT_MS = 90_000;

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \u2714 ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u2716 ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const events = [];
    const timer = setTimeout(() => reject(new Error('WebSocket did not open within 10s')), 10_000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        ws,
        events,
        send(cmd) {
          ws.send(JSON.stringify(cmd));
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error connecting to ${url}`));
    });
    ws.addEventListener('message', (msg) => {
      try {
        events.push(JSON.parse(msg.data));
      } catch {
        events.push({ type: '<unparseable>', raw: String(msg.data).slice(0, 120) });
      }
    });
  });
}

/**
 * Wait for an event, scanning from `from` onward in the live (growing) array.
 * Passing a slice would freeze the view and miss everything that arrives later,
 * which is exactly the bug this helper exists to prevent.
 */
async function waitFor(events, predicate, label, { timeoutMs = 20_000, from = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let i = from; i < events.length; i += 1) {
      const event = events[i];
      if (event !== undefined && predicate(event)) return event;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

async function getJson(path) {
  const res = await fetch(`${HTTP_BASE}${path}`);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** Same as getJson but for the writing endpoints (POST/DELETE). */
async function httpJson(method, path, payload) {
  const res = await fetch(`${HTTP_BASE}${path}`, {
    method,
    ...(payload !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
      : {}),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** Drive a run to completion and return the events collected while it ran. */
async function runBrief(client, brief, pipelineId, label) {
  const before = client.events.length;
  client.send({ type: 'submit', brief, pipelineId });
  const created = await waitFor(client.events, (e) => e.type === 'run.created', `${label}: run.created`, {
    from: before,
  });
  const runId = created.run.id;
  const settled = await waitFor(
    client.events,
    (e) => e.type === 'run.updated' && e.run.id === runId && ['done', 'failed', 'cancelled'].includes(e.run.status),
    `${label}: terminal run.updated`,
    { timeoutMs: RUN_TIMEOUT_MS, from: before },
  );
  const events = client.events.filter((e) => eventRunId(e) === runId);
  // Some events (usage, employee.updated, log) are office-wide rather than
  // run-scoped, so checks about them need the whole window, not the run filter.
  const window = client.events.slice(before);
  return { runId, run: settled.run, events, window };
}

function eventRunId(e) {
  if (e.type === 'run.created' || e.type === 'run.updated') return e.run.id;
  if (e.type === 'turn.started' || e.type === 'turn.finished') return e.turn.runId;
  if (e.type === 'artifact.created') return e.artifact.runId;
  if (typeof e.runId === 'string') return e.runId;
  return null;
}

function summarizeRun(run, events) {
  const turns = events.filter((e) => e.type === 'turn.finished').map((e) => e.turn);
  const deltas = events.filter((e) => e.type === 'turn.delta');
  const speeches = events.filter((e) => e.type === 'speech');
  console.log(`\n  run ${run.id}  pipeline=${run.pipelineId}  status=${run.status}  spend=$${run.budget.spentUsd.toFixed(6)}`);
  console.log(`  objective : ${String(run.objective ?? '').replace(/\s+/g, ' ').slice(0, 150)}`);
  console.log(`  outcome   : ${String(run.outcome ?? '').replace(/\s+/g, ' ').slice(0, 150)}`);
  for (const stage of run.stages) {
    console.log(`    ${stage.spec.kind.padEnd(10)} ${stage.status.padEnd(9)} turns=${String(stage.turnIds.length).padEnd(3)} ${stage.spec.name}`);
  }
  for (const turn of turns) {
    const tools = turn.toolCalls.map((c) => `${c.name}:${c.status}`).join(',') || '-';
    console.log(
      `      ${turn.roleId.padEnd(15)} ${turn.route.modelId.padEnd(42)} ${turn.route.tier.padEnd(9)} tools=${tools.padEnd(18)} $${turn.usage.costUsd.toFixed(6)}`,
    );
  }
  console.log(`  events: ${events.length}  turns: ${turns.length}  deltas: ${deltas.length}  speeches: ${speeches.length}`);
  return { turns, deltas, speeches };
}

async function main() {
  console.log(`dev3d protocol smoke test -> ${HTTP_BASE}\n`);

  // ---------------------------------------------------------------- HTTP API
  console.log('HTTP read API');
  const health = await getJson('/api/health');
  check('GET /api/health is ok', health.status === 200 && health.body.ok === true, `status ${health.status}`);
  check('health reports an llmMode', ['mock', 'live'].includes(health.body.llmMode), String(health.body.llmMode));

  const state = await getJson('/api/state');
  check('GET /api/state returns an office', state.status === 200 && Array.isArray(state.body.roles));
  check(
    'office has a company and an active floor',
    Boolean(state.body.company?.name) &&
      state.body.workspaces?.some((w) => w.id === state.body.activeWorkspaceId && typeof w.path === 'string'),
  );
  check('office has employees matching roles', state.body.employees?.length === state.body.roles?.length,
    `${state.body.employees?.length} employees vs ${state.body.roles?.length} roles`);
  check('office advertises pipelines', Array.isArray(state.body.pipelines) && state.body.pipelines.length > 0);
  check('office advertises a model catalog', Array.isArray(state.body.models) && state.body.models.length > 0);
  check('office advertises providers', Array.isArray(state.body.providers) && state.body.providers.length > 0);
  check('every employee has a seat or is explicitly hot-desking',
    state.body.employees.every((e) => e.seatId === null || typeof e.seatId === 'string'));

  const skills = await getJson('/api/skills');
  check('GET /api/skills returns the skill index', skills.status === 200 && skills.body.length >= 15, `${skills.body.length} skills`);
  const models = await getJson('/api/models');
  check('GET /api/models returns the catalog', models.status === 200 && models.body.length > 0);

  // --------------------------------------------------------------- websocket
  console.log('\nWebSocket protocol');
  const client = await connect(WS_URL);
  const hello = await waitFor(client.events, (e) => e.type === 'hello', 'hello');
  check('connect delivers "hello" with the full office state', Boolean(hello.state?.company?.name));
  check('hello carries the employee roster', hello.state.employees.length === hello.state.roles.length);

  // A question: cheap pipeline, proves the basic path and streaming.
  console.log('\nRun 1 — a question through the quick-answer pipeline');
  const quick = await runBrief(
    client,
    'What does the routing posture "cheap" actually change about model selection?',
    'quick-answer',
    'quick-answer',
  );
  const quickSummary = summarizeRun(quick.run, quick.events);
  check('the run finished', quick.run.status === 'done', quick.run.error ?? '');
  check('the intake stage set the objective', typeof quick.run.objective === 'string' && quick.run.objective.length > 0);
  check('the intake stage parsed tags', Array.isArray(quick.run.tags) && quick.run.tags.length > 0, JSON.stringify(quick.run.tags));
  check('the report stage set the outcome', typeof quick.run.outcome === 'string' && quick.run.outcome.length > 0);
  check('every stage reports a terminal status', quick.run.stages.every((s) => ['done', 'failed', 'skipped'].includes(s.status)));
  check('turns were streamed as deltas', quickSummary.deltas.length > 0, `${quickSummary.deltas.length} deltas`);
  check('every turn was routed to a model', quickSummary.turns.every((t) => t.route.modelId !== ''));
  check('every routing decision explains itself', quickSummary.turns.every((t) => t.route.reason.length > 0));
  check('routing decisions were broadcast separately', quick.events.some((e) => e.type === 'routing.decision'));
  check('budget updates were broadcast', quick.events.some((e) => e.type === 'budget.updated'));
  check('usage was attributed to employees', quick.window.some((e) => e.type === 'usage'));
  check('employee status transitions were broadcast', quick.window.some((e) => e.type === 'employee.updated'));
  check(
    'employees were marked thinking/working while the run was live',
    quick.window.some((e) => e.type === 'employee.updated' && ['thinking', 'working'].includes(e.employee.status)),
  );
  check('the spend is recorded on the run', quick.run.budget.spentUsd > 0);

  // Streaming fidelity: the deltas must reconstruct the final turn text.
  const reconstructed = new Map();
  for (const e of quick.events) {
    if (e.type === 'turn.delta') reconstructed.set(e.turnId, (reconstructed.get(e.turnId) ?? '') + e.text);
  }
  const streamingOk = quickSummary.turns
    .filter((t) => t.text.trim() !== '')
    .every((t) => {
      const streamed = reconstructed.get(t.id) ?? '';
      return streamed !== '' && t.text.replace(/\s+/g, ' ').includes(streamed.replace(/\s+/g, ' ').slice(0, 200));
    });
  check('streamed deltas reconstruct each turn\'s final text', streamingOk);

  // A build: the full pipeline, exercising debate, review-loop and real files.
  console.log('\nRun 2 — a build through the product-build pipeline');
  const build = await runBrief(
    client,
    'Build an audit log viewer for the admin console: filter by actor, date range and action, with a CSV export.',
    'product-build',
    'product-build',
  );
  const buildSummary = summarizeRun(build.run, build.events);
  check('the build run finished', build.run.status === 'done', build.run.error ?? '');
  check('a debate stage ran in rounds', build.run.stages.some((s) => s.spec.kind === 'debate' && s.turnIds.length >= 4));
  check('debate speeches were broadcast', buildSummary.speeches.length >= 4, `${buildSummary.speeches.length} speeches`);
  check('a workshop stage produced a decision', build.run.stages.some((s) => s.spec.kind === 'workshop' && s.summary !== null));
  check('the review stage ran a review loop', build.run.stages.some((s) => s.spec.mode === 'review-loop' && s.turnIds.length >= 2));

  const allTurns = buildSummary.turns;
  const wrote = allTurns.filter((t) => t.wroteFiles.length > 0);
  check('an employee actually wrote files', wrote.length > 0, `${wrote.length} writing turns`);
  const okWrites = allTurns.flatMap((t) => t.toolCalls).filter((c) => c.name === 'write_file' && c.status === 'ok');
  check('write_file calls succeeded', okWrites.length > 0, `${okWrites.length} successful writes`);
  const artifacts = build.events.filter((e) => e.type === 'artifact.created').map((e) => e.artifact);
  check('artifacts were created', artifacts.length >= build.run.stages.length, `${artifacts.length} artifacts`);
  check('file artifacts carry their workspace path', artifacts.some((a) => typeof a.path === 'string' && a.path.length > 0));
  check('the org chart was never mutated by a run', build.events.every((e) => e.type !== 'org.updated'));

  // ------------------------------------------------------- replay + commands
  console.log('\nReplay and client commands');
  const replayFrom = client.events.length;
  client.send({ type: 'loadRun', runId: build.runId });
  await waitFor(
    client.events,
    (e) => e.type === 'run.updated' && e.run.id === build.runId,
    'replayed run.updated',
    { from: replayFrom },
  );
  const replay = client.events.slice(replayFrom).filter((e) => eventRunId(e) === build.runId);
  check('loadRun replays the persisted event log', replay.length >= 10, `${replay.length} replayed events`);
  check('the replay includes finished turns', replay.some((e) => e.type === 'turn.finished'));
  check('the replay includes the run stages', replay.some((e) => e.type === 'stage.finished'));

  const chatFrom = client.events.length;
  client.send({ type: 'chat', employeeId: 'cto', text: 'What would you cut first from that plan?' });
  const dm = await waitFor(client.events, (e) => e.type === 'direct.message', 'direct.message', {
    from: chatFrom,
    timeoutMs: 30_000,
  });
  check('a direct message gets a reply', dm.messages.length === 2 && dm.messages[1].text.length > 0);
  check('the reply is attributed to that employee', dm.messages[1].employeeId === 'cto');

  /*
   * A planning turn is the one command whose answer is *not* broadcast. It is a
   * draft nobody has commissioned, so it is pushed only to the socket that asked
   * - and unlike `chat` it never lands in an employee's direct-message thread.
   */
  const planFrom = client.events.length;
  client.send({
    type: 'plan',
    employeeId: 'ceo',
    text: 'Our checkout retries double-charge on timeout.',
    history: [],
    requestId: 'smoke-plan-1',
  });
  const plan = await waitFor(client.events, (e) => e.type === 'plan.reply', 'plan.reply', {
    from: planFrom,
    timeoutMs: 30_000,
  });
  check('a planning turn gets an answer', typeof plan.text === 'string' && plan.text.length > 0);
  check('the answer echoes the requestId it answers', plan.requestId === 'smoke-plan-1');
  check('the answer is addressed to the employee asked', plan.employeeId === 'ceo');
  check('the answer carries the routing decision', typeof plan.route?.modelId === 'string');
  check(
    'a plan is not a direct message',
    !client.events.slice(planFrom).some((e) => e.type === 'direct.message'),
  );

  // The history is what makes it a refinement rather than unrelated questions.
  const planFrom2 = client.events.length;
  client.send({
    type: 'plan',
    employeeId: 'ceo',
    text: 'Draft the brief now.',
    history: [
      { role: 'user', text: 'Our checkout retries double-charge on timeout.' },
      { role: 'assistant', text: 'What does done look like?' },
    ],
    requestId: 'smoke-plan-2',
  });
  const plan2 = await waitFor(client.events, (e) => e.type === 'plan.reply', 'second plan.reply', {
    from: planFrom2,
    timeoutMs: 30_000,
  });
  check('a follow-up planning turn is answered', plan2.requestId === 'smoke-plan-2');
  check(
    'the two planning turns are answered independently',
    typeof plan2.text === 'string' && plan2.text.length > 0,
  );

  // A plan for an employee who does not exist is a refused command, not a
  // silently dropped one - the error path is shared with every other command.
  const planBadFrom = client.events.length;
  try {
    client.send({ type: 'plan', employeeId: 'nobody', text: 'hello', history: [] });
    await waitFor(client.events, (e) => e.type === 'error', 'error for an unknown planner', {
      from: planBadFrom,
      timeoutMs: 10_000,
    });
    check('planning with an unknown employee is refused with an error', true);
  } catch {
    check('planning with an unknown employee is refused with an error', false, 'no error frame arrived');
  }

  const orgFrom = client.events.length;
  client.send({ type: 'setRoutingPosture', posture: 'cheap' });
  const orgEvent = await waitFor(client.events, (e) => e.type === 'org.updated', 'org.updated', { from: orgFrom });
  check('setRoutingPosture updates the org', orgEvent.org.routingPosture === 'cheap');
  client.send({ type: 'setRoutingPosture', posture: 'balanced' });

  const pingFrom = client.events.length;
  client.send({ type: 'ping' });
  await waitFor(client.events, (e) => e.type === 'office.updated', 'office.updated for ping', { from: pingFrom });
  check('ping answers with a fresh office snapshot', true);

  const beforeBad = client.events.length;
  client.send({ type: 'not-a-real-command' });
  const bad = await waitFor(client.events, (e) => e.type === 'error', 'error for unknown command', {
    from: beforeBad,
  });
  check('an unknown command is refused, not ignored', /unknown command/i.test(bad.message), bad.message);

  // ------------------------------------------------------- org chart editing
  // These use a throwaway role that is hired and then fired, so the shipped org
  // chart is left exactly as it was found.
  console.log('\nOrg chart editing');
  const TEMP_ID = 'smoke-contractor';
  const tempRole = {
    id: TEMP_ID,
    displayName: 'Smoke',
    title: 'Contract Tester',
    departmentId: 'quality',
    seniority: 'mid',
    rank: 9,
    reportsTo: 'cto',
    mission: 'Prove the org chart can be edited at runtime.',
    responsibilities: ['Exist briefly.'],
    skillIds: ['testing-strategy'],
    allowedTools: ['think', 'read_file'],
    modelPolicy: { defaultTier: 'small', minTier: 'nano', maxTier: 'standard' },
    seatId: 'Seat_Meeting_08',
    roomId: 'Anchor_Room_Meeting',
    canDelegate: false,
    maxDirectReports: 0,
    persona: { voice: 'Terse.', values: ['brevity'] },
    appearance: { bodyColor: '#94a3b8', accentColor: '#334155', height: 1 },
    maxTurnsPerStage: 1,
  };

  const hireFrom = client.events.length;
  client.send({ type: 'hire', role: tempRole });
  await waitFor(client.events, (e) => e.type === 'org.updated' && e.org.roles.some((r) => r.id === TEMP_ID), 'org.updated after hire', { from: hireFrom });
  check('hire adds a role to the org chart', true);

  const seatFrom = client.events.length;
  client.send({ type: 'setSeat', employeeId: TEMP_ID, seatId: 'Seat_Meeting_07', roomId: 'Anchor_Room_Meeting' });
  const moved = await waitFor(client.events, (e) => e.type === 'employee.moved' && e.employeeId === TEMP_ID, 'employee.moved', { from: seatFrom });
  check('setSeat moves the employee', moved.toSeatId === 'Seat_Meeting_07', String(moved.toSeatId));

  const policyFrom = client.events.length;
  client.send({
    type: 'setModelPolicy',
    roleId: TEMP_ID,
    policy: { defaultTier: 'standard', minTier: 'small', maxTier: 'strong', pin: true },
  });
  const policyEvent = await waitFor(
    client.events,
    (e) => e.type === 'org.updated' && e.org.roles.find((r) => r.id === TEMP_ID)?.modelPolicy?.pin === true,
    'org.updated after setModelPolicy',
    { from: policyFrom },
  );
  check('setModelPolicy retunes a role live', policyEvent.org.roles.find((r) => r.id === TEMP_ID).modelPolicy.defaultTier === 'standard');

  const dupFrom = client.events.length;
  client.send({ type: 'hire', role: tempRole });
  const dup = await waitFor(client.events, (e) => e.type === 'error', 'error for duplicate hire', { from: dupFrom });
  check('hiring a duplicate role id is refused', /already exists/i.test(dup.message), dup.message);

  const orphanFrom = client.events.length;
  client.send({ type: 'hire', role: { ...tempRole, id: 'smoke-orphan', reportsTo: 'does-not-exist' } });
  const orphan = await waitFor(client.events, (e) => e.type === 'error', 'error for bad reportsTo', { from: orphanFrom });
  check('hiring under a non-existent manager is refused', /does not exist/i.test(orphan.message), orphan.message);

  const fireFrom = client.events.length;
  client.send({ type: 'fire', roleId: TEMP_ID });
  const fired = await waitFor(
    client.events,
    (e) => e.type === 'employee.updated' && e.employee.id === TEMP_ID && e.employee.status === 'offline',
    'employee.updated offline after fire',
    { from: fireFrom },
  );
  check('fire removes the role and marks the employee offline', fired.employee.seatId === null);

  const fireMissingFrom = client.events.length;
  client.send({ type: 'fire', roleId: 'never-existed' });
  const fireMissing = await waitFor(client.events, (e) => e.type === 'error', 'error for unknown fire', { from: fireMissingFrom });
  check('firing an unknown role is refused', /no role/i.test(fireMissing.message), fireMissing.message);

  const orgAfter = await getJson('/api/state');
  check('the org chart is left exactly as it was found', !orgAfter.body.roles.some((r) => r.id === TEMP_ID));
  check('the shipped org chart is intact', orgAfter.body.roles.length === 13, `${orgAfter.body.roles.length} roles`);

  // -------------------------------------------------------------- projects
  // Creating a project is how an operator decides which directory thirteen
  // agents may read and write, so both the happy path and the refusals matter.
  console.log('\nProjects');
  // This suite mutates shared state, so clear anything an earlier run left
  // behind *before* taking the baseline it will compare against at the end.
  await httpJson('DELETE', '/api/workspaces/smoke-project');
  const stateBefore = await getJson('/api/state');
  check('the office exposes its projects', Array.isArray(stateBefore.body.workspaces) && stateBefore.body.workspaces.length > 0);
  check('a default project always exists', stateBefore.body.workspaces.some((w) => w.isDefault === true));
  check(
    'the office states where new floors are created',
    typeof stateBefore.body.settings?.workspacesRoot === 'string' && stateBefore.body.settings.workspacesRoot.length > 0,
  );
  check(
    'the active floor carries its own org, skills and budget',
    stateBefore.body.roles.length > 0 &&
      Array.isArray(stateBefore.body.skillIds) &&
      stateBefore.body.skillIds.length > 0 &&
      typeof stateBefore.body.budget?.defaultRunUsd === 'number',
  );
  check(
    'every floor reports its own headcount and spend',
    stateBefore.body.workspaces.every((w) => typeof w.floor === 'number' && typeof w.roleCount === 'number'),
  );

  const orgFromProject = client.events.length;
  const created = await httpJson('POST', '/api/workspaces', {
    name: 'Smoke project',
    description: 'created by the protocol smoke test',
  });
  check('POST /api/workspaces creates a project', created.status === 201 && created.body.id === 'smoke-project', `status ${created.status}`);
  check('the project reports an absolute path', typeof created.body.path === 'string' && /[\\/]/.test(created.body.path));
  check(
    'a new floor opens as a fully staffed organisation',
    created.body.floor >= 2 && created.body.org?.roles?.length === 13 && created.body.skillIds?.length >= 15,
    `floor ${created.body.floor}, ${created.body.org?.roles?.length} roles, ${created.body.skillIds?.length} skills`,
  );

  // ------------------------------------------- independence between floors
  const trimmed = await httpJson('PUT', `/api/workspaces/${created.body.id}`, { skillIds: ['api-design'] });
  check('a floor can have its own skills', trimmed.status === 200 && trimmed.body.skillCount === 1, `status ${trimmed.status}`);

  const afterTrim = await getJson('/api/state');
  check(
    'trimming one floor leaves the floor being viewed untouched',
    afterTrim.body.skillIds.length >= 15,
    `${afterTrim.body.skillIds.length} skills on the active floor`,
  );

  const budgeted = await httpJson('PUT', `/api/workspaces/${created.body.id}`, { budget: { defaultRunUsd: 42, totalUsd: 250 } });
  check('a floor can have its own budget', budgeted.status === 200 && budgeted.body.budgetTotalUsd === 250, `status ${budgeted.status}`);
  check(
    'the other floor keeps its own budget',
    afterTrim.body.budget.defaultRunUsd !== 42,
    `${afterTrim.body.budget.defaultRunUsd}`,
  );

  // ------------------------------------------------- switching floors
  // This is what the 3D view follows: selecting a floor replaces the whole
  // console context - people, skills, money, runs - in a single event.
  const firstFloor = stateBefore.body.workspaces.find((w) => w.isDefault === true);
  const switchFrom = client.events.length;
  client.send({ type: 'selectWorkspace', workspaceId: created.body.id });
  const switched = await waitFor(
    client.events,
    (e) => e.type === 'office.updated' && e.state.activeWorkspaceId === created.body.id,
    'office.updated after selectWorkspace',
    { from: switchFrom },
  );
  check('selecting a floor swaps the console context', switched.state.activeWorkspaceId === created.body.id);
  check(
    'the new floor brings its own employees',
    switched.state.employees.length === switched.state.roles.length && switched.state.employees.length > 0,
    `${switched.state.employees.length} employees / ${switched.state.roles.length} roles`,
  );
  check('the new floor brings its own skills', switched.state.skillIds.length === 1, `${switched.state.skillIds.length} skills`);
  check('the new floor brings its own budget', switched.state.budget.defaultRunUsd === 42, `$${switched.state.budget.defaultRunUsd}`);
  check('the runs list follows the floor', switched.state.runs.every((run) => run.workspaceId === created.body.id));

  const backFrom = client.events.length;
  client.send({ type: 'selectWorkspace', workspaceId: firstFloor?.id ?? 'default' });
  const back = await waitFor(
    client.events,
    (e) => e.type === 'office.updated' && e.state.activeWorkspaceId === (firstFloor?.id ?? 'default'),
    'office.updated after switching back',
    { from: backFrom },
  );
  check('switching back restores the first floor', back.state.skillIds.length >= 15, `${back.state.skillIds.length} skills`);

  // ------------------------------------------------- installation settings
  const settings = await getJson('/api/settings');
  check('the office exposes installation settings', settings.status === 200 && typeof settings.body.workspacesRoot === 'string');
  const changed = await httpJson('PUT', '/api/settings', { maxConcurrency: 3 });
  check('installation settings can be changed', changed.status === 200 && changed.body.maxConcurrency === 3, `status ${changed.status}`);
  const refused = await httpJson('PUT', '/api/settings', { maxConcurrency: 99 });
  check('an out-of-range setting is refused with a reason', refused.status === 400 && /between 1 and 16/.test(String(refused.body.error)), String(refused.body.error));
  await httpJson('PUT', '/api/settings', { maxConcurrency: 4 });

  const malformed = await fetch(`${HTTP_BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: 'this is not json',
  });
  check('a malformed body is a client error, not a server fault', malformed.status === 400, `status ${malformed.status}`);
  await waitFor(
    client.events,
    (e) => e.type === 'org.updated' && e.workspaceId === 'smoke-project',
    'org.updated carrying the new floor',
    { from: orgFromProject },
  );
  check('opening a floor is broadcast to every client', true);

  const escaping = await httpJson('POST', '/api/workspaces', { name: 'Escape', folder: '../nope' });
  check('a folder that escapes the root is refused', escaping.status === 400, `status ${escaping.status}`);
  check('the refusal explains itself', /path separator/i.test(String(escaping.body.error)), String(escaping.body.error));

  const relative = await httpJson('POST', '/api/workspaces', { name: 'Relative', path: 'not/absolute' });
  check('a relative path is refused', relative.status === 400 && /absolute/i.test(String(relative.body.error)));

  const duplicate = await httpJson('POST', '/api/workspaces', { name: 'Dup', folder: 'smoke-project' });
  check('two projects cannot share a directory', duplicate.status === 400 && /already works in/i.test(String(duplicate.body.error)), String(duplicate.body.error));

  // A run submitted into the project must be scoped to it, and say so.
  const projectRun = await runBrief(
    client,
    'Explain how a run is confined to its workspace.',
    'quick-answer',
    'project run',
  );
  check('a run records the project it was submitted to', projectRun.run.workspaceId !== undefined);
  check(
    'the run carries the resolved project path',
    typeof projectRun.run.workspacePath === 'string' && projectRun.run.workspacePath.length > 0,
  );

  const defaultProject = stateBefore.body.workspaces.find((w) => w.isDefault === true);
  const scoped = await httpJson('POST', '/api/submit', {
    brief: 'Explain how a run is confined to its workspace.',
    pipelineId: 'quick-answer',
    workspaceId: created.body.id,
  });
  check('a brief can be submitted into a named project', scoped.status === 202 && scoped.body.workspaceId === 'smoke-project');
  check(
    'the run is scoped to that project, not the default',
    scoped.body.workspacePath === created.body.path &&
      scoped.body.workspacePath !== defaultProject?.path,
    `${scoped.body.workspacePath}`,
  );

  // Let that run settle before the post-run invariants are checked, or it looks
  // like the office was left mid-task.
  const scopedDeadline = Date.now() + 60_000;
  let scopedStatus = scoped.body.status;
  while (!['done', 'failed', 'cancelled'].includes(scopedStatus) && Date.now() < scopedDeadline) {
    await sleep(300);
    const polled = await getJson(`/api/runs/${scoped.body.id}`);
    scopedStatus = polled.body.status;
  }
  check('a run in a named project runs to completion', scopedStatus === 'done', scopedStatus);

  const unknownProject = await httpJson('POST', '/api/submit', { brief: 'x', workspaceId: 'no-such-project' });
  check('submitting into an unknown project fails loudly', unknownProject.status >= 400 || typeof unknownProject.body.error === 'string');

  const removedProject = await httpJson('DELETE', '/api/workspaces/smoke-project');
  check('a project can be forgotten', removedProject.status === 200, `status ${removedProject.status}`);
  const removedDefault = await httpJson('DELETE', '/api/workspaces/default');
  check('the default project cannot be removed', removedDefault.status === 400);
  const stateFinal = await getJson('/api/state');
  check('the project list is back to where it started', stateFinal.body.workspaces.length === stateBefore.body.workspaces.length);

  // ---------------------------------------------- plugin-contributed surfaces
  // A plugin can add a whole provider, a role template, a pipeline and a panel.
  // Each one has to reach the surface it claims, not just a list in the panel.
  console.log('\nPlugin contributions');
  const contributed = await getJson('/api/plugins');
  const localCoder = contributed.body.records.find((r) => r.manifest.id === 'dev3d.local-coder');
  check('a plugin can contribute a whole provider', localCoder?.contributions.providers === 1, JSON.stringify(localCoder?.contributions));

  const withProvider = await getJson('/api/state');
  const pluginProvider = withProvider.body.providers.find((p) => p.id === 'lmstudio');
  check('a contributed provider joins the provider list', pluginProvider !== undefined, withProvider.body.providers.map((p) => p.id).join(', '));
  check('and the office says which plugin registered it', pluginProvider?.pluginId === 'dev3d.local-coder', String(pluginProvider?.pluginId));
  check('a keyless provider counts as configured', pluginProvider?.configured === true);
  check(
    'a contributed provider model reaches the catalog',
    withProvider.body.models.some((m) => m.providerId === 'lmstudio'),
  );
  check(
    'the provider model count matches the catalog it is serving',
    pluginProvider?.modelCount === withProvider.body.models.filter((m) => m.providerId === 'lmstudio').length,
    `${pluginProvider?.modelCount}`,
  );

  // A built-in provider must stay the installation's, whatever a manifest says.
  check(
    'a plugin cannot shadow a built-in provider',
    withProvider.body.providers.filter((p) => p.id === 'deepseek').length === 1 &&
      withProvider.body.providers.find((p) => p.id === 'deepseek')?.pluginId === null,
  );

  const tools = await getJson('/api/tools');
  check('the office lists every tool an employee could be granted', Array.isArray(tools.body) && tools.body.length >= 10, `${tools.body.length}`);
  const pluginTool = tools.body.find((t) => t.name === 'dev3d_office_echo_echo');
  check('a plugin tool is listed', pluginTool !== undefined);
  check('and is attributed to its plugin', pluginTool?.pluginId === 'dev3d.office-echo', String(pluginTool?.pluginId));

  const templates = await getJson('/api/plugins/role-templates');
  check('a plugin can offer a role template', templates.body.some((t) => t.role.id === 'cost-auditor'), JSON.stringify(templates.body.map((t) => t.role.id)));
  check('the template is attributed to its plugin', templates.body[0]?.pluginId === 'dev3d.cost-guard');
  const pluginPipelines = await getJson('/api/plugins/pipelines');
  check('a plugin can contribute a pipeline', pluginPipelines.body.some((p) => p.pipeline.id === 'spend-review'));
  check(
    'a plugin pipeline is offered on the floor',
    withProvider.body.pipelines.some((p) => p.id === 'spend-review'),
    withProvider.body.pipelines.map((p) => p.id).join(', '),
  );

  // A plugin pipeline usually names a role from the plugin's own templates, and
  // nobody has hired it yet. Starting the run and reporting "the stage produced no
  // turns" would be true and useless, so the office refuses up front and says
  // which role is missing.
  const unstaffed = await httpJson('POST', '/api/submit', {
    brief: 'Review what this office has spent.',
    pipelineId: 'spend-review',
  });
  check('a pipeline this floor cannot staff is refused, not started', unstaffed.status === 400, `status ${unstaffed.status}`);
  check(
    'and the refusal names the role that is missing',
    /cost-auditor/.test(String(unstaffed.body.error)),
    String(unstaffed.body.error),
  );
  check(
    'and points at where the role comes from',
    /role template/i.test(String(unstaffed.body.error)),
    String(unstaffed.body.error),
  );

  // A grant is filtered against what exists, so an unknown name cannot be granted.
  const grantedRole = withProvider.body.roles.find((r) => r.allowedTools.includes('read_file'));
  const grantFrom = client.events.length;
  client.send({
    type: 'setRoleGrants',
    roleId: grantedRole.id,
    allowedTools: ['think', 'read_file', 'dev3d_office_echo_echo', 'not_a_real_tool'],
  });
  const regranted = await waitFor(
    client.events,
    (e) => e.type === 'org.updated' && e.workspaceId === withProvider.body.activeWorkspaceId,
    'org.updated after setRoleGrants',
    { from: grantFrom },
  );
  const granted = regranted.org.roles.find((r) => r.id === grantedRole.id);
  check('a plugin tool can be granted to an employee', granted?.allowedTools.includes('dev3d_office_echo_echo') === true, JSON.stringify(granted?.allowedTools));
  check('an unknown tool is filtered out of a grant, not stored', granted?.allowedTools.includes('not_a_real_tool') === false);
  client.send({ type: 'setRoleGrants', roleId: grantedRole.id, allowedTools: grantedRole.allowedTools });
  await sleep(250);

  // A panel is data: the server resolves it, and the browser never sees the
  // plugin's own endpoint.
  const panel = await getJson('/api/plugins/dev3d.local-coder/panels/local-model-status');
  check('a declared panel resolves to widgets', panel.status === 200 && panel.body.widgets.length === 2, `status ${panel.status}`);
  check('a manifest-bodied panel is not marked live', panel.body.live === false);
  check('the panel carries renderable widget kinds', panel.body.widgets.every((w) => typeof w.kind === 'string'));
  const missingPanel = await getJson('/api/plugins/dev3d.local-coder/panels/nope');
  check('an unknown panel is a 404', missingPanel.status === 404, `status ${missingPanel.status}`);

  // Disabling withdraws the provider and its models everywhere.
  const withdrawFrom = client.events.length;
  await httpJson('POST', '/api/plugins/dev3d.local-coder/enable', { enabled: false });
  await waitFor(client.events, (e) => e.type === 'plugins.updated', 'plugins.updated after disabling the provider plugin', { from: withdrawFrom });
  const afterProviderGone = await getJson('/api/state');
  check('disabling a plugin withdraws its provider', afterProviderGone.body.providers.every((p) => p.id !== 'lmstudio'));
  check('and its models leave the catalog', afterProviderGone.body.models.every((m) => m.providerId !== 'lmstudio'));
  await httpJson('POST', '/api/plugins/dev3d.local-coder/enable', { enabled: true });
  const providerBack = await getJson('/api/state');
  check('re-enabling brings the provider back', providerBack.body.providers.some((p) => p.id === 'lmstudio'));

  // ------------------------------------------------------- generated office space
  // A floor grows itself when its roster outgrows its desks. The numbers come
  // from the asset - the core's seats are counted out of office.glb, never
  // written down - so this checks the whole chain: kit -> capacity -> growth.
  console.log('\nGenerated office space');

  /**
   * A floor keeps the rooms it built, so a previous run leaves them behind. Strip
   * them back to the core first: this suite has to be re-runnable against the
   * same database, and the only way to take a room out is the operator's own
   * control - which means the reset also exercises it.
   */
  async function normaliseFloor(limit = 16) {
    for (let i = 0; i < limit; i += 1) {
      const before = (await getJson('/api/state')).body.floor.layout.blocks.length;
      if (before === 0) return true;
      const from = client.events.length;
      client.send({ type: 'removeRoom' });
      await waitFor(
        client.events,
        (e) =>
          (e.type === 'org.updated' && e.workspaceId !== undefined) ||
          (e.type === 'error' && /no room can be spared|core office only/.test(String(e.message))),
        'a removeRoom answer',
        { from, timeoutMs: 10_000 },
      );
      await sleep(150);
      const after = (await getJson('/api/state')).body.floor.layout.blocks.length;
      if (after >= before) return false;
    }
    return false;
  }

  check('the floor can be stripped back to the core room', await normaliseFloor());

  const floorStart = await getJson('/api/state');
  const floor0 = floorStart.body.floor;
  check('the office reports the floor it is looking at', floor0 !== undefined && typeof floor0.describe === 'string', String(floor0?.describe));
  check('core capacity is counted from the asset, not guessed', floor0.coreSeats === 21, `${floor0.coreSeats} core seats`);
  // The kit is asserted by what it can do rather than by a count, so adding a
  // module does not fail the suite but losing the ability to seat anyone does.
  const roomKinds = floor0.modules.filter((module) => module.fitting !== true);
  check(
    'the kit offers rooms to build with',
    roomKinds.filter((module) => module.seats.length > 0).length >= 4 && roomKinds.length >= 5,
    roomKinds.map((module) => module.id).join(', '),
  );
  check(
    'the kit has circulation as well as rooms',
    roomKinds.some((module) => module.kind === 'junction') && roomKinds.some((module) => module.kind === 'corridor'),
    roomKinds.map((module) => module.kind).join(', '),
  );
  check(
    'a fitting is offered but never counted as a room',
    floor0.modules.some((module) => module.fitting === true) &&
      roomKinds.every((module) => module.fitting !== true && module.doors.length > 0),
  );
  check('a floor with room to spare has grown nothing', floor0.layout.blocks.length === 0, `${floor0.layout.blocks.length} blocks`);
  check('capacity matches the roster it already has', floor0.capacity >= floorStart.body.roles.length, `${floor0.capacity} seats / ${floorStart.body.roles.length} roles`);
  check('the core seat ids still come through unchanged', floor0.seatIds.includes('Seat_Dev_01'));

  // Build one room by hand: an operator may want a lounge nobody is hired into.
  const addFrom = client.events.length;
  client.send({ type: 'addRoom' });
  const added = await waitFor(
    client.events,
    (e) => e.type === 'org.updated' && e.workspaceId === floorStart.body.activeWorkspaceId,
    'org.updated after addRoom',
    { from: addFrom },
  );
  check('a room can be built by hand', added.org !== undefined);
  const afterAdd = await getJson('/api/state');
  check('the floor now has one room', afterAdd.body.floor.layout.blocks.length === 1, `${afterAdd.body.floor.layout.blocks.length} blocks`);
  check('and its capacity grew by that room', afterAdd.body.floor.capacity > floor0.capacity, `${afterAdd.body.floor.capacity}`);
  check(
    'a generated seat id is namespaced by its module',
    afterAdd.body.floor.seatIds.some((seat) => /^B\d+::Seat_/.test(seat)),
    afterAdd.body.floor.seatIds.filter((s) => s.includes('::')).join(', ') || 'none',
  );
  check(
    'the summary carries the layout, so every floor can be drawn',
    afterAdd.body.workspaces.every((w) => w.layout !== undefined && typeof w.capacity === 'number'),
  );
  check('the floor says what it is made of', /core \+ 1 room/.test(afterAdd.body.floor.describe), afterAdd.body.floor.describe);

  // Removal is refused when the roster needs the space, and allowed when it does not.
  const removeEarly = await httpJson('POST', '/api/submit', { brief: 'noop', pipelineId: 'quick-answer' });
  check('the office is still usable with a generated room', removeEarly.status === 202, `status ${removeEarly.status}`);
  const removedFrom = client.events.length;
  client.send({ type: 'removeRoom' });
  await waitFor(
    client.events,
    (e) => e.type === 'org.updated' && e.workspaceId === floorStart.body.activeWorkspaceId,
    'org.updated after removeRoom',
    { from: removedFrom },
  );
  const afterRemove = await getJson('/api/state');
  check('a spare room can be taken back out', afterRemove.body.floor.layout.blocks.length === 0, `${afterRemove.body.floor.layout.blocks.length} blocks`);
  check('and capacity returns to the core', afterRemove.body.floor.capacity === floor0.coreSeats);

  // Now make the roster outgrow the core: the floor has to build for itself.
  const growthFrom = client.events.length;
  const extra = [];
  for (let i = 0; i < floor0.coreSeats - floorStart.body.roles.length + 3; i += 1) {
    const id = `smoke-growth-${i}`;
    extra.push(id);
    client.send({
      type: 'hire',
      role: {
        ...tempRole,
        id,
        displayName: `Growth ${i}`,
        rank: 9,
        seatId: null,
        roomId: null,
        skillIds: [floorStart.body.skillIds[0]],
        allowedTools: ['think'],
      },
    });
  }
  await waitFor(
    client.events,
    (e) => e.type === 'org.updated' && e.workspaceId === floorStart.body.activeWorkspaceId,
    'org.updated after the growth hires',
    { from: growthFrom, timeoutMs: 30_000 },
  );
  const grown = await getJson('/api/state');
  check('the roster outgrew the core office', grown.body.roles.length > floor0.coreSeats, `${grown.body.roles.length} roles / ${floor0.coreSeats} seats`);
  check('the floor built rooms to seat them', grown.body.floor.layout.blocks.length > 0, `${grown.body.floor.layout.blocks.length} blocks`);
  check(
    'and can now seat everyone',
    grown.body.floor.capacity >= grown.body.roles.length,
    `${grown.body.floor.capacity} seats / ${grown.body.roles.length} roles`,
  );
  check(
    'no two generated rooms were given the same instance id',
    new Set(grown.body.floor.layout.blocks.map((b) => b.id)).size === grown.body.floor.layout.blocks.length,
  );
  check(
    'every generated seat id is unique',
    new Set(grown.body.floor.seatIds).size === grown.body.floor.seatIds.length,
  );

  // The loop has to close: a floor that built desks and left them empty would be
  // building for nobody. A hire with no seat takes the first free one.
  const seated = grown.body.roles.filter((role) => extra.includes(role.id));
  check(
    'the new hires were seated at the desks the floor built',
    seated.length > 0 && seated.every((role) => typeof role.seatId === 'string' && role.seatId.length > 0),
    seated.map((role) => `${role.id}=${role.seatId ?? 'none'}`).join(', '),
  );
  check(
    'at least one of them is in a generated room, not the core',
    seated.some((role) => String(role.seatId).includes('::')),
    seated.map((role) => String(role.seatId)).join(', '),
  );
  check(
    'and that employee names the room they are in',
    seated.some((role) => typeof role.roomId === 'string' && String(role.roomId).includes('::')),
    seated.map((role) => String(role.roomId ?? 'null')).join(', '),
  );
  check(
    'nobody was seated in a seat that does not exist',
    grown.body.roles.every((role) => role.seatId === null || grown.body.floor.seatIds.includes(role.seatId)),
  );

  // Clean up the temporary hires, then put the floor back the way it was found.
  // A floor does not shrink itself when someone leaves - that is the operator's
  // call - so the normaliser is what makes the next run start from the core.
  for (const id of extra) client.send({ type: 'fire', roleId: id });
  await sleep(400);
  check('the floor can be left as it was found', await normaliseFloor());
  const floorEnd = await getJson('/api/state');
  check('the floor is back to the core room only', floorEnd.body.floor.layout.blocks.length === 0, `${floorEnd.body.floor.layout.blocks.length} blocks`);
  check('and capacity is back to what the asset carries', floorEnd.body.floor.capacity === floor0.coreSeats, `${floorEnd.body.floor.capacity}`);

  // ------------------------------------------------------------------ headers
  console.log('\nPlugin system');
  const plugins = await getJson('/api/plugins');
  check('the office reports its plugin system', plugins.status === 200 && typeof plugins.body.apiVersion === 'string');
  check('the host advertises the API version it implements', plugins.body.apiVersion === '1', plugins.body.apiVersion);
  check('it says where plugins are loaded from', typeof plugins.body.pluginsRoot === 'string' && plugins.body.pluginsRoot.length > 0);
  check('installing from a marketplace is off unless opted in', plugins.body.allowInstall === false);

  const records = Array.isArray(plugins.body.records) ? plugins.body.records : [];
  const costGuard = records.find((r) => r.manifest.id === 'dev3d.cost-guard');
  const officeEcho = records.find((r) => r.manifest.id === 'dev3d.office-echo');
  check('a shipped declarative plugin is discovered', costGuard !== undefined, records.map((r) => r.manifest.id).join(', '));
  check('a shipped code plugin is discovered', officeEcho !== undefined);
  check('the declarative plugin loaded', costGuard?.status === 'loaded' && costGuard.error === null, String(costGuard?.error));
  check('the code plugin loaded and is flagged as running code', officeEcho?.status === 'loaded' && officeEcho.hasCode === true);
  check(
    'a plugin reports what it contributes',
    costGuard?.contributions.models === 1 && costGuard?.contributions.skills === 1 && costGuard?.contributions.routingRules === 2,
    JSON.stringify(costGuard?.contributions),
  );
  check('plugin settings are seeded from the manifest defaults', costGuard?.settings.aggressiveness === 'balanced', JSON.stringify(costGuard?.settings));
  check('an unknown plugin id is a 404', (await getJson('/api/plugins/dev3d.nope')).status === 404);

  // A plugin model has to reach the office's real model catalog, not just a list
  // in the plugin panel - otherwise routing cannot ever pick it.
  const withPlugin = await getJson('/api/state');
  const pluginModel = withPlugin.body.models.find((m) => m.id === 'local/qwen2.5-coder-7b-instruct');
  check('a plugin model reaches the office model catalog', pluginModel !== undefined, `${withPlugin.body.models.length} models`);

  // A plugin skill has to be enableable on a floor, which is the only route by
  // which an employee can be offered it.
  const skillFrom = client.events.length;
  const enableSkill = await httpJson('PUT', `/api/workspaces/${firstFloor?.id ?? 'default'}`, {
    skillIds: [...withPlugin.body.skillIds, 'cost-aware-delegation'],
  });
  check('a plugin skill can be enabled on a floor', enableSkill.status === 200, `status ${enableSkill.status} ${String(enableSkill.body.error ?? '')}`);
  const withSkill = await getJson('/api/state');
  check('the enabled plugin skill is listed for the floor', withSkill.body.skillIds.includes('cost-aware-delegation'));
  await httpJson('PUT', `/api/workspaces/${firstFloor?.id ?? 'default'}`, { skillIds: withPlugin.body.skillIds });

  // Disabling must withdraw everything the plugin contributed, everywhere.
  const disableFrom = client.events.length;
  const disabled = await httpJson('POST', '/api/plugins/dev3d.cost-guard/enable', { enabled: false });
  check('a plugin can be disabled', disabled.status === 200 && disabled.body.status === 'disabled', `status ${disabled.status}`);
  const disabledEvent = await waitFor(
    client.events,
    (e) => e.type === 'plugins.updated',
    'plugins.updated after disabling a plugin',
    { from: disableFrom },
  );
  check('disabling a plugin is broadcast to every client', disabledEvent.state.records.length > 0);

  const withdrawn = await getJson('/api/state');
  check(
    'a disabled plugin model leaves the catalog',
    withdrawn.body.models.every((m) => m.id !== 'local/qwen2.5-coder-7b-instruct'),
    `${withdrawn.body.models.length} models`,
  );
  // Asking for the withdrawn skill by name is accepted but silently dropped,
  // because the catalog it is validated against no longer contains it.
  await httpJson('PUT', `/api/workspaces/${firstFloor?.id ?? 'default'}`, {
    skillIds: [...withdrawn.body.skillIds, 'cost-aware-delegation'],
  });
  const afterWithdrawal = await getJson('/api/state');
  check(
    'its withdrawn skill is filtered back out of the floor',
    !afterWithdrawal.body.skillIds.includes('cost-aware-delegation'),
    afterWithdrawal.body.skillIds.join(', '),
  );

  const reEnabled = await httpJson('POST', '/api/plugins/dev3d.cost-guard/enable', { enabled: true });
  check('a plugin can be enabled again', reEnabled.status === 200 && reEnabled.body.status === 'loaded', `status ${reEnabled.status}`);
  const backInCatalog = await getJson('/api/state');
  check(
    're-enabling restores its model to the catalog',
    backInCatalog.body.models.some((m) => m.id === 'local/qwen2.5-coder-7b-instruct'),
  );

  // Settings round-trip, and a value the manifest does not declare is refused
  // rather than stored.
  const configured = await httpJson('PUT', '/api/plugins/dev3d.cost-guard/settings', { settings: { aggressiveness: 'aggressive' } });
  check('a plugin setting can be saved', configured.status === 200 && configured.body.settings.aggressiveness === 'aggressive', `status ${configured.status} ${String(configured.body.error ?? '')}`);
  const badSetting = await httpJson('PUT', '/api/plugins/dev3d.cost-guard/settings', { settings: { aggressiveness: 'insane' } });
  check('a plugin setting outside its options is refused', badSetting.status === 400, `status ${badSetting.status}`);
  const unknownSetting = await httpJson('PUT', '/api/plugins/dev3d.cost-guard/settings', { settings: { notASetting: 1 } });
  check('an undeclared plugin setting is refused', unknownSetting.status === 400, `status ${unknownSetting.status}`);
  const noSettingsObject = await httpJson('PUT', '/api/plugins/dev3d.cost-guard/settings', { aggressiveness: 'aggressive' });
  check('a settings patch without the wrapper object is a client error', noSettingsObject.status === 400, `status ${noSettingsObject.status}`);
  const stillAggressive = await getJson('/api/plugins');
  check(
    'a refused setting did not half-apply',
    stillAggressive.body.records.find((r) => r.manifest.id === 'dev3d.cost-guard')?.settings.aggressiveness === 'aggressive',
  );
  await httpJson('PUT', '/api/plugins/dev3d.cost-guard/settings', { settings: { aggressiveness: 'balanced' } });

  const refreshed = await httpJson('POST', '/api/plugins/refresh');
  check('the plugin directory can be rescanned', refreshed.status === 200 && refreshed.body.records.length === records.length, `status ${refreshed.status}`);
  const afterRefresh = await getJson('/api/state');
  check(
    'a rescan does not lose an enabled plugin',
    afterRefresh.body.models.some((m) => m.id === 'local/qwen2.5-coder-7b-instruct'),
  );

  // ------------------------------------------------------------- marketplaces
  const sources = await getJson('/api/plugins/sources');
  check('the marketplace source list is exposed', sources.status === 200 && Array.isArray(sources.body));
  const badSource = await httpJson('POST', '/api/plugins/sources', { url: 'ftp://example.test/catalog.json' });
  check('a non-http marketplace is refused', badSource.status === 400 && /http/i.test(String(badSource.body.error)), String(badSource.body.error));
  const addedSource = await httpJson('POST', '/api/plugins/sources', { label: 'Smoke market', url: 'http://127.0.0.1:1/catalog.json' });
  check('a marketplace can be registered', addedSource.status === 201 && addedSource.body.label === 'Smoke market', `status ${addedSource.status}`);
  const badCatalog = await getJson('/api/plugins/catalog?url=not-a-url');
  check('browsing a non-http catalog is refused', badCatalog.status === 400, `status ${badCatalog.status}`);
  const unreachable = await getJson('/api/plugins/catalog?url=http%3A%2F%2F127.0.0.1%3A1%2Fcatalog.json');
  check('an unreachable marketplace reports why', unreachable.status === 400 && /could not reach/i.test(String(unreachable.body.error)), String(unreachable.body.error));
  const removedSource = await httpJson('DELETE', `/api/plugins/sources/${addedSource.body.id}`);
  check('a marketplace can be forgotten', removedSource.status === 200, `status ${removedSource.status}`);
  const sourcesFinal = await getJson('/api/plugins/sources');
  check('the source list is back to where it started', sourcesFinal.body.length === sources.body.length);

  // The install gate is the most important refusal here: it is what stops a
  // marketplace URL from running code in this process.
  const installRefused = await httpJson('POST', '/api/plugins/install', {
    catalogUrl: 'https://example.test/catalog.json',
    pluginId: 'dev3d.remote-demo',
  });
  check('installing is refused while the operator has not opted in', installRefused.status === 400, `status ${installRefused.status}`);
  check('the refusal names the setting that would allow it', /DEV3D_ALLOW_PLUGIN_INSTALL/.test(String(installRefused.body.error)), String(installRefused.body.error));
  const installNoBody = await fetch(`${HTTP_BASE}/api/plugins/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ catalogUrl: 'https://example.test/catalog.json' }),
  });
  check('installing without a plugin id is a client error', installNoBody.status === 400, `status ${installNoBody.status}`);

  const finalPlugins = await getJson('/api/plugins');
  check(
    'the office is left with every shipped plugin enabled',
    finalPlugins.body.records.every((r) => r.enabled === true || r.status === 'error'),
    finalPlugins.body.records.map((r) => `${r.manifest.id}=${r.status}`).join(', '),
  );

  // ------------------------------------------------------------------ HTTP run
  console.log('\nHTTP run inspection');
  const one = await getJson(`/api/runs/${build.runId}`);
  check('GET /api/runs/:id returns the run', one.status === 200 && one.body.id === build.runId);
  check('it includes the persisted turns', Array.isArray(one.body.turns) && one.body.turns.length > 0, `${one.body.turns?.length} turns`);
  check('it includes the persisted artifacts', Array.isArray(one.body.artifacts) && one.body.artifacts.length > 0);
  const missing = await getJson('/api/runs/nope');
  check('an unknown run id is a 404', missing.status === 404, `status ${missing.status}`);

  // --------------------------------------------------------------- invariants
  console.log('\nPost-run invariants');
  const after = await getJson('/api/state');
  const stuck = after.body.employees.filter((e) => ['thinking', 'working', 'blocked', 'talking'].includes(e.status));
  check(
    'no employee is left mid-task once every run has settled',
    stuck.length === 0,
    stuck.map((e) => `${e.id}=${e.status}`).join(', '),
  );
  check(
    'every employee got a seat in the 3D office',
    after.body.employees.every((e) => typeof e.seatId === 'string' && e.seatId.length > 0),
  );
  check('no approvals are left pending', after.body.runs.every((r) => r.status !== 'awaiting-approval'));
  const spend = after.body.employees.reduce((sum, e) => sum + e.lifetime.costUsd, 0);
  check('lifetime spend was recorded per employee', spend > 0, `$${spend.toFixed(6)} across the roster`);
  const turns = after.body.employees.reduce((sum, e) => sum + e.lifetime.turns, 0);
  check('lifetime turn counts were recorded', turns >= 36, `${turns} turns across the roster`);

  client.close();

  // ------------------------------------------------------------------ summary
  console.log(`\n${'='.repeat(70)}`);
  if (failures.length === 0) {
    console.log(`PASS — ${passed} checks, 0 failures`);
  } else {
    console.log(`FAIL — ${passed} passed, ${failures.length} failed:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nsmoke test crashed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
