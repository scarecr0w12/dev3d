/**
 * Endpoint uptime.
 *
 * The behaviours worth pinning are the ones that decide whether a health lookup
 * can ever hurt: it must never block a turn, it must never fail one, an unknown
 * model must contribute nothing, and a model with no endpoints must not be
 * mistaken for a model with a broken one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelSpec } from '@dev3d/core';
import { aggregateEndpoints, createHealthService, HEALTHY_UPTIME, slugFor } from './health.ts';

function spec(id: string, providerId = 'openrouter'): ModelSpec {
  return {
    id,
    providerId,
    label: id,
    tier: 'standard',
    contextWindow: 1,
    maxOutputTokens: 1,
    costPerMTokIn: 1,
    costPerMTokOut: 1,
    capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
    strengths: [],
  };
}

function endpoint(uptime: unknown, extra: Record<string, unknown> = {}) {
  return { name: 'x', uptime_last_30m: uptime, ...extra };
}

/** A fetch stub that answers one endpoint list per slug. */
function fetchStub(bySlug: Record<string, unknown[]>, onCall?: (url: string) => void): typeof fetch {
  return (async (url: string) => {
    onCall?.(url);
    const slug = String(url).replace('https://openrouter.ai/api/v1/models/', '').replace('/endpoints', '');
    const endpoints = bySlug[slug];
    if (endpoints === undefined) return new Response('{"error":"not found"}', { status: 404 });
    return new Response(JSON.stringify({ data: { endpoints } }), { status: 200 });
  }) as unknown as typeof fetch;
}

// ------------------------------------------------------------------- slugs

test('only OpenRouter-backed models get a slug, and the prefix comes off', () => {
  assert.deepEqual(slugFor(spec('openrouter/openai/gpt-4o'), ['openrouter']), {
    modelId: 'openrouter/openai/gpt-4o',
    permaslug: 'openai/gpt-4o',
  });
});

test('a model on any other provider has no slug, because the data is not about it', () => {
  // OpenRouter's upstream routing says nothing about a direct DeepSeek call.
  assert.equal(slugFor(spec('deepseek-v4-pro', 'deepseek'), ['openrouter']), null);
});

test('an OpenRouter id with no vendor segment is not a slug', () => {
  // A real slug is `author/model`. An id that is just `openrouter/<model>` has
  // nothing to ask about, so it is skipped rather than requested as a 404.
  assert.equal(slugFor(spec('openrouter/gpt-4o'), ['openrouter']), null);
  assert.equal(slugFor(spec('openrouter/'), ['openrouter']), null);
});

// -------------------------------------------------------------- aggregation

test('the best endpoint wins, because that is the one OpenRouter will use', () => {
  const record = aggregateEndpoints('m', 'a/b', [endpoint(50), endpoint(99.5), endpoint(80)], 1);
  assert.equal(record.uptime, 0.995, 'a percentage becomes a fraction');
  assert.equal(record.endpointCount, 3);
  assert.equal(record.healthyCount, 1);
});

test('a percentage and a fraction are both understood', () => {
  assert.equal(aggregateEndpoints('m', 'a/b', [endpoint(99.5)], 1).uptime, 0.995);
  assert.equal(aggregateEndpoints('m', 'a/b', [endpoint(0.995)], 1).uptime, 0.995);
});

test('endpoints with no uptime are counted but do not become a zero', () => {
  const record = aggregateEndpoints('m', 'a/b', [endpoint(null), endpoint(98)], 1);
  assert.equal(record.uptime, 0.98, 'a missing reading must not drag the best down');
  assert.equal(record.endpointCount, 2);
});

test('a model with no endpoints at all reports no uptime, not zero', () => {
  // The live payload has models like this - OpenRouter's own `~`-prefixed
  // cloaked models return an empty list. "No endpoints" is not "all down".
  const record = aggregateEndpoints('m', 'a/b', [], 1);
  assert.equal(record.uptime, null);
  assert.equal(record.endpointCount, 0);
  assert.equal(record.healthyCount, 0);
});

test('nonsense uptime values are ignored rather than believed', () => {
  const record = aggregateEndpoints('m', 'a/b', [endpoint('abc'), endpoint(-5), endpoint(1e9), endpoint(97)], 1);
  assert.equal(record.uptime, 0.97);
  assert.equal(record.endpointCount, 4);
});

test('the healthy count is what makes fragility visible', () => {
  // "The only one of five still standing" is a fragile position an average
  // would hide.
  const fragile = aggregateEndpoints('m', 'a/b', [endpoint(95), endpoint(10), endpoint(5), endpoint(0), endpoint(2)], 1);
  assert.equal(fragile.uptime, 0.95, 'the best endpoint is still good');
  assert.equal(fragile.healthyCount, 1, 'but only one endpoint is carrying it');
  assert.ok(HEALTHY_UPTIME === 0.9);
});

// ------------------------------------------------------------------ lookups

test('a model from another provider reports no uptime', async () => {
  const health = createHealthService({
    providerIds: ['openrouter'],
    cachePath: null,
    ttlMs: 60_000,
    fetchImpl: fetchStub({}),
  });
  assert.equal(health.uptimeFor(spec('deepseek-v4-pro', 'deepseek')), undefined);
});

test('an unknown model is undefined immediately and fetched in the background', async () => {
  let calls = 0;
  const health = createHealthService({
    providerIds: ['openrouter'],
    cachePath: null,
    ttlMs: 60_000,
    fetchImpl: fetchStub({ 'a/b': [endpoint(99)] }, () => {
      calls += 1;
    }),
  });

  // The first ask must not block. It queues and answers undefined.
  const first = health.uptimeFor(spec('openrouter/a/b'));
  assert.equal(first, undefined, 'an unknown model contributes nothing, immediately');

  // Let the background chain settle.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, 'the background fetch happened');
  assert.equal(health.uptimeFor(spec('openrouter/a/b')), 0.99, 'and the next ask knows');
});

test('one model is never fetched twice at once', async () => {
  let calls = 0;
  const health = createHealthService({
    providerIds: ['openrouter'],
    cachePath: null,
    ttlMs: 60_000,
    fetchImpl: fetchStub({ 'a/b': [endpoint(99)] }, () => {
      calls += 1;
    }),
  });
  for (let i = 0; i < 10; i += 1) health.uptimeFor(spec('openrouter/a/b'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1, 'the in-flight guard must collapse a burst into one request');
});

test('a failed lookup leaves the model unknown rather than zero', async () => {
  const health = createHealthService({
    providerIds: ['openrouter'],
    cachePath: null,
    ttlMs: 60_000,
    fetchImpl: fetchStub({}),
  });
  await health.refresh([spec('openrouter/a/b')]);
  assert.equal(health.uptimeFor(spec('openrouter/a/b')), undefined);
  assert.equal(health.recordFor(spec('openrouter/a/b')), undefined);
});

test('a network throw never propagates out of a lookup', async () => {
  const health = createHealthService({
    providerIds: ['openrouter'],
    cachePath: null,
    ttlMs: 60_000,
    fetchImpl: (async () => {
      throw new Error('ENOTFOUND');
    }) as typeof fetch,
  });
  await assert.doesNotReject(() => health.refresh([spec('openrouter/a/b')]));
  assert.equal(health.uptimeFor(spec('openrouter/a/b')), undefined);
});

test('an explicit refresh is awaitable and reports what it did', async () => {
  const health = createHealthService({
    providerIds: ['openrouter'],
    cachePath: null,
    ttlMs: 60_000,
    fetchImpl: fetchStub({ 'a/b': [endpoint(97)], 'c/d': [endpoint(80)] }),
  });
  const result = await health.refresh([spec('openrouter/a/b'), spec('openrouter/c/d'), spec('deepseek-v4-pro', 'deepseek')]);
  // The non-OpenRouter model is skipped, not counted as a failure.
  assert.deepEqual(result, { fetched: 2, failed: 0 });
  assert.equal(health.uptimeFor(spec('openrouter/a/b')), 0.97);
});

test('the URL is built with each slug segment encoded separately', async () => {
  const urls: string[] = [];
  const health = createHealthService({
    providerIds: ['openrouter'],
    cachePath: null,
    ttlMs: 60_000,
    fetchImpl: fetchStub({}, (url) => urls.push(url)),
  });
  await health.refresh([spec('openrouter/openai/gpt-4o')]);
  // The separator slash has to survive, or the path becomes a 404.
  assert.deepEqual(urls, ['https://openrouter.ai/api/v1/models/openai/gpt-4o/endpoints']);
});

test('the record is exposed for the console, with its endpoint counts', async () => {
  const health = createHealthService({
    providerIds: ['openrouter'],
    cachePath: null,
    ttlMs: 60_000,
    fetchImpl: fetchStub({ 'a/b': [endpoint(99), endpoint(10)] }),
  });
  await health.refresh([spec('openrouter/a/b')]);
  const record = health.recordFor(spec('openrouter/a/b'));
  assert.ok(record);
  assert.equal(record.permaslug, 'a/b');
  assert.equal(record.endpointCount, 2);
  assert.equal(record.healthyCount, 1);
});

// --------------------------------------------------------------------- cache

test('the cache round-trips uptime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-health-'));
  const path = join(dir, 'health.json');
  try {
    const first = createHealthService({
      providerIds: ['openrouter'],
      cachePath: path,
      ttlMs: 60_000,
      fetchImpl: fetchStub({ 'a/b': [endpoint(98.5)] }),
    });
    await first.refresh([spec('openrouter/a/b')]);
    first.saveCache();

    const second = createHealthService({ providerIds: ['openrouter'], cachePath: path, ttlMs: 60_000 });
    assert.equal(second.loadCache(), 1);
    assert.equal(second.uptimeFor(spec('openrouter/a/b')), 0.985);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt or foreign cache is ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-health-'));
  const path = join(dir, 'health.json');
  try {
    for (const content of ['nope', '{"version":2,"records":[]}', '{"version":1}', '[]']) {
      writeFileSync(path, content, 'utf8');
      const health = createHealthService({ providerIds: ['openrouter'], cachePath: path, ttlMs: 60_000 });
      assert.equal(health.loadCache(), 0, `should ignore: ${content}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a cache that cannot be written is not fatal', () => {
  const health = createHealthService({
    providerIds: ['openrouter'],
    cachePath: join(process.cwd(), 'package.json', 'nested', 'h.json'),
    ttlMs: 0,
  });
  assert.doesNotThrow(() => health.saveCache());
});

test('health switched off reports nothing for anything', () => {
  const health = createHealthService({ providerIds: [], cachePath: null, ttlMs: 0 });
  assert.equal(health.uptimeFor(spec('openrouter/a/b')), undefined);
  assert.equal(health.status().enabled, false);
});
