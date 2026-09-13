/**
 * Tests for the Streamable HTTP MCP transport.
 *
 * This file had **no tests at all**, and shipped with two defects a test would
 * have caught immediately:
 *
 *  - the session teardown `DELETE` omitted `Mcp-Session-Id`, so the server had
 *    nothing to tear down and the session lingered until it expired;
 *  - SSE framing split only on `\n\n`, while the specification permits CRLF — so
 *    a CRLF server delivered *nothing* until the connection closed, which for a
 *    server that streams its reply and keeps the connection open is never.
 *
 * Everything here runs against a real `node:http` server on loopback, because
 * the properties under test are about what actually goes over the wire.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpTransport } from './http.ts';

interface Harness {
  url: string;
  /** Every request the transport made, in order. */
  seen: Array<{ method: string; sessionId: string | undefined; body: string }>;
  close(): Promise<void>;
}

/** Start a server whose handler is supplied per test. */
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Harness> {
  const seen: Harness['seen'] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        sessionId: req.headers['mcp-session-id'] as string | undefined,
        body,
      });
      handler(req, res);
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/** Wait for a condition, so a test never depends on a fixed sleep. */
async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition was never met');
}

test('a JSON response is delivered as a message', async () => {
  const h = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
  });
  try {
    const transport = new HttpTransport({ url: h.url });
    const got: unknown[] = [];
    transport.onMessage((raw) => got.push(raw));
    await transport.start();
    transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await until(() => got.length === 1);
    assert.deepEqual(got[0], { jsonrpc: '2.0', id: 1, result: { ok: true } });
    await transport.close();
  } finally {
    await h.close();
  }
});

test('a redirect on the JSON-RPC endpoint is reported, not followed', async () => {
  // Not followed, and that is the point. The fetch spec rewrites a redirected POST
  // into a GET and drops its body, so the handshake failed with a protocol error
  // that named nothing — and the real cause was that the configured URL redirects.
  const h = await serve((_req, res) => {
    res.writeHead(302, { location: 'https://elsewhere.example/mcp' });
    res.end();
  });
  try {
    const transport = new HttpTransport({ url: h.url });
    const errors: Error[] = [];
    transport.onError((error) => errors.push(error));
    await transport.start();
    transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    await until(() => errors.length === 1);

    assert.match(errors[0]?.message ?? '', /answered 302 redirecting to https:\/\/elsewhere\.example\/mcp/);
    assert.match(errors[0]?.message ?? '', /rewritten to a GET and its body dropped/);
    // The body was never re-sent anywhere: exactly one request reached the server.
    assert.equal(h.seen.length, 1);
    await transport.close();
  } finally {
    await h.close();
  }
});

test('a batch response delivers each entry separately', async () => {
  const h = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([
      { jsonrpc: '2.0', id: 1, result: 'a' },
      { jsonrpc: '2.0', id: 2, result: 'b' },
    ]));
  });
  try {
    const transport = new HttpTransport({ url: h.url });
    const got: Array<{ id?: number }> = [];
    transport.onMessage((raw) => got.push(raw as { id?: number }));
    await transport.start();
    transport.send({ jsonrpc: '2.0', id: 1, method: 'x' });
    await until(() => got.length === 2);
    assert.deepEqual(got.map((m) => m.id), [1, 2]);
    await transport.close();
  } finally {
    await h.close();
  }
});

test('a CRLF event stream is parsed as it arrives, not only at the end', async () => {
  // The regression: splitting on `\n\n` found nothing in a CRLF stream, so every
  // event sat in the buffer and a server that keeps the connection open after
  // replying delivered no message at all until the socket closed.
  const control: { release: (() => void) | null } = { release: null };
  const h = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // CRLF framing, which the SSE specification permits.
    res.write('event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":"first"}\r\n\r\n');
    // Deliberately leave the stream open: this is the case that used to hang.
    control.release = () => {
      res.write('data: {"jsonrpc":"2.0","id":2,"result":"second"}\r\n\r\n');
      res.end();
    };
  });
  try {
    const transport = new HttpTransport({ url: h.url, streamIdleTimeoutMs: 5_000 });
    const got: Array<{ id?: number }> = [];
    transport.onMessage((raw) => got.push(raw as { id?: number }));
    await transport.start();
    transport.send({ jsonrpc: '2.0', id: 1, method: 'x' });

    // The first event must arrive while the stream is still open.
    await until(() => got.length === 1);
    assert.equal(got[0]?.id, 1, 'the CRLF-framed event was dispatched immediately');

    control.release?.();
    await until(() => got.length === 2);
    assert.equal(got[1]?.id, 2);
    await transport.close();
  } finally {
    control.release?.();
    await h.close();
  }
});

test('an LF event stream still works', async () => {
  const h = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"jsonrpc":"2.0","id":7,"result":"lf"}\n\n');
    res.end();
  });
  try {
    const transport = new HttpTransport({ url: h.url });
    const got: Array<{ id?: number }> = [];
    transport.onMessage((raw) => got.push(raw as { id?: number }));
    await transport.start();
    transport.send({ jsonrpc: '2.0', id: 7, method: 'x' });
    await until(() => got.length === 1);
    assert.equal(got[0]?.id, 7);
    await transport.close();
  } finally {
    await h.close();
  }
});

test('a session issued by the server is remembered and sent on later requests', async () => {
  const h = await serve((req, res) => {
    if (req.headers['mcp-session-id'] === undefined) {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-123' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'issued' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'reused' }));
  });
  try {
    const transport = new HttpTransport({ url: h.url });
    const got: unknown[] = [];
    transport.onMessage((raw) => got.push(raw));
    await transport.start();
    transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    await until(() => got.length === 1);
    assert.equal(transport.session, 'sess-123');
    transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await until(() => got.length === 2);
    assert.equal(h.seen[1]?.sessionId, 'sess-123', 'the issued session must be carried');
    await transport.close();
  } finally {
    await h.close();
  }
});

test('closing ends the session, and says which session', async () => {
  // The regression: `sessionId` was nulled *before* the DELETE was built, and
  // `headers()` only sends the id when it is set — so the teardown request went
  // out with no session header and the server had nothing to tear down.
  const h = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-abc' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }));
  });
  try {
    const transport = new HttpTransport({ url: h.url });
    transport.onMessage(() => {});
    await transport.start();
    transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    await until(() => transport.session === 'sess-abc');
    await transport.close();

    const deletes = h.seen.filter((entry) => entry.method === 'DELETE');
    assert.equal(deletes.length, 1, 'a session teardown must be attempted');
    assert.equal(
      deletes[0]?.sessionId,
      'sess-abc',
      'and it must carry Mcp-Session-Id, or the server cannot close the session',
    );
  } finally {
    await h.close();
  }
});

test('a non-2xx answer is reported with its status', async () => {
  const h = await serve((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('server exploded');
  });
  try {
    const transport = new HttpTransport({ url: h.url });
    const errors: Error[] = [];
    transport.onError((error) => errors.push(error));
    await transport.start();
    transport.send({ jsonrpc: '2.0', id: 1, method: 'x' });
    await until(() => errors.length === 1);
    assert.match(errors[0]!.message, /500/);
    assert.match(errors[0]!.message, /server exploded/);
    await transport.close();
  } finally {
    await h.close();
  }
});

test('an accepted notification is not treated as an error', async () => {
  const h = await serve((_req, res) => {
    res.writeHead(202);
    res.end();
  });
  try {
    const transport = new HttpTransport({ url: h.url });
    const errors: Error[] = [];
    transport.onError((error) => errors.push(error));
    await transport.start();
    transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // Give the request time to complete; nothing should be reported.
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(errors, []);
    await transport.close();
  } finally {
    await h.close();
  }
});

test('an unparseable body is reported as noise rather than thrown', async () => {
  const h = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('this is not json');
  });
  try {
    const noise: string[] = [];
    const transport = new HttpTransport({ url: h.url, onNoise: (line) => noise.push(line) });
    const errors: Error[] = [];
    transport.onError((error) => errors.push(error));
    await transport.start();
    transport.send({ jsonrpc: '2.0', id: 1, method: 'x' });
    await until(() => noise.length === 1);
    assert.match(noise[0]!, /not json/);
    assert.deepEqual(errors, [], 'noise is not a failure');
    await transport.close();
  } finally {
    await h.close();
  }
});

test('a body larger than the cap is refused rather than buffered without bound', async () => {
  const h = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // 9 MB of padding inside an otherwise valid JSON document, above the 8 MB
    // cap. `res.text()` would have buffered all of it before anyone looked.
    res.write('{"jsonrpc":"2.0","id":1,"result":"');
    const chunk = 'x'.repeat(64 * 1024);
    for (let sent = 0; sent < 9 * 1024 * 1024; sent += chunk.length) res.write(chunk);
    res.end('"}');
  });
  try {
    const noise: string[] = [];
    const errors: Error[] = [];
    const delivered: unknown[] = [];
    const transport = new HttpTransport({ url: h.url, onNoise: (line) => noise.push(line) });
    transport.onError((error) => errors.push(error));
    transport.onMessage((raw) => delivered.push(raw));
    await transport.start();
    transport.send({ jsonrpc: '2.0', id: 1, method: 'x' });

    // The truncated read cannot parse as JSON, so it is reported as noise (or, if
    // the response is torn down first, as an error). What must not happen is a
    // message delivered from a body that was read without bound.
    await until(() => noise.length > 0 || errors.length > 0);
    assert.deepEqual(delivered, [], 'no message may be built from an over-cap body');
    await transport.close();
  } finally {
    await h.close();
  }
});
