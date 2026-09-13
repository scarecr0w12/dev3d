import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPathInside, resolveInWorkspace, toWorkspaceRelative } from './paths.ts';
import { createFsTools } from './fs.ts';
import { createShellTools } from './shell.ts';
import { createDefaultTools, createToolRegistry } from './registry.ts';
import { TOOL_IDS } from '../org/defaultCompany.ts';
import type { Tool, ToolContext } from './types.ts';

function makeContext(workspaceRoot: string, overrides?: Partial<ToolContext>): ToolContext {
  return {
    workspaceRoot,
    writtenPaths: new Set<string>(),
    plan: [],
    requestApproval: async () => true,
    autoApproveShell: false,
    log: () => {},
    ...overrides,
  };
}

function makeTempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'dev3d-tools-'));
}

function find(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} should exist`);
  return tool!;
}

test('resolveInWorkspace rejects escapes and accepts nested paths', () => {
  const ws = makeTempWorkspace();
  try {
    assert.throws(() => resolveInWorkspace(ws, '../escape'));
    assert.throws(() => resolveInWorkspace(ws, join(tmpdir(), 'dev3d-outside-xyz')));
    assert.throws(() => resolveInWorkspace(ws, 'C:foo'));
    assert.throws(() => resolveInWorkspace(ws, 'D:bar'));
    const nested = resolveInWorkspace(ws, 'a/b/c.txt');
    assert.equal(nested, join(ws, 'a', 'b', 'c.txt'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveInWorkspace refuses to follow a link out of the workspace', () => {
  // The regression this pins: the check used to be purely lexical, so
  // `<root>/link/secret.txt` normalised to a path starting with the root and
  // was allowed - and then node:fs followed the link and read outside. A pnpm
  // node_modules is largely junctions, so this needed no attacker.
  const base = mkdtempSync(join(tmpdir(), 'dev3d-link-'));
  const ws = join(base, 'ws');
  const outside = join(base, 'outside');
  mkdirSync(ws, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET\n', 'utf8');
  // A directory junction needs no elevation on Windows and is the same code
  // path a symlink takes here.
  symlinkSync(outside, join(ws, 'link'), 'junction');
  try {
    assert.throws(
      () => resolveInWorkspace(ws, 'link/secret.txt'),
      /symbolic link or junction|resolves outside/,
      'a junction out of the workspace must be refused, not followed',
    );
    assert.throws(
      () => resolveInWorkspace(ws, 'link/nested/created.txt'),
      /symbolic link or junction|resolves outside/,
      'a not-yet-existing file under a junction must also be refused',
    );
    // A link that points back INSIDE the root is refused too: the point is that
    // no link is followed, so "the link appears between check and use" is not a
    // meaningful attack.
    mkdirSync(join(ws, 'inner'), { recursive: true });
    symlinkSync(join(ws, 'inner'), join(ws, 'selflink'), 'junction');
    assert.throws(() => resolveInWorkspace(ws, 'selflink/ok.txt'), /symbolic link or junction/);
    // A plain directory still works.
    assert.equal(resolveInWorkspace(ws, 'inner/ok.txt'), join(ws, 'inner', 'ok.txt'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the filesystem tools cannot read or write through a link out of the workspace', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dev3d-linktool-'));
  const ws = join(base, 'ws');
  const outside = join(base, 'outside');
  mkdirSync(ws, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET\n', 'utf8');
  symlinkSync(outside, join(ws, 'link'), 'junction');
  const tools = createFsTools();
  const ctx = makeContext(ws);
  try {
    const read = await find(tools, 'read_file').run({ path: 'link/secret.txt' }, ctx);
    assert.equal(read.ok, false, 'read_file must not read through the junction');
    assert.match(read.content, /symbolic link or junction|escapes|resolves outside/);

    const write = await find(tools, 'write_file').run(
      { path: 'link/planted.txt', content: 'pwned' },
      ctx,
    );
    assert.equal(write.ok, false, 'write_file must not write through the junction');
    assert.equal(existsSync(join(outside, 'planted.txt')), false, 'nothing may land outside');

    const list = await find(tools, 'list_dir').run({ path: 'link' }, ctx);
    assert.equal(list.ok, false, 'list_dir must not follow the junction');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an NTFS alternate data stream is refused as a write target', () => {
  // `write_file('a.txt:hidden')` used to succeed and `read_file` could read it
  // back, while `readdirSync` showed only `a.txt` — so it was a place to stash
  // content the operator's own inspection tools would never show, and it made
  // `affectsPaths` disagree with the tree. `a.txt::$DATA` is the default-stream
  // spelling of the same trick.
  const ws = makeTempWorkspace();
  try {
    for (const candidate of ['a.txt:hidden', 'a.txt::$DATA', 'dir/file.txt:stream', ':hidden']) {
      assert.throws(
        () => resolveInWorkspace(ws, candidate),
        /alternate data stream/,
        `${candidate} must be refused`,
      );
    }
    // A colon is only legal in a Windows path as part of the volume prefix, so an
    // ordinary nested path — and an absolute path whose drive letter contains one
    // — is unaffected.
    assert.equal(resolveInWorkspace(ws, 'a/b/c.txt'), join(ws, 'a', 'b', 'c.txt'));
    assert.equal(resolveInWorkspace(ws, join(ws, 'a', 'b.txt')), join(ws, 'a', 'b.txt'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a reserved Windows device name is refused before it can silently swallow a write', () => {
  // `write_file('NUL')` used to "succeed" while creating nothing, and `NUL` really
  // is the device through `run_shell`'s cmd.exe — so `writtenPaths` recorded a file
  // no later tool could read. Windows maps the name with an extension, with a
  // trailing dot and with a trailing space, and through a directory, so every
  // component is checked rather than only the last.
  const ws = makeTempWorkspace();
  try {
    for (const candidate of [
      'NUL',
      'CON',
      'aux',
      'PRN.txt',
      'sub/COM1',
      'LPT9.log',
      'NUL ',
      'CON.',
      'CONIN$',
      'dir/nul/file.txt',
    ]) {
      assert.throws(
        () => resolveInWorkspace(ws, candidate),
        /reserved Windows device/,
        `${candidate} must be refused`,
      );
    }
    // Ordinary names that merely start with a device name are untouched, or the
    // guard would refuse half of a normal project.
    for (const candidate of ['console.txt', 'nullable.md', 'com10.txt', 'prn-notes.txt', 'a/NULL.txt']) {
      assert.doesNotThrow(() => resolveInWorkspace(ws, candidate), `${candidate} must be allowed`);
    }
    // A device name as a *directory* is the one Windows would silently redirect,
    // so it is refused even though the file beneath it is ordinary.
    assert.throws(() => resolveInWorkspace(ws, 'COM1/notes.txt'), /reserved Windows device/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('isPathInside is boundary-aware and case-exact', () => {
  // `startsWith(root)` reported `C:\plugins\foo-evil\x.js` as inside
  // `C:\plugins\foo`, and lowercasing both sides made `C:\WS` and `C:\ws` the same
  // directory — which they are not on NTFS with per-directory case sensitivity
  // enabled.
  const root = join(tmpdir(), 'dev3d-inside-root');
  assert.equal(isPathInside(root, root), true, 'the root contains itself');
  assert.equal(isPathInside(root, join(root, 'a', 'b.txt')), true, 'a nested path is inside');
  assert.equal(isPathInside(root, join(tmpdir(), 'dev3d-inside-root-evil', 'x.js')), false, 'a sibling sharing the prefix is outside');
  assert.equal(isPathInside(root, join(tmpdir(), 'other')), false, 'an unrelated directory is outside');
  assert.equal(isPathInside(root, join(root, '..', 'sibling')), false, 'a parent is outside');
  if (process.platform === 'win32') {
    // The property the case-folding threw away. On a case-insensitive volume the
    // filesystem itself would resolve both spellings to one directory; the
    // predicate has to be able to say they are different, because on a
    // case-sensitive tree they are.
    assert.equal(
      isPathInside('C:\\WS', 'C:\\ws\\evil'),
      false,
      'a different spelling of the root is a different directory',
    );
    assert.equal(isPathInside('C:\\WS', 'C:\\WS\\ok.txt'), true);
  }
});

test('toWorkspaceRelative refuses a path outside the root instead of returning ../', () => {  const ws = makeTempWorkspace();
  try {
    assert.equal(toWorkspaceRelative(ws, join(ws, 'a', 'b.txt')), 'a/b.txt');
    assert.equal(toWorkspaceRelative(ws, ws), '.');
    // It used to return '../elsewhere', which made every caller's guard dead
    // code and let an outside path be recorded as a file the run wrote.
    assert.throws(() => toWorkspaceRelative(ws, join(tmpdir(), 'elsewhere', 'x.txt')));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('the writing tools refuse a .git control file, because an approval cannot see it', async () => {
  // The attack this closes: plant `.git/hooks/pre-commit` with write_file (no
  // approval needed for a file in your own workspace), then call
  // `git commit -m x`, which a human approves while seeing only the argv — and
  // the planted hook runs with the provider keys in its environment.
  const ws = makeTempWorkspace();
  const tools = createFsTools();
  const ctx = makeContext(ws);
  try {
    mkdirSync(join(ws, '.git', 'hooks'), { recursive: true });
    for (const rel of [
      '.git/hooks/pre-commit',
      '.git/config',
      join('.git', 'objects', 'x'),
      'sub/.git/config',
    ]) {
      const res = await find(tools, 'write_file').run({ path: rel, content: '#!/bin/sh\necho pwned' }, ctx);
      assert.equal(res.ok, false, `write_file must refuse ${rel}`);
      assert.match(res.content, /\.git directory/);
      assert.equal(existsSync(join(ws, rel)), false, `${rel} must not be created`);
    }
    // A directory merely *named* like a git dir is not the repository's own.
    const ok = await find(tools, 'write_file').run({ path: 'src/.gitignore', content: 'node_modules' }, ctx);
    assert.equal(ok.ok, true, 'an ordinary file whose name starts with .git stays writable');
    // edit_file is refused on the same basis.
    const edited = await find(tools, 'edit_file').run(
      { path: '.git/config', oldString: 'a', newString: 'b' },
      ctx,
    );
    assert.equal(edited.ok, false);
    assert.match(edited.content, /\.git directory/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('write_file then read_file round-trips, and records affectsPaths/writtenPaths', async () => {
  const ws = makeTempWorkspace();
  const ctx = makeContext(ws);
  const tools = createFsTools();
  try {
    const w = await find(tools, 'write_file').run(
      { path: 'notes/hello.txt', content: 'line one\nline two' },
      ctx,
    );
    assert.equal(w.ok, true);
    assert.deepEqual(w.affectsPaths, ['notes/hello.txt']);
    assert.equal(ctx.writtenPaths.has('notes/hello.txt'), true);

    const r = await find(tools, 'read_file').run({ path: 'notes/hello.txt' }, ctx);
    assert.equal(r.ok, true);
    assert.match(r.content, /line one/);
    assert.match(r.content, /line two/);
    assert.match(r.content, /\|\s/); // line-number gutter present
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('edit_file succeeds on a unique match and fails on missing/ambiguous matches', async () => {
  const ws = makeTempWorkspace();
  const ctx = makeContext(ws);
  const edit = find(createFsTools(), 'edit_file');
  try {
    writeFileSync(join(ws, 'a.txt'), 'alpha\nbeta\nalpha', 'utf8');

    const ok = await edit.run({ path: 'a.txt', oldString: 'beta', newString: 'BETA' }, ctx);
    assert.equal(ok.ok, true);
    assert.equal(readFileSync(join(ws, 'a.txt'), 'utf8'), 'alpha\nBETA\nalpha');

    const miss = await edit.run({ path: 'a.txt', oldString: 'not-present', newString: 'x' }, ctx);
    assert.equal(miss.ok, false);

    const amb = await edit.run({ path: 'a.txt', oldString: 'alpha', newString: 'x' }, ctx);
    assert.equal(amb.ok, false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('list_dir lists a created tree', async () => {
  const ws = makeTempWorkspace();
  const ctx = makeContext(ws);
  const list = find(createFsTools(), 'list_dir');
  try {
    mkdirSync(join(ws, 'src', 'nested'), { recursive: true });
    writeFileSync(join(ws, 'src', 'a.ts'), '', 'utf8');
    writeFileSync(join(ws, 'src', 'nested', 'b.ts'), '', 'utf8');

    const r = await list.run({ path: 'src' }, ctx);
    assert.equal(r.ok, true);
    assert.match(r.content, /a\.ts/);
    assert.match(r.content, /nested\//);
    assert.match(r.content, /b\.ts/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('search_files finds a planted token and skips node_modules', async () => {
  const ws = makeTempWorkspace();
  const ctx = makeContext(ws);
  const search = find(createFsTools(), 'search_files');
  try {
    mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(ws, 'app'), { recursive: true });
    writeFileSync(join(ws, 'app', 'index.ts'), 'const SECRET_TOKEN = 1;\n', 'utf8');
    writeFileSync(join(ws, 'node_modules', 'pkg', 'dep.ts'), 'const SECRET_TOKEN = 2;\n', 'utf8');

    const r = await search.run({ pattern: 'SECRET_TOKEN', glob: '*.ts' }, ctx);
    assert.equal(r.ok, true);
    assert.match(r.content, /app\/index\.ts/);
    assert.doesNotMatch(r.content, /node_modules/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('run_shell does not execute the command when approval is declined', async () => {
  const ws = makeTempWorkspace();
  const shell = find(createShellTools(), 'run_shell');
  let approvalCalled = false;
  const ctx = makeContext(ws, {
    autoApproveShell: false,
    requestApproval: async () => {
      approvalCalled = true;
      return false;
    },
  });
  const marker = join(ws, 'should-not-exist.txt');
  const r = await shell.run(
    { command: `node -e "require('fs').writeFileSync('should-not-exist.txt','x')"` },
    ctx,
  );
  assert.equal(r.ok, false);
  assert.equal(approvalCalled, true);
  assert.equal(existsSync(marker), false);
  rmSync(ws, { recursive: true, force: true });
});

test('run_shell skips the approval round trip when autoApproveShell is true', async () => {
  const ws = makeTempWorkspace();
  const shell = find(createShellTools(), 'run_shell');
  let approvalCalled = false;
  const ctx = makeContext(ws, {
    autoApproveShell: true,
    requestApproval: async () => {
      approvalCalled = true;
      return false;
    },
  });
  await shell.run({ command: 'echo hi' }, ctx);
  assert.equal(approvalCalled, false);
  rmSync(ws, { recursive: true, force: true });
});

test('run_shell executes the command when approved', async (t) => {
  const ws = makeTempWorkspace();
  const shell = find(createShellTools(), 'run_shell');
  const ctx = makeContext(ws, { autoApproveShell: false, requestApproval: async () => true });
  const marker = join(ws, 'should-exist.txt');
  try {
    const r = await shell.run(
      { command: `node -e "require('fs').writeFileSync('should-exist.txt','x')"` },
      ctx,
    );

    // `run_shell` captures stdout/stderr by contract, which means spawning a
    // child with piped stdio. A confined sandbox blocks exactly that (spawn
    // EPERM), so this assertion is unexercisable there - but it still runs, and
    // still has to hold, anywhere child processes are allowed.
    if (!r.ok && /EPERM|spawn/i.test(r.content)) {
      t.skip('sandbox blocks child processes with piped stdio; run outside the sandbox to exercise this');
      return;
    }

    assert.equal(r.ok, true);
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('registry registers tools, rejects duplicates, and builds schemas', () => {
  const registry = createToolRegistry();
  const defaults = createDefaultTools();
  for (const tool of defaults) registry.register(tool);

  const names = registry.names();
  // Every tool the org chart can grant must exist, and nothing else may. The
  // two lists are the security surface, so they are compared rather than
  // counted: a new tool that nobody can be granted, or a grant for a tool that
  // does not exist, is a defect either way.
  assert.deepEqual(
    [...names].sort(),
    [...TOOL_IDS].sort(),
    'the registry must offer exactly the tool ids the org chart declares',
  );

  assert.throws(() => registry.register(defaults[0]!), /already has a tool/);

  const schemas = registry.schemas(['list_dir', 'does-not-exist', 'think']);
  assert.equal(schemas.length, 2);
  assert.deepEqual(
    schemas.map((s) => s.name),
    ['list_dir', 'think'],
  );
});
