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

import { loadConfig } from '../config.ts';
import { resolveStyle } from '@dev3d/core';
import { createProviderRegistry } from '../llm/registry.ts';
import { defaultWorkspace } from '../org/defaultCompany.ts';
import { openStore } from '../store/store.ts';
import { createRuntime, migrateOffice, type Runtime } from './runtime.ts';

interface Harness {
  runtime: Runtime;
  workspace: string;
  workspacesRoot: string;
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