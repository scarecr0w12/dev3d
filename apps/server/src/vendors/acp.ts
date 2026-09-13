/**
 * An Agent Client Protocol client: one prompt turn against an external agent.
 *
 * ACP is JSON-RPC 2.0 over stdio, and it is the contract that makes a whole
 * registry of harnesses reachable through one implementation — Codex, Claude,
 * Gemini CLI, OpenCode, Copilot, Cursor, Amp, Auggie, Poolside, and OpenClaw.
 * Where the one-shot command transport (`command.ts`) buys reach, this buys three
 * things a command cannot:
 *
 *  1. **The agent's work is visible.** `session/update` notifications carry the
 *     answer as it streams and every tool call the agent makes, so a delegation
 *     can be shown rather than inferred from a blob of stdout.
 *  2. **Reads are confined by the office.** When the agent wants a file it asks
 *     the *client*, and this client answers through `resolveInWorkspace` — the
 *     same choke point every built-in tool goes through. That is a stronger
 *     position than any prompt: the agent cannot read outside the workspace
 *     through this path, because the office does the reading.
 *  3. **Writes are refused.** `writeTextFile` is not advertised and is rejected
 *     if attempted anyway, so a read-only delegation is enforced rather than
 *     requested.
 *
 * ## What this does *not* promise
 *
 * The agent is still a local process. Confining the protocol path constrains what
 * it can do *through dev3d*, not what it can do to the machine — which is exactly
 * why `ReadOnlyEnforcement` has three levels rather than two, and why an ACP
 * vendor is `client` and not `sandbox`.
 *
 * `session/request_permission` is the other half of that. An agent that wants to
 * run a tool puts the question to the client, and this client puts it to a human.
 * With no one able to answer it refuses, because the alternative is an
 * unanswerable question defaulting to yes.
 *
 * ## Written defensively, on purpose
 *
 * The update shapes below are read from a peer's JSON. Every field is optional,
 * an unrecognised `sessionUpdate` variant is ignored rather than fatal, and a
 * message that does not parse is skipped. A protocol revision must never turn a
 * working delegation into a crash — the same discipline `output.ts` applies to
 * stdout.
 *
 * Spec: https://agentclientprotocol.com/protocol/v1/overview
 */

import { readFile, stat as statFile } from 'node:fs/promises';

import {
  isFailure,
  notification,
  parseMessage,
  request,
  type JsonRpcId,
  type JsonRpcResponse,
} from '../rpc/jsonrpc.ts';
import type { JsonRpcTransport } from '../rpc/transport.ts';
import { StdioTransport, type SpawnLike } from '../rpc/stdio.ts';
import { resolveInWorkspace, toWorkspaceRelative } from '../tools/paths.ts';

/**
 * The ACP revision this client implements.
 *
 * Sent as a number rather than a string: the protocol versions itself with an
 * integer, unlike MCP's date-shaped string. The peer answers with its own and the
 * client accepts whatever it says, because negotiating is the point of asking.
 */
export const ACP_PROTOCOL_VERSION = 1;

/** How long any single request may wait before the turn is abandoned. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** A single file the agent asks for, capped. Generous, and bounded. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** One tool call the agent reported, for the console and the run record. */
export interface AcpToolCall {
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  /** Workspace-relative paths the agent named, already confined. */
  paths: string[];
}

export type AcpOutcome = 'ok' | 'failed' | 'timeout' | 'aborted' | 'unstartable';

export interface AcpTurnResult {
  outcome: AcpOutcome;
  /** The agent's answer, from `agent_message_chunk` updates. */
  text: string;
  /** Workspace-relative paths the agent said it touched. */
  files: string[];
  /** The agent's terminal reason for the turn, when it reported one. */
  stopReason: string | null;
  /** Every tool call the agent reported, in order. */
  toolCalls: AcpToolCall[];
  /** A one-line reason. Empty on success. */
  detail: string;
  durationMs: number;
}

export interface AcpTurnOptions {
  command: string;
  args?: string[];
  /** The run's workspace. Both the child's cwd and the read boundary. */
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  clientName: string;
  clientVersion: string;
  /** The task. Sent as one text content block. */
  prompt: string;
  /**
   * Put a permission request to a human. Absent means nobody can answer, and the
   * request is refused — which is the documented fail-closed behaviour rather
   * than an oversight.
   */
  requestApproval?: (request: AcpPermissionAsk) => Promise<boolean>;
  /** Called as the answer streams, so a console can show progress. */
  onChunk?: (text: string) => void;
  /** Called for each tool call the agent reports. */
  onToolCall?: (call: AcpToolCall) => void;
  /** Injected in tests: the wire. Takes precedence over `spawnFn`. */
  transport?: JsonRpcTransport;
  spawnFn?: SpawnLike;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

/** What a human is being asked, when an agent wants to run a tool. */
export interface AcpPermissionAsk {
  /** What the agent says it is about to do. */
  title: string;
  /** The agent's own classification of the tool, e.g. `read`, `execute`. */
  toolKind: string;
  /** The choices the agent offered, as it named them. */
  options: string[];
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Run one ACP prompt turn.
 *
 * Never throws for an ordinary failure: an agent that cannot start, refuses,
 * times out or dies mid-turn produces a result with `outcome` set, because the
 * caller is a tool whose contract is to hand the model something it can act on.
 */
export async function runAcpTurn(options: AcpTurnOptions): Promise<AcpTurnResult> {
  const started = Date.now();
  const log = options.log ?? (() => undefined);

  const finish = (outcome: AcpOutcome, detail: string, extra: Partial<AcpTurnResult> = {}): AcpTurnResult => ({
    outcome,
    text: extra.text ?? '',
    files: extra.files ?? [],
    stopReason: extra.stopReason ?? null,
    toolCalls: extra.toolCalls ?? [],
    detail,
    durationMs: Date.now() - started,
  });

  // ---------------------------------------------------------------- the wire
  const inline = options.transport;
  const transport: JsonRpcTransport =
    inline ??
    new StdioTransport({
      command: options.command,
      args: options.args ?? [],
      cwd: options.cwd,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.spawnFn !== undefined ? { spawnFn: options.spawnFn } : {}),
      onStderr: (line) => log('debug', `acp stderr: ${line}`),
      onNoise: (line) => log('warn', `acp peer printed non-JSON: ${line}`),
    });

  // ------------------------------------------------------------- turn state
  const chunks: string[] = [];
  const toolCalls: AcpToolCall[] = [];
  const files = new Set<string>();
  const pending = new Map<JsonRpcId, Pending>();
  let nextId = 1;
  let sessionId: string | null = null;
  let settled = false;
  let timedOut = false;
  /**
   * Set the moment the turn is abandoned, and checked before every step.
   *
   * Without this, an abort arriving between `start()` and `initialize` tore the
   * wire down and then let the turn carry on issuing requests into it — the
   * session would be opened against a closed transport and the prompt would wait
   * for an answer that could never come. Found by a test that aborts immediately;
   * it is exactly the window a user hitting Cancel the instant a delegation
   * starts would land in.
   */
  let cancelled = false;
  let promptTurn: Promise<unknown> | null = null;

  /** Everything that must happen exactly once, however the turn ends. */
  const teardown = async (): Promise<void> => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new Error(`the turn ended while "${entry.method}" was in flight`));
    }
    await transport.close().catch(() => undefined);
  };

  const send = (message: unknown): void => {
    try {
      transport.send(message);
    } catch (e) {
      log('warn', `acp send failed: ${errMsg(e)}`);
    }
  };

  /**
   * Issue a request and wait for its response, bounded.
   *
   * Refuses immediately once the turn has been abandoned, so an aborted turn
   * cannot open a session or send a prompt into a wire that has already been
   * closed.
   */
  const call = (method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> => {
    if (cancelled) return Promise.reject(new Error('the turn was cancelled before this request was sent'));
    const id = nextId;
    nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      // A timer must not hold the process open on its own.
      timer.unref?.();
      pending.set(id, { resolve, reject, timer, method });
      send(request(id, method, params));
    });
  };

  /** Answer a request the agent made of us. */
  const reply = (id: JsonRpcId, result: unknown): void => {
    send({ jsonrpc: '2.0', id, result });
  };
  const replyError = (id: JsonRpcId, code: number, message: string): void => {
    send({ jsonrpc: '2.0', id, error: { code, message } });
  };

  // ------------------------------------------------------- inbound handling
  const handleUpdate = (params: Record<string, unknown>): void => {
    const update = asRecord(params['update']);
    if (update === null) return;
    const variant = asString(update['sessionUpdate']);

    if (variant === 'agent_message_chunk') {
      const content = asRecord(update['content']);
      if (content !== null && content['type'] === 'text') {
        const text = asString(content['text']);
        if (text !== '') {
          chunks.push(text);
          options.onChunk?.(text);
        }
      }
      return;
    }

    if (variant === 'tool_call' || variant === 'tool_call_update') {
      const call = readToolCall(update, options.cwd);
      if (call === null) return;
      for (const path of call.paths) files.add(path);
      // `tool_call_update` refines a call already reported, so an existing id has
      // its record replaced rather than being appended a second time - otherwise
      // the console would show the same action twice.
      const at = toolCalls.findIndex((entry) => entry.toolCallId === call.toolCallId);
      if (at === -1) toolCalls.push(call);
      else toolCalls[at] = call;
      options.onToolCall?.(call);
      return;
    }

    // Everything else - plans, thoughts, available-commands announcements,
    // anything a future revision adds - is ignored rather than fatal.
    log('debug', `acp update ignored: ${variant || '(no variant)'}`);
  };

  const handleInbound = (raw: unknown): void => {
    const message = parseMessage(raw);
    if (message === null) {
      log('warn', 'acp peer sent something that is not JSON-RPC');
      return;
    }

    // A response to something we asked.
    if (!('method' in message)) {
      const id = (message as JsonRpcResponse).id;
      if (id === null) return;
      const entry = pending.get(id);
      if (entry === undefined) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      if (isFailure(message as JsonRpcResponse)) {
        entry.reject(new Error((message as { error: { message: string } }).error.message));
      } else {
        entry.resolve((message as { result: unknown }).result);
      }
      return;
    }

    // A notification: nothing to answer.
    if (!('id' in message) || (message as { id?: unknown }).id === undefined) {
      if (message.method === 'session/update') {
        const params = asRecord(message.params);
        if (params !== null) handleUpdate(params);
      } else {
        log('debug', `acp notification ignored: ${message.method}`);
      }
      return;
    }

    // A request from the agent, which we must answer.
    const id = (message as { id: JsonRpcId }).id;
    void handleAgentRequest(id, message.method, asRecord(message.params));
  };

  /**
   * Refuse a request that names a session this delegation did not open.
   *
   * The office opens exactly one session per delegation, and every capability it
   * serves is scoped to it — but nothing checked. `fs/read_text_file` was served
   * for *any* path the agent asked for, whatever session it claimed to be in, so
   * the session id was decorative: confinement was the workspace and nothing more.
   * A Gateway-backed agent (whose filesystem access goes through dev3d rather than
   * through its own process) is the case that matters.
   */
  const requireOurSession = (raw: unknown, method: string): void => {
    const named = asString(raw);
    if (sessionId === null) {
      throw new Error(`${method} arrived before this delegation opened a session`);
    }
    if (named === '') {
      throw new Error(`${method} named no session; dev3d serves only the session this delegation opened`);
    }
    if (named !== sessionId) {
      throw new Error(`${method} named session ${JSON.stringify(named)}, which this delegation did not open`);
    }
  };

  /**
   * Serve a request the agent made of this client.
   *
   * Async because one of the three can ask a human. The transport does not
   * serialise inbound messages, so this must not assume it is alone.
   */
  const handleAgentRequest = async (id: JsonRpcId, method: string, params: Record<string, unknown> | null): Promise<void> => {
    const p = params ?? {};

    if (method === 'fs/read_text_file') {
      const wanted = asString(p['path']);
      try {
        requireOurSession(p['sessionId'], 'fs/read_text_file');
        // The confinement, and the whole reason this is served by the office
        // rather than by the agent: the same choke point every built-in tool
        // uses, so an escape attempt fails here rather than being reported.
        // That choke point resolves symlinks and junctions too, so a link planted
        // inside the workspace does not become a read outside it.
        const absolute = resolveInWorkspace(options.cwd, wanted);
        // Bounded *before* reading, not after. The cap used to be applied to a
        // string already in memory, so a large file inside the workspace — a
        // video, a database dump, a log — was a memory spike driven by whatever
        // the remote agent chose to ask for; and `raw.length` counts UTF-16 code
        // units rather than bytes, so the 2 MB cap was not even 2 MB.
        const stat = await statFile(absolute);
        if (!stat.isFile()) {
          replyError(id, -32001, `dev3d will not read "${wanted}": it is not a regular file.`);
          return;
        }
        if (stat.size > MAX_FILE_BYTES) {
          replyError(
            id,
            -32001,
            `dev3d will not read "${wanted}": it is ${stat.size} bytes, above the ${MAX_FILE_BYTES}-byte limit ` +
              'for a delegation. Ask for a specific range in a smaller file, or read it yourself.',
          );
          return;
        }
        const raw = await readFile(absolute, 'utf8');
        reply(id, { content: sliceLines(raw, p['line'], p['limit']) });
      } catch (e) {
        replyError(id, -32001, `dev3d will not read "${wanted}": ${errMsg(e)}`);
      }
      return;
    }

    if (method === 'fs/write_text_file') {
      // Not advertised, so a well-behaved agent never asks. One that does is
      // refused in words, because this is the line the read-only promise rests
      // on and it should be visible in a log rather than a silent no.
      log('warn', 'acp agent attempted fs/write_text_file; refused (read-only delegation)');
      replyError(id, -32001, 'dev3d runs this delegation read-only and does not permit writing files.');
      return;
    }

    if (method === 'session/request_permission') {
      // Checked only when the agent names a session, and that asymmetry is
      // deliberate: a request that names *another* session is refused, while one
      // that names none is still answered. A permission prompt is not a capability
      // dev3d grants, so refusing it would break a working agent over a field the
      // specification requires but that some do omit — a worse outcome than the
      // thing being fixed. The read path above, which hands out file contents, is
      // the one that must be exact.
      const named = asString(p['sessionId']);
      if (named !== '' && sessionId !== null && named !== sessionId) {
        replyError(
          id,
          -32001,
          `dev3d will not answer a permission request for session ${JSON.stringify(named)}, ` +
            'which this delegation did not open.',
        );
        return;
      }
      const decision = await decidePermission(p, options);
      reply(id, decision);
      return;
    }

    replyError(id, -32601, `dev3d does not implement "${method}".`);
  };

  transport.onMessage(handleInbound);
  transport.onError((error) => {
    if (settled) return;
    // A transport failure ends the turn; the pending prompt (if any) settles with
    // its own rejection, and `finish` is reached below with the reason.
    log('warn', `acp transport failed: ${error.message}`);
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
  });

  // ------------------------------------------------------------------ timeout
  const outerTimer = setTimeout(() => {
    timedOut = true;
    cancelled = true;
    // Cancel politely first: an agent given the chance to stop will flush what it
    // has, and a session left running is a process the operator did not ask for.
    if (sessionId !== null) send(notification('session/cancel', { sessionId }));
    void teardown();
  }, options.timeoutMs);
  outerTimer.unref?.();

  const onAbort = (): void => {
    cancelled = true;
    if (sessionId !== null) send(notification('session/cancel', { sessionId }));
    void teardown();
  };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  // -------------------------------------------------------------------- run
  try {
    await transport.start();
  } catch (e) {
    settled = true;
    clearTimeout(outerTimer);
    options.signal?.removeEventListener('abort', onAbort);
    return finish('unstartable', `could not start the ACP agent: ${errMsg(e)}`);
  }

  try {
    // 1. Initialize. The capability block is the contract: this client serves
    //    reads and refuses writes, and says so before the agent does anything.
    if (cancelled) throw new Error('the turn was cancelled before it began');
    const initResult = asRecord(
      await call('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
      }),
    );
    if (initResult === null) throw new Error('initialize returned nothing usable');

    const authMethods = Array.isArray(initResult['authMethods']) ? initResult['authMethods'] : [];
    if (authMethods.length > 0 && initResult['requiresAuth'] === true) {
      // Authentication is the vendor's own business, and this client has no
      // credential to offer. Saying which of the two it is beats "failed".
      throw new Error(
        'the agent requires authentication that dev3d cannot supply; authenticate it directly ' +
          '(for OpenClaw, start and sign in to its Gateway) and try again',
      );
    }

    // 2. A fresh session in the run's workspace.
    if (cancelled) throw new Error('the turn was cancelled before a session was opened');
    const sessionResult = asRecord(
      await call('session/new', { cwd: options.cwd, mcpServers: [] }, 20_000),
    );
    const opened = asString(sessionResult?.['sessionId']);
    if (opened === '') throw new Error('session/new returned no sessionId');
    sessionId = opened;

    // 3. The prompt. This resolves when the *turn* ends, which is why the outer
    //    timer above is the real bound. This request's own timer is deliberately a
    //    second longer so it cannot win the race and report a per-request failure
    //    where the honest answer is "the whole turn ran out of time".
    promptTurn = call(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: options.prompt }] },
      options.timeoutMs + 1_000,
    );
    const promptResult = asRecord(await promptTurn);
    const stopReason = asString(promptResult?.['stopReason']) || null;

    settled = true;
    clearTimeout(outerTimer);
    options.signal?.removeEventListener('abort', onAbort);
    await teardown();

    if (options.signal?.aborted) {
      return finish('aborted', 'Cancelled by the operator.', { text: chunks.join(''), files: [...files], toolCalls });
    }

    const text = chunks.join('').trim();
    if (stopReason === 'refusal') {
      return finish('failed', 'the agent refused the task', { text, files: [...files], stopReason, toolCalls });
    }
    if (text === '') {
      return finish(
        'failed',
        `the agent finished (${stopReason ?? 'no stop reason given'}) without producing any answer`,
        { files: [...files], stopReason, toolCalls },
      );
    }
    return finish('ok', '', { text, files: [...files], stopReason, toolCalls });
  } catch (e) {
    settled = true;
    clearTimeout(outerTimer);
    options.signal?.removeEventListener('abort', onAbort);
    await teardown();

    // The three ways a turn fails are distinguished, because they call for
    // different things from an operator: a timeout is the ceiling being wrong, an
    // abort is their own decision, and anything else is the agent's problem.
    if (options.signal?.aborted) {
      return finish('aborted', 'Cancelled by the operator.', { text: chunks.join(''), files: [...files], toolCalls });
    }
    if (timedOut) {
      return finish('timeout', `the agent did not finish within ${options.timeoutMs}ms`, {
        text: chunks.join(''),
        files: [...files],
        toolCalls,
      });
    }
    return finish('failed', errMsg(e), { text: chunks.join(''), files: [...files], toolCalls });
  }
}

/**
 * Read a `tool_call` / `tool_call_update` body.
 *
 * Paths come from two documented places and are confined here rather than at the
 * point of use, so a path the agent named outside the workspace is dropped before
 * anything downstream can record it as something the vendor did.
 */
function readToolCall(update: Record<string, unknown>, workspaceRoot: string): AcpToolCall | null {
  const toolCallId = asString(update['toolCallId']);
  if (toolCallId === '') return null;

  const paths = new Set<string>();
  const locations = Array.isArray(update['locations']) ? update['locations'] : [];
  for (const entry of locations) {
    const record = asRecord(entry);
    const raw = record === null ? '' : asString(record['path']);
    if (raw !== '') safeRelative(workspaceRoot, raw, paths);
  }
  // A diff-shaped result names the file inside `content`, not in `locations`.
  const content = Array.isArray(update['content']) ? update['content'] : [];
  for (const entry of content) {
    const record = asRecord(entry);
    const raw = record === null ? '' : asString(record['path']);
    if (raw !== '') safeRelative(workspaceRoot, raw, paths);
  }

  return {
    toolCallId,
    title: asString(update['title']) || 'a tool call',
    kind: asString(update['kind']) || 'other',
    status: asString(update['status']) || 'unknown',
    paths: [...paths].sort(),
  };
}

/**
 * Record a path the agent named, as a workspace-relative one.
 *
 * Confined *and* relativised here rather than at the point of use, so the field
 * means one thing wherever it is read: `DelegationResult.files` feeds
 * `affectsPaths`, which feeds `turn.wroteFiles`, which is documented as
 * workspace-relative. A path outside the workspace is dropped rather than
 * reported, because a review loop's idea of who produced what must not contain a
 * file the run cannot back up.
 */
function safeRelative(workspaceRoot: string, candidate: string, into: Set<string>): void {
  try {
    into.add(toWorkspaceRelative(workspaceRoot, resolveInWorkspace(workspaceRoot, candidate)));
  } catch {
    // Outside the workspace, or unresolvable. Dropped.
  }
}

/** Apply the optional `line` / `limit` window a read request may carry. */
function sliceLines(text: string, line: unknown, limit: unknown): string {
  const from = typeof line === 'number' && Number.isFinite(line) ? Math.max(1, Math.floor(line)) : null;
  const count = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : null;
  if (from === null && count === null) return text;
  const lines = text.split('\n');
  const start = (from ?? 1) - 1;
  return lines.slice(start, count === null ? undefined : start + count).join('\n');
}

/**
 * Decide a permission request.
 *
 * The options are the *agent's* list, so nothing about them can be trusted: this
 * picks by documented `kind` first and falls back to a name match, and it never
 * guesses that the first option is the permissive one. With nobody able to
 * answer, it refuses — a question nothing can answer must not resolve to yes,
 * which is the same fail-closed rule the office's own approval broker follows.
 */
async function decidePermission(
  params: Record<string, unknown>,
  options: AcpTurnOptions,
): Promise<unknown> {
  const rawOptions = Array.isArray(params['options']) ? params['options'] : [];
  const parsed = rawOptions
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      optionId: asString(entry['optionId']),
      name: asString(entry['name']),
      kind: asString(entry['kind']),
    }))
    .filter((entry) => entry.optionId !== '');

  const isAllow = (entry: { name: string; kind: string; optionId: string }): boolean =>
    /allow|approve|accept|yes/i.test(`${entry.kind} ${entry.name} ${entry.optionId}`);
  const isReject = (entry: { name: string; kind: string; optionId: string }): boolean =>
    /reject|deny|decline|refuse|no/i.test(`${entry.kind} ${entry.name} ${entry.optionId}`);

  const allow = parsed.find(isAllow) ?? null;
  const reject = parsed.find(isReject) ?? null;

  const toolCall = asRecord(params['toolCall']);
  const ask: AcpPermissionAsk = {
    title: (toolCall === null ? '' : asString(toolCall['title'])) || 'an unreported action',
    toolKind: (toolCall === null ? '' : asString(toolCall['kind'])) || 'unknown',
    options: parsed.map((entry) => entry.name || entry.optionId),
  };

  // Nothing offered that reads as either is a shapes problem, not a decision:
  // refuse rather than pick an option whose meaning is unknown.
  if (options.requestApproval === undefined || allow === null) {
    return reject === null
      ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId: reject.optionId } };
  }

  let approved = false;
  try {
    approved = await options.requestApproval(ask);
  } catch {
    approved = false;
  }

  if (approved) return { outcome: { outcome: 'selected', optionId: allow.optionId } };
  return reject === null
    ? { outcome: { outcome: 'cancelled' } }
    : { outcome: { outcome: 'selected', optionId: reject.optionId } };
}
