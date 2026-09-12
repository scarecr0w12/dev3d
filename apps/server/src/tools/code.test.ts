/**
 * Tests for the code-navigation and patching tools: `glob`, `grep` and
 * `apply_patch`.
 *
 * These lean on the properties that make each tool trustworthy rather than on
 * the happy path alone: `glob` must not escape or return directories, `grep`
 * must bound its output, and `apply_patch` must refuse to half-apply.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodeTools, parsePatch } from './code.ts';
import type { Tool, ToolContext } from './types.ts';

function makeTempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'dev3d-code-'));
}

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

function find(name: string): Tool {
  const tool = createCodeTools().find((t) => t.name === name);
  assert.ok(tool, `tool ${name} should exist`);
  return tool;
}

/** A small tree used by several tests. */
function seed(root: string): void {
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'junk'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'src', 'alpha.ts'), 'export const alpha = 1;\n// NEEDLE here\n');
  writeFileSync(join(root, 'src', 'beta.test.ts'), 'export const beta = 2;\n');
  writeFileSync(join(root, 'src', 'deep', 'gamma.ts'), 'export const gamma = 3;\n// needle lower\n');
  writeFileSync(join(root, 'docs', 'guide.md'), '# Guide\nNEEDLE in prose\n');
  writeFileSync(join(root, 'node_modules', 'junk', 'noisy.ts'), '// NEEDLE should never be found\n');
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

test('glob finds files by name at any depth', async () => {
  const root = makeTempWorkspace();
  try {
    seed(root);
    const res = await find('glob').run({ pattern: '*.ts' }, makeContext(root));
    assert.equal(res.ok, true);
    const lines = res.content.split('\n');
    assert.ok(lines.includes('src/alpha.ts'), `expected src/alpha.ts in:\n${res.content}`);
    assert.ok(lines.includes('src/deep/gamma.ts'), 'a bare *.ts must match at any depth');
    assert.ok(lines.includes('src/beta.test.ts'));
    assert.ok(!lines.some((l) => l.startsWith('docs/')), 'a *.ts pattern must not match .md files');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('glob honours a path prefix and an explicit glob', async () => {
  const root = makeTempWorkspace();
  try {
    seed(root);
    const res = await find('glob').run({ pattern: 'src/**/*.test.ts' }, makeContext(root));
    assert.equal(res.content, 'src/beta.test.ts');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('glob never descends into node_modules or .git', async () => {
  const root = makeTempWorkspace();
  try {
    seed(root);
    const res = await find('glob').run({ pattern: '**/*.ts' }, makeContext(root));
    assert.ok(!res.content.includes('node_modules'), `skipped dirs leaked:\n${res.content}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('glob returns files, never directories', async () => {
  const root = makeTempWorkspace();
  try {
    seed(root);
    const res = await find('glob').run({ pattern: '**/*' }, makeContext(root));
    assert.ok(!res.content.includes('src/deep/') || res.content.includes('src/deep/gamma.ts'));
    for (const line of res.content.split('\n')) {
      if (line === '' || line.startsWith('(')) continue;
      assert.ok(!line.endsWith('/'), `directory listed as a file: ${line}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('glob excludes an explicit pattern', async () => {
  const root = makeTempWorkspace();
  try {
    seed(root);
    const res = await find('glob').run({ pattern: '**/*.ts', exclude: '**/*.test.ts' }, makeContext(root));
    assert.ok(!res.content.includes('beta.test.ts'), res.content);
    assert.ok(res.content.includes('alpha.ts'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('glob reports no matches as a success, not a failure', async () => {
  const root = makeTempWorkspace();
  try {
    seed(root);
    const res = await find('glob').run({ pattern: '*.zzz' }, makeContext(root));
    assert.equal(res.ok, true);
    assert.match(res.content, /No files match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('glob caps its output and says so', async () => {
  const root = makeTempWorkspace();
  try {
    mkdirSync(join(root, 'many'));
    for (let i = 0; i < 12; i += 1) writeFileSync(join(root, 'many', `f${i}.ts`), 'x');
    const res = await find('glob').run({ pattern: '*.ts', limit: 5 }, makeContext(root));
    const listed = res.content.split('\n').filter((l) => l.endsWith('.ts'));
    assert.equal(listed.length, 5);
    assert.match(res.content, /more; raise "limit"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('glob refuses a missing required argument', async () => {
  const root = makeTempWorkspace();
  try {
    const res = await find('glob').run({}, makeContext(root));
    assert.equal(res.ok, false);
    assert.match(res.content, /non-empty "pattern"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('glob refuses a path outside the workspace', async () => {
  const root = makeTempWorkspace();
  try {
    const res = await find('glob').run({ pattern: '*', path: '../..' }, makeContext(root));
    assert.equal(res.ok, false);
    assert.match(res.content, /escapes the workspace root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

test('grep finds matches with file and line', async () => {
  const root = makeTempWorkspace();
  try {
    seed(root);
    const res = await find('grep').run({ pattern: 'NEEDLE' }, makeContext(root));
    assert.equal(res.ok, true);
    assert.match(res.content, /src\/alpha\.ts:2:/);
    assert.match(res.content, /docs\/guide\.md:2:/);
    assert.ok(!res.content.includes('node_modules'), 'grep must skip node_modules');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grep is case-sensitive unless asked not to be', async () => {
  const root = makeTempWorkspace();
  try {
    seed(root);
    const strict = await find('grep').run({ pattern: 'needle' }, makeContext(root));
    assert.ok(!strict.content.includes('alpha.ts'), 'lowercase must not match NEEDLE');
    const loose = await find('grep').run({ pattern: 'needle', ignoreCase: true }, makeContext(root));
    assert.match(loose.content, /alpha\.ts/);
    assert.match(loose.content, /gamma\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grep filters by include glob', async () => {
  const root = makeTempWorkspace();
  try {
    seed(root);
    const res = await find('grep').run({ pattern: 'NEEDLE', include: '*.md' }, makeContext(root));
    assert.match(res.content, /guide\.md/);
    assert.ok(!res.content.includes('alpha.ts'), res.content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grep renders context lines around a match', async () => {
  const root = makeTempWorkspace();
  try {
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nTHREE\nfour\nfive\n');
    const res = await find('grep').run({ pattern: 'THREE', context: 1 }, makeContext(root));
    assert.match(res.content, /a\.txt-2- two/);
    assert.match(res.content, /a\.txt:3: THREE/);
    assert.match(res.content, /a\.txt-4- four/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grep caps context at five lines', async () => {
  const root = makeTempWorkspace();
  try {
    writeFileSync(join(root, 'a.txt'), Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'));
    const res = await find('grep').run({ pattern: 'line 20', context: 99 }, makeContext(root));
    const numbered = res.content.split('\n').filter((l) => l.includes('a.txt'));
    // 5 before + the match + 5 after
    assert.equal(numbered.length, 11, res.content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grep rejects an invalid regular expression with a readable message', async () => {
  const root = makeTempWorkspace();
  try {
    const res = await find('grep').run({ pattern: '([' }, makeContext(root));
    assert.equal(res.ok, false);
    assert.match(res.content, /Invalid regular expression/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grep reports no matches as success', async () => {
  const root = makeTempWorkspace();
  try {
    seed(root);
    const res = await find('grep').run({ pattern: 'nowhere-to-be-found' }, makeContext(root));
    assert.equal(res.ok, true);
    assert.match(res.content, /No matches for/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grep bounds its result count', async () => {
  const root = makeTempWorkspace();
  try {
    mkdirSync(join(root, 'src'));
    for (let i = 0; i < 10; i += 1) writeFileSync(join(root, 'src', `f${i}.txt`), 'HIT\nHIT\n');
    const res = await find('grep').run({ pattern: 'HIT', limit: 4 }, makeContext(root));
    const hits = res.content.split('\n').filter((l) => l.includes(':') && l.includes('HIT'));
    assert.equal(hits.length, 4, res.content);
    assert.match(res.content, /truncated at 4 matches/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// apply_patch - the parser
// ---------------------------------------------------------------------------

test('parsePatch reads one file with one edit', () => {
  const { edits, error } = parsePatch(
    ['*** Begin Patch', '*** Update File: a.txt', '*** Find:', 'old', '*** Replace:', 'new', '*** End Patch'].join('\n'),
  );
  assert.equal(error, null);
  assert.deepEqual(edits, [{ path: 'a.txt', find: 'old', replace: 'new' }]);
});

test('parsePatch reads several files and several edits', () => {
  const { edits, error } = parsePatch(
    [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '*** Find:',
      'one',
      '*** Replace:',
      'ONE',
      '*** Find:',
      'two',
      '*** Replace:',
      'TWO',
      '*** Update File: b/c.txt',
      '*** Find:',
      'x',
      '*** Replace:',
      'y',
      '*** End Patch',
    ].join('\n'),
  );
  assert.equal(error, null);
  assert.equal(edits.length, 3);
  assert.deepEqual(
    edits.map((e) => e.path),
    ['a.txt', 'a.txt', 'b/c.txt'],
  );
});

test('parsePatch preserves multi-line blocks verbatim', () => {
  const { edits, error } = parsePatch(
    ['*** Begin Patch', '*** Update File: a.txt', '*** Find:', '  indented', 'second', '*** Replace:', '  changed', '*** End Patch'].join('\n'),
  );
  assert.equal(error, null);
  assert.equal(edits[0]!.find, '  indented\nsecond');
  assert.equal(edits[0]!.replace, '  changed');
});

test('parsePatch rejects a patch with no update blocks', () => {
  const { error } = parsePatch('*** Begin Patch\n*** End Patch');
  assert.match(error!, /no \*\*\* Update File: blocks/);
});

test('parsePatch treats a Find with no Replace as a deletion', () => {
  const { edits, error } = parsePatch(
    ['*** Begin Patch', '*** Update File: a.txt', '*** Find:', 'gone', '*** End Patch'].join('\n'),
  );
  assert.equal(error, null);
  assert.deepEqual(edits, [{ path: 'a.txt', find: 'gone', replace: '' }]);
});

test('parsePatch rejects a Replace with no Find', () => {
  const { error } = parsePatch(['*** Begin Patch', '*** Update File: a.txt', '*** Replace:', 'x', '*** End Patch'].join('\n'));
  assert.match(error!, /has no matching \*\*\* Find/);
});

test('parsePatch rejects stray text outside any block', () => {
  const { error } = parsePatch(['*** Begin Patch', 'hello', '*** End Patch'].join('\n'));
  assert.match(error!, /Unexpected line outside any block/);
});

// ---------------------------------------------------------------------------
// apply_patch - applying
// ---------------------------------------------------------------------------

test('apply_patch writes an edit and records the path', async () => {
  const root = makeTempWorkspace();
  try {
    writeFileSync(join(root, 'a.txt'), 'hello world\n');
    const ctx = makeContext(root);
    const res = await find('apply_patch').run(
      { patch: ['*** Begin Patch', '*** Update File: a.txt', '*** Find:', 'hello world', '*** Replace:', 'goodbye world', '*** End Patch'].join('\n') },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'goodbye world\n');
    assert.deepEqual(res.affectsPaths, ['a.txt']);
    assert.ok(ctx.writtenPaths.has('a.txt'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('apply_patch changes several files in one call', async () => {
  const root = makeTempWorkspace();
  try {
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'a.txt'), 'AAA\n');
    writeFileSync(join(root, 'sub', 'b.txt'), 'BBB\n');
    const res = await find('apply_patch').run(
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: a.txt',
          '*** Find:',
          'AAA',
          '*** Replace:',
          'aaa',
          '*** Update File: sub/b.txt',
          '*** Find:',
          'BBB',
          '*** Replace:',
          'bbb',
          '*** End Patch',
        ].join('\n'),
      },
      makeContext(root),
    );
    assert.equal(res.ok, true);
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'aaa\n');
    assert.equal(readFileSync(join(root, 'sub', 'b.txt'), 'utf8'), 'bbb\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('apply_patch applies two edits to the same file in order', async () => {
  const root = makeTempWorkspace();
  try {
    writeFileSync(join(root, 'a.txt'), 'first\nsecond\n');
    const res = await find('apply_patch').run(
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: a.txt',
          '*** Find:',
          'first',
          '*** Replace:',
          'FIRST',
          '*** Find:',
          'second',
          '*** Replace:',
          'SECOND',
          '*** End Patch',
        ].join('\n'),
      },
      makeContext(root),
    );
    assert.equal(res.ok, true);
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'FIRST\nSECOND\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('apply_patch writes nothing when one block is missing', async () => {
  const root = makeTempWorkspace();
  try {
    writeFileSync(join(root, 'a.txt'), 'AAA\n');
    writeFileSync(join(root, 'b.txt'), 'BBB\n');
    const res = await find('apply_patch').run(
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: a.txt',
          '*** Find:',
          'AAA',
          '*** Replace:',
          'aaa',
          '*** Update File: b.txt',
          '*** Find:',
          'NOT PRESENT',
          '*** Replace:',
          'bbb',
          '*** End Patch',
        ].join('\n'),
      },
      makeContext(root),
    );
    assert.equal(res.ok, false);
    assert.match(res.content, /made no changes/);
    assert.match(res.content, /b\.txt/);
    // The valid edit to a.txt must not have landed: the patch is atomic.
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'AAA\n');
    assert.equal(readFileSync(join(root, 'b.txt'), 'utf8'), 'BBB\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('apply_patch refuses an ambiguous Find block', async () => {
  const root = makeTempWorkspace();
  try {
    writeFileSync(join(root, 'a.txt'), 'dup\ndup\n');
    const res = await find('apply_patch').run(
      { patch: ['*** Begin Patch', '*** Update File: a.txt', '*** Find:', 'dup', '*** Replace:', 'x', '*** End Patch'].join('\n') },
      makeContext(root),
    );
    assert.equal(res.ok, false);
    assert.match(res.content, /appears 2 times/);
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'dup\ndup\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('apply_patch reports a missing file and changes nothing', async () => {
  const root = makeTempWorkspace();
  try {
    const res = await find('apply_patch').run(
      { patch: ['*** Begin Patch', '*** Update File: nope.txt', '*** Find:', 'x', '*** Replace:', 'y', '*** End Patch'].join('\n') },
      makeContext(root),
    );
    assert.equal(res.ok, false);
    assert.match(res.content, /does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('apply_patch refuses a path outside the workspace', async () => {
  const root = makeTempWorkspace();
  try {
    const res = await find('apply_patch').run(
      { patch: ['*** Begin Patch', '*** Update File: ../escape.txt', '*** Find:', 'x', '*** Replace:', 'y', '*** End Patch'].join('\n') },
      makeContext(root),
    );
    assert.equal(res.ok, false);
    assert.match(res.content, /escapes the workspace root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('apply_patch refuses a malformed patch without touching the disk', async () => {
  const root = makeTempWorkspace();
  try {
    const res = await find('apply_patch').run({ patch: 'not a patch at all' }, makeContext(root));
    assert.equal(res.ok, false);
    // The message names the offending line, which is what makes it fixable.
    assert.match(res.content, /Unexpected line outside any block/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
