/**
 * `git`: repository inspection, and — behind approval — saving work.
 *
 * Every other way an employee could reach git is `run_shell`, which is
 * approval-gated because it can do anything. That made the most common question
 * in development work, "what have I actually changed?", the most expensive one to
 * ask, and it is asked constantly. So inspection is here, un-gated, because it
 * cannot write.
 *
 * Saving work is the other half. An employee that writes files and cannot commit
 * them leaves the run's product in a working tree nobody recorded, so commits are
 * available here too — through the same human approval `run_shell` uses, because
 * a commit is a change to the repository and the point of the gate is that a
 * person sees those. `autoApproveShell` covers it, so an unattended run is not
 * blocked by a question nobody is there to answer.
 *
 * Arguments are passed to git as an argv array rather than through a shell, so
 * there is no quoting or metacharacter surface at all.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';

const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_CHARS = 20_000;

/** Subcommands an employee may run without asking. Read-only by construction. */
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
 * Subcommands that change the repository, and so ask a human first.
 *
 * `checkout` and `restore` are deliberately absent even though they are ordinary
 * development commands: both can throw away uncommitted work, which no approval
 * prompt can undo. Creating a branch is here (`checkout -b`) because it discards
 * nothing, and switching an existing branch is not.
 */
const WRITE_SUBCOMMANDS = new Set(['add', 'commit', 'stash', 'cherry-pick', 'tag']);

/**
 * Arguments refused even with approval.
 *
 * These are the ones that destroy work or evade review, as opposed to merely
 * changing the repository. A commit is a change a person can see and revert; a
 * `reset --hard` is not, and `--no-verify` skips the hooks a project installed
 * precisely to run before a commit lands.
 */
const FORBIDDEN_ARGS = new Set([
  '--hard',
  '--force',
  '-f',
  '--no-verify',
  '--output',
  '--exec',
  '--upload-pack',
  '--receive-pack',
  'clean',
]);

/**
 * Arguments that are only refused on the read-only path.
 *
 * `git stash` with no verb lists stashes; `git stash push` discards the working
 * tree. On the write path the verb is the point, so it is allowed there and
 * refused here — which is a smaller and more auditable rule than trying to
 * enumerate everything safe.
 */
const READ_ONLY_FORBIDDEN = new Set([
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
  '--soft',
  '--mixed',
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

/**
 * Is this invocation something a human should see before it runs?
 *
 * `stash` and `tag` are in both lists because they have a read-only form and a
 * writing one: bare `git stash` lists, `git stash push` saves and clears the
 * working tree, bare `git tag` lists, `git tag v1` creates.
 */
function isWrite(command: string, extra: string[]): boolean {
  if (command === 'stash') return extra[0] !== undefined && extra[0] !== 'list';
  if (command === 'tag') return extra.some((a) => !a.startsWith('-')) || extra.includes('-d');
  return WRITE_SUBCOMMANDS.has(command);
}

const gitTool: Tool = {
  name: 'git',
  description:
    'Work with the git repository in the workspace. Inspection never asks: status, ' +
    'diff, log, show, branch, ls-files, blame, shortlog, describe, tag (list), ' +
    'remote, stash (list). Saving work asks a human first, like run_shell: add, ' +
    'commit, checkout -b, cherry-pick, tag, stash push/pop. Arguments that destroy ' +
    'work or skip hooks (--hard, --force, --no-verify) are refused outright. ' +
    'Prefer this to run_shell for anything git.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        enum: [...new Set([...READ_ONLY_SUBCOMMANDS, ...WRITE_SUBCOMMANDS, 'checkout'])],
        description: 'The git subcommand to run.',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Extra arguments passed to git verbatim, e.g. ["--stat"] or ["-m", "the message"].',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const command = typeof args.command === 'string' ? args.command : '';

    let extra: string[] = [];
    if (args.args !== undefined) {
      if (!Array.isArray(args.args) || args.args.some((a) => typeof a !== 'string')) {
        return fail('git: "args" must be an array of strings.');
      }
      extra = args.args as string[];
    }

    // `checkout` is special-cased rather than listed: creating a branch discards
    // nothing and is a normal part of saving work, while switching to an existing
    // branch can drop uncommitted changes on the floor. Only `-b`/`-B` is allowed.
    const isBranchCreate =
      command === 'checkout' && (extra[0] === '-b' || extra[0] === '-B') && extra.length >= 2;

    const known =
      READ_ONLY_SUBCOMMANDS.has(command) || WRITE_SUBCOMMANDS.has(command) || isBranchCreate;
    if (!known) {
      return fail(
        command === 'checkout'
          ? 'git: only `checkout -b <name>` is available, because switching to an existing branch ' +
            'can discard uncommitted work. Use run_shell if you need more, which asks a human first.'
          : `git: "${command}" is not available. Inspection (no approval): ${[...READ_ONLY_SUBCOMMANDS].join(', ')}. ` +
            `Writing (approval): ${[...WRITE_SUBCOMMANDS].join(', ')}, checkout -b. ` +
            `Anything else needs run_shell.`,
        'Unsupported subcommand',
      );
    }

    const hardForbidden = extra.find((a) => FORBIDDEN_ARGS.has(a));
    if (hardForbidden !== undefined) {
      return fail(
        `git: refusing the argument ${JSON.stringify(hardForbidden)} - it destroys work or skips the ` +
          `hooks this repository installed. Do it deliberately in a shell if you really mean it.`,
        'Refused a destructive argument',
      );
    }

    const write = isWrite(command, extra) || isBranchCreate;
    if (!write) {
      const readOnlyForbidden = extra.find((a) => READ_ONLY_FORBIDDEN.has(a));
      if (readOnlyForbidden !== undefined) {
        return fail(
          `git: refusing the argument ${JSON.stringify(readOnlyForbidden)} on the inspection path. ` +
            `It changes the repository, so it needs approval - call git again with a subcommand that writes.`,
          'Refused a mutating argument',
        );
      }
    }

    if (!withinRepo(ctx.workspaceRoot)) {
      return fail(
        `git: the workspace ${ctx.workspaceRoot} is not a git repository (no .git directory).`,
        'Not a repository',
      );
    }

    if (write && !ctx.autoApproveShell) {
      const rendered = [command, ...extra].join(' ');
      const approved = await ctx.requestApproval({
        kind: 'shell',
        summary: `git ${rendered}`,
        detail:
          `An employee wants to change the git repository in ${ctx.workspaceRoot}:\n\n` +
          `    git ${rendered}\n\n` +
          `Commits and branch changes are recorded in the repository's history and can be reverted, ` +
          `but nothing else in this office writes to git, so this is the change a human should see.`,
      });
      if (!approved) {
        return fail(
          `git ${rendered} was not approved, so the repository is unchanged.`,
          'Refused by the operator',
        );
      }
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
