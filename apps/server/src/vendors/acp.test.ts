/**
 * Tests for the Agent Client Protocol client.
 *
 * No process is started and no socket is opened: the wire is a `FakeWire` that
 * records what the client sent and lets a test play the agent. That is the whole
 * reason `runAcpTurn` takes a transport rather than spawning one — the paths worth
 * testing here are the ones an agent will not perform on demand: refusing a read,
 * asking permission with nobody to answer, dying mid-turn, never answering at all.
 *
 * The assertions that matter most are the enforcement ones. `writeTextFile` must
 * never be advertised, reads must never escape the workspace, and a permission
 * request with no human behind it must resolve to *no* — because those three are
 * the entire reason an ACP vendor is described as `client` enforcement rather
 * than as a polite request.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ACP_PROTOCOL_VERSION, runAcpTurn } from './acp.ts';
import type { JsonRpcId } from '../rpc/jsonrpc.ts';
import type { JsonRpcTransport } from '../rpc/transport.ts';

/**
 * A wire that plays the agent.
 *
 * `send` records everything and hands any *request* to `onRequest`, deferred by a
 * microtask so the client's pending-request bookkeeping is in place before a reply
 * can arrive — the same ordering a real transport has.
 */
class FakeWire implements JsonRpcTransport {
  readonly label = 'fake';
  readonly sent: Record<string, unknown>[] = [];
  started = false;
  closed = false;
  onRequest: ((method: string, params: Record<string, unknown>, id: JsonRpcId) => void) | null = null;
  private handler: ((raw: unknown) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;

  async start(): Promise<void> {
    this.started = true;
  }

  send(message: unknown): void {
    const record = message as Record<string, unknown>;
    this.sent.push(record);
    const method = record['method'];
    const id = record['id'];
    if (typeof method === 'string' && id !== undefined && id !== null) {
      queueMicrotask(() => this.onRequest?.(method, (record['params'] ?? {}) as Record<string, unknown>, id as JsonRpcId));
    }
  }

  onMessage(handler: (raw: unknown) => void): void {
    this.handler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Push a message from the agent to the client. */
  emit(raw: unknown): void {
    queueMicrotask(() => this.handler?.(raw));
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.emit({ jsonrpc: '2.0', id, result });
  }

  respondError(id: JsonRpcId, message: string): void {
    this.emit({ jsonrpc: '2.0', id, error: { code: -32000, message } });
  }

  /** An update notification, the shape a real agent streams. */
  update(sessionId: string, update: Record<string, unknown>): void {
    this.emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
  }

  /** A request from the agent that the client must answer. */
  ask(id: JsonRpcId, method: string, params: Record<string, unknown>): void {
    this.emit({ jsonrpc: '2.0', id, method, params });
  }

  fail(error: Error): void {
    this.errorHandler?.(error);
  }

  /** Every message the client sent, by method. */
  methods(): string[] {
    return this.sent.map((message) => String(message['method'] ?? `<response to ${String(message['id'])}>`));
  }

  /** The response the client sent for a given id, if any. */
  responseFor(id: JsonRpcId): Record<string, unknown> | null {
    for (const message of this.sent) {
      if (message['id'] === id && message['method'] === undefined) return message;
    }
    return null;
  }
}

/** A workspace with one file in it, and one file outside it. */
function workspace(): { root: string; outside: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'dev3d-acp-'));
  const root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'session.ts'), 'line one\nline two\nline three\n', 'utf8');
  const outside = join(base, 'secret.txt');
  writeFileSync(outside, 'not yours', 'utf8');
  return { root, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** The default agent script: a session that answers a prompt. */
function wireAnswering(text: string, stopReason = 'end_turn'): FakeWire {
  const wire = new FakeWire();
  wire.onRequest = (method, _params, id) => {
    if (method === 'initialize') wire.respond(id, { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities: {} });
    else if (method === 'session/new') wire.respond(id, { sessionId: 'sess_1' });
    else if (method === 'session/prompt') {
      wire.update('sess_1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      wire.respond(id, { stopReason });
    }
  };
  return wire;
}

/** Poll until `check` yields something, or give up. */
async function until<T>(check: () => T | null, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('the client never answered');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * An agent that asks the client **one** thing mid-prompt.
 *
 * The prompt is not answered until the client's reply has actually been observed,
 * which is what makes these tests deterministic: capturing the reply on a fixed
 * timer raced the client's own asynchronous work (a real `readFile`, or a human
 * being asked), and a slow machine would have failed them for no reason.
 */
function wireAsking(
  id: JsonRpcId,
  method: string,
  params: Record<string, unknown>,
): { wire: FakeWire; asked: () => Record<string, unknown> | null } {
  let observed: Record<string, unknown> | null = null;
  const wire = new FakeWire();
  wire.onRequest = (outbound, _params, requestId) => {
    if (outbound === 'initialize') wire.respond(requestId, { protocolVersion: ACP_PROTOCOL_VERSION });
    else if (outbound === 'session/new') wire.respond(requestId, { sessionId: 'sess_1' });
    else if (outbound === 'session/prompt') {
      void (async () => {
        wire.ask(id, method, params);
        observed = await until(() => wire.responseFor(id));
        // Give the turn an answer, so a test about the *nested* request is not
        // also asserting that the turn happened to produce text.
        wire.update('sess_1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answered.' } });
        wire.respond(requestId, { stopReason: 'end_turn' });
      })();
    }
  };
  // Safe to read synchronously once `runAcpTurn` has returned: the prompt is only
  // answered after `observed` is set, so the turn cannot finish before it exists.
  return { wire, asked: () => observed };
}

test('a read inside the workspace is served from disk', async () => {
  const ws = workspace();
  try {
    const { wire, asked } = wireAsking(99, 'fs/read_text_file', { sessionId: 'sess_1', path: 'session.ts' });
    const result = await runAcpTurn({
      command: 'openclaw',
      cwd: ws.root,
      timeoutMs: 5_000,
      clientName: 'dev3d',
      clientVersion: '1.0.0',
      prompt: 'read session.ts',
      transport: wire,
    });

    assert.equal(result.outcome, 'ok');
    assert.deepEqual(asked()?.['result'], { content: 'line one\nline two\nline three\n' });
  } finally {
    ws.cleanup();
  }
});

test('a read naming another session, or no session, is refused', async () => {
  // The session id was decorative: `fs/read_text_file` was served for any path the
  // agent asked for, whatever session it claimed, so confinement was the workspace
  // and nothing else. The office opens exactly one session per delegation, and a
  // read must be in it.
  const ws = workspace();
  try {
    for (const [label, params] of [
      ['another session', { sessionId: 'sess_someone_else', path: 'session.ts' }],
      ['no session at all', { path: 'session.ts' }],
    ] as const) {
      const { wire, asked } = wireAsking(31, 'fs/read_text_file', params);
      const result = await runAcpTurn({
        command: 'openclaw',
        cwd: ws.root,
        timeoutMs: 5_000,
        clientName: 'dev3d',
        clientVersion: '1.0.0',
        prompt: 'read it',
        transport: wire,
      });

      assert.equal(result.outcome, 'ok', 'the delegation continues; only the read is refused');
      const answer = asked();
      assert.ok(answer && 'error' in answer, `${label} must be refused`);
      assert.doesNotMatch(JSON.stringify(answer), /line one/, `${label} must not be served`);
    }
  } finally {
    ws.cleanup();
  }
});

test('a link out of the workspace is refused by the ACP read too', async () => {
  // The other half of the same finding: the read boundary has to be the real one.
  // `resolveInWorkspace` resolves the canonical path *and* refuses any component
  // that is a reparse point, so a junction planted inside the workspace is not a
  // way to read outside it — which is the case a lexical check cannot see.
  const ws = workspace();
  try {
    symlinkSync(join(ws.root, '..'), join(ws.root, 'up'), 'junction');
    const { wire, asked } = wireAsking(41, 'fs/read_text_file', { sessionId: 'sess_1', path: 'up/secret.txt' });
    const result = await runAcpTurn({
      command: 'openclaw',
      cwd: ws.root,
      timeoutMs: 5_000,
      clientName: 'dev3d',
      clientVersion: '1.0.0',
      prompt: 'follow the link',
      transport: wire,
    });

    assert.equal(result.outcome, 'ok');
    const answer = asked();
    assert.ok(answer && 'error' in answer, 'the link must be refused, not followed');
    assert.doesNotMatch(JSON.stringify(answer), /not yours/, 'and its contents must not leak');
  } finally {
    ws.cleanup();
  }
});

test('a read outside the workspace is refused, not served', async () => {
  // The confinement, and the reason reads are answered by the office rather than
  // by the agent: `resolveInWorkspace` is the same choke point every built-in tool
  // goes through, so an escape fails here instead of being reported.
  const ws = workspace();
  try {
    const { wire, asked } = wireAsking(7, 'fs/read_text_file', { sessionId: 'sess_1', path: ws.outside });
    const result = await runAcpTurn({
      command: 'openclaw',
      cwd: ws.root,
      timeoutMs: 5_000,
      clientName: 'dev3d',
      clientVersion: '1.0.0',
      prompt: 'read the secret',
      transport: wire,
    });

    assert.equal(result.outcome, 'ok', 'the delegation continues; only the read is refused');
    const answer = asked();
    assert.ok(answer && 'error' in answer, 'and it was an error, not content');
    assert.doesNotMatch(JSON.stringify(answer), /not yours/, 'the file contents must not leak into the refusal');
  } finally {
    ws.cleanup();
  }
});

test('a traversal out of the workspace is refused too', async () => {
  const ws = workspace();
  try {
    const { wire, asked } = wireAsking(8, 'fs/read_text_file', { sessionId: 'sess_1', path: '../secret.txt' });
    await runAcpTurn({
      command: 'openclaw',
      cwd: ws.root,
      timeoutMs: 5_000,
      clientName: 'dev3d',
      clientVersion: '1.0.0',
      prompt: 'escape',
      transport: wire,
    });
    const answer = asked();
    assert.ok(answer && 'error' in answer, 'a `..` path is refused like any other escape');
  } finally {
    ws.cleanup();
  }
});

test('a write is refused even though it was never advertised', async () => {
  const ws = workspace();
  try {
    // A misbehaving agent: the capability block said false and it asked anyway.
    const { wire, asked } = wireAsking(9, 'fs/write_text_file', {
      sessionId: 'sess_1',
      path: 'session.ts',
      content: 'clobbered',
    });
    await runAcpTurn({
      command: 'openclaw',
      cwd: ws.root,
      timeoutMs: 5_000,
      clientName: 'dev3d',
      clientVersion: '1.0.0',
      prompt: 'write',
      transport: wire,
    });

    const answer = asked();
    assert.ok(answer && 'error' in answer);
    assert.match(JSON.stringify(answer), /read-only/);
    // And the file is untouched, which is the part that actually matters.
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(join(ws.root, 'session.ts'), 'utf8'), 'line one\nline two\nline three\n');
  } finally {
    ws.cleanup();
  }
});

/** The two options a well-behaved agent offers for any tool call. */
const PERMISSION_OPTIONS = [
  { optionId: 'ok', name: 'Allow', kind: 'allow_once' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];

test('a permission request with nobody to answer it is refused', async () => {
  // Fail closed. A question nothing can answer must not resolve to yes - the same
  // rule the office's own approval broker follows when its timeout expires.
  const { wire, asked } = wireAsking(11, 'session/request_permission', {
    sessionId: 'sess_1',
    toolCall: { toolCallId: 'c1', title: 'Run rm -rf', kind: 'execute' },
    options: PERMISSION_OPTIONS,
  });

  await runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 5_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    transport: wire,
  });

  const outcome = (asked()?.['result'] ?? {}) as { outcome?: { outcome?: string; optionId?: string } };
  assert.equal(outcome.outcome?.outcome, 'selected');
  assert.equal(outcome.outcome?.optionId, 'no', 'the refusing option, never the permissive one');
});

test('a permission request a human approves selects the permissive option', async () => {
  const asked: string[] = [];
  const { wire, asked: reply } = wireAsking(12, 'session/request_permission', {
    sessionId: 'sess_1',
    toolCall: { toolCallId: 'c1', title: 'Read package.json', kind: 'read' },
    options: PERMISSION_OPTIONS,
  });

  await runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 5_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    requestApproval: async (ask) => {
      asked.push(ask.title);
      return true;
    },
    transport: wire,
  });

  assert.deepEqual(asked, ['Read package.json'], 'the human is told what the agent wants to do');
  const outcome = (reply()?.['result'] ?? {}) as { outcome?: { optionId?: string } };
  assert.equal(outcome.outcome?.optionId, 'ok');
});

test('a permission request a human declines selects the refusing option', async () => {
  const { wire, asked } = wireAsking(13, 'session/request_permission', {
    sessionId: 'sess_1',
    toolCall: { toolCallId: 'c1', title: 'Run a shell command', kind: 'execute' },
    options: PERMISSION_OPTIONS,
  });

  await runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 5_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    requestApproval: async () => false,
    transport: wire,
  });

  const outcome = (asked()?.['result'] ?? {}) as { outcome?: { optionId?: string } };
  assert.equal(outcome.outcome?.optionId, 'no');
});

test('a decline with no refusing option offered is cancelled, not approved', async () => {
  // The agent's option list is the *agent's*, so a list containing only "allow"
  // must not turn a refusal into a yes.
  const { wire, asked } = wireAsking(14, 'session/request_permission', {
    sessionId: 'sess_1',
    toolCall: { toolCallId: 'c1', title: 'Run a shell command', kind: 'execute' },
    options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }],
  });

  await runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 5_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    requestApproval: async () => false,
    transport: wire,
  });

  const outcome = (asked()?.['result'] ?? {}) as { outcome?: { outcome?: string } };
  assert.equal(outcome.outcome?.outcome, 'cancelled');
});

test('a turn initializes, opens a session, prompts, and returns the answer', async () => {
  const wire = wireAnswering('The lookup derefs null at session.ts:41.');
  const result = await runAcpTurn({
    command: 'openclaw',
    args: ['acp'],
    cwd: '/workspace',
    timeoutMs: 5_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'find the bug',
    transport: wire,
  });

  assert.equal(result.outcome, 'ok');
  assert.equal(result.text, 'The lookup derefs null at session.ts:41.');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.detail, '');
  assert.deepEqual(wire.methods().slice(0, 3), ['initialize', 'session/new', 'session/prompt']);
  assert.equal(wire.closed, true, 'the wire is released however the turn ends');
});

test('the client advertises reads and refuses writes, before anything else happens', async () => {
  // This is the enforcement claim, stated on the wire. If `writeTextFile` were
  // advertised as true the whole read-only story would be a request dressed up as
  // a guarantee, so it is asserted rather than assumed.
  const wire = wireAnswering('done');
  await runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 5_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    transport: wire,
  });

  const init = wire.sent.find((message) => message['method'] === 'initialize');
  assert.ok(init);
  const params = init['params'] as { protocolVersion: unknown; clientCapabilities: { fs: Record<string, unknown> } };
  assert.equal(params.protocolVersion, ACP_PROTOCOL_VERSION);
  assert.equal(params.clientCapabilities.fs['readTextFile'], true);
  assert.equal(params.clientCapabilities.fs['writeTextFile'], false);
  // Terminals are not advertised either: a client that offered them would be
  // handing the agent a shell it did not have to ask for.
  assert.equal('terminal' in params.clientCapabilities, false);
});

test('tool calls are collected in order, with their paths confined', async () => {
  const ws = workspace();
  try {
    const wire = new FakeWire();
    wire.onRequest = (method, _params, id) => {
      if (method === 'initialize') wire.respond(id, { protocolVersion: ACP_PROTOCOL_VERSION });
      else if (method === 'session/new') wire.respond(id, { sessionId: 'sess_1' });
      else if (method === 'session/prompt') {
        wire.update('sess_1', {
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          title: 'Reading session.ts',
          kind: 'read',
          status: 'pending',
          locations: [{ path: 'session.ts' }],
        });
        // A path outside the workspace must be dropped, not recorded: `files`
        // feeds a review loop's idea of who produced what.
        wire.update('sess_1', {
          sessionUpdate: 'tool_call',
          toolCallId: 'c2',
          title: 'Reading something else',
          kind: 'read',
          status: 'in_progress',
          locations: [{ path: ws.outside }],
        });
        wire.update('sess_1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Two files.' } });
        wire.respond(id, { stopReason: 'end_turn' });
      }
    };

    const result = await runAcpTurn({
      command: 'openclaw',
      cwd: ws.root,
      timeoutMs: 5_000,
      clientName: 'dev3d',
      clientVersion: '1.0.0',
      prompt: 'task',
      transport: wire,
    });

    assert.equal(result.outcome, 'ok');
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0]?.title, 'Reading session.ts');
    assert.deepEqual(result.toolCalls[0]?.paths, ['session.ts']);
    assert.deepEqual(result.toolCalls[1]?.paths, [], 'a path outside the workspace is dropped');
    assert.deepEqual(result.files, ['session.ts']);
  } finally {
    ws.cleanup();
  }
});

test('a tool call update replaces its record rather than appearing twice', async () => {
  const wire = new FakeWire();
  wire.onRequest = (method, _params, id) => {
    if (method === 'initialize') wire.respond(id, { protocolVersion: ACP_PROTOCOL_VERSION });
    else if (method === 'session/new') wire.respond(id, { sessionId: 'sess_1' });
    else if (method === 'session/prompt') {
      wire.update('sess_1', { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Reading', status: 'pending' });
      wire.update('sess_1', { sessionUpdate: 'tool_call_update', toolCallId: 'c1', title: 'Reading', status: 'completed' });
      wire.update('sess_1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
      wire.respond(id, { stopReason: 'end_turn' });
    }
  };

  const result = await runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 5_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    transport: wire,
  });

  assert.equal(result.toolCalls.length, 1, 'one action, refined - not two actions');
  assert.equal(result.toolCalls[0]?.status, 'completed');
});

test('an unknown or malformed update is ignored, and the turn still succeeds', async () => {
  // A protocol revision adding a variant must not turn a working delegation into a
  // crash. The same discipline `output.ts` applies to stdout.
  const wire = new FakeWire();
  wire.onRequest = (method, _params, id) => {
    if (method === 'initialize') wire.respond(id, { protocolVersion: ACP_PROTOCOL_VERSION });
    else if (method === 'session/new') wire.respond(id, { sessionId: 'sess_1' });
    else if (method === 'session/prompt') {
      wire.update('sess_1', { sessionUpdate: 'something_from_the_future', payload: { a: 1 } });
      wire.update('sess_1', { sessionUpdate: 'tool_call' }); // no toolCallId: unusable
      // Not JSON-RPC at all.
      wire.emit({ hello: 'i am not a protocol message' });
      wire.update('sess_1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Still here.' } });
      wire.respond(id, { stopReason: 'end_turn' });
    }
  };

  const result = await runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 5_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    transport: wire,
  });

  assert.equal(result.outcome, 'ok');
  assert.equal(result.text, 'Still here.');
  assert.deepEqual(result.toolCalls, []);
});

test('a turn that ends with no answer is a failure, not an empty success', async () => {
  const wire = new FakeWire();
  wire.onRequest = (method, _params, id) => {
    if (method === 'initialize') wire.respond(id, { protocolVersion: ACP_PROTOCOL_VERSION });
    else if (method === 'session/new') wire.respond(id, { sessionId: 'sess_1' });
    else if (method === 'session/prompt') wire.respond(id, { stopReason: 'end_turn' });
  };

  const result = await runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 5_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    transport: wire,
  });

  assert.equal(result.outcome, 'failed');
  assert.match(result.detail, /without producing any answer/);
});

test('an agent that refuses outright is reported as a refusal', async () => {
  const wire = wireAnswering('I will not do that.', 'refusal');
  const result = await runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 5_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    transport: wire,
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.stopReason, 'refusal');
  // What it did say is kept: an operator wants to read the refusal.
  assert.equal(result.text, 'I will not do that.');
});

test('a session that cannot be opened is reported rather than run against', async () => {
  const wire = new FakeWire();
  wire.onRequest = (method, _params, id) => {
    if (method === 'initialize') wire.respond(id, { protocolVersion: ACP_PROTOCOL_VERSION });
    else if (method === 'session/new') wire.respond(id, {});
  };

  const result = await runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 5_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    transport: wire,
  });

  assert.equal(result.outcome, 'failed');
  assert.match(result.detail, /no sessionId/);
});

test('an error from the agent during initialize is reported in its own words', async () => {
  const wire = new FakeWire();
  wire.onRequest = (method, _params, id) => {
    if (method === 'initialize') wire.respondError(id, 'unsupported protocol version');
  };

  const result = await runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 5_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    transport: wire,
  });

  assert.equal(result.outcome, 'failed');
  assert.match(result.detail, /unsupported protocol version/);
});

test('an agent needing authentication is told apart from one that simply failed', async () => {
  // "Authenticate this vendor" and "this vendor is broken" call for different
  // things from an operator, so they must not read the same.
  const wire = new FakeWire();
  wire.onRequest = (method, _params, id) => {
    if (method === 'initialize') {
      wire.respond(id, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        requiresAuth: true,
        authMethods: [{ id: 'gateway', name: 'Sign in to the Gateway' }],
      });
    }
  };

  const result = await runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 5_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    transport: wire,
  });

  assert.equal(result.outcome, 'failed');
  assert.match(result.detail, /requires authentication/);
  assert.match(result.detail, /Gateway/);
});

test('a turn that never ends is cancelled and reported as a timeout', async () => {
  const wire = new FakeWire();
  wire.onRequest = (method, _params, id) => {
    if (method === 'initialize') wire.respond(id, { protocolVersion: ACP_PROTOCOL_VERSION });
    else if (method === 'session/new') wire.respond(id, { sessionId: 'sess_1' });
    // `session/prompt` is never answered.
  };

  const result = await runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 40,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    transport: wire,
  });

  assert.equal(result.outcome, 'timeout');
  assert.match(result.detail, /did not finish within 40ms/);
  // Cancelled politely before the wire is dropped, so the agent can stop rather
  // than being left running.
  assert.ok(wire.methods().includes('session/cancel'));
  assert.equal(wire.closed, true);
});

test('a cancelled turn is reported as the operator\u2019s decision, not a failure', async () => {
  const wire = new FakeWire();
  wire.onRequest = (method, _params, id) => {
    if (method === 'initialize') wire.respond(id, { protocolVersion: ACP_PROTOCOL_VERSION });
    // A session is opened, and then the prompt is never answered - so the turn is
    // genuinely in flight when the operator cancels, which is the case that
    // matters: a running delegation must be told to stop, not just dropped.
    else if (method === 'session/new') wire.respond(id, { sessionId: 'sess_1' });
  };

  const controller = new AbortController();
  const pending = runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 60_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    signal: controller.signal,
    transport: wire,
  });

  await until(() => (wire.methods().includes('session/prompt') ? true : null));
  controller.abort();
  const result = await pending;

  assert.equal(result.outcome, 'aborted');
  assert.match(result.detail, /Cancelled by the operator/);
  // Cancelled politely as well as dropped, so the agent can stop rather than
  // being left running against a closed wire.
  assert.ok(wire.methods().includes('session/cancel'));
  assert.equal(wire.closed, true);
});

test('a turn cancelled before a session exists is not cancelled over a non-existent session', async () => {
  // Distinct from the above: there is nothing to tell the agent to stop, so no
  // cancel is sent - and the turn must still not carry on opening a session.
  const wire = new FakeWire();
  const controller = new AbortController();
  const pending = runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 60_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    signal: controller.signal,
    transport: wire,
  });
  controller.abort();
  const result = await pending;

  assert.equal(result.outcome, 'aborted');
  assert.deepEqual(wire.methods(), [], 'nothing was sent to a peer we were about to abandon');
});

test('a wire that cannot start is unstartable, and nothing is left open', async () => {
  const wire = new FakeWire();
  wire.start = async () => {
    throw new Error('spawn openclaw ENOENT');
  };

  const result = await runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 5_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    transport: wire,
  });

  assert.equal(result.outcome, 'unstartable');
  assert.match(result.detail, /ENOENT/);
  // Nothing was sent to a peer that never came up.
  assert.deepEqual(wire.methods(), []);
});

test('a wire that dies mid-turn ends the turn with the reason', async () => {
  const wire = new FakeWire();
  wire.onRequest = (method, _params, id) => {
    if (method === 'initialize') wire.respond(id, { protocolVersion: ACP_PROTOCOL_VERSION });
    else if (method === 'session/new') wire.respond(id, { sessionId: 'sess_1' });
    else if (method === 'session/prompt') {
      wire.update('sess_1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial answer' } });
      setTimeout(() => wire.fail(new Error('the agent exited (exit code 1)')), 5);
    }
  };

  const result = await runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 5_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    transport: wire,
  });

  assert.equal(result.outcome, 'failed');
  assert.match(result.detail, /exit code 1/);
  // Whatever it managed to say before dying is kept.
  assert.equal(result.text, 'partial answer');
});

test('the answer streams as it arrives, and tool calls are announced', async () => {
  const chunks: string[] = [];
  const announced: string[] = [];
  const wire = new FakeWire();
  wire.onRequest = (method, _params, id) => {
    if (method === 'initialize') wire.respond(id, { protocolVersion: ACP_PROTOCOL_VERSION });
    else if (method === 'session/new') wire.respond(id, { sessionId: 'sess_1' });
    else if (method === 'session/prompt') {
      wire.update('sess_1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Look' } });
      wire.update('sess_1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ing…' } });
      wire.update('sess_1', { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Reading a file', kind: 'read' });
      wire.respond(id, { stopReason: 'end_turn' });
    }
  };

  const result = await runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 5_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    onChunk: (text) => chunks.push(text),
    onToolCall: (call) => announced.push(call.title),
    transport: wire,
  });

  assert.deepEqual(chunks, ['Look', 'ing…'], 'progress reaches a console as it happens');
  assert.deepEqual(announced, ['Reading a file']);
  assert.equal(result.text, 'Looking…');
});

test('a read request may ask for a window of lines', async () => {
  const ws = workspace();
  try {
    const { wire, asked } = wireAsking(21, 'fs/read_text_file', {
      sessionId: 'sess_1',
      path: 'session.ts',
      line: 2,
      limit: 1,
    });
    await runAcpTurn({
      command: 'openclaw',
      cwd: ws.root,
      timeoutMs: 5_000,
      clientName: 'dev3d',
      clientVersion: '1.0.0',
      prompt: 'read one line',
      transport: wire,
    });

    const content = (asked()?.['result'] as { content?: unknown } | undefined)?.content;
    // 1-based, like every editor and every other line number in this codebase.
    assert.equal(content, 'line two');
  } finally {
    ws.cleanup();
  }
});

test('a request dev3d does not implement is refused by name, not ignored', async () => {
  // Silence would leave the agent waiting forever; a method-not-found is an answer.
  const { wire, asked } = wireAsking(31, 'terminal/create', { sessionId: 'sess_1', command: 'rm -rf /' });
  await runAcpTurn({
    command: 'openclaw',
    cwd: '/workspace',
    timeoutMs: 5_000,
    clientName: 'dev3d',
    clientVersion: '1.0.0',
    prompt: 'task',
    transport: wire,
  });

  const error = (asked()?.['error'] ?? {}) as { code?: number; message?: string };
  assert.equal(error.code, -32601);
  assert.match(String(error.message), /terminal\/create/);
});
