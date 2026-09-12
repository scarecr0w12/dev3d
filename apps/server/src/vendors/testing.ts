/**
 * A scripted child process, for testing the vendor transport.
 *
 * This is the seam that makes `vendors/command.ts` testable at all. Two reasons
 * it has to exist rather than using a real `spawn`:
 *
 *  - **This environment blocks child processes with piped stdio**, which is what
 *    capturing a command's output requires. `docs/development.md` records the
 *    four existing tests that skip for that reason.
 *  - The interesting paths are the ones a real process will not perform on
 *    demand: a process that never exits, one that fails to start at all, one that
 *    writes to stderr and then dies, one that prints more than the cap.
 *
 * It lives in `src` rather than beside the tests for the same reason
 * `llm/mock.ts` does: it is a *seam* the production code deliberately accepts, not
 * a fixture bolted on afterwards. `SpawnLike` is an interface the transport
 * declares, and this is the reference implementation of it.
 *
 * **Everything emits asynchronously.** The transport attaches its listeners
 * synchronously after `spawn` returns, exactly as Node's real `ChildProcess`
 * expects, so a fake that emitted during the `spawn` call would have its output
 * dropped and its exit missed - which would look like a transport bug.
 */

import { EventEmitter } from 'node:events';
import type { ChildLike, SpawnLike } from '../rpc/transport.ts';

/** The slice of a readable stream the transport touches. */
class FakeStream extends EventEmitter {
  encoding: string | null = null;
  setEncoding(encoding: string): this {
    this.encoding = encoding;
    return this;
  }
}

class FakeStdin {
  destroyed = false;
  readonly written: string[] = [];
  /**
   * Called for every write, so a test can make a fake child *speak a protocol*.
   *
   * Overridable per instance rather than fixed: the ACP tests need a child that
   * answers JSON-RPC requests on its stdout, and that is behaviour, not fixture.
   */
  onWrite: ((chunk: string) => void) | null = null;
  write(chunk: string): boolean {
    this.written.push(chunk);
    this.onWrite?.(chunk);
    return true;
  }
  end(): void {
    this.destroyed = true;
  }
}

export class FakeChild extends EventEmitter implements ChildLike {
  readonly stdin: FakeStdin | null;
  readonly stdout: FakeStream | null;
  readonly stderr: FakeStream | null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** Set when the transport kills it, so a timeout test can assert the signal. */
  killSignal: NodeJS.Signals | null = null;
  killCount = 0;
  /** True once `failToStart` has been called, which suppresses the spawn event. */
  private failed = false;

  constructor(options: { stdin?: boolean; stdout?: boolean; stderr?: boolean } = {}) {
    super();
    this.stdin = options.stdin === true ? new FakeStdin() : null;
    this.stdout = options.stdout === false ? null : new FakeStream();
    this.stderr = options.stderr === false ? null : new FakeStream();
    // A real `ChildProcess` emits `spawn` once the process is up, and
    // `StdioTransport.start()` waits for exactly that before it will carry a
    // message. Without it the transport sits until its start timeout, which looks
    // like a broken client rather than a thin double.
    queueMicrotask(() => {
      if (this.failed) return;
      this.emit('spawn');
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killCount += 1;
    this.killSignal = signal ?? 'SIGTERM';
    // A real SIGKILL is not instantaneous either; deferring the close keeps the
    // transport's ordering assumptions honest.
    if (this.exitCode === null && this.signalCode === null) {
      queueMicrotask(() => this.closeWith(null, signal ?? 'SIGTERM'));
    }
    return true;
  }

  /** Emit output, then exit. */
  emitData(stdout: string, stderr = ''): void {
    queueMicrotask(() => {
      if (stdout !== '') this.stdout?.emit('data', stdout);
      if (stderr !== '') this.stderr?.emit('data', stderr);
    });
  }

  closeWith(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = signal === null ? code : null;
    this.signalCode = signal;
    this.emit('close', code, signal);
  }

  /** Report that the process could not be started at all. */
  failToStart(code = 'ENOENT', message = 'spawn fake ENOENT'): void {
    // Suppress the pending `spawn`: a process that failed to start never spawned,
    // and emitting both would let a caller treat a dead child as a live one.
    this.failed = true;
    queueMicrotask(() => {
      const error = new Error(message) as NodeJS.ErrnoException;
      error.code = code;
      this.emit('error', error);
    });
  }
}

/** What one `spawn` call was asked to do, recorded for assertions. */
export interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

/**
 * Build a `SpawnLike` that always returns the same child.
 *
 * Only correct for a **single** spawn. A `FakeChild` can close exactly once - as
 * a real process does - so a second `spawn` returning the same object would hang
 * forever waiting for a close that has already happened. For anything that both
 * probes and delegates, use `spawnEach`.
 *
 * `calls` is the useful half: a test can assert the exact argv a vendor was
 * invoked with, which is where a preset's argument order either is or is not
 * right.
 */
export function spawnReturning(
  child: FakeChild,
  calls: SpawnCall[] = [],
): { spawnFn: SpawnLike; calls: SpawnCall[] } {
  const spawnFn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
  return { spawnFn, calls };
}

/**
 * Build a `SpawnLike` that makes a fresh child for every call.
 *
 * This is what a probe-then-delegate test needs: the probe is one process and the
 * delegation is another, and they cannot share a body.
 */
export function spawnEach(
  make: () => FakeChild,
  calls: SpawnCall[] = [],
): { spawnFn: SpawnLike; calls: SpawnCall[] } {
  const spawnFn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, options });
    return make();
  };
  return { spawnFn, calls };
}

/** A child that prints `stdout`, optionally complains on stderr, and exits 0. */
export function childThatSucceeds(stdout: string, stderr = ''): FakeChild {
  const child = new FakeChild({ stdin: false });
  child.emitData(stdout, stderr);
  queueMicrotask(() => child.closeWith(0));
  return child;
}

/** A child that exits non-zero with a message, which is what a bad arg list does. */
export function childThatFails(stderr: string, code = 1): FakeChild {
  const child = new FakeChild({ stdin: false });
  child.emitData('', stderr);
  queueMicrotask(() => child.closeWith(code));
  return child;
}

/**
 * A child that starts and then never exits.
 *
 * The case the timeout exists for, and the one a real harness produces when its
 * approval layer fails closed or it blocks on a prompt nobody can answer.
 */
export function childThatHangs(): FakeChild {
  return new FakeChild({ stdin: false });
}
