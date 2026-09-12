/**
 * Tests for the MCP protocol layer: JSON-RPC framing, the client's request and
 * response handling, and the config readers.
 *
 * The transports are tested separately and through a fake, because a sandbox
 * that forbids piped stdio cannot run a real MCP server as a child process —
 * the same constraint `docs/sandbox.md` records for the rest of the toolchain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MCP_PROTOCOL_VERSION,
  McpClient,
  notification,
  parseMessage,
  request,
  type McpTransport,
} from '../mcp/index.ts';
import { loadMcpConfig, parseServerList, readConfigFile } from '../mcp/config.ts';

// ---------------------------------------------------------------------------
// jsonrpc
// ---------------------------------------------------------------------------

test('request and notification are shaped per the spec', () => {
  assert.deepEqual(request(7, 'tools/list', { cursor: 'x' }), {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/list',
    params: { cursor: 'x' },
  });
  // A request with no params must omit the key rather than send null.
  assert.deepEqual(request(1, 'initialize'), { jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.deepEqual(notification('notifications/initialized'), {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
});

test('parseMessage accepts requests, notifications and responses', () => {
  assert.equal(parseMessage({ jsonrpc: '2.0', id: 1, method: 'x' })?.constructor, Object);
  const notif = parseMessage({ jsonrpc: '2.0', method: 'x' });
  assert.ok(notif && 'method' in notif && !('id' in notif));
  const ok = parseMessage({ jsonrpc: '2.0', id: 1, result: { a: 1 } });
  assert.ok(ok && 'result' in ok);
  const err = parseMessage({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } });
  assert.ok(err && 'error' in err);
});

test('parseMessage rejects things that are not JSON-RPC', () => {
  for (const bad of [null, undefined, 42, 'text', [], {}, { id: 1, method: 'x' }, { jsonrpc: '2.0' }, { jsonrpc: '2.0', id: 1 }]) {
    assert.equal(parseMessage(bad), null, `${JSON.stringify(bad)} should not parse`);
  }
});

// ---------------------------------------------------------------------------
// a fake transport, driving the real client
// ---------------------------------------------------------------------------

/** Records what the client sent and lets a test script the replies. */
class FakeTransport implements McpTransport {
  readonly label = 'fake';
  readonly sent: Array<Record<string, unknown>> = [];
  private handler: ((raw: unknown) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  closed = false;
  startError: Error | null = null;

  /** How to answer a request. Return undefined to answer nothing. */
  respond: (msg: Record<string, unknown>) => unknown | undefined = () => undefined;

  async start(): Promise<void> {
    if (this.startError !== null) throw this.startError;
  }

  send(message: unknown): void {
    const msg = message as Record<string, unknown>;
    this.sent.push(msg);
    if (!('id' in msg)) return; // notification: no reply
    const reply = this.respond(msg);
    if (reply !== undefined) {
      // Answer on a later tick, as a real transport would.
      queueMicrotask(() => this.handler?.(reply));
    }
  }

  onMessage(handler: (raw: unknown) => void): void {
    this.handler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  /** Let a test push a server-initiated message. */
  push(raw: unknown): void {
    this.handler?.(raw);
  }

  /** Let a test simulate the transport failing. */
  fail(error: Error): void {
    this.errorHandler?.(error);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A transport that speaks just enough MCP to satisfy a client. */
function serverDouble(tools: Array<{ name: string; description?: string; inputSchema?: unknown }>): FakeTransport {
  const transport = new FakeTransport();
  transport.respond = (msg) => {
    const id = msg['id'] as number;
    switch (msg['method']) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-server', version: '9.9.9' },
          },
        };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools } };
      case 'tools/call':
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'tool output' }] },
        };
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `no method ${String(msg['method'])}` } };
    }
  };
  return transport;
}

test('connect performs the handshake and records the server identity', async () => {
  const transport = serverDouble([]);
  const client = new McpClient(transport);
  const info = await client.connect();

  assert.equal(info.name, 'fake-server');
  assert.equal(info.version, '9.9.9');
  // The server's protocol version wins: that is what negotiation is for.
  assert.equal(info.protocolVersion, '2025-03-26');

  const methods = transport.sent.map((m) => m['method']);
  assert.deepEqual(methods, ['initialize', 'notifications/initialized']);
  // The client must not claim capabilities it does not use.
  assert.deepEqual((transport.sent[0]!['params'] as Record<string, unknown>)['capabilities'], { tools: {} });
});

test('connect reports a server that refuses the handshake', async () => {
  const transport = new FakeTransport();
  transport.respond = (msg) => ({
    jsonrpc: '2.0',
    id: msg['id'],
    error: { code: -32600, message: 'no' },
  });
  const client = new McpClient(transport);
  await assert.rejects(() => client.connect(), /failed: no \(code -32600\)/);
});

test('listTools returns the advertised tools', async () => {
  const transport = serverDouble([
    { name: 'read', description: 'read a file', inputSchema: { type: 'object' } },
    { name: 'write' },
  ]);
  const client = new McpClient(transport);
  await client.connect();
  const tools = await client.listTools();
  assert.equal(tools.length, 2);
  assert.equal(tools[0]!.name, 'read');
  assert.equal(tools[0]!.description, 'read a file');
});

test('listTools follows pagination', async () => {
  const transport = new FakeTransport();
  let page = 0;
  transport.respond = (msg) => {
    const id = msg['id'];
    if (msg['method'] === 'initialize') {
      return { jsonrpc: '2.0', id, result: { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: 'p', version: '1' } } };
    }
    page += 1;
    return page === 1
      ? { jsonrpc: '2.0', id, result: { tools: [{ name: 'a' }], nextCursor: 'more' } }
      : { jsonrpc: '2.0', id, result: { tools: [{ name: 'b' }] } };
  };
  const client = new McpClient(transport);
  await client.connect();
  const tools = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['a', 'b']);
});

test('listTools ignores malformed tool entries', async () => {
  const transport = serverDouble([{ name: 'good' }, { description: 'no name' } as never, null as never]);
  const client = new McpClient(transport);
  await client.connect();
  const tools = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['good']);
});

test('callTool joins text content blocks', async () => {
  const transport = serverDouble([]);
  const client = new McpClient(transport);
  await client.connect();
  const result = await client.callTool('anything', { a: 1 });
  assert.equal(result.isError, false);
  assert.equal(result.content, 'tool output');
});

test('callTool describes non-text content rather than dropping it', async () => {
  const transport = new FakeTransport();
  transport.respond = (msg) =>
    msg['method'] === 'initialize'
      ? { jsonrpc: '2.0', id: msg['id'], result: { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: 'f', version: '1' } } }
      : { jsonrpc: '2.0', id: msg['id'], result: { content: [{ type: 'image', data: 'xyz' }, { type: 'text', text: 'caption' }] } };
  const client = new McpClient(transport);
  await client.connect();
  const result = await client.callTool('t', {});
  assert.equal(result.content, '[image content]\ncaption');
});

test('callTool surfaces a tool failure without throwing', async () => {
  const transport = new FakeTransport();
  transport.respond = (msg) =>
    msg['method'] === 'initialize'
      ? { jsonrpc: '2.0', id: msg['id'], result: { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: 'f', version: '1' } } }
      : { jsonrpc: '2.0', id: msg['id'], result: { content: [{ type: 'text', text: 'file not found' }], isError: true } };
  const client = new McpClient(transport);
  await client.connect();
  const result = await client.callTool('t', {});
  // A tool that ran and failed is information, not a transport fault.
  assert.equal(result.isError, true);
  assert.equal(result.content, 'file not found');
});

test('a request that is never answered times out', async () => {
  const transport = new FakeTransport();
  transport.respond = () => undefined;
  const client = new McpClient(transport, { requestTimeoutMs: 30, handshakeTimeoutMs: 30 });
  await assert.rejects(() => client.connect(), /timed out after 30ms/);
});

test('closing the client rejects what is in flight', async () => {
  const transport = new FakeTransport();
  transport.respond = () => undefined;
  const client = new McpClient(transport, { requestTimeoutMs: 5000, handshakeTimeoutMs: 5000 });
  const pending = client.connect();
  await new Promise((r) => setTimeout(r, 10));
  await client.close();
  await assert.rejects(() => pending, /client closed|closed/);
  assert.equal(transport.closed, true);
});

test('cancelling a call aborts it', async () => {
  const transport = serverDouble([]);
  const client = new McpClient(transport);
  await client.connect();
  const controller = new AbortController();
  const pending = client.callTool('t', {}, controller.signal);
  controller.abort();
  await assert.rejects(() => pending, /cancelled/);
});

test('a transport failure rejects pending calls with its reason', async () => {
  const transport = new FakeTransport();
  transport.respond = () => undefined;
  const client = new McpClient(transport, { requestTimeoutMs: 5000, handshakeTimeoutMs: 5000 });
  const pending = client.connect();
  await new Promise((r) => setTimeout(r, 10));
  transport.fail(new Error('pipe closed'));
  await assert.rejects(() => pending, /pipe closed/);
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

test('parseServerList reads semicolon-separated id=command entries with arguments', () => {
  const { servers, problems } = parseServerList(
    'fs=npx -y @modelcontextprotocol/server-filesystem /tmp; git=uvx mcp-server-git --repository x',
  );
  assert.deepEqual(problems, []);
  assert.equal(servers.length, 2);
  assert.equal(servers[0]!.id, 'fs');
  assert.deepEqual((servers[0]!.transport as { command: string; args: string[] }).args, [
    '-y',
    '@modelcontextprotocol/server-filesystem',
    '/tmp',
  ]);
  assert.equal((servers[1]!.transport as { command: string }).command, 'uvx');
});

test('parseServerList keeps arguments containing "="', () => {
  const { servers, problems } = parseServerList('x=tool --flag=a=b --root=/srv');
  assert.deepEqual(problems, []);
  assert.deepEqual((servers[0]!.transport as { args: string[] }).args, ['--flag=a=b', '--root=/srv']);
});

test('parseServerList tolerates spacing around the separator', () => {
  const { servers, problems } = parseServerList('  a=cmd one ;b=cmd2  ');
  assert.deepEqual(problems, []);
  assert.deepEqual(servers.map((s) => s.id), ['a', 'b']);
});

test('parseServerList reports malformed entries without dropping the good ones', () => {
  const { servers, problems } = parseServerList('noseparator; good=cmd; bad-id!=x');
  assert.equal(servers.length, 1);
  assert.equal(servers[0]!.id, 'good');
  assert.equal(problems.length, 2, problems.join(' | '));
});

test('readConfigFile reads stdio and http servers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-mcp-'));
  try {
    const file = join(dir, 'mcp.json');
    writeFileSync(
      file,
      JSON.stringify({
        servers: [
          { id: 'fs', command: 'npx', args: ['-y', 'server-fs'], description: 'files' },
          { id: 'remote', type: 'http', url: 'https://example.test/mcp', headers: { authorization: 'Bearer x' } },
          { id: 'off', command: 'x', enabled: false },
        ],
      }),
    );
    const { servers, problems } = readConfigFile(file);
    assert.deepEqual(problems, []);
    assert.deepEqual(servers.map((s) => s.id), ['fs', 'remote', 'off']);
    assert.equal(servers[1]!.transport.kind, 'http');
    assert.equal((servers[1]!.transport as { headers: Record<string, string> }).headers['authorization'], 'Bearer x');
    assert.equal(servers[2]!.enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfigFile refuses a bad entry but keeps the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-mcp-'));
  try {
    const file = join(dir, 'mcp.json');
    writeFileSync(
      file,
      JSON.stringify({
        servers: [
          { id: 'ok', command: 'x' },
          { id: 'bad id!', command: 'x' },
          { id: 'noCommand' },
          { id: 'badUrl', type: 'http', url: 'ftp://nope' },
          { id: 'dup', command: 'a' },
          { id: 'dup', command: 'b' },
        ],
      }),
    );
    const { servers, problems } = readConfigFile(file);
    assert.deepEqual(servers.map((s) => s.id), ['ok', 'dup']);
    assert.equal(problems.length, 4, problems.join(' | '));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfigFile reports invalid JSON rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-mcp-'));
  try {
    const file = join(dir, 'mcp.json');
    writeFileSync(file, '{ not json');
    const { servers, problems } = readConfigFile(file);
    assert.deepEqual(servers, []);
    assert.match(problems[0]!, /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMcpConfig merges the environment list and the file, file winning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-mcp-'));
  try {
    writeFileSync(
      join(dir, 'mcp.json'),
      JSON.stringify({ servers: [{ id: 'both', command: 'from-file' }, { id: 'only-file', command: 'f' }] }),
    );
    const result = loadMcpConfig(
      { DEV3D_MCP_SERVERS: 'both=from-env; only-env=e', DEV3D_MCP_CONFIG: 'mcp.json' },
      dir,
    );
    assert.deepEqual(result.problems, []);
    const byId = new Map(result.servers.map((s) => [s.id, s]));
    assert.deepEqual([...byId.keys()].sort(), ['both', 'only-env', 'only-file']);
    assert.equal((byId.get('both')!.transport as { command: string }).command, 'from-file');
    assert.equal(result.file, join(dir, 'mcp.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMcpConfig is empty and quiet when nothing is configured', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-mcp-'));
  try {
    const result = loadMcpConfig({}, dir);
    assert.deepEqual(result.servers, []);
    assert.deepEqual(result.problems, [], 'a missing default mcp.json is not a problem');
    assert.equal(result.file, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMcpConfig complains when a named config file is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-mcp-'));
  try {
    const result = loadMcpConfig({ DEV3D_MCP_CONFIG: 'nope.json' }, dir);
    assert.deepEqual(result.servers, []);
    assert.match(result.problems[0]!, /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
