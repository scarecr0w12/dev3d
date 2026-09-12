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
import type { Tool, ToolContext, ToolResult } from './types.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;

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

function runShellCommand(command: string, timeoutMs: number, ctx: ToolContext): Promise<ToolResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let totalChars = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
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
      child = spawn(command, {
        cwd: ctx.workspaceRoot,
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
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

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* child already gone */
      }
    }, timeoutMs);

    const onAbort = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
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

      const parts: string[] = [];
      if (stdout) parts.push(stdout);
      if (stderr) parts.push(`[stderr]\n${stderr}`);
      let combined = parts.join('\n');
      if (truncated) combined += (combined ? '\n' : '') + '(output truncated)';

      if (timedOut) {
        finish({
          ok: false,
          content: `Command timed out after ${timeoutMs} ms and was killed.\n${combined || '(no output)'}`,
          preview: 'Command timed out',
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

const runShellTool: Tool = {
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
      return await runShellCommand(command, timeoutMs, ctx);
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

export function createShellTools(): Tool[] {
  return [runShellTool];
}
