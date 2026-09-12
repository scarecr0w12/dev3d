/**
 * The discovery service.
 *
 * The behaviours worth pinning are the ones that decide whether a vendor outage
 * is survivable: a failure must keep the curated catalog rather than emptying
 * it, a cache must round-trip, and "I could not ask" must stay distinguishable
 * from "the provider serves nothing".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveredModel } from '@dev3d/core';
import { createDiscoveryService, curatedButMissing, specsFromDiscovered } from './discovery.ts';
import type { LlmProvider } from './types.ts';

function fakeProvider(id: string, impl?: () => Promise<DiscoveredModel[]>): LlmProvider {
  const provider: LlmProvider = {
    id,
    label: id,
    models: [],
    isConfigured: () => true,
    chat: () => Promise.reject(new Error('not used in these tests')),
  };
  if (impl !== undefined) provider.listModels = impl;
  return provider;
}

function tempCache(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-discovery-'));
  return {
    path: join(dir, 'models.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('a successful discovery records the models and merges curated metadata', async () => {
  const service = createDiscoveryService({
    // `deepseek-flash` is a real curated id, so the merge path is exercised.
    providers: () => [fakeProvider('deepseek', async () => [{ id: 'deepseek-flash' }])],
    ttlMs: 60_000,
    cachePath: null,
  });

  const report = await service.discover('deepseek');
  assert.equal(report?.ok, true);
  assert.equal(report?.models.length, 1);
  assert.equal(service.modeFor('deepseek'), 'discovered');

  const specs = service.modelsFor('deepseek');
  assert.ok(specs, 'a successful discovery must produce specs');
  assert.equal(specs.length, 1);
  assert.equal(specs[0]?.id, 'deepseek-flash');
  // The curated table's judgement, not the vendor's silence.
  assert.equal(specs[0]?.tier, 'nano');
  assert.equal(specs[0]?.capabilities.tools, true);
  assert.equal(specs[0]?.quality?.quality, 0.25);
  assert.equal(specs[0]?.origin, 'discovered');
});

test('a model nobody described is kept and flagged unrated', async () => {
  const service = createDiscoveryService({
    providers: () => [fakeProvider('p', async () => [{ id: 'brand/new-model', costPerMTokIn: 1, costPerMTokOut: 3 }])],
    ttlMs: 60_000,
    cachePath: null,
  });
  await service.discover('p');
  const spec = service.modelsFor('p')?.[0];
  assert.ok(spec);
  assert.equal(spec.unrated, true, 'the console must be able to say the tier is a guess');
  // Strong price, so the price ladder - not the name - decides the tier.
  assert.equal(spec.tier, 'standard');
  assert.equal(spec.quality, undefined, 'nothing has an opinion about it yet');
});

test('a failed discovery keeps the curated catalog instead of emptying it', async () => {
  const service = createDiscoveryService({
    providers: () => [
      fakeProvider('p', async () => {
        throw new Error('HTTP 401 Unauthorized');
      }),
    ],
    ttlMs: 60_000,
    cachePath: null,
  });

  const report = await service.discover('p');
  assert.equal(report?.ok, false);
  assert.match(report?.error ?? '', /401/);
  assert.equal(service.modeFor('p'), 'degraded');
  // The decisive assertion: no discovered specs, so the caller falls back to the
  // seed. Returning [] here would leave the router with nothing to route to.
  assert.equal(service.modelsFor('p'), null);
});

test('a provider with no list endpoint is recorded, not treated as empty', async () => {
  const service = createDiscoveryService({
    providers: () => [fakeProvider('legacy')],
    ttlMs: 60_000,
    cachePath: null,
  });
  const report = await service.discover('legacy');
  assert.equal(report?.ok, false);
  assert.match(report?.error ?? '', /no model-list endpoint/);
  assert.equal(service.modelsFor('legacy'), null);
});

test('a provider that genuinely serves nothing yields an empty, successful result', async () => {
  // The distinction that matters: this is `ok: true` with zero models, so the
  // provider's emptiness is a fact rather than a failure to be papered over.
  const service = createDiscoveryService({
    providers: () => [fakeProvider('p', async () => [])],
    ttlMs: 60_000,
    cachePath: null,
  });
  const report = await service.discover('p');
  assert.equal(report?.ok, true);
  assert.deepEqual(report?.models, []);
  assert.deepEqual(service.modelsFor('p'), []);
  assert.equal(service.modeFor('p'), 'discovered');
});

test('discovering an unknown provider reports nothing rather than throwing', async () => {
  const service = createDiscoveryService({ providers: () => [], ttlMs: 0, cachePath: null });
  assert.equal(await service.discover('ghost'), null);
  assert.equal(service.modeFor('ghost'), 'seed');
  assert.equal(service.modelsFor('ghost'), null);
});

test('a fresh result is not re-fetched, and a forced one is', async () => {
  let calls = 0;
  const service = createDiscoveryService({
    providers: () => [
      fakeProvider('p', async () => {
        calls += 1;
        return [{ id: `m${calls}` }];
      }),
    ],
    ttlMs: 60_000,
    cachePath: null,
  });

  await service.discover('p');
  await service.discover('p');
  assert.equal(calls, 1, 'a result inside the TTL must be reused');

  await service.discover('p', { force: true });
  assert.equal(calls, 2, 'force must actually re-ask');
});

test('a zero TTL always re-asks', async () => {
  let calls = 0;
  const service = createDiscoveryService({
    providers: () => [
      fakeProvider('p', async () => {
        calls += 1;
        return [{ id: `m${calls}` }];
      }),
    ],
    ttlMs: 0,
    cachePath: null,
  });
  await service.discover('p');
  await service.discover('p');
  assert.equal(calls, 2);
});

test('discoverAll covers every provider and one failure does not stop the rest', async () => {
  const service = createDiscoveryService({
    providers: () => [
      fakeProvider('good', async () => [{ id: 'a' }]),
      fakeProvider('bad', async () => {
        throw new Error('down');
      }),
      fakeProvider('also-good', async () => [{ id: 'b' }]),
    ],
    ttlMs: 60_000,
    cachePath: null,
  });

  const reports = await service.discoverAll({ force: true });
  assert.equal(reports.length, 3);
  assert.deepEqual(
    reports.map((r) => r.ok),
    [true, false, true],
  );
  assert.equal(service.modeFor('also-good'), 'discovered');
});

test('a failure after a success withdraws the discovered set', async () => {
  // A stale answer we can no longer vouch for is worse than falling back: it
  // would keep routing to models we can no longer confirm exist.
  let fail = false;
  const service = createDiscoveryService({
    providers: () => [
      fakeProvider('p', async () => {
        if (fail) throw new Error('now down');
        return [{ id: 'a' }];
      }),
    ],
    ttlMs: 0,
    cachePath: null,
  });

  await service.discover('p');
  assert.ok(service.modelsFor('p'));

  fail = true;
  await service.discover('p', { force: true });
  assert.equal(service.modelsFor('p'), null, 'the withdrawn set must not linger');
  assert.equal(service.modeFor('p'), 'degraded');
});

test('the cache round-trips a successful result', async () => {
  const cache = tempCache();
  try {
    const first = createDiscoveryService({
      providers: () => [fakeProvider('deepseek', async () => [{ id: 'deepseek-flash' }])],
      ttlMs: 60_000,
      cachePath: cache.path,
    });
    await first.discover('deepseek');
    first.saveCache();

    // A fresh service, as a restart would build, with a provider that would fail
    // if it were actually asked.
    const second = createDiscoveryService({
      providers: () => [
        fakeProvider('deepseek', async () => {
          throw new Error('should not have been called');
        }),
      ],
      ttlMs: 60_000,
      cachePath: cache.path,
    });
    assert.equal(second.loadCache(), 1);
    assert.equal(second.modeFor('deepseek'), 'discovered');
    assert.equal(second.modelsFor('deepseek')?.[0]?.id, 'deepseek-flash');

    // And the cached result is fresh enough that asking is skipped entirely.
    const report = await second.discover('deepseek');
    assert.equal(report?.ok, true);
  } finally {
    cache.cleanup();
  }
});

test('a cached failure loads as degraded, not as never-asked', async () => {
  const cache = tempCache();
  try {
    const first = createDiscoveryService({
      providers: () => [
        fakeProvider('p', async () => {
          throw new Error('HTTP 503');
        }),
      ],
      ttlMs: 60_000,
      cachePath: cache.path,
    });
    await first.discover('p');
    first.saveCache();

    const second = createDiscoveryService({ providers: () => [fakeProvider('p')], ttlMs: 60_000, cachePath: cache.path });
    second.loadCache();
    assert.equal(second.modeFor('p'), 'degraded', 'the fact that we asked must survive a restart');
    assert.equal(second.modelsFor('p'), null);
  } finally {
    cache.cleanup();
  }
});

test('a corrupt or foreign cache file is ignored rather than trusted', async () => {
  const cache = tempCache();
  try {
    for (const content of ['not json at all', '{"version":99,"reports":[]}', '{"version":1}', 'null', '[]']) {
      writeFileSync(cache.path, content, 'utf8');
      const service = createDiscoveryService({ providers: () => [], ttlMs: 0, cachePath: cache.path });
      assert.equal(service.loadCache(), 0, `should ignore: ${content}`);
      assert.deepEqual(service.reports(), []);
    }
  } finally {
    cache.cleanup();
  }
});

test('a cache entry with a malformed shape is dropped, not half-applied', async () => {
  const cache = tempCache();
  try {
    writeFileSync(
      cache.path,
      JSON.stringify({
        version: 1,
        savedAt: 0,
        reports: [
          { providerId: 'ok', at: 1, ok: true, error: null, models: [{ id: 'm' }] },
          { providerId: 42, at: 1, ok: true, models: [] },
          { at: 1, ok: true },
          { providerId: 'no-at', ok: true, models: [] },
          'nonsense',
        ],
      }),
      'utf8',
    );
    const service = createDiscoveryService({ providers: () => [fakeProvider('ok')], ttlMs: 60_000, cachePath: cache.path });
    assert.equal(service.loadCache(), 1, 'only the well-formed entry counts');
    assert.equal(service.modeFor('ok'), 'discovered');
  } finally {
    cache.cleanup();
  }
});

test('a cache that cannot be written is not fatal', () => {
  const service = createDiscoveryService({
    providers: () => [],
    ttlMs: 0,
    // A path whose parent is a file, so mkdir can never succeed.
    cachePath: join(process.cwd(), 'package.json', 'nested', 'models.json'),
  });
  assert.doesNotThrow(() => service.saveCache());
});

test('curated entries the provider did not report are named', async () => {
  const service = createDiscoveryService({
    providers: () => [fakeProvider('deepseek', async () => [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }])],
    ttlMs: 0,
    cachePath: null,
  });
  const report = await service.discover('deepseek');
  assert.ok(report);
  // The exact stale entry this whole mechanism exists to catch: the curated
  // table still describes it and the live provider does not serve it.
  assert.deepEqual(curatedButMissing('deepseek', report.models), ['deepseek-v4-flash-vision-exp']);
});

test('specsFromDiscovered keeps a curated model routable when the vendor is silent', () => {
  // DeepSeek answers with only an id and an owner, so every price and capability
  // has to come from the curated table or the model would be a free, toolless
  // ghost that wins cost ties and cannot call a tool.
  const specs = specsFromDiscovered('deepseek', [{ id: 'deepseek-v4-pro', ownedBy: 'deepseek' }]);
  const spec = specs[0];
  assert.ok(spec);
  assert.equal(spec.costPerMTokIn, 0.55);
  assert.equal(spec.costPerMTokOut, 2.19);
  assert.equal(spec.capabilities.tools, true);
  assert.equal(spec.capabilities.reasoning, true);
  assert.equal(spec.tier, 'strong');
  assert.equal(spec.label, 'DeepSeek V4 Pro');
});

test('the cache file is valid JSON with a version, so a future change can refuse it', async () => {
  const cache = tempCache();
  try {
    const service = createDiscoveryService({
      providers: () => [fakeProvider('p', async () => [{ id: 'm' }])],
      ttlMs: 0,
      cachePath: cache.path,
    });
    await service.discover('p');
    service.saveCache();
    const parsed = JSON.parse(readFileSync(cache.path, 'utf8')) as { version: number; reports: unknown[] };
    assert.equal(parsed.version, 1);
    assert.equal(parsed.reports.length, 1);
  } finally {
    cache.cleanup();
  }
});
