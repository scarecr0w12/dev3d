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

  /** Re-read the server list: drop what is gone, add what is new. */
  async refresh(configs: McpServerConfig[]): Promise<void> {
    const wanted = new Set(configs.map((c) => c.id));
    for (const [id, conn] of [...this.connections]) {
      if (!wanted.has(id) || configs.find((c) => c.id === id)?.enabled === false) {
        await this.disconnect(id);
        void conn;
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

    try {
      const info = await client.connect();
      const listed = await client.listTools();
      const published: McpToolRecord[] = [];

      for (const tool of listed) {
        const publishedName = publishedToolName(config.id, tool.name);
        if (this.deps.registry.get(publishedName) !== undefined) {
          this.deps.log('warn', 'mcp', `${config.id}: "${tool.name}" is already published; skipping`);
          continue;
        }
        this.deps.registry.register(toTool(config.id, publishedName, tool, client));
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

  private pushNote(notes: string[], line: string): void {
    notes.push(line);
    while (notes.length > 10) notes.shift();
  }
}

/**
 * The name a remote tool is published under.
 *
 * Server ids and tool names are both restricted to characters that cannot be
 * confused with the `__` separator, so the published name can be split back
 * apart again without ambiguity.
 */
export function publishedToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
}

/** Split a published name back into its parts, or `null` if it is not one. */
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
  return { serverId, toolName };
}

/** Wrap a remote tool as a local one. */
function toTool(
  serverId: string,
  publishedName: string,
  info: McpToolInfo,
  client: McpClient,
): Tool {
  return {
    name: publishedName,
    description:
      `${info.description ?? `The "${info.name}" tool from the MCP server "${serverId}".`}\n` +
      `(Provided by the MCP server "${serverId}" as "${info.name}".)`,
    parameters:
      typeof info.inputSchema === 'object' && info.inputSchema !== null
        ? (info.inputSchema as Record<string, unknown>)
        : { type: 'object', properties: {} },
    run: async (args, ctx): Promise<ToolResult> => {
      const started = Date.now();
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
