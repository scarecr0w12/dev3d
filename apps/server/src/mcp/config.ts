/**
 * MCP configuration.
 *
 * Two sources, because the two cases are genuinely different:
 *
 *  - `DEV3D_MCP_SERVERS` in the environment, for one or two servers and for
 *    deployments that configure everything through env. One server per entry,
 *    whitespace-separated as `<id>=<command> [args...]`.
 *  - A JSON file (`DEV3D_MCP_CONFIG`, default `./mcp.json`), for anything
 *    richer: http servers, extra environment, per-server timeouts.
 *
 * Both are merged, and the file wins on an id collision, so an env entry can
 * point a server at a different command without the file being edited.
 *
 * A malformed entry is skipped with a reason rather than taking the whole list
 * down: one bad server must not stop the others connecting.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { McpServerConfig } from './manager.ts';

export interface McpConfigResult {
  servers: McpServerConfig[];
  /** Problems found while reading config, to be logged rather than thrown. */
  problems: string[];
  /** Where the file was read from, when one was. */
  file: string | null;
}

/** Server ids appear inside tool names, so keep them to a safe alphabet. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Parse the `DEV3D_MCP_SERVERS` environment variable.
 *
 * Entries are separated by a semicolon, and within an entry everything after the
 * first `=` is the command line, split on whitespace:
 *
 *     DEV3D_MCP_SERVERS="fs=npx -y @modelcontextprotocol/server-filesystem /srv; git=uvx mcp-server-git"
 *
 * A semicolon separator rather than a space is the whole point: arguments
 * routinely contain spaces (and `=`), so anything whitespace-delimited cannot
 * tell where one server ends and the next begins. A path with a semicolon in it
 * is the one thing this cannot express — that server's arguments have to move to
 * the JSON config file.
 */
export function parseServerList(raw: string): { servers: McpServerConfig[]; problems: string[] } {
  const servers: McpServerConfig[] = [];
  const problems: string[] = [];
  const entries = raw
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '');

  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      problems.push(
        `DEV3D_MCP_SERVERS entry ${JSON.stringify(entry)} is not in <id>=<command> form. ` +
          `Separate servers with ";".`,
      );
      continue;
    }
    const id = entry.slice(0, eq).trim();
    const rest = entry.slice(eq + 1).trim();
    if (!ID_RE.test(id)) {
      problems.push(`MCP server id ${JSON.stringify(id)} must be letters, digits, "-" or "_", and start with one of the first two.`);
      continue;
    }
    if (rest === '') {
      problems.push(`MCP server ${JSON.stringify(id)} names no command.`);
      continue;
    }
    const parts = rest.split(/\s+/);
    const command = parts[0]!;
    const args = parts.slice(1);
    servers.push({
      id,
      transport: { kind: 'stdio', command, ...(args.length > 0 ? { args } : {}) },
      enabled: true,
    });
  }
  return { servers, problems };
}

/** Read and validate the JSON config file. */
export function readConfigFile(path: string): { servers: McpServerConfig[]; problems: string[] } {
  const problems: string[] = [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { servers: [], problems: [`Could not read ${path}: ${e instanceof Error ? e.message : String(e)}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { servers: [], problems: [`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }

  const record = isRecord(parsed) ? parsed : null;
  const list = record !== null && Array.isArray(record['servers']) ? (record['servers'] as unknown[]) : null;
  if (list === null) {
    return { servers: [], problems: [`${path} must be an object with a "servers" array.`] };
  }

  const servers: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i += 1) {
    const result = readServer(list[i], `servers[${i}]`, problems);
    if (result === null) continue;
    if (seen.has(result.id)) {
      problems.push(`servers[${i}]: duplicate server id ${JSON.stringify(result.id)}.`);
      continue;
    }
    seen.add(result.id);
    servers.push(result);
  }
  return { servers, problems };
}

function readServer(entry: unknown, where: string, problems: string[]): McpServerConfig | null {
  if (!isRecord(entry)) {
    problems.push(`${where} is not an object.`);
    return null;
  }
  const id = entry['id'];
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    problems.push(`${where}.id must be letters, digits, "-" or "_", and start with one of the first two.`);
    return null;
  }
  const enabled = entry['enabled'] !== false;
  const description = typeof entry['description'] === 'string' ? entry['description'] : undefined;
  const requestTimeoutMs =
    typeof entry['requestTimeoutMs'] === 'number' && Number.isFinite(entry['requestTimeoutMs'])
      ? entry['requestTimeoutMs']
      : undefined;
  const common = {
    id,
    enabled,
    ...(description !== undefined ? { description } : {}),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
  };

  // `type` names the transport; `transport` is accepted as an alias.
  const kind = typeof entry['type'] === 'string' ? entry['type'] : entry['transport'];
  if (kind === 'http' || kind === 'sse') {
    const url = entry['url'];
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      problems.push(`${where}.url must be an absolute http(s) URL.`);
      return null;
    }
    const headers = isRecord(entry['headers'])
      ? Object.fromEntries(
          Object.entries(entry['headers'] as Record<string, unknown>)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => [k, v as string]),
        )
      : undefined;
    return {
      ...common,
      transport: { kind: 'http', url, ...(headers !== undefined ? { headers } : {}) },
    };
  }

  if (kind === 'stdio' || kind === undefined) {
    const command = entry['command'];
    if (typeof command !== 'string' || command.trim() === '') {
      problems.push(`${where}.command must be a non-empty string (or set "type": "http" with a "url").`);
      return null;
    }
    const args = Array.isArray(entry['args'])
      ? (entry['args'] as unknown[]).filter((a): a is string => typeof a === 'string')
      : undefined;
    const env = isRecord(entry['env'])
      ? Object.fromEntries(
          Object.entries(entry['env'] as Record<string, unknown>)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => [k, v as string]),
        )
      : undefined;
    const cwd = typeof entry['cwd'] === 'string' ? entry['cwd'] : undefined;
    return {
      ...common,
      transport: {
        kind: 'stdio',
        command,
        ...(args !== undefined && args.length > 0 ? { args } : {}),
        ...(env !== undefined ? { env } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      },
    };
  }

  problems.push(`${where}.type must be "stdio" or "http", not ${JSON.stringify(kind)}.`);
  return null;
}

/**
 * Load the whole configuration.
 *
 * `repoRoot` is used to resolve a relative config path, so the office reads the
 * same file no matter which directory it was started from.
 */
export function loadMcpConfig(env: NodeJS.ProcessEnv, repoRoot: string): McpConfigResult {
  const problems: string[] = [];
  const byId = new Map<string, McpServerConfig>();

  const inline = env['DEV3D_MCP_SERVERS'];
  if (typeof inline === 'string' && inline.trim() !== '') {
    const parsed = parseServerList(inline);
    problems.push(...parsed.problems);
    for (const server of parsed.servers) byId.set(server.id, server);
  }

  const configured = env['DEV3D_MCP_CONFIG'];
  const filePath =
    configured !== undefined && configured !== ''
      ? resolve(repoRoot, configured)
      : env['DEV3D_MCP_CONFIG'] === ''
        ? null
        : resolve(repoRoot, 'mcp.json');

  let file: string | null = null;
  if (filePath !== null && existsSync(filePath)) {
    const parsed = readConfigFile(filePath);
    problems.push(...parsed.problems);
    // The file wins on a collision: it is the richer, more explicit source.
    for (const server of parsed.servers) byId.set(server.id, server);
    file = filePath;
  } else if (configured !== undefined && configured !== '' && filePath !== null) {
    // An explicitly named file that is missing is worth saying out loud; a
    // missing default `mcp.json` is simply "no MCP servers configured".
    problems.push(`DEV3D_MCP_CONFIG points at ${filePath}, which does not exist.`);
  }

  return { servers: [...byId.values()], problems, file };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
