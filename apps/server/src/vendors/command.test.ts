/**
 * Tests for the one-shot command transport.
 *
 * Nothing here starts a process: every case uses the scripted fake from
 * `testing.ts`, which is what lets the interesting paths - a hang, a failed
 * start, an oversized output - be exercised on a machine that forbids piped child
 * stdio entirely.
 *
 * The assertions worth reading twice are the ones about **argv**: the prompt is
 * model-authored text, and the difference between it being one argument and it
 * being a command line is the difference between a delegation and an injection.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { describeVendorCommand, runVendorCommand } from './command.ts';
import { FakeChild, childThatFails, childThatHangs, childThatSucceeds, spawnReturning } from './testing.ts';
import type { SpawnCall } from './testing.ts';

const CWD = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';

/**
 * Everything a shell would act on, in one string: separators, a redirect, a
 * command substitution and a quoted argument. If the transport ever let this
 * reach a shell, this is the string that would prove it.
 */
const HOSTILE_PROMPT = 'inspect this; rm -rf / && echo "pwned" `whoami` $(id)';

test('the prompt is appended as one argument, never as a command line', async () => {
  const calls: SpawnCall[] = [];
  const { spawnFn } = spawnReturning(childThatSucceeds('done'), calls);

  await runVendorCommand({
    command: 'codex',
    args: ['exec', '--json', '-s', 'read-only'],
    prompt: HOSTILE_PROMPT,
    promptTransport: 'argv',
    cwd: CWD,
    timeoutMs: 5_000,
    spawnFn,
  });

  const call = calls[0];
  assert.ok(call);
  assert.equal(call.command, 'codex');
  // Five arguments, the last being the whole prompt: no split, no quoting rule
  // for anything downstream to get wrong.
  assert.equal(call.args.length, 5);
  assert.equal(call.args[3], 'read-only');
  assert.equal(call.args[4], HOSTILE_PROMPT);
  // And no shell between the office and the process.
  assert.equal(call.options['shell'], false);
  assert.equal(call.options['cwd'], CWD);
});

test('a stdin vendor gets the prompt on its pipe, which is then closed', async () => {
  // stdin opened as a pipe, which is what the transport must do when the prompt
  // travels that way.
  const child = new FakeChild({ stdin: true });
  child.emitData('read it');
  queueMicrotask(() => child.closeWith(0));
  const { spawnFn, calls } = spawnReturning(child);

  const result = await runVendorCommand({
    command: 'some-agent',
    args: ['--prompt-from-stdin'],
    prompt: 'the whole task',
    promptTransport: 'stdin',
    cwd: CWD,
    timeoutMs: 5_000,
    spawnFn,
  });

  assert.equal(result.outcome, 'ok');
  assert.deepEqual(child.stdin?.written, ['the whole task']);
  assert.equal(child.stdin?.destroyed, true, 'the pipe is closed so the vendor does not wait for more');
  // Nothing was appended to argv, and stdin was opened as a pipe rather than
  // ignored - the other half of the same decision.
  assert.deepEqual(calls[0]?.args, ['--prompt-from-stdin']);
  assert.deepEqual((calls[0]?.options['stdio'] as string[])[0], 'pipe');
});

test('an argv vendor gets stdin closed, so it cannot block waiting for input', async () => {
  const { spawnFn, calls } = spawnReturning(childThatSucceeds('hi'));
  await runVendorCommand({
    command: 'codex',
    args: ['exec'],
    prompt: 'task',
    promptTransport: 'argv',
    cwd: CWD,
    timeoutMs: 5_000,
    spawnFn,
  });
  assert.equal((calls[0]?.options['stdio'] as string[])[0], 'ignore');
});

test('a clean exit is ok, and both streams are captured', async () => {
  const result = await runVendorCommand({
    command: 'codex',
    args: [],
    prompt: 'task',
    promptTransport: 'argv',
    cwd: CWD,
    timeoutMs: 5_000,
    ...spawnReturning(childThatSucceeds('the answer', 'a warning')),
  });

  assert.equal(result.outcome, 'ok');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'the answer');
  assert.equal(result.stderr, 'a warning');
  assert.equal(result.detail, '');
  assert.equal(result.stdoutTruncated, false);
});

test('a non-zero exit is a failure, and the stderr tail explains it', async () => {
  const result = await runVendorCommand({
    command: 'codex',
    args: ['exec'],
    prompt: 'task',
    promptTransport: 'argv',
    cwd: CWD,
    timeoutMs: 5_000,
    ...spawnReturning(childThatFails('error: unexpected argument --json', 2)),
  });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.exitCode, 2);
  assert.match(result.detail, /exited with code 2/);
  // The last stderr is the part that says *why*, so it travels with the message.
  assert.match(result.detail, /unexpected argument --json/);
});

test('a process that never exits is killed, and reported as a timeout', async () => {
  const child = childThatHangs();
  const { spawnFn } = spawnReturning(child);

  const result = await runVendorCommand({
    command: 'dsh',
    args: [],
    prompt: 'task',
    promptTransport: 'argv',
    cwd: CWD,
    // Short enough to keep the suite fast; the transport does not care about the
    // value, only that it enforces one.
    timeoutMs: 30,
    spawnFn,
  });

  assert.equal(result.outcome, 'timeout');
  assert.match(result.detail, /did not finish within 30ms/);
  // SIGKILL, not SIGTERM: a harness that ignores a polite request must still stop.
  assert.equal(child.killSignal, 'SIGKILL');
});

test('an abort kills the process and is not mistaken for a vendor failure', async () => {
  const child = childThatHangs();
  const { spawnFn } = spawnReturning(child);
  const controller = new AbortController();

  const pending = runVendorCommand({
    command: 'dsh',
    args: [],
    prompt: 'task',
    promptTransport: 'argv',
    cwd: CWD,
    timeoutMs: 60_000,
    signal: controller.signal,
    spawnFn,
  });

  controller.abort();
  const result = await pending;

  assert.equal(result.outcome, 'aborted');
  assert.equal(child.killSignal, 'SIGKILL');
  // An operator cancelling is a decision, not a fault, and the wording has to say
  // so - `registry.ts` keys the vendor's status off this outcome.
  assert.match(result.detail, /Cancelled by the operator/);
});

test('an already-aborted signal kills the process without waiting for the event', async () => {
  const child = childThatHangs();
  const { spawnFn } = spawnReturning(child);
  const controller = new AbortController();
  controller.abort();

  const result = await runVendorCommand({
    command: 'dsh',
    args: [],
    prompt: 'task',
    promptTransport: 'argv',
    cwd: CWD,
    timeoutMs: 60_000,
    signal: controller.signal,
    spawnFn,
  });

  assert.equal(result.outcome, 'aborted');
  assert.equal(child.killSignal, 'SIGKILL');
});

test('a kill that never produces a close still ends the delegation', async () => {
  // The wedge this pins: `settle` was reachable only from `error` and `close`,
  // and `close` fires when the child's stdio closes — which is not the same as
  // the process exiting. A harness that leaves a grandchild holding the pipes
  // (the `npx` case the module comment names) never emits `close` at all, so the
  // promise never settled: the turn hung and, because the runtime had already
  // marked the vendor `engaged`, every later delegation to it was refused until
  // the office restarted. The timeout is a ceiling on the delegation, so it has
  // to actually end it.
  class NeverCloses extends FakeChild {
    override kill(): boolean {
      this.killCount += 1;
      this.killSignal = 'SIGKILL';
      // Deliberately never closes.
      return true;
    }
  }
  const child = new NeverCloses({ stdin: false });
  const { spawnFn } = spawnReturning(child);

  const started = Date.now();
  const result = await runVendorCommand({
    command: 'npx',
    args: ['-y', 'some-harness'],
    prompt: 'task',
    promptTransport: 'argv',
    cwd: CWD,
    timeoutMs: 30,
    spawnFn,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.outcome, 'timeout', 'the delegation must settle as a timeout, not hang');
  assert.match(result.detail, /did not finish within 30ms/);
  assert.equal(child.killSignal, 'SIGKILL');
  // Bounded by the kill grace, not by a client timeout somewhere far above.
  assert.ok(elapsed < 10_000, `settled after ${elapsed}ms`);
});

test('an abort that never produces a close still ends the delegation', async () => {
  class NeverCloses extends FakeChild {
    override kill(): boolean {
      this.killCount += 1;
      this.killSignal = 'SIGKILL';
      return true;
    }
  }
  const child = new NeverCloses({ stdin: false });
  const { spawnFn } = spawnReturning(child);
  const controller = new AbortController();

  const pending = runVendorCommand({
    command: 'npx',
    args: ['-y', 'some-harness'],
    prompt: 'task',
    promptTransport: 'argv',
    cwd: CWD,
    timeoutMs: 60_000,
    signal: controller.signal,
    spawnFn,
  });
  controller.abort();
  const result = await pending;

  assert.equal(result.outcome, 'aborted', 'a Cancel must end the delegation even if the child never closes');
  assert.equal(child.killSignal, 'SIGKILL');
});

test('a process that cannot start is unstartable, with the EPERM hint when that is why', async () => {
  const missing = new FakeChild({ stdin: false });
  missing.failToStart('ENOENT', 'spawn codex ENOENT');
  const result = await runVendorCommand({
    command: 'codex',
    args: [],
    prompt: 'task',
    promptTransport: 'argv',
    cwd: CWD,
    timeoutMs: 5_000,
    ...spawnReturning(missing),
  });
  assert.equal(result.outcome, 'unstartable');
  assert.match(result.detail, /could not start/);
  assert.match(result.detail, /ENOENT/);
  assert.doesNotMatch(result.detail, /sandbox/, 'a missing command is not a sandbox problem');

  // EPERM is the one code with a specific and non-obvious cause, so it is the one
  // that earns an explanation.
  const blocked = new FakeChild({ stdin: false });
  blocked.failToStart('EPERM', 'spawn codex EPERM');
  const blockedResult = await runVendorCommand({
    command: 'codex',
    args: [],
    prompt: 'task',
    promptTransport: 'argv',
    cwd: CWD,
    timeoutMs: 5_000,
    ...spawnReturning(blocked),
  });
  assert.equal(blockedResult.outcome, 'unstartable');
  assert.match(blockedResult.detail, /sandbox/);
  assert.match(blockedResult.detail, /docs\/sandbox\.md/);
});

test('output past the cap is truncated and says so, rather than growing without bound', async () => {
  // 3 MB against a 2 MB cap.
  const huge = 'x'.repeat(3 * 1024 * 1024);
  const result = await runVendorCommand({
    command: 'codex',
    args: [],
    prompt: 'task',
    promptTransport: 'argv',
    cwd: CWD,
    timeoutMs: 10_000,
    ...spawnReturning(childThatSucceeds(huge)),
  });

  assert.equal(result.outcome, 'ok');
  assert.equal(result.stdoutTruncated, true);
  assert.ok(result.stdout.length <= 2 * 1024 * 1024, `captured ${result.stdout.length} bytes`);
});

test('the command line shown to an operator has a placeholder, not the last task', () => {
  // The console shows what the office *intends* to run. Echoing a previous task
  // into a status panel would leak one delegation's text into the description of
  // every other one.
  assert.equal(
    describeVendorCommand('codex', ['exec', '--json'], 'argv'),
    'codex exec --json "<task>"',
  );
  assert.equal(
    describeVendorCommand('some-agent', ['-p'], 'stdin'),
    'some-agent -p < "<task>"',
  );
});

test('a thrown spawn is reported rather than escaping as a rejection', async () => {
  const result = await runVendorCommand({
    command: 'codex',
    args: [],
    prompt: 'task',
    promptTransport: 'argv',
    cwd: CWD,
    timeoutMs: 5_000,
    spawnFn: () => {
      throw new Error('bad options object');
    },
  });
  assert.equal(result.outcome, 'unstartable');
  assert.match(result.detail, /bad options object/);
});
