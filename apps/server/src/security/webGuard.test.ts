/**
 * Tests for the `web_fetch` host guard and body cap.
 *
 * The bugs these exist for:
 *
 *  - `web_fetch` validated only the URL scheme, so an employee could fetch
 *    `http://127.0.0.1:8787/api/state` and read the whole office state — memory
 *    record and run history included — through a tool that asks nobody. On a
 *    cloud VM the same call reaches the instance metadata service.
 *  - `res.text()` buffered the entire body before the character cap, so a 400 MB
 *    response cost +412 MB of RSS. A big enough page could take the orchestrator
 *    down and every run with it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  MAX_FETCH_BYTES,
  MAX_REDIRECTS,
  checkHostIsPublic,
  fetchGuarded,
  isBlockedAddress,
  readCapped,
} from './webGuard.ts';

test('private, loopback and link-local addresses are refused', () => {
  const blocked = [
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // AWS/GCP/Azure instance metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
  ];
  for (const ip of blocked) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be refused`);
  }
});

test('public addresses are allowed, so the tool is still useful', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} must be allowed`);
  }
});

test('a blocked hostname is refused without resolving it', async () => {
  for (const url of [
    'http://localhost/admin',
    'http://127.0.0.1:8787/api/state',
    'http://[::1]:8787/api/state',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://169.254.169.254/latest/meta-data/',
  ]) {
    const check = await checkHostIsPublic(new URL(url));
    assert.equal(check.ok, false, `${url} must be refused`);
    assert.ok(check.reason.length > 0, 'and it must say why');
  }
});

test('a public host is allowed', async () => {
  // A literal public address needs no DNS, so this is deterministic offline.
  const check = await checkHostIsPublic(new URL('http://93.184.216.34/'));
  assert.equal(check.ok, true);
});

test('a name that does not resolve is left for fetch to report', async () => {
  // Not a policy refusal: failing DNS and being refused by policy are different
  // answers, and the fetch gives the more useful message.
  const check = await checkHostIsPublic(new URL('http://this-name-should-not-resolve.invalid/'));
  assert.equal(check.ok, true);
  assert.deepEqual(check.addresses, []);
});

test('readCapped stops reading at the ceiling instead of buffering everything', async () => {
  const total = 5_000_000;
  let sent = 0;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const pump = (): void => {
      while (sent < total) {
        sent += chunk.length;
        if (!res.write(chunk)) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  try {
    const before = process.memoryUsage().rss;
    const resp = await fetch(`http://127.0.0.1:${port}/big`);
    const { text, truncated } = await readCapped(resp, MAX_FETCH_BYTES);
    const grew = process.memoryUsage().rss - before;
    assert.equal(truncated, true, 'a 5 MB body must be reported as truncated');
    assert.ok(text.length <= MAX_FETCH_BYTES, `read ${text.length} bytes, above the ${MAX_FETCH_BYTES} cap`);
    // The old code allocated the whole body; 5 MB is small, but the ratio is the
    // property: what is held must be bounded by the cap, not by the response.
    assert.ok(grew < 200 * 1024 * 1024, `RSS grew ${Math.round(grew / 1e6)} MB for a 5 MB body`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('readCapped passes a small body through untouched and untruncated', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello world');
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/small`);
    const { text, truncated } = await readCapped(resp, MAX_FETCH_BYTES);
    assert.equal(text, 'hello world');
    assert.equal(truncated, false);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// ------------------------------------------------------- following redirects
//
// `redirect: 'follow'` checked the URL a tool asked for and never the URL it
// landed on, so a public host could 302 straight into loopback. These pin the
// by-hand loop that re-checks every hop — with an injected fetch, so nothing here
// touches the network.
{
  /** A fetch that answers with the given `location`, recording every URL asked for. */
  function redirectingFetch(table: Record<string, { status: number; location?: string }>, seen: string[]) {
    return (async (input: string | URL | Request) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seen.push(href);
      const entry = table[href] ?? { status: 200 };
      const headers = new Headers();
      if (entry.location !== undefined) headers.set('location', entry.location);
      return new Response(entry.status >= 300 && entry.status < 400 ? null : 'body', {
        status: entry.status,
        headers,
      });
    }) as typeof fetch;
  }

  const options = { headers: {}, timeoutMs: 1_000 };

  test('a redirect into loopback is refused at the hop, not followed', async () => {
    const seen: string[] = [];
    const result = await fetchGuarded(new URL('https://public.example/start'), {
      ...options,
      fetchImpl: redirectingFetch(
        { 'https://public.example/start': { status: 302, location: 'http://127.0.0.1:8787/api/state' } },
        seen,
      ),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.refused, true, 'this is a policy refusal, not a network failure');
    assert.match(result.refused ? result.reason : '', /127\.0\.0\.1|loopback|private/);
    // The loopback URL was checked and rejected before any request was made to it.
    assert.deepEqual(seen, ['https://public.example/start']);
  });

  test('a redirect to another public host is followed and the response returned', async () => {
    const seen: string[] = [];
    const result = await fetchGuarded(new URL('https://public.example/start'), {
      ...options,
      fetchImpl: redirectingFetch(
        {
          'https://public.example/start': { status: 301, location: 'https://elsewhere.example/final' },
          'https://elsewhere.example/final': { status: 200 },
        },
        seen,
      ),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.response.status, 200);
    assert.equal(result.finalUrl.href, 'https://elsewhere.example/final');
    assert.deepEqual(seen, ['https://public.example/start', 'https://elsewhere.example/final']);
  });

  test('a redirect loop is bounded rather than followed forever', async () => {
    const seen: string[] = [];
    const result = await fetchGuarded(new URL('https://public.example/loop'), {
      ...options,
      fetchImpl: redirectingFetch({ 'https://public.example/loop': { status: 302, location: '/loop' } }, seen),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.refused, true);
    assert.match(result.refused ? result.reason : '', new RegExp(`more than ${MAX_REDIRECTS} redirects`));
    assert.equal(seen.length, MAX_REDIRECTS + 1, 'and it stops asking');
  });

  test('a non-http(s) redirect target is refused rather than handed to fetch', async () => {
    const seen: string[] = [];
    const result = await fetchGuarded(new URL('https://public.example/start'), {
      ...options,
      fetchImpl: redirectingFetch(
        { 'https://public.example/start': { status: 302, location: 'file:///etc/passwd' } },
        seen,
      ),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.refused, false, 'a malformed target is a failure, not a policy refusal');
    assert.match(result.refused === false ? result.error : '', /file:/);
    assert.equal(seen.length, 1);
  });

  test('a transport failure is reported as a failure, not as a refusal', async () => {
    const result = await fetchGuarded(new URL('https://public.example/x'), {
      ...options,
      fetchImpl: (async () => {
        throw new Error('socket hang up');
      }) as typeof fetch,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.refused, false);
    assert.match(result.refused === false ? result.error : '', /socket hang up/);
  });

  test('a refusal is checked before the request, so a blocked host is never contacted', async () => {
    let called = 0;
    const result = await fetchGuarded(new URL('http://169.254.169.254/latest/meta-data/'), {
      ...options,
      fetchImpl: (async () => {
        called += 1;
        return new Response('secret');
      }) as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(called, 0, 'the metadata service must not be dialled at all');
  });
}
