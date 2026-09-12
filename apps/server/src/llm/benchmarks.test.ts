/**
 * OpenRouter benchmark parsing and matching.
 *
 * Two things are load-bearing here. The **percentile calibration** is tested
 * against the real measured distribution, because a fixed scale is what a
 * reasonable person would write from the published example and it is wrong. And
 * the **ambiguity guard** is tested because a false match is the worst failure
 * this module can have: it would hand one vendor's scores to another's model
 * while looking authoritative.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelSpec } from '@dev3d/core';
import {
  bareKey,
  BENCHMARK_ATTRIBUTION,
  createBenchmarkService,
  fullKey,
  parseBenchmarks,
} from './benchmarks.ts';

function spec(id: string, providerId = 'openrouter', label?: string): ModelSpec {
  return {
    id,
    providerId,
    label: label ?? id,
    tier: 'standard',
    contextWindow: 1,
    maxOutputTokens: 1,
    costPerMTokIn: 1,
    costPerMTokOut: 1,
    capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
    strengths: [],
  };
}

/** Real rows, trimmed from the live payload. */
const LIVE = {
  data: [
    {
      source: 'artificial-analysis',
      model_permaslug: 'anthropic/claude-fable-5.1-20260831',
      display_name: 'Claude Fable 5.1',
      intelligence_index: 53.4,
      coding_index: 81.6,
      agentic_index: 58,
      pricing: { prompt: '0.000005', completion: '0.000025' },
    },
    {
      source: 'artificial-analysis',
      model_permaslug: 'ibm-granite/granite-4.2-8b',
      display_name: 'Granite 4.2 8B',
      intelligence_index: 3.8,
      coding_index: 2.7,
      agentic_index: 0.1,
      pricing: null,
    },
    {
      source: 'artificial-analysis',
      model_permaslug: 'qwen/qwen3.8-max-20260803',
      display_name: 'Qwen3.8 Max',
      intelligence_index: 22.3,
      coding_index: 42.8,
      agentic_index: 17.2,
      pricing: null,
    },
    {
      source: 'design-arena',
      model_permaslug: 'sourceful/riverflow-v2.5-pro-20260605',
      display_name: 'Riverflow 2.5 Pro',
      arena: 'models',
      category: 'graphicdesign',
      elo: 1440,
      win_rate: 79.2,
    },
    {
      source: 'design-arena',
      model_permaslug: 'acme/weak-design-20260101',
      display_name: 'Weak Design',
      arena: 'models',
      category: 'graphicdesign',
      elo: 900,
      win_rate: 20,
    },
    {
      source: 'openrouter',
      model_permaslug: 'google/gemini-3.1-pro-preview-20260219',
      display_name: 'Gemini 3.1 Pro Preview',
      benchmark_type: 'gpqa_diamond',
      accuracy: 0.944444,
    },
    {
      source: 'openrouter',
      model_permaslug: 'acme/weak-science-20260101',
      display_name: 'Weak Science',
      benchmark_type: 'gpqa_diamond',
      accuracy: 0.2,
    },
  ],
};

function serviceWith(json: unknown, opts: Record<string, unknown> = {}) {
  const service = createBenchmarkService({
    apiKey: 'test-key',
    cachePath: null,
    ttlMs: 60_000,
    fetchImpl: (async () => new Response(JSON.stringify(json), { status: 200 })) as typeof fetch,
    ...opts,
  });
  return service;
}

// ------------------------------------------------------------------- parsing

test('rows from all three sources parse into one entry list', () => {
  const entries = parseBenchmarks(LIVE);
  assert.equal(entries.length, 7);
  assert.deepEqual(
    [...new Set(entries.map((e) => e.source))].sort(),
    ['artificial-analysis', 'design-arena', 'openrouter'],
  );
});

test('a payload that is not a benchmark list yields nothing rather than throwing', () => {
  for (const bad of [null, 'nope', {}, { data: 'x' }, { data: [null, 42] }, []]) {
    assert.deepEqual(parseBenchmarks(bad), []);
  }
});

test('a row with no permaslug is dropped', () => {
  assert.deepEqual(parseBenchmarks({ data: [{ display_name: 'x' }, { model_permaslug: '' }] }), []);
});

// ------------------------------------------- the calibration that must be right

test('indices are ranked as percentiles, not mapped through a fixed window', () => {
  // This is the correction that matters. The published example shows values
  // around 60-90, which invites `(v - 15) / 65`; measured against the live
  // payload the median intelligence index is 22.3, so that window would put the
  // median model at 0.11 and never award a top score to anything.
  const entries = parseBenchmarks(LIVE);
  const byslug = new Map(entries.map((e) => [e.permaslug, e]));

  const weakest = byslug.get('ibm-granite/granite-4.2-8b');
  const median = byslug.get('qwen/qwen3.8-max-20260803');
  const strongest = byslug.get('anthropic/claude-fable-5.1-20260831');
  assert.ok(weakest && median && strongest);

  assert.equal(weakest.pIntelligence, 0, 'the weakest index in the population scores 0');
  assert.equal(strongest.pIntelligence, 1, 'the strongest scores 1');
  assert.equal(median.pIntelligence, 0.5, 'and the median sits in the middle');

  // Under the fixed window these would have been 0, 0.11 and 0.59.
  assert.notEqual(strongest.pIntelligence, 0.59);
});

test('percentiles are computed per index, because the indices differ in range', () => {
  const entries = parseBenchmarks(LIVE);
  const granite = entries.find((e) => e.permaslug === 'ibm-granite/granite-4.2-8b');
  assert.ok(granite);
  // Granite is weakest on all three, so it is 0 on all three.
  assert.equal(granite.pCoding, 0);
  assert.equal(granite.pAgentic, 0);
});

test('Elo is ranked within its own arena and category, not across all of them', () => {
  const entries = parseBenchmarks(LIVE);
  const strong = entries.find((e) => e.permaslug === 'sourceful/riverflow-v2.5-pro-20260605');
  const weak = entries.find((e) => e.permaslug === 'acme/weak-design-20260101');
  assert.ok(strong && weak);
  assert.equal(strong.pElo, 1);
  assert.equal(weak.pElo, 0);
});

test('benchmark accuracy is ranked within its own benchmark type', () => {
  const entries = parseBenchmarks(LIVE);
  const strong = entries.find((e) => e.permaslug === 'google/gemini-3.1-pro-preview-20260219');
  assert.equal(strong?.pAccuracy, 1);
});

// ------------------------------------------------------------------- opinion

test('an Artificial Analysis row produces quality and coding fitness', async () => {
  const service = serviceWith(LIVE);
  await service.refresh();
  const opinion = service.opinionFor(spec('openrouter/anthropic/claude-fable-5.1'));
  assert.ok(opinion, 'the provider prefix must be stripped to match');
  assert.equal(opinion.source, 'pooled');
  assert.equal(opinion.quality, 1);
  assert.equal(opinion.fitness.coding, 1);
  assert.equal(opinion.confidence, 0.6, 'three indices is more to go on than one');
});

test('a bare-name match works when the catalog id carries no vendor', async () => {
  const service = serviceWith(LIVE);
  await service.refresh();
  // `anthropic/claude-fable-5.1-20260831` reduced to its bare key.
  const opinion = service.opinionFor(spec('openrouter/claude-fable-5.1'));
  assert.ok(opinion, 'the bare tail should match when it is unambiguous');
});

test('an ambiguous bare name is refused rather than guessed', async () => {
  // Two vendors, one bare name. Handing either of them the other's scores is the
  // worst thing this module could do, so the key is poisoned instead.
  const ambiguous = {
    data: [
      { source: 'artificial-analysis', model_permaslug: 'vendorA/twin-model', intelligence_index: 50, coding_index: 50 },
      { source: 'artificial-analysis', model_permaslug: 'vendorB/twin-model', intelligence_index: 5, coding_index: 5 },
    ],
  };
  const service = serviceWith(ambiguous);
  await service.refresh();
  assert.equal(
    service.opinionFor(spec('openrouter/twin-model')),
    undefined,
    'an ambiguous bare key must produce no opinion at all',
  );
  // But the unambiguous full slugs still resolve.
  assert.ok(service.opinionFor(spec('openrouter/vendorA/twin-model')));
  assert.ok(service.opinionFor(spec('openrouter/vendorB/twin-model')));
});

test('an unknown model gets no opinion rather than an invented one', async () => {
  const service = serviceWith(LIVE);
  await service.refresh();
  assert.equal(service.opinionFor(spec('openrouter/nobody/never-benchmarked')), undefined);
});

test('design-arena supplies design fitness, which no coding index could', async () => {
  const service = serviceWith(LIVE);
  await service.refresh();
  const opinion = service.opinionFor(spec('openrouter/sourceful/riverflow-v2.5-pro'));
  assert.ok(opinion);
  assert.equal(opinion.fitness.design, 1);
  // A design Elo says nothing about coding, so no number is invented for it.
  assert.equal(opinion.fitness.coding, undefined);
});

test('the attribution names the source, the standing and the population', async () => {
  const service = serviceWith(LIVE);
  await service.refresh();
  const opinion = service.opinionFor(spec('openrouter/anthropic/claude-fable-5.1'));
  assert.ok(opinion);
  assert.match(opinion.attribution ?? '', /artificialanalysis\.ai/);
  assert.match(opinion.attribution ?? '', /openrouter\.ai/);
  // "top 0%" because this fixture's model has the highest intelligence index.
  assert.match(opinion.attribution ?? '', /top 0% of \d+ benchmarked model\(s\)/);
  assert.match(opinion.attribution ?? '', /Claude Fable 5\.1/);
});

test('a row with no index at all produces no opinion', async () => {
  const service = serviceWith({ data: [{ source: 'openrouter', model_permaslug: 'a/b', benchmark_type: 'x' }] });
  await service.refresh();
  // No intelligence, coding or agentic index - only a benchmark type with no
  // accuracy - so there is nothing to rank on.
  assert.equal(service.opinionFor(spec('openrouter/a/b')), undefined);
});

// ------------------------------------------------------------------ fetching

test('no API key means no request at all', async () => {
  let called = 0;
  const service = createBenchmarkService({
    apiKey: null,
    cachePath: null,
    ttlMs: 0,
    fetchImpl: (async () => {
      called += 1;
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  });
  const result = await service.refresh();
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /no OpenRouter API key/);
  assert.equal(called, 0);
});

test('the bearer token is what is sent, and it is the key', async () => {
  let seen: string | null = null;
  const service = createBenchmarkService({
    apiKey: 'sk-or-test',
    cachePath: null,
    ttlMs: 0,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      seen = (init.headers as Record<string, string>).Authorization ?? null;
      return new Response(JSON.stringify(LIVE), { status: 200 });
    }) as unknown as typeof fetch,
  });
  await service.refresh();
  assert.equal(seen, 'Bearer sk-or-test');
});

test('an HTTP failure is reported and changes nothing', async () => {
  const service = createBenchmarkService({
    apiKey: 'k',
    cachePath: null,
    ttlMs: 0,
    fetchImpl: (async () => new Response('rate limited', { status: 429 })) as typeof fetch,
  });
  const result = await service.refresh();
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /429/);
  assert.equal(service.coverage().entries, 0);
});

test('a network throw is caught rather than propagated', async () => {
  const service = createBenchmarkService({
    apiKey: 'k',
    cachePath: null,
    ttlMs: 0,
    fetchImpl: (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as typeof fetch,
  });
  const result = await service.refresh();
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /ENOTFOUND/);
});

test('coverage reports the real numbers, not an implication of full cover', async () => {
  const service = serviceWith(LIVE);
  await service.refresh();
  const c = service.coverage();
  assert.equal(c.entries, 7, 'every row, across all three sources');
  assert.equal(c.models, 7);
  assert.equal(c.measured, 3, 'only three rows carry an index');
  assert.equal(c.attribution, BENCHMARK_ATTRIBUTION);
  assert.ok(c.fetchedAt !== null);
});

test('a fresh payload is not re-fetched', async () => {
  let calls = 0;
  const service = createBenchmarkService({
    apiKey: 'k',
    cachePath: null,
    ttlMs: 60_000,
    fetchImpl: (async () => {
      calls += 1;
      return new Response(JSON.stringify(LIVE), { status: 200 });
    }) as typeof fetch,
  });
  await service.refresh();
  await service.refresh();
  assert.equal(calls, 1);
});

// --------------------------------------------------------------------- cache

test('the cache round-trips the entries and their percentiles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-bench-'));
  const path = join(dir, 'benchmarks.json');
  try {
    const first = createBenchmarkService({
      apiKey: 'k',
      cachePath: path,
      ttlMs: 60_000,
      fetchImpl: (async () => new Response(JSON.stringify(LIVE), { status: 200 })) as typeof fetch,
    });
    await first.refresh();
    first.saveCache();

    const second = createBenchmarkService({ apiKey: 'k', cachePath: path, ttlMs: 60_000 });
    assert.equal(second.loadCache(), 7);
    // The percentile has to survive the round trip, or a cached run would rank
    // differently from a fresh one.
    const opinion = second.opinionFor(spec('openrouter/anthropic/claude-fable-5.1'));
    assert.equal(opinion?.quality, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt or foreign cache is ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-bench-'));
  const path = join(dir, 'benchmarks.json');
  try {
    for (const content of ['nope', '{"version":2,"entries":[]}', '{"version":1}', '[]']) {
      writeFileSync(path, content, 'utf8');
      const service = createBenchmarkService({ apiKey: 'k', cachePath: path, ttlMs: 60_000 });
      assert.equal(service.loadCache(), 0, `should ignore: ${content}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a cache that cannot be written is not fatal', () => {
  const service = createBenchmarkService({
    apiKey: 'k',
    cachePath: join(process.cwd(), 'package.json', 'nested', 'b.json'),
    ttlMs: 0,
  });
  assert.doesNotThrow(() => service.saveCache());
});

// -------------------------------------------------------------- key helpers

test('full and bare keys differ in exactly the way the guard depends on', () => {
  assert.equal(fullKey('deepseek/deepseek-chat'), 'deepseekdeepseekchat');
  assert.equal(bareKey('deepseek/deepseek-chat'), 'deepseekchat');
  // Two vendors' same-named models collide on the bare key and not the full one.
  assert.equal(bareKey('openai/gpt-4o'), bareKey('azure/gpt-4o'));
  assert.notEqual(fullKey('openai/gpt-4o'), fullKey('azure/gpt-4o'));
});
