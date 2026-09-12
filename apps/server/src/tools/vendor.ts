/**
 * The delegation tool: handing a piece of work to a third-party vendor.
 *
 * One tool per configured vendor, published as `agent__<vendorId>__delegate`, so
 * a role's grant names the vendor it may reach and nothing else. An employee with
 * Codex granted cannot accidentally engage Hermes, which is the same per-role
 * deliberate grant MCP tools get and for the same reason: a vendor is somebody
 * else's process with somebody else's idea of what is safe.
 *
 * ## Why there is no blanket approval gate, and why one appears anyway
 *
 * `run_shell` asks a human every time because a shell can do anything. A
 * *read-only* delegation cannot: it reads the workspace and answers, which is the
 * risk class of `read_file` and `web_fetch`, neither of which is gated.
 *
 * But dev3d cannot actually guarantee read-only for every vendor. Codex takes a
 * real sandbox mode (`-s read-only`) and enforces it; DSH and Hermes expose no
 * documented equivalent, so for them read-only is a request the harness is free
 * to ignore. `VendorCapabilities.enforcesReadOnly` is the field that records
 * which of those two worlds this is - and this tool is where it stops being a
 * badge and becomes a gate:
 *
 *     enforced   ->  the office can promise it, so no human is asked
 *     requested  ->  the office cannot, so a human is asked first
 *
 * That is the whole point of declaring the capability honestly. A flag that
 * changed nothing on screen would be decoration; this one decides whether an
 * unconfined external process is allowed to touch a workspace unattended.
 *
 * The existing `autoApproveShell` switch is what an operator uses to say "I trust
 * unattended execution" once, rather than a second near-identical setting being
 * invented for this feature.
 */

import type { Tool, ToolContext, ToolResult } from './types.ts';
import { toWorkspaceRelative } from './paths.ts';
import { vendorToolName, type VendorRegistry } from '../vendors/registry.ts';

/**
 * How much of a vendor's answer is kept.
 *
 * Deliberately below the turn's own 8 000-character feed-back cap
 * (`engine/turn.ts`), so a delegation is trimmed *here*, with a marker that says
 * so, rather than silently clipped by the engine where the truncation would read
 * as a complete answer. A Codex or DSH run routinely produces far more than this;
 * the transcript belongs in the vendor's own logs, and the model needs the
 * conclusion.
 */
const MAX_ANSWER_CHARS = 6_000;

export interface VendorToolsDeps {
  registry: VendorRegistry;
  log(level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string): void;
}

/**
 * Build one tool per configured vendor.
 *
 * A vendor that is unreachable still gets a tool. That is on purpose: an employee
 * that can see "the Codex vendor exists but is not installed" can say so and move
 * on, whereas a tool that vanishes makes the same situation look like the
 * employee forgot how to ask for help. The failure is reported by the tool, in
 * words, at the moment it is called.
 */
export function createVendorTools(deps: VendorToolsDeps): Tool[] {
  return deps.registry.ids().map((vendorId) => createVendorTool(vendorId, deps));
}

export function createVendorTool(vendorId: string, deps: VendorToolsDeps): Tool {
  const config = deps.registry.get(vendorId);
  const label = config?.label ?? vendorId;
  const enforcement = config?.capabilities.readOnlyEnforcement ?? 'requested';
  // `requested` is the only level the office cannot bound at all: for `sandbox`
  // the harness confines itself, and for `client` dev3d is the one refusing the
  // write path and answering the read requests. So the blanket, up-front approval
  // is reserved for the case where nothing but the harness's cooperation stands
  // between it and the workspace.
  const needsUpfrontApproval = enforcement === 'requested';
  const operator = config?.operator ?? 'a third party';

  return {
    name: vendorToolName(vendorId),
    description:
      `Delegate a self-contained piece of work to ${label}, an external agent harness operated by ${operator}. ` +
      `${label} runs in your workspace, works autonomously with its own tools, and returns a written answer. ` +
      (enforcement === 'sandbox'
        ? `${label} is pinned to a read-only sandbox of its own, so it cannot change any file: use it to investigate, `
        : enforcement === 'client'
          ? `dev3d drives ${label} over the Agent Client Protocol and refuses every write it attempts, so it cannot `
          : `${label} is *asked* to work read-only but nothing enforces it, so a human is asked to approve each `
      ) +
      'delegation. ' +
      'Use it for work that is genuinely self-contained - "why does this fail", "review this file for race ' +
      'conditions" - because it cannot see the rest of your conversation or your stage transcript. ' +
      'It is slow, measured in minutes, and it costs money on somebody else\'s subscription.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'The complete, self-contained task. Include the context it needs: it cannot see this conversation, ' +
            'your plan, or your colleagues\' work. State the workspace-relative files or paths it should look at.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Optional ceiling for this one delegation, in milliseconds. It can only lower the vendor\'s own ' +
            'ceiling, never raise it.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    run: async (args, ctx): Promise<ToolResult> =>
      runDelegation(vendorId, label, needsUpfrontApproval, args, ctx, deps),
  };
}

async function runDelegation(
  vendorId: string,
  label: string,
  needsUpfrontApproval: boolean,
  args: Record<string, unknown>,
  ctx: ToolContext,
  deps: VendorToolsDeps,
): Promise<ToolResult> {
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  if (task === '') {
    return fail(`Delegating to ${label} requires a non-empty "task" string.`, 'Missing task');
  }

  // Only a switched-off vendor is refused outright. An `unreachable` one is
  // *tried*, because that status comes from a probe taken at boot and the most
  // likely reason it is wrong is that the harness was installed since - so a
  // refusal here would block a working vendor until somebody clicked Re-check.
  // The delegation's own outcome is the authoritative answer, and a success
  // updates the status for every console looking at it.
  const status = deps.registry.statusOf(vendorId);
  if (status === undefined) {
    return fail(`There is no vendor named "${vendorId}" any more.`, `${label} gone`);
  }
  if (status === 'offsite') {
    return fail(
      `${label} is switched off, so it was not engaged. Do the work yourself, or ask the operator to enable it.`,
      `${label} switched off`,
    );
  }

  const timeoutArg = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) ? args.timeoutMs : undefined;

  if (needsUpfrontApproval && !ctx.autoApproveShell) {
    // Nothing but the harness's own cooperation stands between it and the
    // workspace, so the office cannot promise what it will do. A human decides,
    // in the same callout a shell command uses.
    let approved = false;
    try {
      approved = await ctx.requestApproval({
        kind: 'network',
        summary: `Engage ${label}: ${task.split(/\r?\n/)[0]?.slice(0, 140) ?? task.slice(0, 140)}`,
        detail:
          `${label} (${vendorId}) runs as an external process in:\n${ctx.workspaceRoot}\n\n` +
          'It is asked to work read-only but nothing enforces that, so it may write to this workspace. ' +
          `Task:\n${task}`,
      });
    } catch {
      approved = false;
    }
    if (!approved) {
      return fail(
        `The human declined to engage ${label}. Do not retry the same delegation; do the work yourself, ` +
          'or propose an approach that does not need an external harness.',
        `${label} declined`,
      );
    }
  }

  const result = await deps.registry.delegate(vendorId, {
    task,
    cwd: ctx.workspaceRoot,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    ...(timeoutArg !== undefined ? { timeoutMs: timeoutArg } : {}),
    // An ACP agent asks permission per tool call rather than per delegation, and
    // that question goes to the same human a shell command does. With no one to
    // answer it the request is refused downstream, which is the right default:
    // an unanswerable question must not resolve to yes.
    requestApproval: (ask) =>
      ctx.requestApproval({
        kind: 'network',
        summary: `${label} wants to ${ask.title}`,
        detail:
          `${label} (${vendorId}) is working in:\n${ctx.workspaceRoot}\n\n` +
          `It reported a "${ask.toolKind}" action and is asking to proceed.\n` +
          (ask.options.length > 0 ? `Its own options were: ${ask.options.join(', ')}\n` : ''),
      }),
  });

  if (!result.ok) {
    deps.log('warn', 'vendors', `${vendorId} delegation failed: ${result.detail}`);
    return {
      ok: false,
      content:
        `${label} did not complete this delegation (${result.outcome} after ${formatDuration(result.durationMs)}):\n` +
        `${result.detail}\n\n` +
        'This is an external system failing, not a problem with your task. Report it if it matters, or continue ' +
        'without it - do not repeat the same delegation unchanged.',
      preview: `${label} ${result.outcome}`,
      affectsPaths: [],
    };
  }

  // Vendor-reported paths are turned into workspace-relative ones, and anything
  // that does not resolve inside the workspace is dropped rather than recorded:
  // `affectsPaths` flows to `turn.wroteFiles` and from there to the review loop's
  // idea of who produced what, so a path that escaped the workspace would be a
  // claim the run cannot back up.
  const affectsPaths: string[] = [];
  for (const file of result.files) {
    const relative = relativeOrNull(ctx.workspaceRoot, file);
    if (relative !== null && !affectsPaths.includes(relative)) affectsPaths.push(relative);
  }

  const notes: string[] = [];
  if (!result.parsed) notes.push('read as plain text');
  if (result.files.length > 0 && affectsPaths.length < result.files.length) {
    notes.push(`${result.files.length - affectsPaths.length} reported path(s) were outside the workspace and ignored`);
  }

  const capped =
    result.text.length > MAX_ANSWER_CHARS
      ? `${result.text.slice(0, MAX_ANSWER_CHARS)}\n\n…(${label}'s answer was longer; ${result.text.length - MAX_ANSWER_CHARS} further characters were not passed on)`
      : result.text;

  return {
    ok: true,
    content: `${capped}${notes.length > 0 ? `\n\n(${label}: ${notes.join('; ')})` : ''}`,
    preview: `${label} answered in ${formatDuration(result.durationMs)}${affectsPaths.length > 0 ? ` · ${affectsPaths.length} file(s)` : ''}`,
    affectsPaths,
  };
}

function relativeOrNull(workspaceRoot: string, candidate: string): string | null {
  try {
    return toWorkspaceRelative(workspaceRoot, candidate);
  } catch {
    // `toWorkspaceRelative` refuses anything outside the root, which is exactly
    // the answer wanted here: drop it rather than report it.
    return null;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function fail(content: string, preview: string): ToolResult {
  return { ok: false, content, preview, affectsPaths: [] };
}
