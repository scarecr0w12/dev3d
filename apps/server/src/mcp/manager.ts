/**
 * The MCP manager: it owns the connections to every configured MCP server and
 * turns each server's tools into tools this office can grant.
 *
 * The naming rule is the important part. A remote server names its own tools,
 * and nothing stops two servers from both offering `search`, or a server from
 * offering `read_file` and shadowing a built-in. Every MCP tool is therefore
 * published as:
 *
 *     mcp__<serverId>__<toolName>
 *
 * which is unambiguous, greppable, and impossible to collide with a built-in
 * because of the prefix. The original name is what gets sent on the wire; only
 * the published name is namespaced.
 *
 * Connections are made in the background. A server that is down must not stop
 * the office booting, and must not stop the other servers working.
 */

import type { Tool, ToolRegistry, ToolResult } from '../tools/types.ts';
import { McpClient, type McpToolInfo, type McpTransport } from './client.ts';
import { StdioTransport } from '../rpc/stdio.ts';
import { HttpTransport } from './http.ts';

export type McpServerState = 'connecting' | 'ready' | 'failed' | 'disabled';

export interface McpServerConfig {
  id: string;
  /** stdio: the program to run. http: the endpoint URL. */
  transport:
    | { kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
    | { kind: 'http'; url: string; headers?: Record<string, string> };
  /** A server that is configured but turned off is not connected. */
  enabled?: boolean;
  /** Optional human note, shown in the console. */
  description?: string;
  requestTimeoutMs?: number;
}

export interface McpToolRecord {
  /** The name published to the registry, e.g. `mcp__fs__read_file`. */
  publishedName: string;
  /** The name the server knows. */
  remoteName: string;
  serverId: string;
  description: string;
  /** True once a role has been granted it. */
  granted: boolean;
}

export interface McpStatus {
  id: string;
  state: McpServerState;
  transport: string;
  /** Present when ready. */
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  toolCount: number;
  /** Why it is not ready. */
  error?: string;
  /** Last stderr lines or transport noise, for diagnosis. */
  notes: string[];
}

export interface McpManagerDeps {
  registry: ToolRegistry;
  /** Where status and noise go. */
  log(level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string): void;
  /** Build a transport. Injected so tests can supply a fake one. */
  makeTransport?(config: McpServerConfig, hooks: TransportHooks): McpTransport;
  clientName?: string;
  clientVersion?: string;
  /**
   * Whether the first call to a tool from a newly connected server asks a human.
   *
   * On unless the operator turned it off. A remote tool is the one kind that is
   * neither confined nor otherwise gated: its arguments go to somebody else's
   * process verbatim and `ctx.workspaceRoot` is never consulted, so the approval
   * round trip is the only thing standing between a model-authored argument and a
   * filesystem that is not the workspace.
   */
  requireApproval?: boolean;
}

/** Hooks handed to a transport so its chatter reaches the log and status. */
export interface TransportHooks {
  onStderr(line: string): void;
  onNoise(line: string): void;
}

/** The maximum a single remote tool result may contribute to a turn. */
const MAX_RESULT_CHARS = 20_000;

interface Connection {
  config: McpServerConfig;
  client: McpClient;
  status: McpStatus;
  tools: McpToolRecord[];
}

export class McpManager {
  private readonly deps: McpManagerDeps;
  private readonly connections = new Map<string, Connection>();
  /**
   * Servers whose tools an operator has already agreed to for this connection.
   *
   * Keyed by server id and cleared when a server disconnects, so a reconnect asks
   * again — a different process may be answering. Asked once per connection rather
   * than once per call: a prompt on every call is answered by reflex, which is
   * worse than not asking.
   */
  private readonly approvedServers = new Set<string>();
  private started = false;

  constructor(deps: McpManagerDeps) {
    this.deps = deps;
  }

  /**
   * Connect every enabled server, in the background.
   *
   * Returns immediately: boot must not wait on somebody else's process or
   * network. The returned promise resolves when every connection has settled,
   * which is what tests and the `refresh` command await.
   */
  start(configs: McpServerConfig[]): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    return this.connectAll(configs);
  }

  /** Re-read the server list: drop what is gone, add what is new, retry what failed. */
  async refresh(configs: McpServerConfig[]): Promise<void> {
    const wanted = new Set(configs.map((c) => c.id));
    for (const [id, conn] of [...this.connections]) {
      const config = configs.find((c) => c.id === id);
      // Also drop anything that is not `ready`, so a retry can actually retry.
      // `connectAll` skips ids already in the map, so a connection that failed at
      // boot — or died mid-session — stayed failed for the life of the process,
      // and this route (whose whole purpose is "pick up a new server") was the
      // one place an operator would go to fix it.
      const unhealthy = conn.status.state !== 'ready';
      if (!wanted.has(id) || config?.enabled === false || unhealthy) {
        await this.disconnect(id);
      }
    }
    await this.connectAll(configs);
  }

  /** Status of every configured server, for the console. */
  status(): McpStatus[] {
    return [...this.connections.values()].map((c) => ({ ...c.status, notes: [...c.status.notes] }));
  }

  /** Every MCP tool currently published, across all ready servers. */
  tools(): McpToolRecord[] {
    return [...this.connections.values()].flatMap((c) => c.tools.map((t) => ({ ...t })));
  }

  /** The names an org chart may grant. */
  toolNames(): string[] {
    return this.tools().map((t) => t.publishedName);
  }

  /** Disconnect one server and unpublish its tools. */
  async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (conn === undefined) return;
    for (const tool of conn.tools) this.deps.registry.unregister(tool.publishedName);
    await conn.client.close();
    this.connections.delete(id);
    // A reconnect is a new process on the other end, so the operator's earlier
    // answer does not carry over to it.
    this.approvedServers.delete(id);
    this.deps.log('info', 'mcp', `disconnected ${id}`);
  }

  /** Disconnect everything. */
  async close(): Promise<void> {
    for (const id of [...this.connections.keys()]) await this.disconnect(id);
  }

  private async connectAll(configs: McpServerConfig[]): Promise<void> {
    const work = configs
      .filter((config) => config.enabled !== false)
      .filter((config) => !this.connections.has(config.id))
      .map((config) => this.connectOne(config));
    await Promise.all(work);
  }

  /** Connect one server. Never throws: a failure is recorded as status. */
  private async connectOne(config: McpServerConfig): Promise<void> {
    const notes: string[] = [];
    const transportLabel =
      config.transport.kind === 'stdio'
        ? [config.transport.command, ...(config.transport.args ?? [])].join(' ')
        : config.transport.url;

    const status: McpStatus = {
      id: config.id,
      state: 'connecting',
      transport: transportLabel,
      toolCount: 0,
      notes,
    };

    const hooks: TransportHooks = {
      onStderr: (line) => {
        this.pushNote(notes, line);
        this.deps.log('debug', 'mcp', `${config.id} stderr: ${line}`);
      },
      onNoise: (line) => {
        this.pushNote(notes, `unparseable output: ${line}`);
        this.deps.log('warn', 'mcp', `${config.id} printed non-JSON to its wire: ${line}`);
      },
    };

    let transport: McpTransport;
    try {
      transport = this.deps.makeTransport
        ? this.deps.makeTransport(config, hooks)
        : buildTransport(config, hooks);
    } catch (e) {
      status.state = 'failed';
      status.error = e instanceof Error ? e.message : String(e);
      this.connections.set(config.id, {
        config,
        client: new McpClient(new NullTransport(`${config.id} (unstartable)`)),
        status,
        tools: [],
      });
      this.deps.log('error', 'mcp', `${config.id}: ${status.error}`);
      return;
    }

    const client = new McpClient(transport, {
      ...(config.requestTimeoutMs !== undefined ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
      ...(this.deps.clientName !== undefined ? { clientName: this.deps.clientName } : {}),
      ...(this.deps.clientVersion !== undefined ? { clientVersion: this.deps.clientVersion } : {}),
    });

    const connection: Connection = { config, client, status, tools: [] };
    this.connections.set(config.id, connection);

    /**
     * A server that dies mid-session must stop looking healthy.
     *
     * Nothing told the manager before: `failAll` rejected in-flight calls and the
     * status stayed whatever the last successful probe said, so the console kept
     * a green row, `tools()` kept publishing names that could no longer be
     * called, and a role's grant went on pointing at a dead process. The remedy
     * was a full restart.
     *
     * There is deliberately **no automatic reconnect**. A crashed harness is
     * usually a misconfiguration, and respawning one in a loop on every boot is a
     * worse experience than saying plainly that it failed — `POST
     * /api/mcp/refresh` is the operator's retry, and it now retries failures too.
     */
    client.onFatalError((error) => {
      // Only if this connection is still the current one: a `refresh` may have
      // replaced it between the failure and this callback.
      if (this.connections.get(config.id) !== connection) return;
      status.state = 'failed';
      status.error = `the server stopped responding: ${error.message}`;
      status.toolCount = 0;
      for (const tool of connection.tools) this.deps.registry.unregister(tool.publishedName);
      connection.tools = [];
      this.deps.log('warn', 'mcp', `${config.id}: ${status.error}`);
    });

    /**
     * The server moved its tool set; follow it.
     *
     * The published set used to be frozen at connect time, so a server that added
     * or removed a tool at runtime kept advertising stale names — and the only
     * remedy was a restart, because `refresh` cannot re-list a connection that is
     * otherwise healthy.
     */
    client.onToolsChanged(() => {
      if (this.connections.get(config.id) !== connection) return;
      void this.relistTools(config.id).catch((e: unknown) => {
        this.deps.log(
          'warn',
          'mcp',
          `${config.id}: could not re-read its tool list: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    });

    try {
      const info = await client.connect();
      const listed = await client.listTools();
      const published: McpToolRecord[] = [];

      const serverId = config.id;
      const requireApproval = this.deps.requireApproval !== false;
      const toolNames = listed.map((tool) => tool.name);
      for (const tool of listed) {
        const publishedName = publishedToolName(config.id, tool.name);
        if (this.deps.registry.get(publishedName) !== undefined) {
          this.deps.log('warn', 'mcp', `${config.id}: "${tool.name}" is already published; skipping`);
          continue;
        }
        this.deps.registry.register(
          toTool(config.id, publishedName, tool, client, {
            requireApproval,
            toolNames,
            isApproved: () => this.approvedServers.has(serverId),
            approve: () => this.approvedServers.add(serverId),
          }),
        );
        published.push({
          publishedName,
          remoteName: tool.name,
          serverId: config.id,
          description: tool.description ?? '',
          granted: false,
        });
      }

      connection.tools = published;
      status.state = 'ready';
      status.serverName = info.name;
      status.serverVersion = info.version;
      status.protocolVersion = info.protocolVersion;
      status.toolCount = published.length;
      this.deps.log(
        'info',
        'mcp',
        `${config.id}: ready (${info.name} ${info.version}, protocol ${info.protocolVersion}), ${published.length} tool(s)`,
      );
    } catch (e) {
      status.state = 'failed';
      status.error = e instanceof Error ? e.message : String(e);
      await client.close().catch(() => undefined);
      this.deps.log('warn', 'mcp', `${config.id}: ${status.error}`);
    }
  }

  /**
   * Re-read one server's tool list and reconcile the published set with it.
   *
   * Diffs rather than replacing wholesale, because a tool that has not changed
   * must keep the *same* registry entry: unregistering and re-registering it
   * would drop the console's grant state and any in-flight reference for no
   * reason. Gone tools are withdrawn, new ones registered, and a rename shows up
   * honestly as one of each rather than as a silent swap.
   */
  private async relistTools(id: string): Promise<void> {
    const connection = this.connections.get(id);
    if (connection === undefined || connection.status.state !== 'ready') return;
    const listed = await connection.client.listTools();

    const before = new Map(connection.tools.map((tool) => [tool.remoteName, tool]));
    const next: McpToolRecord[] = [];
    const requireApproval = this.deps.requireApproval !== false;
    const toolNames = listed.map((tool) => tool.name);

    for (const tool of listed) {
      const existing = before.get(tool.name);
      if (existing !== undefined) {
        // Unchanged: keep the record (and therefore the grant) as it was.
        before.delete(tool.name);
        next.push(existing);
        continue;
      }
      const publishedName = publishedToolName(id, tool.name);
      if (this.deps.registry.get(publishedName) !== undefined) {
        this.deps.log('warn', 'mcp', `${id}: "${tool.name}" is already published; skipping`);
        continue;
      }
      this.deps.registry.register(
        toTool(id, publishedName, tool, connection.client, {
          requireApproval,
          toolNames,
          isApproved: () => this.approvedServers.has(id),
          approve: () => this.approvedServers.add(id),
        }),
      );
      next.push({
        publishedName,
        remoteName: tool.name,
        serverId: id,
        description: tool.description ?? '',
        granted: false,
      });
      this.deps.log('info', 'mcp', `${id}: published new tool "${tool.name}"`);
    }

    for (const gone of before.values()) {
      this.deps.registry.unregister(gone.publishedName);
      this.deps.log('info', 'mcp', `${id}: withdrew tool "${gone.remoteName}"`);
    }

    connection.tools = next;
    connection.status.toolCount = next.length;
  }

  private pushNote(notes: string[], line: string): void {
    notes.push(line);
    while (notes.length > 10) notes.shift();
  }
}

/**
 * The name a remote tool is published under.
 *
 * The split back apart is unambiguous because the two halves are constrained
 * differently, and both constraints are enforced rather than assumed:
 *
 *  - a **server id** may not contain `_` at all (`mcp/config.ts` `ID_RE`), so the
 *    first `__` is always the separator;
 *  - a **tool name** may contain `_` freely, which is why nothing here escapes it.
 *
 * That comment used to say ids and tool names "are both restricted to characters
 * that cannot be confused with the `__` separator" — untrue of ids, which allowed
 * `_`. With it, server `a` tool `b__c` and server `a__b` tool `c` published the
 * same name, and whichever connected second was skipped with a warning.
 */
export function publishedToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
}

/**
 * Split a published name back into its parts, or `null` if it is not one.
 *
 * Returns `null` for a server id containing `_`, because such a name cannot be
 * split reliably: the id itself is ambiguous with the separator, and guessing
 * would silently attribute a tool to the wrong server. Config validation now
 * refuses those ids, so this is the belt to that braces.
 */
export function parsePublishedToolName(
  publishedName: string,
): { serverId: string; toolName: string } | null {
  if (!publishedName.startsWith('mcp__')) return null;
  const rest = publishedName.slice('mcp__'.length);
  const at = rest.indexOf('__');
  if (at <= 0) return null;
  const serverId = rest.slice(0, at);
  const toolName = rest.slice(at + 2);
  if (toolName === '') return null;
  if (serverId.includes('_')) return null;
  return { serverId, toolName };
}

/** Wrap a remote tool as a local one. */
/**
 * How much of a server-chosen description or schema is kept.
 *
 * A server's `description` becomes part of every system prompt that grants the
 * tool, so an unbounded one is a context-flooding channel — as is an
 * arbitrarily deep `inputSchema`, which is also what the model is asked to
 * produce arguments against.
 */
const MAX_DESCRIPTION_CHARS = 1_000;
const MAX_SCHEMA_CHARS = 8_000;

/**
 * Strip control characters from text that came from somewhere else.
 *
 * A terminal escape sequence in a description or a tool result renders in the
 * console and can hide what is really there; NUL bytes and C1 controls have no
 * legitimate place in a JSON-RPC payload. Tabs and newlines are kept, because
 * they carry meaning in prose and code.
 */
function stripControls(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}

/**
 * An MCP tool's `inputSchema`, validated enough to be worth passing on.
 *
 * The model is asked to produce arguments against this, so it has to be a JSON
 * Schema *object*: a server that answers with a string, a number or an array
 * would otherwise have that value used as `parameters` and fail somewhere much
 * less obvious than here.
 */
function usableSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const record = schema as Record<string, unknown>;
  // Bound it by serialised size: depth is what would otherwise be unbounded.
  let encoded: string;
  try {
    encoded = JSON.stringify(record);
  } catch {
    return { type: 'object', properties: {} };
  }
  if (encoded.length > MAX_SCHEMA_CHARS) {
    // Keep the declared shape but drop everything else, rather than passing a
    // truncated document that is no longer a valid schema.
    const narrowed: Record<string, unknown> = {};
    if (typeof record['type'] === 'string') narrowed['type'] = record['type'];
    if (typeof record['description'] === 'string') {
      narrowed['description'] = stripControls(record['description']).slice(0, MAX_DESCRIPTION_CHARS);
    }
    return { ...narrowed, type: typeof narrowed['type'] === 'string' ? narrowed['type'] : 'object', properties: {} };
  }
  return record;
}

function toTool(
  serverId: string,
  publishedName: string,
  info: McpToolInfo,
  client: McpClient,
  options: {
    /** Whether this call must clear an approval first. */
    requireApproval: boolean;
    /** The server's tools, named for the approval prompt. */
    toolNames: readonly string[];
    /** Records that the operator agreed, so the next call does not ask again. */
    approve(): void;
    /** Whether the operator has already agreed for this connection. */
    isApproved(): boolean;
  },
): Tool {
  const described = stripControls(info.description ?? '').trim();
  const fallback = `The "${info.name}" tool from the MCP server "${serverId}".`;
  const description = clip(described === '' ? fallback : described, MAX_DESCRIPTION_CHARS);
  return {
    name: publishedName,
    description: `${description}\n(Provided by the MCP server "${serverId}" as "${info.name}".)`,
    parameters: usableSchema(info.inputSchema),
    run: async (args, ctx): Promise<ToolResult> => {
      const started = Date.now();
      if (options.requireApproval && !options.isApproved()) {
        // The gate the review asked for, and the only one of its kind here: an MCP
        // tool is unconfined (the arguments go to somebody else's process verbatim
        // and `ctx.workspaceRoot` is never consulted) and, unlike `run_shell`, was
        // not approval-gated at all. Asked once per server per connection.
        const granted = await ctx
          .requestApproval({
            kind: 'network',
            summary: `use the MCP server "${serverId}" (${options.toolNames.length} tool(s))`,
            detail:
              `"${info.name}" would be run by the MCP server "${serverId}", which is a separate program ` +
              `outside this office.\n\nIt provides: ${options.toolNames.join(', ')}.\n\n` +
              'Unlike the built-in tools, dev3d cannot confine what it does with the arguments it is given.',
          })
          .catch(() => false);
        if (!granted) {
          return {
            ok: false,
            content:
              `The human declined to use the MCP server "${serverId}", so "${info.name}" was not called. ` +
              'Do not retry it; carry on with the tools you have.',
            preview: `MCP server "${serverId}" declined`,
            affectsPaths: [],
          };
        }
        options.approve();
      }
      try {
        const result = await client.callTool(info.name, args, ctx.signal);
        const content = clip(result.content, MAX_RESULT_CHARS);
        return {
          // `isError` means the server ran the tool and it failed, which is
          // ordinary information for the model rather than a transport fault.
          ok: !result.isError,
          content: result.isError ? `The tool reported an error:\n${content}` : content,
          preview: `${info.name} via ${serverId} (${Date.now() - started}ms)`,
          affectsPaths: [],
        };
      } catch (e) {
        return {
          ok: false,
          content: `MCP tool "${info.name}" on server "${serverId}" did not complete: ${
            e instanceof Error ? e.message : String(e)
          }`,
          preview: `${info.name} failed`,
          affectsPaths: [],
        };
      }
    },
  };
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated at ${max} characters)`;
}

/** Build the transport a config asks for. */
function buildTransport(config: McpServerConfig, hooks: TransportHooks): McpTransport {
  if (config.transport.kind === 'stdio') {
    return new StdioTransport({
      command: config.transport.command,
      ...(config.transport.args !== undefined ? { args: config.transport.args } : {}),
      ...(config.transport.env !== undefined ? { env: config.transport.env } : {}),
      ...(config.transport.cwd !== undefined ? { cwd: config.transport.cwd } : {}),
      onStderr: hooks.onStderr,
      onNoise: hooks.onNoise,
    });
  }
  return new HttpTransport({
    url: config.transport.url,
    ...(config.transport.headers !== undefined ? { headers: config.transport.headers } : {}),
    onNoise: hooks.onNoise,
  });
}

/** A transport that fails every send. Used to record an unbuildable config. */
class NullTransport implements McpTransport {
  readonly label: string;
  constructor(label: string) {
    this.label = label;
  }
  async start(): Promise<void> {
    throw new Error(`${this.label} could not be constructed.`);
  }
  send(): void {
    throw new Error(`${this.label} is not running.`);
  }
  onMessage(): void {}
  onError(): void {}
  async close(): Promise<void> {}
}
