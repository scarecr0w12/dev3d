/**
 * stdio transport: a peer run as a child process, speaking newline-delimited
 * JSON-RPC over its stdin and stdout.
 *
 * This is how nearly every published MCP server is used — `npx -y
 * @modelcontextprotocol/server-filesystem /path` and its many relatives — so it
 * is the transport that decides whether an integration is useful in practice. It
 * is also exactly what the Agent Client Protocol needs, which is why it lives
 * here rather than under either protocol: an academic distinction about which
 * JSON-RPC dialect is flowing would otherwise have been paid for twice.
 *
 * Two details that are easy to get wrong and expensive to debug:
 *
 *  - **stdout is the wire.** Anything a peer prints there that is not a
 *    JSON-RPC message corrupts the stream, so a line that does not parse is
 *    logged and skipped rather than treated as fatal. Peers do occasionally
 *    print banners.
 *  - **stderr is a diagnostic channel, not a wire.** It is read continuously and
 *    kept in a ring buffer. Both halves matter: leaving it unread can fill the
 *    pipe and wedge the process, and keeping it all would grow without bound.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { ChildLike, JsonRpcTransport, SpawnLike } from './transport.ts';

// Re-exported for the callers that used to find them here. The definitions live
// in `transport.ts` because the one-shot vendor transport needs the same seam.
export type { ChildLike, SpawnLike };

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  /** Extra environment for the child. The parent's environment is inherited. */
  env?: Record<string, string>;
  /** Working directory for the child. */
  cwd?: string;
  /** Max lines of stderr retained for diagnostics. */
  stderrLines?: number;
  /** How long the process has to announce itself before `start` gives up. */
  startTimeoutMs?: number;
  /** Called for every stderr line, so the runtime can surface it. */
  onStderr?: (line: string) => void;
  /** Called for a stdout line that is not JSON. */
  onNoise?: (line: string) => void;
  /** Injected in tests. Defaults to the real `spawn`. */
  spawnFn?: SpawnLike;
}

const DEFAULT_STDERR_LINES = 50;
const DEFAULT_START_TIMEOUT_MS = 15_000;

export class StdioTransport implements JsonRpcTransport {
  readonly label: string;
  private readonly options: StdioTransportOptions;
  private child: ChildLike | null = null;
  private handler: ((raw: unknown) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private stdoutBuffer = '';
  private readonly stderrRing: string[] = [];
  private closed = false;

  constructor(options: StdioTransportOptions) {
    this.options = options;
    const rendered = [options.command, ...(options.args ?? [])].join(' ');
    this.label = `stdio:${rendered}`;
  }

  /** The last lines the server wrote to stderr, for error reporting. */
  get stderrTail(): string[] {
    return [...this.stderrRing];
  }

  async start(): Promise<void> {
    if (this.child !== null) return;
    const spawnFn: SpawnLike =
      this.options.spawnFn ?? (spawn as unknown as SpawnLike);
    const child = spawnFn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // No shell: the command and its arguments are passed as argv, so a server
      // id in a config file cannot smuggle in a shell command.
      shell: false,
    });
    this.child = child;

    // Both are optional in the shared `ChildLike`, because a caller may ignore a
    // descriptor. This transport always pipes them, so the guards are for the
    // type rather than for a case that happens here.
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.consume(chunk));

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const text = line.trimEnd();
        if (text === '') continue;
        this.stderrRing.push(text);
        const max = this.options.stderrLines ?? DEFAULT_STDERR_LINES;
        while (this.stderrRing.length > max) this.stderrRing.shift();
        this.options.onStderr?.(text);
      }
    });

    child.on('error', (err: Error) => {
      // `spawn EPERM` here almost always means the process is confined by a
      // sandbox that forbids piped child stdio, not that the command is missing:
      // a missing command reports ENOENT. Saying so saves the search.
      const hint =
        (err as NodeJS.ErrnoException).code === 'EPERM'
          ? ' — a sandbox that blocks piped child stdio reports EPERM for any command; see docs/sandbox.md'
          : '';
      this.errorHandler?.(
        new Error(`${this.label} could not start: ${err.message}${hint}${this.stderrSuffix()}`),
      );
    });

    child.on('close', (code: number | null, signal: string | null) => {
      if (this.closed) return;
      const how = signal !== null ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      this.errorHandler?.(new Error(`${this.label} exited (${how})${this.stderrSuffix()}`));
    });

    // Wait for the process to either spawn or fail, so a bad command is reported
    // by `connect()` rather than by the first request timing out.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${this.label} did not start within ${this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS}ms.`));
      }, this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
      timer.unref?.();

      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      child.once('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`${this.label} could not start: ${err.message}`));
      });
    });
  }

  send(message: unknown): void {
    // stdin is nullable in the shared `ChildLike`, because a caller may spawn
    // with `stdio: 'ignore'` on that descriptor. This transport always pipes it,
    // so a missing pipe means the child is gone rather than that it was never
    // there - either way there is nothing to write to.
    const stdin = this.child?.stdin ?? null;
    if (this.child === null || stdin === null || stdin.destroyed) {
      throw new Error(`${this.label} is not running.`);
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(handler: (raw: unknown) => void): void {
    this.handler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (child === null) return;

    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    try {
      child.stdin?.end();
    } catch {
      // The pipe may already be gone; nothing to do about it.
    }

    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      // Give it a moment to go, then stop insisting. `unref` keeps this timer
      // from holding the process open if everything else has finished.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          resolve();
        }, 2000);
        timer.unref?.();
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Split a stdout chunk into lines and dispatch each complete one. */
  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line !== '') this.dispatch(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
    // A server that never sends a newline must not be able to grow this buffer
    // without bound.
    if (this.stdoutBuffer.length > 8 * 1024 * 1024) this.stdoutBuffer = '';
  }

  private dispatch(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not JSON: a banner, a stray print. Worth surfacing, never fatal.
      this.options.onNoise?.(line.length > 200 ? `${line.slice(0, 200)}…` : line);
      return;
    }
    this.handler?.(parsed);
  }

  private stderrSuffix(): string {
    if (this.stderrRing.length === 0) return '';
    return `\nlast stderr:\n${this.stderrRing.slice(-5).join('\n')}`;
  }
}
