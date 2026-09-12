/**
 * One-shot command transport: run an external harness, collect what it said.
 *
 * This is the smallest thing that can drive Codex, DeepSeek Harness or Hermes:
 * spawn a process with a prompt, read its stdout, wait for it to exit, and
 * report the exit code. Unlike `mcp/stdio.ts` there is no long-lived connection
 * and no line framing on a live wire - a vendor is invoked per delegation and
 * exits.
 *
 * Four decisions, each of which is a way this goes wrong:
 *
 *  - **`shell: false`.** The command and its arguments are passed as argv, so a
 *    vendor id or a task string cannot smuggle in a shell command. This is the
 *    same rule `mcp/stdio.ts` follows, and it matters more here because part of
 *    the argv is model-authored text.
 *  - **The prompt is data, never a command line.** On `argv` it is appended to
 *    the argument list as one element, so a task containing a quote or a
 *    semicolon is one argument and not three.
 *  - **A timeout that actually kills.** `SIGKILL`, and the promise settles on
 *    `close` rather than on the kill, because a harness that spawned its own
 *    children holds the pipe open. See `docs/external-agents.md` §5.3: a killed
 *    delegation can still leave a running grandchild, and the honest position is
 *    to bound dev3d's patience rather than to claim the machine is quiet.
 *  - **Output is bounded on both streams.** The stdout cap is generous because a
 *    `--json` run is verbose and truncating it mid-stream loses the last event,
 *    which is the one that carries the answer. The stderr ring is small because
 *    it exists to explain a failure, not to be read in full.
 *
 * `spawnFn` is injectable for the same reason `StdioTransport`'s is, and for one
 * more: this environment blocks child processes with piped stdio, so without a
 * seam the entire transport would be untestable. `docs/development.md` records
 * the four existing tests that skip for that reason; everything here runs
 * everywhere.
 */

import { spawn } from 'node:child_process';
import type { ChildLike, SpawnLike } from '../rpc/transport.ts';

// The child-process seam is shared with the stdio transport (`rpc/transport.ts`)
// rather than declared here, so one test double fakes both. It was two nearly
// identical interfaces until the ACP transport arrived and made the duplication
// obvious: a `ChildLike` whose `stdin` could not be null could not describe a
// spawn with `stdio: 'ignore'`, which is exactly what this transport does.

/** 2 MB: a verbose `--json` run fits, and nothing can grow without bound. */
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
/** Kept for diagnosis only, so a small ring is enough. */
const MAX_STDERR_BYTES = 64 * 1024;

export interface VendorRunOptions {
  command: string;
  args?: string[];
  /** The task text. Data, never parsed as shell syntax. */
  prompt: string;
  /** `argv` appends the prompt as one argument; `stdin` writes it and closes the pipe. */
  promptTransport: 'argv' | 'stdin';
  /** Working directory. Always the run's workspace, never the repository. */
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Injected in tests. Defaults to the real `spawn`. */
  spawnFn?: SpawnLike;
}

export type VendorRunOutcome =
  | 'ok'
  | 'failed'
  /** The process did not finish in time and was killed. */
  | 'timeout'
  /** The operator cancelled the run. */
  | 'aborted'
  /** The process could not be started at all. */
  | 'unstartable';

export interface VendorRunResult {
  outcome: VendorRunOutcome;
  /** Null when the process never started. */
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** True when stdout hit the cap and the tail is missing. */
  stdoutTruncated: boolean;
  durationMs: number;
  /** A one-line, human-readable reason. Empty on success. */
  detail: string;
}

/** A rendering of the command line, for the console. Never executed from here. */export function describeVendorCommand(
  command: string,
  args: string[],
  promptTransport: 'argv' | 'stdin',
): string {
  const parts = [command, ...args];
  // The prompt is shown as a placeholder: an operator needs to see the shape of
  // the invocation, not a screenful of whatever task was last delegated.
  parts.push(promptTransport === 'argv' ? '"<task>"' : '< "<task>"');
  return parts.join(' ');
}

export function runVendorCommand(options: VendorRunOptions): Promise<VendorRunResult> {
  const started = Date.now();
  const spawnFn: SpawnLike = options.spawnFn ?? (spawn as unknown as SpawnLike);
  const args = [...(options.args ?? [])];
  if (options.promptTransport === 'argv') args.push(options.prompt);

  const label = `${options.command} ${(options.args ?? []).join(' ')}`.trim();

  return new Promise<VendorRunResult>((resolve) => {
    let child: ChildLike | null = null;
    let settled = false;
    let timedOut = false;
    let spawnError: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;

    /**
     * Settle exactly once.
     *
     * Both `error` and `close` can arrive, and on some platforms `close` can
     * arrive without `error`, so this is the only place either is turned into a
     * result. Everything else - the timer, the abort listener - is released
     * here, which is what stops a long-lived run from leaking a listener per
     * delegation.
     */
    function settle(result: VendorRunResult): void {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    }

    function killIfPossible(): void {
      try {
        child?.kill('SIGKILL');
      } catch {
        // The process may already be gone; nothing to do about it.
      }
    }

    function onAbort(): void {
      killIfPossible();
    }

    try {
      child = spawnFn(options.command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        // stdin is a pipe only when the prompt goes there; otherwise it is
        // closed, so a harness that reads stdin does not block waiting for
        // input that is never coming.
        stdio: [options.promptTransport === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      // `spawn` itself rarely throws - a missing binary arrives as an `error`
      // event - but a bad options object does, and letting it escape would turn
      // a programming error into an unhandled rejection.
      settle(finish('unstartable', null, null, '', '', false, started, `${label} could not be started: ${errMsg(e)}`));
      return;
    }

    const onStdout = (chunk: string): void => {
      if (stdout.length >= MAX_STDOUT_BYTES) {
        stdoutTruncated = true;
        return;
      }
      stdout += chunk;
      if (stdout.length > MAX_STDOUT_BYTES) {
        stdout = stdout.slice(0, MAX_STDOUT_BYTES);
        stdoutTruncated = true;
      }
    };
    const onStderr = (chunk: string): void => {
      stderr += chunk;
      if (stderr.length > MAX_STDERR_BYTES) stderr = stderr.slice(-MAX_STDERR_BYTES);
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', onStdout);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', onStderr);

    child.on('error', (err: Error) => {
      spawnError = errMsg(err);
      // A spawn failure never fires `close`, so this is the only chance to
      // settle - and the `EPERM` hint is worth more than the raw code, because
      // a sandbox that blocks piped child stdio reports EPERM for *any*
      // command, including one that exists.
      settle(
        finish(
          'unstartable',
          null,
          null,
          stdout,
          stderr,
          stdoutTruncated,
          started,
          (err as NodeJS.ErrnoException).code === 'EPERM'
            ? `${label} could not start: EPERM - a sandbox that blocks piped child stdio reports EPERM for any command; see docs/sandbox.md`
            : `${label} could not start: ${spawnError}`,
        ),
      );
    });

    child.on('close', (code: number | null, signal: string | null) => {
      const outcome: VendorRunOutcome = options.signal?.aborted
        ? 'aborted'
        : timedOut
          ? 'timeout'
          : code === 0
            ? 'ok'
            : 'failed';
      const detail =
        outcome === 'ok'
          ? ''
          : outcome === 'aborted'
            ? 'Cancelled by the operator.'
            : outcome === 'timeout'
              ? `${label} did not finish within ${options.timeoutMs}ms and was killed.`
              : spawnError !== null
                ? `${label} could not start: ${spawnError}`
                : `${label} exited with code ${code ?? 'unknown'}${signal !== null ? ` (signal ${signal})` : ''}${stderrSuffix(stderr)}`;
      settle(finish(outcome, code, signal, stdout, stderr, stdoutTruncated, started, detail));
    });

    timer = setTimeout(() => {
      timedOut = true;
      killIfPossible();
    }, options.timeoutMs);

    if (options.signal) {
      // An already-aborted signal never fires its event, so the check and the
      // listener are both required.
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    if (options.promptTransport === 'stdin' && child.stdin) {
      try {
        child.stdin.write(options.prompt);
        child.stdin.end();
      } catch {
        // The pipe may already be gone if the process died immediately; the
        // close handler reports the exit code, which is the useful half.
      }
    }
  });
}

function finish(
  outcome: VendorRunOutcome,
  exitCode: number | null,
  signal: string | null,
  stdout: string,
  stderr: string,
  stdoutTruncated: boolean,
  started: number,
  detail: string,
): VendorRunResult {
  return {
    outcome,
    exitCode,
    signal,
    stdout,
    stderr,
    stdoutTruncated,
    durationMs: Date.now() - started,
    detail,
  };
}

/** The last few stderr lines, as a suffix for a failure message. */
function stderrSuffix(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');
  if (lines.length === 0) return '';
  return `\nlast stderr:\n${lines.slice(-5).join('\n')}`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
