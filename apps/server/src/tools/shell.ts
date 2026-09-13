/**
 * The shell tool. This is the most dangerous tool an employee can hold, so it
 * is the only one that goes through a human approval round trip before it runs
 * (unless the run is configured to auto-approve shell commands).
 *
 * Windows note: `spawn(command, { shell: true })` runs the command through
 * `cmd.exe` semantics, so `&&`, `|`, `>`, and `%VAR%` all behave the way a
 * Windows developer expects.
 */

import { spawn } from 'node:child_process';
import { childEnv } from '../security/childEnv.ts';
import { killProcessTree, type KillableChild, type KillTreeFn } from '../security/processTree.ts';
import type { Tool, ToolContext, ToolResult } from './types.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;

/**
 * How long to wait for `close` after a kill before settling anyway.
 *
 * The timeout is a ceiling on the command, so it has to actually end the call. It
 * did not: the promise settled only on `close`, and `close` waits for the stdio
 * pipes — which a *surviving grandchild* holds open, because it inherited them.
 * So a command that started a background process left `run_shell` hanging with
 * `timedOut` already true, and with it the turn and the run. This is the same
 * wedge the vendor transport hit, fixed the same way.
 */
const KILL_GRACE_MS = 2_000;

/** The slice of `spawn` this tool uses, so a test can drive it without a child. */
export type ShellSpawnFn = (
  command: string,
  options: Record<string, unknown>,
) => KillableChild & {
  stdout?: { on(event: 'data', handler: (chunk: Buffer) => void): unknown } | null;
  stderr?: { on(event: 'data', handler: (chunk: Buffer) => void): unknown } | null;
  on(event: 'error', handler: (error: Error) => void): unknown;
  on(event: 'close', handler: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
};

export interface ShellToolOptions {
  /** Injected in tests. Defaults to the real `spawn`. */
  spawnFn?: ShellSpawnFn;
  /** Injected in tests. Defaults to `killProcessTree`. */
  killTree?: KillTreeFn;
  /** Overridden in tests, which should not wait two seconds per case. */
  killGraceMs?: number;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toInt(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return fallback;
}

function runShellCommand(
  command: string,
  timeoutMs: number,
  ctx: ToolContext,
  options: ShellToolOptions,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let totalChars = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | null = null;

    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      if (graceTimer !== null) clearTimeout(graceTimer);
      resolve(result);
    };

    const append = (buf: Buffer, isErr: boolean): void => {
      if (truncated) return;
      const chunk = buf.toString();
      const remaining = MAX_OUTPUT_CHARS - totalChars;
      if (chunk.length > remaining) {
        const part = chunk.slice(0, Math.max(0, remaining));
        if (isErr) stderr += part;
        else stdout += part;
        totalChars += part.length;
        truncated = true;
      } else {
        if (isErr) stderr += chunk;
        else stdout += chunk;
        totalChars += chunk.length;
      }
    };

    let child;
    try {
      child = (options.spawnFn ?? (spawn as unknown as ShellSpawnFn))(command, {
        cwd: ctx.workspaceRoot,
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Provider credentials are withheld: a shell command is model-authored,
        // and the approval prompt is about the command, not about the fact that
        // it could otherwise read every API key the office holds.
        env: childEnv(),
      });
    } catch (e) {
      finish({
        ok: false,
        content: `Failed to start shell: ${errMsg(e)}`,
        preview: 'Shell failed to start',
        affectsPaths: [],
      });
      return;
    }

    child.stdout?.on('data', (d: Buffer) => append(d, false));
    child.stderr?.on('data', (d: Buffer) => append(d, true));

    const killTree = options.killTree ?? killProcessTree;

    /**
     * Report the command finished after a kill, whether or not `close` arrives.
     *
     * `close` is the *good* ending and still wins the race when it comes: the
     * grace period only decides the case where a grandchild is holding the pipes
     * open and nothing will ever fire. The result is built when the grace period
     * expires rather than when the kill happens, so whatever the command printed
     * in between is still in it — the output is the only evidence the operator
     * has of what the command did before it was stopped.
     */
    const settleAfterKill = (build: () => ToolResult): void => {
      graceTimer = setTimeout(() => finish(build()), options.killGraceMs ?? KILL_GRACE_MS);
      graceTimer.unref?.();
    };

    const killNow = (): void => {
      killTree(child as unknown as KillableChild);
    };

    /** The output collected so far, as the tail of a result. */
    const collected = (): string => {
      const parts: string[] = [];
      if (stdout) parts.push(stdout);
      if (stderr) parts.push(`[stderr]\n${stderr}`);
      let combined = parts.join('\n');
      if (truncated) combined += (combined ? '\n' : '') + '(output truncated)';
      return combined;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killNow();
      settleAfterKill(() => ({
        ok: false,
        content:
          `Command timed out after ${timeoutMs} ms and was killed, with whatever it had printed so far.\n` +
          `${collected() || '(no output)'}\n` +
          'A process it started may still be running: only the command itself is ended, and anything it ' +
          'left behind is not part of this result.',
        preview: 'Command timed out',
        affectsPaths: [],
      }));
    }, timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      killNow();
      // The same wedge, reached by cancelling instead of by timing out: a kill
      // that never produces `close` must still end the tool call, or a cancelled
      // run hangs on a tool that is already dead.
      settleAfterKill(() => ({
        ok: false,
        content: `The run was cancelled while this command was running, so it was killed.\n${collected() || '(no output)'}`,
        preview: 'Command cancelled',
        affectsPaths: [],
      }));
    };
    if (ctx.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      finish({
        ok: false,
        content: `Failed to run shell command: ${err.message}`,
        preview: 'Shell failed',
        affectsPaths: [],
      });
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      const combined = collected();

      if (timedOut) {
        // The command ended on its own after the kill: better than the grace
        // fallback, because `close` means no grandchild is still holding the
        // pipes and the output collected here is complete.
        finish({
          ok: false,
          content: `Command timed out after ${timeoutMs} ms and was killed.\n${combined || '(no output)'}`,
          preview: 'Command timed out',
          affectsPaths: [],
        });
        return;
      }

      if (aborted) {
        finish({
          ok: false,
          content: `The run was cancelled while this command was running, so it was killed.\n${combined || '(no output)'}`,
          preview: 'Command cancelled',
          affectsPaths: [],
        });
        return;
      }

      const exitCode = code ?? (signal ? 1 : 0);
      const ok = exitCode === 0;
      finish({
        ok,
        content: `exit code: ${exitCode}${signal ? ` (signal ${signal})` : ''}\n${combined || '(no output)'}`,
        preview: ok ? 'Command succeeded' : `Command failed (exit ${exitCode})`,
        affectsPaths: [],
      });
    });
  });
}

function createRunShellTool(options: ShellToolOptions): Tool {
  return {
    name: 'run_shell',
  description:
    'Run a shell command inside the workspace. The command runs through the platform shell ' +
    '(cmd.exe on Windows) with the workspace root as the working directory. ' +
    'Defaults to a 30s timeout (hard max 120s). This tool usually requires human approval before it runs.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 30000, max 120000).' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    if (typeof args.command !== 'string' || args.command.trim() === '') {
      return {
        ok: false,
        content: 'run_shell requires a non-empty "command" string.',
        preview: 'Missing command',
        affectsPaths: [],
      };
    }
    const command = args.command;
    let timeoutMs = toInt(args.timeoutMs, DEFAULT_TIMEOUT_MS);
    timeoutMs = Math.min(Math.max(timeoutMs, 1), MAX_TIMEOUT_MS);

    if (!ctx.autoApproveShell) {
      const firstLine = command.trim().split(/\r?\n/)[0] ?? command.trim();
      let approved = false;
      try {
        approved = await ctx.requestApproval({
          kind: 'shell',
          summary: firstLine.slice(0, 200),
          detail: `Command:\n${command}\n\nWorking directory:\n${ctx.workspaceRoot}`,
        });
      } catch {
        approved = false;
      }
      if (!approved) {
        return {
          ok: false,
          content:
            'The human declined to run this shell command. Do not retry the same command; ' +
            'ask for clarification or propose a non-shell alternative.',
          preview: 'Shell command declined',
          affectsPaths: [],
        };
      }
    }

    try {
      return await runShellCommand(command, timeoutMs, ctx, options);
    } catch (e) {
      return {
        ok: false,
        content: `run_shell failed: ${errMsg(e)}`,
        preview: 'Shell failed',
        affectsPaths: [],
      };
    }
    },
  };
}
export function createShellTools(options: ShellToolOptions = {}): Tool[] {
  return [createRunShellTool(options)];
}
