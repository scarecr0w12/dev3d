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