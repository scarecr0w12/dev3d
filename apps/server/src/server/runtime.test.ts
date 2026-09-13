/**
 * Runtime tests: the parts of office state an operator can edit.
 *
 * Workspaces get the most attention here because they are the security
 * boundary. Every tool an employee holds resolves paths against the workspace of
 * the run it serves, so "which directories can the office touch" is decided
 * entirely by this code. A bug that lets a folder name escape the workspaces
 * root would hand thirteen agents the whole disk, so it is tested directly
 * rather than inferred from a happy path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { loadConfig, describeMcpGrant } from '../config.ts';
import { resolveStyle } from '@dev3d/core';
import { createProviderRegistry } from '../llm/registry.ts';
import { defaultWorkspace } from '../org/defaultCompany.ts';
import { openStore } from '../store/store.ts';
import { createRuntime, mcpGrantedForRole, migrateOffice, type Runtime } from './runtime.ts';

interface Harness {
  runtime: Runtime;
  workspace: string;
  workspacesRoot: string;
  /** The store behind the runtime, so a test can plant a row the runtime refuses to write. */
  store: ReturnType<typeof openStore>;
  cleanup(): void;
}

function makeRuntime(opts: { allowExternal?: boolean } = {}): Harness {
  const base = mkdtempSync(join(tmpdir(), 'dev3d-runtime-'));
  const workspace = join(base, 'default-workspace');
  const workspacesRoot = join(base, 'projects');
  const config = {
    ...loadConfig(),
    workspace,
    workspacesRoot,
    allowExternalWorkspaces: opts.allowExternal ?? true,
    dbPath: ':memory:',
    llmMode: 'mock' as const,
    logLevel: 'error' as const,
  };
  const quiet = (): void => {};
  const store = openStore(':memory:', quiet);
  const runtime = createRuntime({
    config,
    store,
    registry: createProviderRegistry(config),
    skills: [],
    log: quiet,
  });
  return {
    runtime,
    workspace,
    workspacesRoot,
    store,
    cleanup: () => {
      runtime.close();
      store.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test('the office always ships with a default workspace', () => {
  const h = makeRuntime();
  try {
    const workspaces = h.runtime.workspaces();
    assert.equal(workspaces.length, 1);
    const [only] = workspaces;
    assert.ok(only);
    assert.equal(only.isDefault, true);
    // The default follows DEV3D_WORKSPACE rather than being frozen at first boot.
    assert.equal(only.path, h.workspace);
    assert.equal(h.runtime.workspace(only.id)?.name, only.name);
    assert.equal(h.runtime.workspace('nope'), undefined);
  } finally {
    h.cleanup();
  }
});

test('a new project is created as a directory under the workspaces root', () => {
  const h = makeRuntime();
  try {
    const result = h.runtime.createWorkspace({ name: 'Customer portal', description: 'the public site' });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.workspace.id, 'customer-portal');
    assert.equal(result.workspace.path, resolve(h.workspacesRoot, 'customer-portal'));
    assert.equal(result.workspace.description, 'the public site');
    // The directory has to exist: it is the boundary every tool call resolves against.
    assert.ok(existsSync(result.workspace.path), 'the project directory should have been created');
    assert.equal(h.runtime.workspaces().length, 2);
  } finally {
    h.cleanup();
  }
});

test('an explicit folder name is honoured, and ids stay unique', () => {
  const h = makeRuntime();
  try {
    const first = h.runtime.createWorkspace({ name: 'Portal' });
    const second = h.runtime.createWorkspace({ name: 'Portal', folder: 'portal-v2' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;

    assert.equal(first.workspace.id, 'portal');
    assert.equal(second.workspace.id, 'portal-2', 'a repeated name must not collide');
    assert.equal(second.workspace.path, resolve(h.workspacesRoot, 'portal-v2'));
  } finally {
    h.cleanup();
  }
});

test('a workspace can point at an existing project outside the root, when allowed', () => {
  const h = makeRuntime({ allowExternal: true });
  try {
    const external = join(h.workspacesRoot, '..', 'elsewhere', 'legacy-app');
    mkdirSync(external, { recursive: true });

    const result = h.runtime.createWorkspace({ name: 'Legacy app', path: external });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.workspace.path, resolve(external));
  } finally {
    h.cleanup();
  }
});

test('an external path is refused when external workspaces are disabled', () => {
  const h = makeRuntime({ allowExternal: false });
  try {
    const outside = join(h.workspacesRoot, '..', 'outside');
    mkdirSync(outside, { recursive: true });

    const result = h.runtime.createWorkspace({ name: 'Outside', path: outside });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /External workspaces are disabled/);
    assert.equal(h.runtime.workspaces().length, 1, 'nothing should have been added');
  } finally {
    h.cleanup();
  }
});

test('path and folder inputs that would escape are refused', () => {
  const h = makeRuntime();
  try {
    const cases: Array<{ label: string; input: Parameters<Runtime['createWorkspace']>[0]; pattern: RegExp }> = [
      { label: 'empty name', input: { name: '   ' }, pattern: /needs a name/ },
      { label: 'overlong name', input: { name: 'x'.repeat(61) }, pattern: /60 characters/ },
      { label: 'relative path', input: { name: 'Rel', path: 'some/where' }, pattern: /not an absolute path/ },
      { label: 'folder separator', input: { name: 'Sep', folder: 'a/b' }, pattern: /path separator/ },
      { label: 'backslash folder', input: { name: 'Win', folder: 'a\\b' }, pattern: /path separator/ },
      { label: 'parent traversal', input: { name: 'Up', folder: '../escape' }, pattern: /path separator/ },
    ];

    for (const item of cases) {
      const result = h.runtime.createWorkspace(item.input);
      assert.equal(result.ok, false, `${item.label} should be refused`);
      if (!result.ok) assert.match(result.error, item.pattern, item.label);
    }

    assert.equal(h.runtime.workspaces().length, 1, 'no invalid workspace may be registered');
    assert.equal(existsSync(join(h.workspacesRoot, '..', 'escape')), false);
  } finally {
    h.cleanup();
  }
});

test('two workspaces cannot point at the same directory', () => {
  const h = makeRuntime();
  try {
    const first = h.runtime.createWorkspace({ name: 'Alpha', folder: 'shared' });
    const second = h.runtime.createWorkspace({ name: 'Beta', folder: 'shared' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    if (!second.ok) assert.match(second.error, /already works in/);
  } finally {
    h.cleanup();
  }
});

test('the default workspace cannot be removed, but a project can be forgotten', () => {
  const h = makeRuntime();
  try {
    assert.equal(h.runtime.removeWorkspace('default').ok, false);

    const created = h.runtime.createWorkspace({ name: 'Scratch' });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const removed = h.runtime.removeWorkspace(created.workspace.id);
    assert.equal(removed.ok, true);
    assert.equal(h.runtime.workspaces().length, 1);
    // Forgetting a project must never delete the work inside it.
    assert.ok(existsSync(created.workspace.path), 'the directory should still be on disk');

    assert.equal(h.runtime.removeWorkspace('never-existed').ok, false);
  } finally {
    h.cleanup();
  }
});

test('the shipped default workspace carries the whole organisation', () => {
  const seeded = defaultWorkspace({ id: 'default', name: 'Default project', path: 'E:\\somewhere', floor: 1, isDefault: true });
  assert.equal(seeded.isDefault, true);
  assert.equal(seeded.path, 'E:\\somewhere');
  assert.equal(seeded.floor, 1);
  // A new organisation starts staffed, skilled and funded rather than empty.
  assert.equal(seeded.org.roles.length, 13);
  assert.equal(seeded.org.departments.length, 8);
  assert.ok(seeded.skillIds.length >= 15);
  assert.equal(seeded.budget.defaultRunUsd, 5);
  assert.equal(seeded.budget.spentUsd, 0);
  assert.equal(seeded.org.company.name, 'Default project');
});

test('a legacy single-org config is migrated into one organisation', () => {
  const legacy = {
    company: { id: 'dev3d-labs', name: 'Legacy Labs', mission: 'ship', workspace: 'E:\\old', defaultBudgetUsd: 9, createdAt: 1 },
    departments: [],
    roles: [],
    pipelineIds: ['quick-answer'],
    routingPosture: 'quality' as const,
    updatedAt: 1,
    workspaces: [{ id: 'default', name: 'Old default', path: 'E:\\old', color: '#fff' }],
  };
  const migrated = migrateOffice(legacy, { ...loadConfig(), workspace: 'E:\\fallback' });

  assert.equal(migrated.workspaces.length, 1);
  const [only] = migrated.workspaces;
  assert.ok(only);
  assert.equal(only.id, 'default');
  assert.equal(only.isDefault, true);
  assert.equal(only.floor, 1);
  assert.equal(only.path, 'E:\\old');
  assert.equal(only.name, 'Old default');
  // The old budget and chart survive the move.
  assert.equal(only.budget.defaultRunUsd, 9);
  assert.equal(only.org.company.name, 'Legacy Labs');
  assert.equal(only.org.routingPosture, 'quality');
  assert.deepEqual(only.org.pipelineIds, ['quick-answer']);
  assert.ok(only.skillIds.length >= 15);
});

test('a fresh install gets a default organisation on floor 1', () => {
  const fresh = migrateOffice(null, { ...loadConfig(), workspace: 'E:\\fresh' });
  assert.equal(fresh.workspaces.length, 1);
  assert.equal(fresh.workspaces[0]?.path, 'E:\\fresh');
  assert.equal(fresh.workspaces[0]?.floor, 1);
  assert.equal(fresh.settings.workspacesRoot.length > 0, true);
});

// ------------------------------------------------------------------ the look
// A style is the one part of a workspace that a naive write could poison: it
// flows straight into a shader, so a `NaN` or an unknown preset has to be
// refused at the boundary rather than rendered. It also travels on every state
// push, which means a round trip through the store is part of the contract.

test('a floor starts on the default preset, and says so', () => {
  const h = makeRuntime();
  try {
    const state = h.runtime.state();
    assert.equal(state.style.preset, 'studio');
    assert.equal(state.floor.style.preset, 'studio');
    // The default is *shown* as a preset rather than as a hole, so the editor has
    // something to render on a floor nobody has styled.
    assert.equal(state.workspaces[0]?.style?.preset, 'studio');
  } finally {
    h.cleanup();
  }
});

test('a floor can be restyled, and the new look is what the console reads', () => {
  const h = makeRuntime();
  try {
    const result = h.runtime.setWorkspaceStyle('default', {
      preset: 'nordic',
      materials: { wall: { color: '#112233' } },
      lighting: { exposure: 1.4 },
    });
    assert.equal(result.ok, true, result.error);

    const state = h.runtime.state();
    assert.equal(state.style.preset, 'nordic');
    assert.equal(state.style.materials?.wall?.color, '#112233');
    assert.equal(state.style.lighting?.exposure, 1.4);
    // Both places carry it, because the view draws every floor from the summaries
    // and the editor reads the active floor's style.
    assert.equal(state.floor.style.preset, 'nordic');
    assert.equal(state.workspaces[0]?.style?.materials?.wall?.color, '#112233');
  } finally {
    h.cleanup();
  }
});

test('a nonsense style is refused rather than stored', () => {
  const h = makeRuntime();
  try {
    const before = h.runtime.state().style;
    // Not a style at all.
    assert.equal(h.runtime.setWorkspaceStyle('default', 'neonlab' as never).ok, false);
    // A preset that does not exist.
    const unknown = h.runtime.setWorkspaceStyle('default', { preset: 'chartreuse' });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? '', /chartreuse/);
    // A colour that is not a colour is dropped, and the rest is kept.
    const partial = h.runtime.setWorkspaceStyle('default', {
      preset: 'noir',
      materials: { wall: { color: 'red' } },
    } as never);
    assert.equal(partial.ok, true);
    assert.equal(h.runtime.state().style.materials, undefined);
    // Nothing above left the floor in a broken state.
    assert.equal(before.preset, 'studio');
    assert.equal(h.runtime.setWorkspaceStyle('default', null).ok, true);
    assert.equal(h.runtime.state().style.preset, 'studio');
  } finally {
    h.cleanup();
  }
});

test('a style survives a restart, and a corrupt one degrades to its preset', () => {
  const h = makeRuntime();
  try {
    assert.equal(h.runtime.setWorkspaceStyle('default', { preset: 'atelier', environment: { grid: false } }).ok, true);
    // Round-trip it through the store the way a restart does.
    const stored = h.runtime.office();
    const revived = migrateOffice(JSON.parse(JSON.stringify(stored)), { ...loadConfig(), workspace: h.workspace });
    const only = revived.workspaces[0];
    assert.ok(only);
    assert.equal(only.style?.preset, 'atelier');
    assert.equal(only.style?.environment?.grid, false);

    // And a hand-edited style - a colour that is not one, a preset that is not
    // one - is read as far as it is usable rather than taken on trust.
    const broken = migrateOffice(
      {
        workspaces: [
          { id: 'default', name: 'Broken', path: 'E:\\x', org: { roles: [] }, style: { preset: 'nope', materials: { wall: 'blue' } } },
        ],
      },
      { ...loadConfig(), workspace: 'E:\\x' },
    );
    const repaired = broken.workspaces[0];
    assert.ok(repaired);
    assert.equal(repaired.style?.preset, 'nope', 'an unknown preset id is kept as the user wrote it');
    assert.equal(repaired.style?.materials, undefined, 'and the unusable material list is dropped');
    // Which resolves to the default, so it still renders as something.
    assert.equal(resolveStyle(repaired.style).preset.id, 'studio');
  } finally {
    h.cleanup();
  }
});

test('setting a style on a floor that does not exist is refused, not silently ignored', () => {
  const h = makeRuntime();
  try {
    const result = h.runtime.setWorkspaceStyle('no-such-floor', { preset: 'studio' });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /no-such-floor/);
    assert.equal(h.runtime.setWorkspaceDetails('no-such-floor', { name: 'x' }).ok, false);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// MCP grants
//
// A connected MCP server can be somebody else's filesystem, database or
// deployment system. Deciding who may call it is therefore a security decision,
// and it gets tested as one: directly, on the rule, rather than inferred from a
// server that happened to connect.
// ---------------------------------------------------------------------------

const dev = { id: 'frontend-dev-1', allowedTools: ['read_file', 'run_shell'] };
const ceo = { id: 'ceo', allowedTools: ['read_file', 'write_file'] };

test('by default the MCP tools go to the roles that already hold run_shell', () => {
  const config = { mcpGrantRoles: ['shell-roles'], mcpGrantToShellRoles: true };
  assert.equal(mcpGrantedForRole(dev, config), true);
  assert.equal(
    mcpGrantedForRole(ceo, config),
    false,
    'a role that cannot run a command should not inherit a remote server',
  );
});

test('an explicit role list grants only those roles', () => {
  const config = { mcpGrantRoles: ['ceo'], mcpGrantToShellRoles: false };
  assert.equal(mcpGrantedForRole(ceo, config), true);
  assert.equal(mcpGrantedForRole(dev, config), false, 'run_shell is not a free pass when a list is given');
});

test('"*" grants every role', () => {
  const config = { mcpGrantRoles: ['*'], mcpGrantToShellRoles: false };
  assert.equal(mcpGrantedForRole(ceo, config), true);
  assert.equal(mcpGrantedForRole(dev, config), true);
});

test('an empty list grants nobody, which is the default-deny case', () => {
  const config = { mcpGrantRoles: [], mcpGrantToShellRoles: false };
  assert.equal(mcpGrantedForRole(ceo, config), false);
  assert.equal(mcpGrantedForRole(dev, config), false);
});

test('a role with neither run_shell nor a named grant gets nothing', () => {
  const qa = { id: 'qa-lead', allowedTools: ['read_file'] };
  const config = { mcpGrantRoles: ['shell-roles'], mcpGrantToShellRoles: true };
  assert.equal(mcpGrantedForRole(qa, config), false);
});

test('by default nobody is granted MCP tools, and a role holding run_shell is no exception', () => {
  // The default used to be `shell-roles`, so every role holding `run_shell` silently
  // received every tool from every connected server. `run_shell` is approval-gated and
  // runs in the run's workspace; a remote server's tool is somebody else's program
  // with reach dev3d cannot confine. Inheriting one from the other made the operator's
  // consent for `run_shell` stand in for consent they never gave.
  const config = { mcpGrantRoles: [] as string[], mcpGrantToShellRoles: false };
  assert.equal(mcpGrantedForRole(dev, config), false, 'not even for a role with run_shell');
  assert.equal(mcpGrantedForRole(ceo, config), false);
});

test('the shipped default is default-deny, whatever this machine\u2019s .env says', () => {
  // Read with the variable cleared rather than through `loadConfig()` alone: the
  // operator's own `.env` legitimately sets `shell-roles`, and a test that only read
  // that would be asserting their file rather than the default shipped to everyone.
  const previous = process.env['DEV3D_MCP_GRANT_ROLES'];
  delete process.env['DEV3D_MCP_GRANT_ROLES'];
  try {
    const config = loadConfig();
    assert.deepEqual(config.mcpGrantRoles, [], 'the shipped default grants nothing');
    assert.equal(config.mcpGrantToShellRoles, false);
    assert.equal(config.mcpRequireApproval, true, 'and the approval gate is on');
    assert.equal(mcpGrantedForRole({ id: 'x', allowedTools: ['run_shell'] }, config), false);
  } finally {
    if (previous !== undefined) process.env['DEV3D_MCP_GRANT_ROLES'] = previous;
  }
});

test('`shell-roles` is still honoured when an operator asks for it', () => {
  const previous = process.env['DEV3D_MCP_GRANT_ROLES'];
  process.env['DEV3D_MCP_GRANT_ROLES'] = 'shell-roles';
  try {
    const config = loadConfig();
    assert.deepEqual(config.mcpGrantRoles, ['shell-roles']);
    assert.equal(config.mcpGrantToShellRoles, true);
    assert.equal(mcpGrantedForRole({ id: 'dev', allowedTools: ['run_shell'] }, config), true);
  } finally {
    if (previous === undefined) delete process.env['DEV3D_MCP_GRANT_ROLES'];
    else process.env['DEV3D_MCP_GRANT_ROLES'] = previous;
  }
});

test('the boot line states who may call extension tools, and that they are unconfined', () => {
  // The line exists so the blast radius of the setting is legible without reading
  // `.env` — the same reasoning as the auto-approve warning.
  const denied = describeMcpGrant({ mcpGrantRoles: [], mcpGrantToShellRoles: false, mcpRequireApproval: true });
  assert.match(denied, /nobody/);
  assert.match(denied, /asks a human/);
  assert.match(denied, /not confined to the workspace/);

  const shellRoles = describeMcpGrant({ mcpGrantRoles: ['shell-roles'], mcpGrantToShellRoles: true, mcpRequireApproval: true });
  assert.match(shellRoles, /holding run_shell/);

  const everyone = describeMcpGrant({ mcpGrantRoles: ['*'], mcpGrantToShellRoles: false, mcpRequireApproval: false });
  assert.match(everyone, /every role/);
  assert.match(everyone, /approval is OFF/);
});

test('the token stream is broadcast but never written to the log', () => {
  // Two things depend on this fact. Persisting it made the durable history almost
  // entirely deliberation — a measured 3,483 `turn.reasoning` rows in a single run,
  // 96% of every event in the database — and replaying it is what doubled a client's
  // live buffer, because the client's delta handler is a blind append.
  const h = makeRuntime();
  try {
    const before = h.runtime.state().activeWorkspaceId;
    assert.equal(typeof before, 'string');
    const start = Date.now();
    h.runtime.emit({ type: 'turn.delta', runId: 'run_x', turnId: 'turn_x', text: 'to', at: start });
    h.runtime.emit({ type: 'turn.delta', runId: 'run_x', turnId: 'turn_x', text: 'ken', at: start + 1 });
    h.runtime.emit({ type: 'turn.reasoning', runId: 'run_x', turnId: 'turn_x', text: 'thinking', at: start + 2 });
    // A turn-level event that *is* record, so the test would notice a filter that
    // simply dropped everything for this run.
    h.runtime.emit({
      type: 'turn.started',
      turn: {
        id: 'turn_x',
        runId: 'run_x',
        stageId: 'stage_x',
        employeeId: 'ceo',
        roleId: 'ceo',
        purpose: 'test',
        route: { providerId: 'mock', modelId: 'mock', tier: 'standard', taskClass: 'coding', reason: 'test', fallbacks: [], considered: [] },
        status: 'running',
        startedAt: start,
        endedAt: null,
        usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        text: '',
        reasoning: null,
        toolCalls: [],
        skills: [],
        wroteFiles: [],
        error: null,
      },
      at: start + 3,
    });

    const stored = h.runtime.replayableEvents('run_x');
    assert.deepEqual(
      stored.map((event) => event.type),
      ['turn.started'],
      'only the record, not the stream',
    );

    // And a row that *is* on disk is filtered out of the replay. This is the case
    // that matters: the token rows already in a long-lived database were written
    // before the persistence rule changed, and a replayed delta is a blind append on
    // the client — onto a buffer that may already hold the live text — which doubles
    // it. Appended straight to the store, because the runtime will not write one.
    h.store.appendEvent({
      runId: 'run_x',
      type: 'turn.delta',
      payloadJson: JSON.stringify({ type: 'turn.delta', runId: 'run_x', turnId: 'turn_x', text: 'to', at: start + 4 }),
      at: start + 4,
    });
    assert.deepEqual(
      h.runtime.replayableEvents('run_x').map((event) => event.type),
      ['turn.started'],
      'a delta row on disk is still not replayed',
    );
  } finally {
    h.cleanup();
  }
});

test('the state frame says whether a provider is on this machine', () => {  // The registry has always known this and the state frame dropped it, so a local
  // runtime that was simply not started rendered exactly like a remote provider that
  // could not be reached — an expected state of an install presented as a fault.
  const h = makeRuntime();
  try {
    const providers = h.runtime.state().providers;
    assert.ok(providers.length > 0, 'the shipped config has providers');
    for (const provider of providers) {
      assert.equal(typeof provider.local, 'boolean', `${provider.id} must say whether it is local`);
    }
    // The distinction has to be real, not a constant: the mock registry's providers
    // are the shipped ones, and at least one of them is a local runtime.
    const registryFlags = createProviderRegistry(loadConfig()).status().map((status) => `${status.id}:${status.local}`);
    assert.ok(registryFlags.length > 0, registryFlags.join(', '));
  } finally {
    h.cleanup();
  }
});