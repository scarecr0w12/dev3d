/**
 * `git`: read-only repository inspection.
 *
 * Every other way an employee can learn what changed in the workspace is
 * `run_shell`, which is approval-gated because it can do anything. That makes
 * the most common question in development work — "what have I actually changed?"
 * the most expensive one to ask, and it is asked constantly.
 *
 * So this tool exists, and it is limited to commands that cannot write: no
 * `checkout`, no `commit`, no `stash`, no `clean`, no arguments that redirect
 * output or run a program. Anything that changes the repository still goes
 * through `run_shell` and its approval, which is the point.
 *
 * Arguments are passed to git as an argv array rather than through a shell, so
 * there is no quoting or metacharacter surface at all.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ToolResult } from './types.ts';

const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_CHARS = 20_000;

/** Subcommands an employee may run. Read-only by construction. */
const READ_ONLY_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'branch',
  'rev-parse',
  'ls-files',
  'blame',
  'shortlog',
  'describe',
  'tag',
  'remote',
  'stash',
]);

/**
 * Subcommands that are in the allow-list above but have a mutating form.
 *
 * `git stash` with no verb lists stashes, but `git stash push` discards the
 * working tree; `git branch -d` deletes. Rather than removing the read-only
 * value, the mutating verbs and flags are refused explicitly, which is a smaller
 * and more auditable rule than trying to enumerate everything safe.
 */
const FORBIDDEN_ARGS = new Set([
  'push',
  'pop',
  'drop',
  'clear',
  'save',
  '-d',
  '-D',
  '--delete',
  '-m',
  '-M',
  '--move',
  '-c',
  '-C',
  '--create',
  '--set-upstream-to',
  '-u',
  '--edit-description',
  '--force',
  '-f',
  '--hard',
  '--soft',
  '--mixed',
  '--output',
  '--exec',
  '--upload-pack',
  '--receive-pack',
  '--no-index',
]);

interface GitRun {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  spawnError: string | null;
}

function runGit(args: string[], cwd: string): Promise<GitRun> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let total = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (run: Partial<GitRun>): void => {
      if (settled) return;
      settled = true;
      resolve({ code: null, stdout, stderr, truncated, timedOut, spawnError: null, ...run });
    };

    let child;
    try {
      child = spawn('git', args, {
        cwd,
        // No shell: arguments reach git as an argv array, so nothing an employee
        // writes can be interpreted as a command or a redirect.
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Keep output stable and parseable: no colour, no pager, no prompts.
          GIT_PAGER: 'cat',
          GIT_TERMINAL_PROMPT: '0',
          NO_COLOR: '1',
        },
      });
    } catch (e) {
      finish({ spawnError: e instanceof Error ? e.message : String(e) });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);

    const append = (buf: Buffer, isErr: boolean): void => {
      if (truncated) return;
      const chunk = buf.toString();
      const remaining = MAX_OUTPUT_CHARS - total;
      if (chunk.length > remaining) {
        const part = chunk.slice(0, Math.max(0, remaining));
        if (isErr) stderr += part;
        else stdout += part;
        total += part.length;
        truncated = true;
      } else {
        if (isErr) stderr += chunk;
        else stdout += chunk;
        total += chunk.length;
      }
    };

    child.stdout?.on('data', (b: Buffer) => append(b, false));
    child.stderr?.on('data', (b: Buffer) => append(b, true));
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ spawnError: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code });
    });
  });
}

function fail(content: string, preview = 'Error'): ToolResult {
  return { ok: false, content, preview, affectsPaths: [] };
}

/** Does this directory (or any parent within the workspace) hold a repository? */
function withinRepo(root: string): boolean {
  return existsSync(join(root, '.git'));
}

const gitTool: Tool = {
  name: 'git',
  description:
    'Inspect the git repository in the workspace, read-only: status, diff, log, ' +
    'show, branch, ls-files, blame, shortlog, describe, tag, remote, and bare ' +
    '`stash` (list). Use this instead of run_shell for looking at what changed. ' +
    'Anything that writes - commit, checkout, stash push, branch -d - needs ' +
    'run_shell and its approval.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        enum: [...READ_ONLY_SUBCOMMANDS],
        description: 'The git subcommand to run.',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Extra arguments passed to git verbatim, e.g. ["--stat"] or ["-n", "20", "--oneline"].',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const command = typeof args.command === 'string' ? args.command : '';
    if (!READ_ONLY_SUBCOMMANDS.has(command)) {
      return fail(
        `git: "${command}" is not available read-only. Choose one of: ${[...READ_ONLY_SUBCOMMANDS].join(', ')}. ` +
          `To change the repository, use run_shell, which asks a human first.`,
        'Not a read-only command',
      );
    }

    let extra: string[] = [];
    if (args.args !== undefined) {
      if (!Array.isArray(args.args) || args.args.some((a) => typeof a !== 'string')) {
        return fail('git: "args" must be an array of strings.');
      }
      extra = args.args as string[];
    }
    const forbidden = extra.find((a) => FORBIDDEN_ARGS.has(a));
    if (forbidden !== undefined) {
      return fail(
        `git: refusing the argument ${JSON.stringify(forbidden)} - it changes the repository. ` +
          `Use run_shell with its approval round trip instead.`,
        'Refused a mutating argument',
      );
    }

    if (!withinRepo(ctx.workspaceRoot)) {
      return fail(
        `git: the workspace ${ctx.workspaceRoot} is not a git repository (no .git directory).`,
        'Not a repository',
      );
    }

    const run = await runGit([command, ...extra], ctx.workspaceRoot);
    if (run.spawnError !== null) {
      return fail(
        `git could not be started: ${run.spawnError}. Is git installed and on PATH?`,
        'git unavailable',
      );
    }
    if (run.timedOut) {
      return fail(`git ${command} did not finish within ${TIMEOUT_MS / 1000}s and was stopped.`, 'Timed out');
    }

    const body = [run.stdout.trim(), run.stderr.trim()].filter(Boolean).join('\n');
    const suffix = run.truncated ? `\n(output truncated at ${MAX_OUTPUT_CHARS} characters)` : '';
    if (run.code !== 0) {
      // A non-zero exit is ordinary here - `git diff` with no changes, a path
      // that does not exist - so it is reported as a result the model can read,
      // not as a tool failure.
      return {
        ok: true,
        content: `git ${[command, ...extra].join(' ')} exited ${run.code}:\n${body || '(no output)'}${suffix}`,
        preview: `git ${command} (exit ${run.code})`,
        affectsPaths: [],
      };
    }
    if (body === '') {
      return {
        ok: true,
        content: `git ${[command, ...extra].join(' ')} produced no output.`,
        preview: `git ${command}: no output`,
        affectsPaths: [],
      };
    }
    return {
      ok: true,
      content: body + suffix,
      preview: `git ${command}`,
      affectsPaths: [],
    };
  },
};

export function createGitTools(): Tool[] {
  return [gitTool];
}
