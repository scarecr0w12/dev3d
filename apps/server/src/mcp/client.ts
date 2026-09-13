/**
 * The MCP client: one connection to one server, speaking JSON-RPC over whatever
 * transport it was given.
 *
 * The client owns the parts that must be identical no matter how bytes move:
 * the `initialize` handshake, request/response correlation, timeouts, the
 * `tools/list` and `tools/call` calls, and clean shutdown. A transport only has
 * to move strings — that is the entire contract, which is what lets stdio and
 * Streamable HTTP share all of the logic below.
 */

import {
  RPC_ERRORS,
  isFailure,
  notification,
  parseMessage,
  request,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '../rpc/jsonrpc.ts';
import type { JsonRpcTransport } from '../rpc/transport.ts';

/**
 * What an MCP transport must provide.
 *
 * An alias rather than a second declaration: the contract is protocol-agnostic
 * and the Agent Client Protocol needs exactly the same one, so it lives in
 * `rpc/` and this name is kept because "the transport MCP talks to" is what
 * every call site means by it.
 */
export type McpTransport = JsonRpcTransport;

/** A tool as the server describes it in `tools/list`. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** The subset of `initialize`'s result this client actually uses. */
export interface McpServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
  instructions?: string;
}

export interface McpClientOptions {
  /** How long any single request may take before it is abandoned. */
  requestTimeoutMs?: number;
  /** How long `initialize` may take. Usually longer than a normal request. */
  handshakeTimeoutMs?: number;
  /** Client identity reported to the server. */
  clientName?: string;
  clientVersion?: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * The protocol version this client speaks.
 *
 * Servers may answer with a different version they prefer; per the spec the
 * client accepts the server's answer, because the negotiation exists precisely
 * so an older server can be talked to.
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  method: string;
}

export class McpClient {
  private readonly transport: McpTransport;
  private readonly options: Required<McpClientOptions>;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private nextId = 1;
  private closed = false;
  private closeReason: Error | null = null;
  private info: McpServerInfo | null = null;
  /** Tools the server last advertised. Refreshed by `listTools`. */
  private cachedTools: McpToolInfo[] | null = null;
  /**
   * Called when the connection dies rather than being closed.
   *
   * `failAll` rejected in-flight calls and recorded a reason, but nothing above
   * it could find out: the manager kept reporting the last successful probe, kept
   * handing out the now-dead tool names, and a role's grant and the console's
   * green row both survived the crash. This is the signal that lets the owner of
   * the connection decide what a dead server means.
   */
  private onFatal: ((error: Error) => void) | null = null;

  /** Called when the server announces that its tool list changed. */
  private toolsChanged: (() => void) | null = null;

  /** Subscribe to an unexpected disconnection. Called at most once. */
  onFatalError(handler: (error: Error) => void): void {
    this.onFatal = handler;
  }

  /**
   * Subscribe to `notifications/tools/list_changed`.
   *
   * The server is telling us its tool set moved. Without this the published set
   * was frozen at connect time: a server that added or removed a tool at runtime
   * kept advertising the stale names, and the only remedy was a restart, because
   * `refresh` cannot re-list a connection that is otherwise healthy.
   */
  onToolsChanged(handler: () => void): void {
    this.toolsChanged = handler;
  }

  constructor(transport: McpTransport, options: McpClientOptions = {}) {
    this.transport = transport;
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      clientName: options.clientName ?? 'dev3d',
      clientVersion: options.clientVersion ?? '1.0.0',
    };
  }

  get label(): string {
    return this.transport.label;
  }

  /** What the server said about itself, once `initialize` has completed. */
  get serverInfo(): McpServerInfo | null {
    return this.info;
  }

  /**
   * Start the transport and perform the `initialize` handshake.
   *
   * The `notifications/initialized` notification is sent afterwards because the
   * spec requires it before any other request, and a server is entitled to
   * refuse everything until it arrives.
   */
  async connect(): Promise<McpServerInfo> {
    this.transport.onMessage((raw) => this.handleMessage(raw));
    this.transport.onError((err) => this.failAll(err, true));

    await this.transport.start();

    const result = await this.call(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        // Empty, and that is the honest answer. `tools` is a *server* capability,
        // not a client one — `ClientCapabilities` is `{ experimental?, roots?,
        // sampling?, elicitation? }` — and claiming it declared something the
        // schema does not define. This client implements none of the four, so it
        // claims none: a strict validator is entitled to reject an unknown key
        // with `-32602`, and a permissive one learns nothing either way.
        capabilities: {},
        clientInfo: { name: this.options.clientName, version: this.options.clientVersion },
      },
      this.options.handshakeTimeoutMs,
    );

    const info = readServerInfo(result);
    this.info = info;
    this.transport.send(notification('notifications/initialized'));
    return info;
  }

  /**
   * Ask the server for its tools.
   *
   * Follows `nextCursor` so a server with many tools is not silently truncated.
   * Capped, because an unbounded loop over a buggy or hostile server would hang
   * the caller that is only trying to discover tools.
   */
  async listTools(maxPages = 20): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const params = cursor === undefined ? {} : { cursor };
      const result = await this.call('tools/list', params);
      const record = asRecord(result);
      const listed = Array.isArray(record?.['tools']) ? (record['tools'] as unknown[]) : [];
      for (const entry of listed) {
        const tool = readToolInfo(entry);
        if (tool !== null) tools.push(tool);
      }
      const next = record?.['nextCursor'];
      if (typeof next !== 'string' || next === '') break;
      cursor = next;
    }
    this.cachedTools = tools;
    return tools;
  }

  /** The last advertised tool set, or `null` before `listTools` has run. */
  get tools(): McpToolInfo[] | null {
    return this.cachedTools;
  }

  /**
   * Call a tool.
   *
   * MCP reports a tool's own failure inside a successful response (`isError`),
   * which is deliberately not turned into a thrown error: a tool that could not
   * do its job is information for the model, exactly as `ToolResult.ok === false`
   * is elsewhere in this codebase.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: string; isError: boolean; raw: unknown }> {
    const result = await this.call('tools/call', { name, arguments: args }, this.options.requestTimeoutMs, signal);
    const record = asRecord(result);
    const blocks = Array.isArray(record?.['content']) ? (record['content'] as unknown[]) : [];
    const text = blocks
      .map((block) => {
        const b = asRecord(block);
        if (b === null) return '';
        // Text blocks carry `text`; anything else (image, resource, audio) is
        // summarised by type rather than dropped, so the model knows it exists.
        if (typeof b['text'] === 'string') return b['text'];
        if (typeof b['type'] === 'string') return `[${b['type']} content]`;
        return '';
      })
      .filter((part) => part !== '')
      .join('\n');
    return {
      content: text,
      isError: record?.['isError'] === true,
      raw: result,
    };
  }

  /** Shut the transport down. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('client closed'));
    await this.transport.close().catch(() => undefined);
  }

  /** Issue one request and await its response. */
  private call(
    method: string,
    params?: unknown,
    timeoutMs = this.options.requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(this.closeReason ?? new Error(`MCP client for ${this.label} is closed.`));
    }
    if (signal?.aborted === true) {
      return Promise.reject(new Error(`MCP call ${method} was cancelled.`));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} on ${this.label} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      // A timeout must never keep the process alive on its own.
      timer.unref?.();

      const onAbort = (): void => {
        const entry = this.pending.get(id);
        if (entry === undefined) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        reject(new Error(`MCP ${method} on ${this.label} was cancelled.`));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(id, {
        method,
        timer,
        resolve: (result) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      });

      try {
        this.transport.send(request(id, method, params));
      } catch (e) {
        const entry = this.pending.get(id);
        if (entry !== undefined) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
        }
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private handleMessage(raw: unknown): void {
    const msg = parseMessage(raw);
    if (msg === null) return;

    // A request *from* the server has to be told apart from a response *to* us,
    // and the discriminator is `method`, not `id`. Both carry an id, so checking
    // only for an id made a server→client request — `sampling/createMessage`,
    // `roots/list`, `ping` — look like the answer to whatever call happened to be
    // in flight: the pending promise resolved with `response.result`, which is
    // `undefined`, and the server was left waiting for a reply forever. Silent
    // wrong data is the worst failure mode available here.
    if ('method' in msg) {
      this.handleServerMessage(msg as JsonRpcRequest);
      return;
    }

    // A notification has no id and expects no answer.
    if (!('id' in msg) || msg.id === undefined || msg.id === null) return;

    const entry = this.pending.get(msg.id);
    if (entry === undefined) return; // A response to something already abandoned.
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);

    const response = msg as JsonRpcResponse;
    if (isFailure(response)) {
      entry.reject(
        new Error(
          `MCP ${entry.method} on ${this.label} failed: ${response.error.message} (code ${response.error.code})`,
        ),
      );
      return;
    }
    entry.resolve(response.result);
  }

  /**
   * Answer something the server asked *us*.
   *
   * `ping` is the one request the MCP specification obliges a client to answer,
   * and it is how a server decides the connection is still worth keeping.
   * Everything else — sampling, roots, elicitation — is a capability this office
   * does not advertise, so the honest reply is "method not found": the server
   * then knows not to ask again, rather than hanging on a promise nobody will
   * settle. Refusing by name is also what the ACP side already does
   * (`vendors/acp.ts`), and the two protocols share this transport.
   */
  private handleServerMessage(msg: JsonRpcRequest): void {
    // A notification has no id and expects no answer — but some of them carry
    // information worth acting on, so it is handled before the early return
    // rather than dropped.
    if (msg.id === undefined) {
      if (msg.method === 'notifications/tools/list_changed') this.toolsChanged?.();
      return;
    }
    const reply = (payload: Record<string, unknown>): void => {
      try {
        this.transport.send(payload);
      } catch {
        // A transport that cannot carry the reply is already failing; the close
        // path reports why.
      }
    };

    if (msg.method === 'ping') {
      reply({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }
    if (msg.method.startsWith('notifications/')) return;
    reply({
      jsonrpc: '2.0',
      id: msg.id,
      error: {
        code: RPC_ERRORS.methodNotFound,
        message:
          `This office does not implement "${msg.method}". It advertises no client capabilities, ` +
          'so it cannot answer sampling, roots or elicitation requests.',
      },
    });
  }

  /** Reject everything in flight, e.g. because the connection died. */
  /**
   * Reject everything in flight, e.g. because the connection died.
   *
   * `unexpected` distinguishes a transport failure — a crashed server, a closed
   * pipe — from our own `close()`. Only the former is reported upward: a
   * deliberate shutdown is not news, and waking the manager for it would make it
   * mark a connection failed that it just chose to remove.
   */
  private failAll(error: Error, unexpected = false): void {
    if (this.closeReason === null) this.closeReason = error;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new Error(`MCP ${entry.method} on ${this.label} failed: ${error.message}`));
    }
    if (unexpected) {
      const notify = this.onFatal;
      // Cleared first, so a client that keeps failing reports once: the manager
      // acts by tearing the connection down, and a second report would race that.
      this.onFatal = null;
      notify?.(error);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readServerInfo(result: unknown): McpServerInfo {
  const record = asRecord(result);
  const server = asRecord(record?.['serverInfo']);
  return {
    name: typeof server?.['name'] === 'string' ? server['name'] : 'unknown',
    version: typeof server?.['version'] === 'string' ? server['version'] : 'unknown',
    protocolVersion:
      typeof record?.['protocolVersion'] === 'string' ? record['protocolVersion'] : MCP_PROTOCOL_VERSION,
    ...(typeof record?.['instructions'] === 'string' ? { instructions: record['instructions'] } : {}),
  };
}

function readToolInfo(entry: unknown): McpToolInfo | null {
  const record = asRecord(entry);
  if (record === null) return null;
  const name = record['name'];
  if (typeof name !== 'string' || name === '') return null;
  return {
    name,
    ...(typeof record['description'] === 'string' ? { description: record['description'] } : {}),
    ...(record['inputSchema'] !== undefined ? { inputSchema: record['inputSchema'] } : {}),
  };
}

export { RPC_ERRORS };
