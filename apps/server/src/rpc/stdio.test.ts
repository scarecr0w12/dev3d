/**
 * The stdio transport's framing.
 *
 * This is the transport every published MCP server is reached through, and it had
 * **no test at all** — because the natural way to test it is to run a child
 * process, and a sandbox that forbids piped child stdio cannot. The `spawnFn` seam
 * exists exactly for that, so these use fake pipes and never start anything.
 *
 * What is pinned here is the framing, because that is the part that fails
 * silently: a line split across two chunks, several lines in one chunk, noise on
 * stdout, and a peer that never sends a newline at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { StdioTransport } from './stdio.ts';
import type { ChildLike, SpawnLike } from './transport.ts';

/** A child whose three pipes the test drives directly. */
class FakeChild extends EventEmitter implements ChildLike {
  readonly written: string[] = [];
  readonly stdout = new EventEmitter() as EventEmitter & { setEncoding(e: string): unknown };
  readonly stderr = new EventEmitter() as EventEmitter & { setEncoding(e: string): unknown };
  killed: string[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdinEnded = false;
  readonly stdin = {
    destroyed: false,
    write: (chunk: string) => {
      this.written.push(chunk);
      return true;
    },
    end: () => {
      this.stdinEnded = true;
      return undefined;
    },
  };

  constructor() {
    super();
    this.stdout.setEncoding = () => this.stdout;
    this.stderr.setEncoding = () => this.stderr;
  }

  /**
   * A well-behaved child: the signal is recorded and the process reports its own
   * exit, which is what lets `close()` resolve without escalating to SIGKILL.
   */
  kill(signal?: NodeJS.Signals): boolean {
    const used = signal ?? 'SIGTERM';
    this.killed.push(used);
    queueMicrotask(() => {
      this.signalCode = used;
      this.emit('close', null, used);
    });
    return true;
  }
}

function harness(): {
  child: FakeChild;
  transport: StdioTransport;
  messages: unknown[];
  noise: string[];
  errors: Error[];
  stderr: string[];
} {
  const child = new FakeChild();
  const messages: unknown[] = [];
  const noise: string[] = [];
  const errors: Error[] = [];
  const stderr: string[] = [];
  const spawnFn: SpawnLike = () => {
    // Real spawn emits this once the process exists; the transport waits for it,
    // so a fake that never does would hang `start()`.
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const transport = new StdioTransport({
    command: 'fake-server',
    spawnFn,
    onNoise: (line) => noise.push(line),
    onStderr: (line) => stderr.push(line),
  });
  transport.onMessage((raw) => messages.push(raw));
  transport.onError((error) => errors.push(error));
  return { child, transport, messages, noise, errors, stderr };
}

test('a message split across two chunks is dispatched once, whole', async () => {
  const h = harness();
  await h.transport.start();

  h.child.stdout.emit('data', '{"jsonrpc":"2.0","id":1,"res');
  assert.deepEqual(h.messages, [], 'a partial line must not be dispatched');
  h.child.stdout.emit('data', 'ult":{"ok":true}}\n');

  assert.deepEqual(h.messages, [{ jsonrpc: '2.0', id: 1, result: { ok: true } }]);
});

test('several messages in one chunk are all dispatched, in order', async () => {
  const h = harness();
  await h.transport.start();

  h.child.stdout.emit('data', '{"id":1}\n{"id":2}\n{"id":3}\n');
  assert.deepEqual(h.messages, [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test('a blank line is skipped rather than parsed as a message', async () => {
  const h = harness();
  await h.transport.start();

  h.child.stdout.emit('data', '\n\n{"id":1}\n\n');
  assert.deepEqual(h.messages, [{ id: 1 }]);
  assert.deepEqual(h.noise, [], 'and is not reported as noise either');
});

test('a non-JSON line is reported as noise and never fatal', async () => {
  const h = harness();
  await h.transport.start();

  // Peers do print banners on stdout; that corrupts the stream but is not a
  // transport failure, so it must not reach the error handler.
  h.child.stdout.emit('data', 'Server listening on port 3000\n{"id":1}\n');
  assert.deepEqual(h.messages, [{ id: 1 }], 'the stream carries on after the banner');
  assert.equal(h.noise.length, 1);
  assert.match(h.noise[0] ?? '', /Server listening/);
  assert.deepEqual(h.errors, []);
});

test('a long noise line is truncated in the report, not printed whole', async () => {
  const h = harness();
  await h.transport.start();

  h.child.stdout.emit('data', `${'x'.repeat(5_000)}\n`);
  assert.equal(h.noise.length, 1);
  assert.ok((h.noise[0] ?? '').length < 300, 'the report is bounded, because it becomes a log line');
});

test('an unterminated stream is discarded *and reported*, not silently dropped', async () => {
  // The regression: the buffer was cleared with no word to anyone, so an operator
  // saw a peer whose replies vanished with no reason why — and the dropped bytes
  // were the only diagnostic there was.
  const h = harness();
  await h.transport.start();

  // 9 MB with no newline in it: over the 8 MB ceiling.
  const flood = 'y'.repeat(9 * 1024 * 1024);
  h.child.stdout.emit('data', flood);

  assert.equal(h.noise.length, 1, 'the discard is reported');
  assert.match(h.noise[0] ?? '', /discarded \d+ bytes with no newline/);
  assert.match(h.noise[0] ?? '', /newline-delimited JSON-RPC/);

  // And the stream resynchronises: the next properly framed message is parsed.
  h.child.stdout.emit('data', '{"id":9}\n');
  assert.deepEqual(h.messages, [{ id: 9 }]);
});

test('a message larger than one chunk is still a single message', async () => {
  // The ceiling bounds an *unterminated* stream, not a large message: a tool
  // result carrying a file is legitimate and must arrive intact.
  const h = harness();
  await h.transport.start();

  const payload = 'z'.repeat(2 * 1024 * 1024);
  h.child.stdout.emit('data', `{"id":1,"result":"${payload.slice(0, 1024 * 1024)}`);
  h.child.stdout.emit('data', `${payload.slice(1024 * 1024)}"}\n`);

  assert.equal(h.messages.length, 1);
  const message = h.messages[0] as { result?: string };
  assert.equal(message.result?.length, payload.length);
  assert.deepEqual(h.noise, [], 'a large but framed message is not noise');
});

test('stderr is kept in a bounded ring and reported as it arrives', async () => {
  const h = harness();
  await h.transport.start();

  h.child.stderr.emit('data', 'one\ntwo\n\nthree\n');
  assert.deepEqual(h.stderr, ['one', 'two', 'three'], 'blank lines are not diagnostics');
  assert.deepEqual(h.transport.stderrTail, ['one', 'two', 'three']);

  // The ring is bounded, so a chatty peer cannot grow it without limit.
  for (let i = 0; i < 100; i += 1) h.child.stderr.emit('data', `line ${i}\n`);
  assert.ok(h.transport.stderrTail.length <= 50, `ring holds ${h.transport.stderrTail.length} lines`);
  assert.equal(h.transport.stderrTail.at(-1), 'line 99', 'and holds the most recent ones');
});

test('a send with no live child throws rather than writing nowhere', async () => {
  const h = harness();
  await h.transport.start();

  h.transport.send({ id: 1 });
  assert.deepEqual(h.child.written, ['{"id":1}\n'], 'one JSON-RPC message, newline framed');

  await h.transport.close();
  assert.throws(() => h.transport.send({ id: 2 }), /not running/);
  assert.equal(h.child.stdinEnded, true, 'closing ends stdin so the peer can exit');
  assert.deepEqual(h.child.killed, ['SIGTERM'], 'and asks it to stop');
});

test('an unexpected exit is reported with the stderr tail attached', async () => {
  const h = harness();
  await h.transport.start();

  h.child.stderr.emit('data', 'fatal: cannot find module\n');
  h.child.emit('close', 1, null);

  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0]?.message ?? '', /exited \(exit code 1\)/);
  assert.match(h.errors[0]?.message ?? '', /cannot find module/, 'the last stderr is what makes it diagnosable');
});

test('closing a transport is idempotent and its own exit is not an error', async () => {
  const h = harness();
  await h.transport.start();

  const first = h.transport.close();
  const second = h.transport.close();
  await Promise.all([first, second]);

  // The close handler was detached, so shutting down on purpose is not reported
  // as the peer dying.
  h.child.emit('close', 0, null);
  assert.deepEqual(h.errors, []);
});
