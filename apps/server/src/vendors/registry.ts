/**
 * The vendor registry: the third-party harnesses this office has engaged, and
 * the one place a delegation is actually run.
 *
 * Shaped after `McpManager`, because it answers the same kind of question - "what
 * external capability does this office have, and is it working" - and because
 * the lessons there were learned the hard way:
 *
 *  - **Boot never waits on somebody else's process.** Probes run in the
 *    background after the HTTP listener is open, each settles independently, and
 *    a failure is recorded as status rather than thrown.
 *  - **A dead vendor must not affect a live one.** One unreachable harness is a
 *    row in the console, not a reason for the office to open without the others.
 *  - **The tool name is namespaced, and the rule is the same one.**
 *
 * ## The naming rule
 *
 * MCP publishes `mcp__<serverId>__<toolName>`. A vendor publishes:
 *
 *     agent__<vendorId>__delegate
 *
 * The prefix makes a collision with a built-in or an MCP tool impossible, and
 * vendor ids are restricted to characters that cannot be confused with the `__`
 * separator (`config.ts`'s `ID_RE` forbids `_` outright), so the published name
 * can be split back apart without ambiguity.
 *
 * `agent__` rather than `vendor__` deliberately: the tool is *the act of
 * delegating to an external agent*, which is what a model needs to understand,
 * while "vendor" is the office's word for who is on site. The console uses the
 * office's word; the model is given the plain one.
 */

import type { VendorCapabilities, VendorState, VendorStatus } from '@dev3d/core';
import type { VendorConfig } from './config.ts';
import { describeVendorCommand, runVendorCommand, type VendorRunOutcome } from './command.ts';
import type { SpawnLike } from '../rpc/transport.ts';
import { extractVendorAnswer } from './output.ts';
import { runAcpTurn, type AcpPermissionAsk, type AcpToolCall } from './acp.ts';

export interface VendorRegistryDeps {
  log(level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string): void;
  /** Injected in tests. Threaded to the transport, which owns the real default. */
  spawnFn?: SpawnLike;
  /** How long a liveness probe may take. Short: it runs at boot. */
  probeTimeoutMs?: number;
  /** Reported to an ACP agent in `initialize`, so it knows who is asking. */
  clientName?: string;
  clientVersion?: string;
}

/** One delegation: the task text, and where the vendor should work. */
export interface DelegationRequest {
  task: string;
  /** The run's workspace. Never the repository, and never the office's cwd. */
  cwd: string;
  signal?: AbortSignal;
  /** Overrides the vendor's own ceiling, clamped to it rather than beyond it. */
  timeoutMs?: number;
  /**
   * Put an ACP agent's permission request to a human.
   *
   * Only the `acp` transport can use this, and only it needs to: a one-shot
   * command harness has no way to ask mid-run, which is precisely what the
   * blanket approval gate on `requested` enforcement exists to compensate for.
   * Absent means nobody can answer, and the request is refused.
   */
  requestApproval?: (ask: AcpPermissionAsk) => Promise<boolean>;
  /** Called as an ACP agent's answer streams, so a console can show progress. */
  onChunk?: (text: string) => void;
}

export interface DelegationResult {
  ok: boolean;
  vendorId: string;
  /** The vendor's answer, or its failure message when `ok` is false. */
  text: string;
  /** Workspace-relative paths the vendor named. Usually empty when read-only. */
  files: string[];
  outcome: VendorRunOutcome;
  /** A one-line reason, empty on success. */
  detail: string;
  durationMs: number;
  /** True when the answer came from a structured event rather than raw text. */
  parsed: boolean;
  /**
   * Tool calls an ACP agent reported, for the console.
   *
   * Empty for a command vendor, which reports nothing until it exits - one of
   * the three things the protocol buys over a one-shot invocation.
   */
  toolCalls: AcpToolCall[];
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** Runtime state a vendor accumulates that is not in its config. */
interface VendorRuntime {
  config: VendorConfig;
  status: VendorStatus;
  detail: string | null;
  engagements: number;
  activity: string | null;
  lastError: string | null;
}

/**
 * The published tool name for a vendor.
 *
 * `agent__<id>__delegate` - see the module comment for why the prefix is
 * `agent__` and why the id may not contain `_`.
 */
export function vendorToolName(vendorId: string): string {
  return `agent__${vendorId}__delegate`;
}

/** Split a published name back into its parts, or `null` if it is not one. */
export function parseVendorToolName(publishedName: string): { vendorId: string } | null {
  if (!publishedName.startsWith('agent__')) return null;
  const rest = publishedName.slice('agent__'.length);
  const at = rest.indexOf('__');
  if (at <= 0) return null;
  if (rest.slice(at + 2) !== 'delegate') return null;
  return { vendorId: rest.slice(0, at) };
}

/** The declared capabilities, with the always-true parts filled in. */
function capabilitiesOf(config: VendorConfig): VendorCapabilities {
  return {
    // Only ever `requested` for a vendor the office cannot mediate, and that is
    // what the field means: an ACP vendor is served by this office (reads
    // confined, writes refused) and so is `client`, and a harness with its own
    // sandbox flag is `sandbox`. The value comes from the preset, which derives
    // it from what the invocation actually does.
    readOnlyEnforcement: config.capabilities.readOnlyEnforcement,
    reportsFiles: config.capabilities.reportsFiles,
    streams: config.capabilities.streams,
    reportsCost: config.capabilities.reportsCost,
  };
}

export class VendorRegistry {
  private readonly deps: VendorRegistryDeps;
  private readonly runtimes = new Map<string, VendorRuntime>();
  private started = false;

  constructor(configs: VendorConfig[], deps: VendorRegistryDeps) {
    this.deps = deps;
    for (const config of configs) {
      this.runtimes.set(config.id, {
        config,
        // Until probed, a vendor is *not* claimed to be available: an optimistic
        // `docked` would put a green terminal on the floor for a harness that is
        // not installed, and the first delegation would then fail in a way the
        // operator had already been told could not happen.
        status: config.enabled ? 'unreachable' : 'offsite',
        detail: config.enabled ? 'not yet checked' : 'switched off by the operator',
        engagements: 0,
        activity: null,
        lastError: null,
      });
    }
  }

  /**
   * Probe every enabled vendor, in the background.
   *
   * Never awaited by boot. The returned promise resolves when every probe has
   * settled, which is what tests await.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await Promise.all([...this.runtimes.values()].map((runtime) => this.probeOne(runtime)));
  }

  /** Every configured vendor, as the console and the 3D office see it. */
  states(): VendorState[] {
    return [...this.runtimes.values()].map((runtime) => this.toState(runtime));
  }

  /** The vendor ids, for building per-vendor tools and grants. */
  ids(): string[] {
    return [...this.runtimes.keys()];
  }

  /** The published tool names, which is what an org chart may grant. */
  toolNames(): string[] {
    return this.ids().map(vendorToolName);
  }

  get(vendorId: string): VendorConfig | undefined {
    return this.runtimes.get(vendorId)?.config;
  }

  /** True when the office could hand this vendor work right now. */
  isAvailable(vendorId: string): boolean {
    return this.runtimes.get(vendorId)?.status === 'docked';
  }

  /**
   * The vendor's current status, for a caller that has to explain itself.
   *
   * `delegate` deliberately does **not** refuse on anything except `offsite`. A
   * probe is a point-in-time check taken at boot, and the common case for a wrong
   * answer is "the operator installed the harness five minutes ago" - so a stale
   * `unreachable` that blocked every delegation until somebody clicked Re-check
   * would be a worse lie than one that self-heals the moment a run succeeds.
   * `offsite` is different: that is a decision, and a decision is not retried.
   */
  statusOf(vendorId: string): VendorStatus | undefined {
    return this.runtimes.get(vendorId)?.status;
  }

  /**
   * Run one delegation.
   *
   * Never throws for an ordinary failure: a vendor that is missing, unreachable,
   * times out or exits non-zero produces `ok: false` with a message, because the
   * caller is a tool whose contract is to hand the model something it can act on
   * rather than to propagate an exception into the turn.
   */
  async delegate(vendorId: string, request: DelegationRequest): Promise<DelegationResult> {
    const runtime = this.runtimes.get(vendorId);
    if (runtime === undefined) {
      return this.failed(vendorId, `There is no vendor named "${vendorId}".`, 0);
    }
    if (!runtime.config.enabled) {
      return this.failed(vendorId, `${runtime.config.label} is switched off, so it was not engaged.`, 0);
    }
    if (runtime.status === 'engaged') {
      // Serialised on purpose. A harness is a subscription with a rate limit and
      // a machine behind it, and two concurrent delegations to the same vendor
      // share its session store and its quota.
      return this.failed(
        vendorId,
        `${runtime.config.label} is already working on something. Wait for it to finish, or use a different vendor.`,
        0,
      );
    }

    const task = request.task.trim();
    if (task === '') {
      return this.failed(vendorId, 'The delegation had no task text.', 0);
    }

    // A caller may ask for less time than the vendor's ceiling, never more: the
    // ceiling is what an operator decided this harness is allowed to consume, and
    // a model choosing its own timeout would be able to raise it.
    const timeoutMs =
      request.timeoutMs !== undefined
        ? Math.min(Math.max(1_000, request.timeoutMs), runtime.config.timeoutMs)
        : runtime.config.timeoutMs;

    runtime.status = 'engaged';
    runtime.activity = summarize(task);
    this.deps.log(
      'info',
      'vendors',
      `${runtime.config.id}: engaged (${timeoutMs}ms ceiling) in ${request.cwd}`,
    );

    // Two ways to run a vendor, chosen by its transport. Everything around this
    // - the guards, the status bookkeeping, the tally - is identical, which is
    // the point of putting the difference behind one branch rather than two
    // delegation paths.
    const result =
      runtime.config.transport === 'acp'
        ? await this.delegateOverAcp(runtime, task, timeoutMs, request)
        : await this.delegateOverCommand(runtime, task, timeoutMs, request);

    runtime.activity = null;

    if (!result.ok) {
      runtime.status = result.outcome === 'aborted' ? 'docked' : 'errored';
      runtime.lastError = result.detail;
      this.deps.log('warn', 'vendors', `${runtime.config.id}: ${result.detail}`);
      return result;
    }

    runtime.status = 'docked';
    runtime.lastError = null;
    runtime.engagements += 1;
    this.deps.log(
      'info',
      'vendors',
      `${runtime.config.id}: returned in ${result.durationMs}ms (${result.text.length} chars)`,
    );
    return result;
  }

  /**
   * Run a vendor as a one-shot process and read its stdout.
   *
   * The transport for a harness with no protocol: prompt in, text out, exit code.
   */
  private async delegateOverCommand(
    runtime: VendorRuntime,
    task: string,
    timeoutMs: number,
    request: DelegationRequest,
  ): Promise<DelegationResult> {
    const { config } = runtime;
    const failed = (detail: string, outcome: VendorRunOutcome, durationMs: number): DelegationResult => ({
      ok: false,
      vendorId: config.id,
      text: detail,
      files: [],
      outcome,
      detail,
      durationMs,
      parsed: false,
      toolCalls: [],
    });

    const result = await runVendorCommand({
      command: config.command,
      args: config.args,
      prompt: task,
      promptTransport: config.promptTransport,
      cwd: request.cwd,
      timeoutMs,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(this.deps.spawnFn !== undefined ? { spawnFn: this.deps.spawnFn } : {}),
    });

    if (result.outcome !== 'ok') {
      return failed(result.detail, result.outcome, result.durationMs);
    }

    const answer = extractVendorAnswer(result.stdout, config.outputFormat);

    // A vendor that exits zero but says nothing is a real and confusing outcome -
    // a wrong argument list does it - so it is reported as a failure with the
    // stderr tail rather than as an empty but successful answer.
    if (answer.text === '') {
      const detail = `${config.label} exited successfully but produced no output.${
        result.stderr.trim() === '' ? '' : `\nlast stderr:\n${result.stderr.trim().split(/\r?\n/).slice(-5).join('\n')}`
      }`;
      const failure = failed(detail, 'ok', result.durationMs);
      // Not `errored`: the process was fine, the *answer* was missing. The caller
      // reads this outcome to decide the status, and "it ran and said nothing" is
      // not the same fault as "it could not run".
      return { ...failure, parsed: answer.parsed };
    }

    return {
      ok: true,
      vendorId: config.id,
      text: result.stdoutTruncated
        ? `${answer.text}\n\n(vendor output was truncated at the office's cap; the tail is missing)`
        : answer.text,
      files: answer.files,
      outcome: 'ok',
      detail: '',
      durationMs: result.durationMs,
      parsed: answer.parsed,
      toolCalls: [],
    };
  }

  /**
   * Run a vendor over the Agent Client Protocol.
   *
   * The transport that reaches a whole registry of harnesses at once, and the
   * only one where the office can *mediate*: reads are served through the
   * workspace choke point, writes are refused, and every tool call the agent
   * reports is put to a human.
   */
  private async delegateOverAcp(
    runtime: VendorRuntime,
    task: string,
    timeoutMs: number,
    request: DelegationRequest,
  ): Promise<DelegationResult> {
    const { config } = runtime;
    const turn = await runAcpTurn({
      command: config.command,
      args: config.args,
      prompt: task,
      cwd: request.cwd,
      timeoutMs,
      clientName: this.deps.clientName ?? 'dev3d',
      clientVersion: this.deps.clientVersion ?? '0.0.0',
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(request.requestApproval !== undefined ? { requestApproval: request.requestApproval } : {}),
      ...(request.onChunk !== undefined ? { onChunk: request.onChunk } : {}),
      ...(this.deps.spawnFn !== undefined ? { spawnFn: this.deps.spawnFn } : {}),
      log: (level, message) => this.deps.log(level, 'vendors', `${config.id}: ${message}`),
    });

    return {
      ok: turn.outcome === 'ok',
      vendorId: config.id,
      text: turn.outcome === 'ok' ? turn.text : turn.detail,
      files: turn.files,
      // `unstartable` is a transport-level outcome, and `VendorRunOutcome` has an
      // entry for exactly it, so the console's existing status mapping works.
      outcome: turn.outcome === 'ok' ? 'ok' : turn.outcome === 'unstartable' ? 'unstartable' : turn.outcome,
      detail: turn.detail,
      durationMs: turn.durationMs,
      parsed: true,
      toolCalls: turn.toolCalls,
    };
  }

  /** Re-probe everything, for the console's Refresh button. */
  async refresh(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => this.probeOne(runtime)));
  }

  private failed(vendorId: string, detail: string, durationMs: number): DelegationResult {
    return {
      ok: false,
      vendorId,
      text: detail,
      files: [],
      outcome: 'failed',
      detail,
      durationMs,
      parsed: false,
      toolCalls: [],
    };
  }

  /**
   * Check one vendor is runnable.
   *
   * A probe is a real subprocess, which is why it is bounded tightly and why an
   * empty `probeArgs` skips it entirely: a harness with no cheap liveness command
   * would otherwise be reported unreachable while working perfectly, and a
   * wrong "unreachable" is worse than an honest "not checked".
   */
  private async probeOne(runtime: VendorRuntime): Promise<void> {
    const { config } = runtime;
    if (!config.enabled) {
      runtime.status = 'offsite';
      runtime.detail = 'switched off by the operator';
      return;
    }
    if (config.probeArgs.length === 0) {
      runtime.status = 'docked';
      runtime.detail = 'not probed; this vendor declares no liveness command';
      return;
    }

    const result = await runVendorCommand({
      command: config.command,
      args: config.probeArgs,
      prompt: '',
      // A probe has no prompt, so it goes nowhere; `stdin` would open a pipe the
      // vendor then waits on, which is exactly the hang this avoids.
      promptTransport: 'argv',
      cwd: process.cwd(),
      timeoutMs: this.deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      ...(this.deps.spawnFn !== undefined ? { spawnFn: this.deps.spawnFn } : {}),
    });

    if (result.outcome === 'ok') {
      runtime.status = 'docked';
      // The version line is worth keeping: it is the one fact that tells an
      // operator which build of a fast-moving harness they are actually driving.
      const version = result.stdout.trim().split(/\r?\n/)[0] ?? '';
      runtime.detail = version === '' ? null : version;
      this.deps.log('info', 'vendors', `${config.id}: on site (${version || 'no version reported'})`);
      return;
    }

    runtime.status = 'unreachable';
    runtime.detail = result.detail;
    this.deps.log('warn', 'vendors', `${config.id}: ${result.detail}`);
  }

  private toState(runtime: VendorRuntime): VendorState {
    const { config } = runtime;
    const state: VendorState = {
      id: config.id,
      label: config.label,
      operator: config.operator,
      status: runtime.status,
      command: describeVendorCommand(config.command, config.args, config.promptTransport),
      detail: runtime.detail,
      capabilities: capabilitiesOf(config),
      engagements: runtime.engagements,
      activity: runtime.activity,
      lastError: runtime.lastError,
      authNote: config.authNote ?? null,
    };
    if (config.color !== undefined) state.color = config.color;
    return state;
  }
}

/** A short, UI-safe one-liner for what a vendor was asked to do. */
function summarize(task: string): string {
  const firstLine = task.split(/\r?\n/)[0]?.trim() ?? '';
  const text = firstLine === '' ? task.trim() : firstLine;
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}
