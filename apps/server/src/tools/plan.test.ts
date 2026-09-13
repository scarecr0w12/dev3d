/**
 * Tests for `todo_write` (the run's working plan) and `git` (read-only
 * repository inspection).
 *
 * The properties under test are the ones that make each tool safe to hand to an
 * employee: the plan is the run's own array and every call replaces it whole,
 * and the git tool can only ever read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlanTools, parsePlan, renderPlan } from './plan.ts';
import { createGitTools } from './git.ts';
import type { Tool, ToolContext } from './types.ts';

function makeTempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'dev3d-plan-git-'));
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

function plan(): Tool {
  const tool = createPlanTools().find((t) => t.name === 'todo_write');
  assert.ok(tool);
  return tool;
}

function git(): Tool {
  const tool = createGitTools().find((t) => t.name === 'git');
  assert.ok(tool);
  return tool;
}

/**
 * Can this environment capture a child process's output at all?
 *
 * The git tool reads what git prints, which requires piped stdio. A confined
 * sandbox blocks that with `spawn EPERM`, so the tests that need a real
 * repository report themselves skipped rather than failing — the same treatment
 * `run_shell`'s execution test already gets. The tool itself is unaffected
 * anywhere child processes are permitted, which is where it actually runs.
 */
const canCaptureChildOutput = (() => {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return probe.error === undefined && probe.status === 0 && typeof probe.stdout === 'string';
})();

const SKIP_REASON = 'sandbox blocks child processes with piped stdio; run outside the sandbox to exercise this';

// ---------------------------------------------------------------------------
// todo_write
// ---------------------------------------------------------------------------

test('parsePlan accepts a well-formed list', () => {
  const { steps, error } = parsePlan([
    { content: 'read the router', status: 'completed' },
    { content: 'change the scoring', status: 'in_progress' },
    { content: 'run the tests', status: 'pending' },
  ]);
  assert.equal(error, null);
  assert.equal(steps.length, 3);
  assert.equal(steps[1]!.status, 'in_progress');
});

test('parsePlan rejects an unknown status', () => {
  const { error } = parsePlan([{ content: 'x', status: 'doing' }]);
  assert.match(error!, /expected one of pending, in_progress, completed/);
});

test('parsePlan rejects more than one in_progress step', () => {
  const { error } = parsePlan([
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'in_progress' },
  ]);
  assert.match(error!, /2 steps are in_progress/);
});

test('parsePlan rejects empty content and non-objects', () => {
  assert.match(parsePlan([{ content: '   ', status: 'pending' }]).error!, /no non-empty "content"/);
  assert.match(parsePlan(['nope']).error!, /is not an object/);
  assert.match(parsePlan({}).error!, /must be an array/);
});

test('parsePlan rejects an oversized plan', () => {
  const many = Array.from({ length: 51 }, (_, i) => ({ content: `step ${i}`, status: 'pending' }));
  assert.match(parsePlan(many).error!, /limited to 50 steps/);
});

test('renderPlan marks each status distinctly', () => {
  const rendered = renderPlan([
    { content: 'done thing', status: 'completed' },
    { content: 'current thing', status: 'in_progress' },
    { content: 'later thing', status: 'pending' },
  ]);
  assert.match(rendered, /\[x\] done thing/);
  assert.match(rendered, /\[~\] current thing/);
  assert.match(rendered, /\[ \] later thing/);
  assert.equal(renderPlan([]), '(the plan is empty)');
});

test('todo_write writes into the run plan it was handed', async () => {
  const ctx = makeContext(makeTempWorkspace());
  const res = await plan().run(
    { todos: [{ content: 'first', status: 'in_progress' }] },
    ctx,
  );
  assert.equal(res.ok, true);
  // The context's own array must have changed, not been replaced: the engine
  // hands the run's array to every turn by reference.
  assert.equal(ctx.plan.length, 1);
  assert.equal(ctx.plan[0]!.content, 'first');
  assert.match(res.content, /Plan updated \(0\/1 complete\)/);
});

test('todo_write replaces the whole list rather than merging', async () => {
  const ctx = makeContext(makeTempWorkspace());
  await plan().run({ todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }] }, ctx);
  await plan().run({ todos: [{ content: 'a', status: 'completed' }] }, ctx);
  assert.deepEqual(
    ctx.plan.map((s) => `${s.content}:${s.status}`),
    ['a:completed'],
  );
});

test('todo_write reports how much is done and what is current', async () => {
  const ctx = makeContext(makeTempWorkspace());
  const res = await plan().run(
    {
      todos: [
        { content: 'one', status: 'completed' },
        { content: 'two', status: 'completed' },
        { content: 'three', status: 'in_progress' },
      ],
    },
    ctx,
  );
  assert.match(res.content, /2\/3 complete/);
  assert.match(res.preview, /2\/3 done, now: three/);
});

test('todo_write calls onPlanChange so the console can update', async () => {
  let calls = 0;
  const ctx = makeContext(makeTempWorkspace(), { onPlanChange: () => { calls += 1; } });
  await plan().run({ todos: [{ content: 'x', status: 'pending' }] }, ctx);
  assert.equal(calls, 1);
});

test('todo_write leaves the plan untouched when the input is invalid', async () => {
  const ctx = makeContext(makeTempWorkspace());
  await plan().run({ todos: [{ content: 'good', status: 'pending' }] }, ctx);
  const res = await plan().run({ todos: [{ content: 'bad', status: 'nonsense' }] }, ctx);
  assert.equal(res.ok, false);
  assert.deepEqual(ctx.plan.map((s) => s.content), ['good'], 'a rejected call must not clear the plan');
});

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

test('git refuses a subcommand that is neither inspection nor a supported write', async () => {
  const root = makeTempWorkspace();
  try {
    const res = await git().run({ command: 'reset' }, makeContext(root));
    assert.equal(res.ok, false);
    assert.match(res.content, /is not available/);
    assert.match(res.content, /run_shell/, 'the refusal should name the way to do it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git allows only `checkout -b`, because switching branches can discard work', async () => {
  const root = makeTempWorkspace();
  try {
    const plain = await git().run({ command: 'checkout', args: ['main'] }, makeContext(root));
    assert.equal(plain.ok, false);
    assert.match(plain.content, /checkout -b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git refuses arguments that destroy work, on either path', async () => {
  const root = makeTempWorkspace();
  try {
    for (const [command, args] of [
      ['stash', ['push', '--hard']],
      ['commit', ['-m', 'x', '--no-verify']],
      ['add', ['--force']],
    ] as const) {
      const res = await git().run({ command, args: [...args] }, makeContext(root));
      assert.equal(res.ok, false, `git ${command} ${args.join(' ')} should be refused`);
      assert.match(res.content, /refusing the argument/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A directory that passes the "is this a repository" check without being one.
 *
 * The tool only requires a `.git` entry to exist, so this reaches the argument
 * and approval logic without needing child processes — which matters in a sandbox
 * that forbids them, and keeps these tests about the rules rather than about git.
 */
function fakeRepo(): string {
  const root = makeTempWorkspace();
  mkdirSync(join(root, '.git'), { recursive: true });
  return root;
}

test('git refuses the --option=value spelling of a forbidden argument', async () => {
  // The regression this pins: the gate was `Set.has(arg)`, which is exact
  // equality, so `--output=<path>` never matched the `--output` entry. On the
  // un-gated inspection path that let a model write attacker-chosen content to
  // any path git could reach, and `blame --contents=<path>` print an arbitrary
  // file into its own context.
  const root = fakeRepo();
  try {
    for (const [command, args, why] of [
      ['log', ['--output=C:/Windows/Temp/pwned.txt'], 'writes a file outside the workspace'],
      ['log', ['--output', 'C:/Windows/Temp/pwned.txt'], 'spaced form of the same'],
      ['diff', ['--output=../pwned.txt'], 'relative escape via --output'],
      ['blame', ['--contents=C:/Windows/win.ini', '--', 'README.md'], 'reads an arbitrary file'],
      ['show', ['--exec=calc.exe'], 'runs a program'],
      ['log', ['--upload-pack=evil'], 'redirects a pack fetch'],
      ['commit', ['-m', 'x', '-n'], 'short spelling of --no-verify'],
      ['commit', ['-m', 'x', '--no-verify=true'], 'valued spelling of --no-verify'],
    ] as const) {
      const res = await git().run({ command, args: [...args] }, makeContext(root));
      assert.equal(res.ok, false, `git ${command} ${args.join(' ')} should be refused (${why})`);
      assert.match(res.content, /refusing the argument/);
      // The message must name the offending argument, not merely refuse. The
      // refused argument is the dangerous one, which is not always the first.
      const dangerous = args.find((a) => /^--|^-[A-Za-z]/.test(a) && a !== '-m')!;
      assert.ok(
        res.content.includes(JSON.stringify(dangerous.split('=')[0])),
        `the refusal should name ${dangerous.split('=')[0]}, got: ${res.content}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git refuses a read-only subcommand whose verb mutates the repository', async () => {
  // `remote` and `branch` are read-only *bare*; with a verb they rewrite
  // .git/config (core.sshCommand, core.hooksPath, aliases) or delete a branch.
  // `remote add` is refused outright rather than offered behind approval,
  // because blessing it would mean blessing a change to the configuration that
  // runs every other command.
  const root = fakeRepo();
  try {
    for (const [command, args] of [
      ['remote', ['add', 'origin', 'https://evil.example/x.git']],
      ['remote', ['set-url', 'origin', 'https://evil.example/x.git']],
      ['remote', ['update']],
      ['remote', ['prune']],
    ] as const) {
      const res = await git().run({ command, args: [...args] }, makeContext(root));
      assert.equal(res.ok, false, `git ${command} ${args.join(' ')} should be refused`);
      assert.match(res.content, /refusing the argument/, `git ${command} ${args[0]} must be refused`);
    }
    // A mutating flag on an otherwise read-only subcommand must either be
    // refused on the inspection path or go through the approval gate. What it
    // must never do is reach git with nobody asked: `branch -D` deletes a
    // branch, `tag -d` deletes a tag.
    for (const [command, args] of [
      ['branch', ['-D', 'main']],
      ['tag', ['-d', 'v1']],
    ] as const) {
      let asked = 0;
      const refused = await git().run(
        { command, args: [...args] },
        makeContext(root, {
          requestApproval: async () => {
            asked += 1;
            return false;
          },
        }),
      );
      assert.equal(refused.ok, false, `git ${command} ${args.join(' ')} must not run`);
      assert.doesNotMatch(
        refused.content,
        /could not be started/,
        `git ${command} ${args.join(' ')} reached git without approval`,
      );
      const refusedOnInspectionPath = /on the inspection path/.test(refused.content);
      assert.ok(
        refusedOnInspectionPath || asked >= 1,
        `git ${command} ${args.join(' ')} must be refused or ask a human, got: ${refused.content}`,
      );
    }
    // The bare read-only forms still pass the gate: they must reach git (which
    // then fails to start in this sandbox), not be refused by the tool.
    for (const command of ['remote', 'branch', 'tag'] as const) {
      const listed = await git().run({ command }, makeContext(root));
      assert.doesNotMatch(
        listed.content,
        /refusing the argument|inspection path/,
        `bare \`git ${command}\` must not be refused`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git tells a reading stash from a destructive one by what it will ask', async () => {
  const root = fakeRepo();
  try {
    // `git stash` with no verb and `git stash list` only read; they must not spend
    // an approval. `git stash drop` destroys an entry, so it must.
    const asked: string[] = [];
    const ctx = makeContext(root, {
      requestApproval: async (req) => {
        asked.push(req.summary);
        return false;
      },
    });

    await git().run({ command: 'stash' }, ctx);
    assert.deepEqual(asked, [], 'listing stashes must not ask');

    await git().run({ command: 'stash', args: ['list'] }, ctx);
    assert.deepEqual(asked, [], 'listing stashes explicitly must not ask');

    const dropped = await git().run({ command: 'stash', args: ['drop'] }, ctx);
    assert.deepEqual(asked, ['git stash drop'], 'dropping a stash is a write and must ask');
    assert.equal(dropped.ok, false);
    assert.match(dropped.content, /was not approved/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a git write asks a human before it runs', async () => {
  const root = fakeRepo();
  try {
    const asked: string[] = [];
    const ctx = makeContext(root, {
      requestApproval: async (req) => {
        asked.push(req.summary);
        return false;
      },
    });
    const res = await git().run({ command: 'commit', args: ['-m', 'save'] }, ctx);
    assert.equal(res.ok, false);
    assert.match(res.content, /was not approved/);
    assert.deepEqual(asked, ['git commit -m save']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an approved git write runs', { skip: canCaptureChildOutput ? false : SKIP_REASON }, async () => {
  const root = makeTempWorkspace();
  try {
    const run = (args: string[]): void => {
      const r = spawnSync('git', args, { cwd: root, stdio: 'ignore' });
      assert.equal(r.status, 0, `git ${args.join(' ')} should succeed`);
    };
    run(['init']);
    run(['config', 'user.email', 'test@example.test']);
    run(['config', 'user.name', 'Test']);
    writeFileSync(join(root, 'saved.txt'), 'content\n');

    const ctx = makeContext(root, { requestApproval: async () => true });
    assert.equal((await git().run({ command: 'add', args: ['saved.txt'] }, ctx)).ok, true);
    const committed = await git().run({ command: 'commit', args: ['-m', 'save the work'] }, ctx);
    assert.equal(committed.ok, true, committed.content);

    const log = await git().run({ command: 'log', args: ['--oneline'] }, ctx);
    assert.match(log.content, /save the work/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a git write does not ask when shell commands are auto-approved', async () => {
  const root = makeTempWorkspace();
  try {
    let asked = 0;
    const ctx = makeContext(root, {
      autoApproveShell: true,
      requestApproval: async () => {
        asked += 1;
        return true;
      },
    });
    // No repository, so it fails at that check - but only after deciding not to ask.
    const res = await git().run({ command: 'commit', args: ['-m', 'save'] }, ctx);
    assert.equal(asked, 0);
    assert.match(res.content, /not a git repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git inspection never asks, even when approval is denied', async () => {
  const root = makeTempWorkspace();
  try {
    let asked = 0;
    const ctx = makeContext(root, {
      requestApproval: async () => {
        asked += 1;
        return false;
      },
    });
    const res = await git().run({ command: 'status' }, ctx);
    assert.equal(asked, 0, 'inspection must not consume an approval');
    assert.match(res.content, /not a git repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git refuses a non-string args array', async () => {
  const root = makeTempWorkspace();
  try {
    const res = await git().run({ command: 'diff', args: [1, 2] }, makeContext(root));
    assert.equal(res.ok, false);
    assert.match(res.content, /array of strings/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git says so when the workspace is not a repository', async () => {
  const root = makeTempWorkspace();
  try {
    const res = await git().run({ command: 'status' }, makeContext(root));
    assert.equal(res.ok, false);
    assert.match(res.content, /not a git repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git reports uncommitted work in a real repository', { skip: canCaptureChildOutput ? false : SKIP_REASON }, async () => {
  const root = makeTempWorkspace();
  try {
    const run = (args: string[]): void => {
      const r = spawnSync('git', args, { cwd: root, stdio: 'ignore' });
      assert.equal(r.status, 0, `git ${args.join(' ')} should succeed`);
    };
    run(['init']);
    run(['config', 'user.email', 'test@example.test']);
    run(['config', 'user.name', 'Test']);
    writeFileSync(join(root, 'committed.txt'), 'one\n');
    run(['add', '.']);
    run(['commit', '-m', 'first']);

    writeFileSync(join(root, 'new.txt'), 'two\n');

    const status = await git().run({ command: 'status', args: ['--short'] }, makeContext(root));
    assert.equal(status.ok, true);
    assert.match(status.content, /new\.txt/, status.content);

    const log = await git().run({ command: 'log', args: ['--oneline'] }, makeContext(root));
    assert.equal(log.ok, true);
    assert.match(log.content, /first/);

    const files = await git().run({ command: 'ls-files' }, makeContext(root));
    assert.match(files.content, /committed\.txt/);

    // A command that legitimately produces nothing is still a success.
    const clean = await git().run({ command: 'diff' }, makeContext(root));
    assert.equal(clean.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git does not run a shell, so metacharacters are inert', { skip: canCaptureChildOutput ? false : SKIP_REASON }, async () => {
  const root = makeTempWorkspace();
  try {
    spawnSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    const canary = join(root, 'canary.txt');
    const res = await git().run(
      { command: 'log', args: [`--pretty=%H; touch ${canary}`] },
      makeContext(root),
    );
    // Whatever git makes of the argument, no shell may have interpreted it.
    assert.equal(res.ok, true);
    assert.equal(
      spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.includes('canary'),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
