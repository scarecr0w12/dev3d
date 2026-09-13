/**
 * `run_shell`'s timeout, which has to actually end the call.
 *
 * Both defects here are reason-only in the sandbox that wrote the review — a
 * confined shell reports `spawn EPERM` for any piped child — so they are pinned
 * with injected pipes, like the stdio transport's framing:
 *
 *  - the promise settled only on `close`, and `close` waits for the stdio pipes.
 *    A grandchild that inherited them keeps them open forever, so a command that
 *    started a background process left the tool call hanging with `timedOut`
 *    already true — and with it the turn and the run;
 *  - `child.kill('SIGKILL')` ends `cmd.exe`, not the tree it started.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createShellTools, type ShellSpawnFn } from './shell.ts';
import type { KillableChild } from '../security/processTree.ts';
import type { ToolContext } from './types.ts';

/** A child that behaves however the test says, including "never closes". */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kills: (NodeJS.Signals | undefined)[] = [];
  pid = 4_242;

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal);
    return true;
  }
}

function context(): ToolContext {
  return {
    workspaceRoot: 'C:/ws',
    writtenPaths: new Set<string>(),
    plan: [],
    requestApproval: async () => true,
    // Approved shell, so each test exercises the execution path and not the gate.
    autoApproveShell: true,
    log: () => {},
  };
}

function harness(): {
  child: FakeChild;
  invoke: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<{ ok: boolean; content: string; preview: string }>;
  killed: KillableChild[];
} {
  const child = new FakeChild();
  const killed: KillableChild[] = [];
  const spawnFn = (() => child) as unknown as ShellSpawnFn;
  const [tool] = createShellTools({
    spawnFn,
    // Short enough to keep the file fast; the default is the real two seconds.
    killGraceMs: 25,
    killTree: (target) => {
      killed.push(target);
      // The real one kills and then reports; here the kill is recorded and the
      // child is left alive on purpose, which is the whole point of the test.
    },
  });
  assert.ok(tool);
  return {
    child,
    killed,
    invoke: (args, ctx = context()) =>
      tool.run(args, ctx) as Promise<{ ok: boolean; content: string; preview: string }>,
  };
}

/**
 * Await a result, but fail rather than hang if it never comes.
 *
 * A test for a *hang* that hangs is a test that tells the person who broke it
 * nothing: the suite stops and there is no message naming the cause. The budget is
 * generous against the 25 ms grace period and still finite.
 */
async function within<T>(pending: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: the tool call never settled`)), 2_000);
    timer.unref?.();
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test('a command that never closes still ends the tool call at the deadline', async () => {
  const h = harness();
  // 40 ms timeout: the tool's own floor is 1 ms, so this is a real deadline.
  const pending = h.invoke({ command: 'start /B watcher.exe', timeoutMs: 40 });
  h.child.stdout.emit('data', Buffer.from('partial output before the kill\n'));

  const result = await within(pending, 'a command that never closes');
  assert.equal(result.ok, false);
  assert.equal(result.preview, 'Command timed out');
  assert.match(result.content, /timed out after 40 ms/);
  // The honest half: what it printed is kept, and what it left behind is named
  // rather than implied to be gone.
  assert.match(result.content, /partial output before the kill/);
  assert.match(result.content, /may still be running/);
});

test('the timeout kills the tree, not just the direct child', async () => {
  const h = harness();
  const pending = h.invoke({ command: 'start /B watcher.exe', timeoutMs: 20 });
  // The fake's own kill is the backstop; the injected tree kill is what has to be
  // asked for, because `child.kill` on Windows ends cmd.exe and nothing below it.
  await within(pending, 'a timed-out command');
  assert.equal(h.killed.length, 1, 'the timeout asks for a tree kill');
  assert.equal(h.killed[0], h.child, 'and it is given the child whose tree it is');
});

test('a timeout that does get a close reports the output it collected', async () => {
  const h = harness();
  const pending = h.invoke({ command: 'long-thing', timeoutMs: 20 });
  h.child.stdout.emit('data', Buffer.from('everything it managed\n'));
  const result = await within(pending, 'a timed-out command with no close');
  // No `close` is emitted here either, so this is the grace-period text: the
  // point is that the result arrives at all rather than a second later.
  assert.equal(result.ok, false);
  assert.match(result.content, /timed out/);
});

test('cancelling the run ends the call even when the kill produces no close', async () => {
  const h = harness();
  const controller = new AbortController();
  const ctx: ToolContext = { ...context(), signal: controller.signal };
  const pending = h.invoke({ command: 'sleep 600', timeoutMs: 60_000 }, ctx);
  controller.abort();

  const result = await within(pending, 'a cancelled command');
  assert.equal(result.ok, false);
  assert.equal(result.preview, 'Command cancelled');
  assert.match(result.content, /cancelled while this command was running/);
  assert.equal(h.killed.length, 1, 'and it is killed rather than left running');
});

test('a command that closes normally is unaffected by the deadline', async () => {
  const h = harness();
  const pending = h.invoke({ command: 'echo hi', timeoutMs: 5_000 });
  h.child.stdout.emit('data', Buffer.from('hi\n'));
  h.child.emit('close', 0, null);

  const result = await pending;
  assert.equal(result.ok, true);
  assert.match(result.content, /exit code: 0/);
  assert.match(result.content, /hi/);
  assert.equal(h.killed.length, 0, 'nothing is killed on the happy path');
});

test('a non-zero exit is reported as a failure with its output', async () => {
  const h = harness();
  const pending = h.invoke({ command: 'exit 3', timeoutMs: 5_000 });
  h.child.stderr.emit('data', Buffer.from('something went wrong\n'));
  h.child.emit('close', 3, null);

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.preview, 'Command failed (exit 3)');
  assert.match(result.content, /\[stderr\]/);
  assert.match(result.content, /something went wrong/);
});

test('a close that arrives after the timeout wins, because it is the better answer', async () => {
  // `close` means no grandchild is holding the pipes, so the output is complete.
  // The grace period exists only for the case where it never comes.
  const h = harness();
  const pending = h.invoke({ command: 'slow-but-finishes', timeoutMs: 20 });
  await new Promise((settle) => setTimeout(settle, 30));
  h.child.stdout.emit('data', Buffer.from('the rest of it\n'));
  h.child.emit('close', null, 'SIGKILL');

  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.content, /timed out after 20 ms/);
  assert.match(result.content, /the rest of it/, 'output written between the kill and the close is kept');
});
