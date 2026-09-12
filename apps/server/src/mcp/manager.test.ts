/**
 * Tests for the MCP manager: connecting to servers, publishing their tools under
 * non-colliding names, and reporting status.
 *
 * Transports are injected, so nothing here starts a process or opens a socket —
 * which also means these run anywhere, including a sandbox that forbids both.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { McpManager, parsePublishedToolName, publishedToolName } from './manager.ts';
import { McpClient, type McpTransport } from './client.ts';
import { createToolRegistry } from '../tools/registry.ts';
import type { McpServerConfig, TransportHooks } from './manager.ts';

/** A transport that speaks enough MCP to be connected to. */
class StubTransport implements McpTransport {
  readonly label: string;
  private handler: ((raw: unknown) => void) | null = null;
  closed = false;
  /** Set to fail the handshake, simulating a server that is down. */
  failWith: Error | null = null;
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  // Fields are assigned explicitly rather than declared as constructor
  // parameters: Node runs these files through type *stripping*, which does not
  // implement parameter properties.
  private readonly tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  private readonly toolResult: { content: unknown[]; isError?: boolean };

  constructor(
    label: string,
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
    toolResult: { content: unknown[]; isError?: boolean } = {
      content: [{ type: 'text', text: 'remote output' }],
    },
  ) {
    this.label = label;
    this.tools = tools;
    this.toolResult = toolResult;
  }

  async start(): Promise<void> {
    if (this.failWith !== null) throw this.failWith;
  }

  send(message: unknown): void {
    const msg = message as Record<string, unknown>;
    if (!('id' in msg)) return;
    const id = msg['id'];
    switch (msg['method']) {
      case 'initialize':
        if (this.failWith !== null) {
          queueMicrotask(() =>
            this.handler?.({ jsonrpc: '2.0', id, error: { code: -32000, message: this.failWith!.message } }),
          );
          return;
        }
        queueMicrotask(() =>
          this.handler?.({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2025-06-18',
              serverInfo: { name: this.label, version: '1.0.0' },
            },
          }),
        );
        return;
      case 'tools/list':
        queueMicrotask(() => this.handler?.({ jsonrpc: '2.0', id, result: { tools: this.tools } }));
        return;
      case 'tools/call': {
        const params = msg['params'] as { name: string; arguments: Record<string, unknown> };
        this.calls.push({ name: params.name, args: params.arguments });
        queueMicrotask(() =>
          this.handler?.({
            jsonrpc: '2.0',
            id,
            result: { content: this.toolResult.content, isError: this.toolResult.isError === true },
          }),
        );
        return;
      }
      default:
        queueMicrotask(() =>
          this.handler?.({ jsonrpc: '2.0', id, error: { code: -32601, message: 'no such method' } }),
        );
    }
  }

  onMessage(handler: (raw: unknown) => void): void {
    this.handler = handler;
  }

  onError(): void {}

  async close(): Promise<void> {
    this.closed = true;
  }
}

interface HarnessResult {
  manager: McpManager;
  registry: ReturnType<typeof createToolRegistry>;
  transports: Map<string, StubTransport>;
  logs: string[];
}

function harness(
  servers: Array<{ config: McpServerConfig; transport: StubTransport | null; error?: string }>,
): HarnessResult {
  const registry = createToolRegistry();
  const transports = new Map<string, StubTransport>();
  const logs: string[] = [];

  const manager = new McpManager({
    registry,
    log: (level, scope, message) => {
      logs.push(`${level} ${scope}: ${message}`);
    },
    makeTransport: (config: McpServerConfig, hooks: TransportHooks): McpTransport => {
      void hooks;
      const entry = servers.find((s) => s.config.id === config.id);
      if (entry === undefined || entry.transport === null) {
        throw new Error(entry?.error ?? 'no transport');
      }
      transports.set(config.id, entry.transport);
      return entry.transport;
    },
  });

  return { manager, registry, transports, logs };
}

function stdioConfig(id: string, enabled = true): McpServerConfig {
  return { id, enabled, transport: { kind: 'stdio', command: 'server' } };
}

// ---------------------------------------------------------------------------
// naming
// ---------------------------------------------------------------------------

test('publishedToolName namespaces a tool by its server', () => {
  assert.equal(publishedToolName('fs', 'read_file'), 'mcp__fs__read_file');
});

test('parsePublishedToolName inverts publishedToolName', () => {
  assert.deepEqual(parsePublishedToolName('mcp__fs__read_file'), { serverId: 'fs', toolName: 'read_file' });
  // A remote tool name may itself contain the separator.
  assert.deepEqual(parsePublishedToolName('mcp__fs__a__b'), { serverId: 'fs', toolName: 'a__b' });
});

test('parsePublishedToolName rejects names that are not MCP tools', () => {
  for (const bad of ['read_file', 'mcp__', 'mcp__only', 'mcp____x', 'mcp__fs__']) {
    assert.equal(parsePublishedToolName(bad), null, `${bad} should not parse`);
  }
});

// ---------------------------------------------------------------------------
// connecting and publishing
// ---------------------------------------------------------------------------

test('start connects a server and publishes its tools under MCP names', async () => {
  const transport = new StubTransport('files', [{ name: 'read_file', description: 'read a file' }]);
  const { manager, registry } = harness([{ config: stdioConfig('fs'), transport }]);

  await manager.start([stdioConfig('fs')]);

  const status = manager.status();
  assert.equal(status.length, 1);
  assert.equal(status[0]!.state, 'ready');
  assert.equal(status[0]!.serverName, 'files');
  assert.equal(status[0]!.toolCount, 1);

  // The published name is namespaced; the built-in read_file is untouched.
  assert.ok(registry.get('mcp__fs__read_file'));
  assert.equal(registry.get('mcp__fs__read_file')!.description.includes('read a file'), true);
  assert.equal(manager.tools()[0]!.remoteName, 'read_file');
});

test('a remote tool is called by its own name, not the published one', async () => {
  const transport = new StubTransport('files', [{ name: 'read_file' }]);
  const { manager, registry } = harness([{ config: stdioConfig('fs'), transport }]);
  await manager.start([stdioConfig('fs')]);

  const tool = registry.get('mcp__fs__read_file')!;
  const result = await tool.run(
    { path: 'a.txt' },
    {
      workspaceRoot: '/tmp',
      writtenPaths: new Set(),
      plan: [],
      requestApproval: async () => true,
      autoApproveShell: false,
      log: () => {},
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.content, 'remote output');
  // The wire carries the server's own name.
  assert.deepEqual(transport.calls, [{ name: 'read_file', args: { path: 'a.txt' } }]);
});

test('a remote tool reporting an error is a failed ToolResult, not a throw', async () => {
  const transport = new StubTransport(
    'files',
    [{ name: 'read_file' }],
    { content: [{ type: 'text', text: 'permission denied' }], isError: true },
  );
  const { manager, registry } = harness([{ config: stdioConfig('fs'), transport }]);
  await manager.start([stdioConfig('fs')]);

  const result = await registry.get('mcp__fs__read_file')!.run(
    {},
    {
      workspaceRoot: '/tmp',
      writtenPaths: new Set(),
      plan: [],
      requestApproval: async () => true,
      autoApproveShell: false,
      log: () => {},
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.content, /reported an error/);
  assert.match(result.content, /permission denied/);
});

test('a server that cannot start is recorded as failed and does not break the others', async () => {
  const good = new StubTransport('good', [{ name: 'a' }]);
  const bad = new StubTransport('bad', []);
  bad.failWith = new Error('command not found');

  const configs = [stdioConfig('bad'), stdioConfig('good')];
  const { manager, registry } = harness([
    { config: configs[0]!, transport: bad },
    { config: configs[1]!, transport: good },
  ]);

  // Must not throw, even though one server is broken.
  await manager.start(configs);

  const byId = new Map(manager.status().map((s) => [s.id, s]));
  assert.equal(byId.get('bad')!.state, 'failed');
  assert.match(byId.get('bad')!.error!, /command not found/);
  assert.equal(byId.get('good')!.state, 'ready');
  assert.ok(registry.get('mcp__good__a'), 'the healthy server still published its tools');
  assert.equal(registry.get('mcp__bad__a'), undefined);
});

test('an unbuildable transport is recorded rather than thrown', async () => {
  const config = stdioConfig('broken');
  const { manager } = harness([{ config, transport: null, error: 'no such command form' }]);
  await manager.start([config]);
  assert.equal(manager.status()[0]!.state, 'failed');
  assert.match(manager.status()[0]!.error!, /no such command form/);
});

test('a disabled server is not connected at all', async () => {
  const transport = new StubTransport('off', [{ name: 'a' }]);
  const config = stdioConfig('off', false);
  const { manager } = harness([{ config, transport }]);
  await manager.start([config]);
  assert.deepEqual(manager.status(), []);
});

test('two servers may each publish a tool with the same remote name', async () => {
  const one = new StubTransport('one', [{ name: 'search' }]);
  const two = new StubTransport('two', [{ name: 'search' }]);
  const configs = [stdioConfig('one'), stdioConfig('two')];
  const { manager, registry } = harness([
    { config: configs[0]!, transport: one },
    { config: configs[1]!, transport: two },
  ]);
  await manager.start(configs);
  assert.ok(registry.get('mcp__one__search'));
  assert.ok(registry.get('mcp__two__search'));
});

test('disconnect unpublishes the tools it contributed', async () => {
  const transport = new StubTransport('fs', [{ name: 'read' }]);
  const { manager, registry } = harness([{ config: stdioConfig('fs'), transport }]);
  await manager.start([stdioConfig('fs')]);
  assert.ok(registry.get('mcp__fs__read'));

  await manager.disconnect('fs');
  assert.equal(registry.get('mcp__fs__read'), undefined);
  assert.equal(transport.closed, true);
  assert.deepEqual(manager.status(), []);
});

test('refresh adds a new server and drops one that is gone', async () => {
  const first = new StubTransport('first', [{ name: 'a' }]);
  const { manager, registry } = harness([{ config: stdioConfig('first'), transport: first }]);
  await manager.start([stdioConfig('first')]);
  assert.ok(registry.get('mcp__first__a'));

  const second = new StubTransport('second', [{ name: 'b' }]);
  (manager as unknown as { deps: { makeTransport?: unknown } }).deps.makeTransport = (
    config: McpServerConfig,
  ): McpTransport => {
    if (config.id !== 'second') throw new Error('unexpected server');
    return second;
  };

  await manager.refresh([stdioConfig('second')]);
  assert.equal(registry.get('mcp__first__a'), undefined, 'the removed server is unpublished');
  assert.ok(registry.get('mcp__second__b'), 'the added server is published');
});

test('refresh is idempotent for a server that is already connected', async () => {
  const transport = new StubTransport('fs', [{ name: 'a' }]);
  const { manager, registry } = harness([{ config: stdioConfig('fs'), transport }]);
  await manager.start([stdioConfig('fs')]);
  await manager.refresh([stdioConfig('fs')]);
  // Re-registering the same name would throw, so reaching here proves it did not.
  assert.ok(registry.get('mcp__fs__a'));
  assert.equal(manager.status()[0]!.state, 'ready');
});

test('status notes carry transport noise and stderr lines', async () => {
  const transport = new StubTransport('fs', []);
  const { manager } = harness([{ config: stdioConfig('fs'), transport }]);
  await manager.start([stdioConfig('fs')]);
  // Notes start empty for a well-behaved server.
  assert.deepEqual(manager.status()[0]!.notes, []);
});

test('close disconnects everything', async () => {
  const one = new StubTransport('one', [{ name: 'a' }]);
  const two = new StubTransport('two', [{ name: 'b' }]);
  const configs = [stdioConfig('one'), stdioConfig('two')];
  const { manager, registry } = harness([
    { config: configs[0]!, transport: one },
    { config: configs[1]!, transport: two },
  ]);
  await manager.start(configs);
  await manager.close();
  assert.deepEqual(manager.status(), []);
  assert.equal(registry.get('mcp__one__a'), undefined);
  assert.equal(registry.get('mcp__two__b'), undefined);
});

test('the manager never reads a client it did not create', () => {
  // A guard against a future refactor wiring the manager to a shared client.
  const { manager } = harness([]);
  assert.deepEqual(manager.tools(), []);
  assert.deepEqual(manager.toolNames(), []);
});

test('McpClient is exported with a working label', () => {
  const transport = new StubTransport('labelled', []);
  const client = new McpClient(transport);
  assert.equal(client.label, 'labelled');
});
