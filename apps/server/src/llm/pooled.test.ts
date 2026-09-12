/**
 * The pooled quality source, tested against the response shape Artificial
 * Analysis documents and against the failure modes that decide whether an
 * unreachable aggregator can hurt the office (it cannot).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelSpec } from '@dev3d/core';
import { AA_ATTRIBUTION, createPooledService, matchKey, parseArtificialAnalysis, scaleIndex } from './pooled.ts';

/** A trimmed copy of the response shape their API reference documents. */
const AA_RESPONSE = {
  status: 200,
  data: [
    {
      id: '2dad8957',
      name: 'o3-mini',
      slug: 'o3-mini',
      model_creator: { id: 'x', name: 'OpenAI', slug: 'openai' },
      evaluations: {
        artificial_analysis_intelligence_index: 62.9,
        artificial_analysis_coding_index: 55.8,
        artificial_analysis_math_index: 87.2,
        mmlu_pro: 0.791,
      },
      pricing: { price_1m_blended_3_to_1: 1.925, price_1m_input_tokens: 1.1, price_1m_output_tokens: 4.4 },
    },
    {
      id: 'other',
      name: 'Some Model 3.5',
      slug: 'some-model',
      evaluations: { artificial_analysis_intelligence_index: 30 },
      pricing: {},
    },
  ],
};

function spec(id: string, label?: string): ModelSpec {
  return {
    id,
    providerId: 'p',
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

function serviceWith(entries: ReturnType<typeof parseArtificialAnalysis>, opts: Partial<Parameters<typeof createPooledService>[0]> = {}) {
  const service = createPooledService({
    apiKey: 'test-key',
    cachePath: null,
    ttlMs: 0,
    fetchImpl: (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch,
    ...opts,
  });
  // Seed through the cache path, which is the only public way in - and which
  // also exercises the loader.
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-pooled-'));
  const path = join(dir, 'pooled.json');
  writeFileSync(
    path,
    JSON.stringify({ version: 1, fetchedAt: 1_700_000_000_000, attribution: AA_ATTRIBUTION, entries }),
    'utf8',
  );
  const seeded = createPooledService({ apiKey: 'k', cachePath: path, ttlMs: 60_000, ...opts });
  seeded.loadCache();
  rmSync(dir, { recursive: true, force: true });
  return { service: seeded, dir };
}

// ------------------------------------------------------------------ parsing

test('the documented response shape parses into indices', () => {
  const entries = parseArtificialAnalysis(AA_RESPONSE);
  assert.equal(entries.length, 2);
  const o3 = entries[0];
  assert.equal(o3?.name, 'o3-mini');
  assert.equal(o3?.intelligence, 62.9);
  assert.equal(o3?.coding, 55.8);
  assert.equal(o3?.math, 87.2);
  assert.equal(o3?.costIn, 1.1);
  assert.equal(o3?.costOut, 4.4);
});

test('a missing index stays null rather than becoming zero', () => {
  // Zero would read as "worst possible model", which is a much stronger claim
  // than "this source did not measure it".
  const entries = parseArtificialAnalysis(AA_RESPONSE);
  assert.equal(entries[1]?.coding, null);
  assert.equal(entries[1]?.math, null);
});

test('a body that is not a model list yields nothing rather than throwing', () => {
  for (const bad of [null, 'nope', {}, { data: 'x' }, { data: [null, 42] }, []]) {
    assert.deepEqual(parseArtificialAnalysis(bad), []);
  }
});

test('an entry with no usable name is dropped', () => {
  const entries = parseArtificialAnalysis({ data: [{ name: '' }, { evaluations: {} }, { slug: 'ok-slug' }] });
  assert.deepEqual(
    entries.map((e) => e.name),
    ['ok-slug'],
  );
});

// ------------------------------------------------------------------- scaling

test('the index scale lands weak and strong models at sensible ends', () => {
  assert.equal(scaleIndex(80), 1);
  assert.equal(scaleIndex(100), 1, 'clamped, not extrapolated');
  assert.equal(scaleIndex(15), 0);
  assert.equal(scaleIndex(0), 0, 'clamped');
  assert.ok(scaleIndex(47.5) > 0.45 && scaleIndex(47.5) < 0.55, 'the midpoint is mid-scale');
});

// ------------------------------------------------------------------ matching

test('match keys survive the ways vendors disagree about a name', () => {
  assert.equal(matchKey('DeepSeek Chat v3.1'), matchKey('deepseek-chat-v3.1'));
  assert.equal(matchKey('Claude 3.5 Sonnet'), matchKey('claude-3-5-sonnet'));
  assert.equal(matchKey('  GPT-4o  '), matchKey('gpt-4o'));
});

test('a vendor prefix is kept, because two vendors can ship one name', () => {
  // Folding them together would attach one model's benchmark scores to another's.
  assert.notEqual(matchKey('openai/gpt-4o'), matchKey('gpt-4o'));
  assert.equal(matchKey('openai/gpt-4o'), 'openaigpt4o');
});

test('a dated snapshot and a `latest` alias both match their base name', () => {
  assert.equal(matchKey('gpt-4o-2024-11-20'), matchKey('gpt-4o'));
  assert.equal(matchKey('gpt-4o-20241120'), matchKey('gpt-4o'));
  assert.equal(matchKey('claude-3-5-sonnet-20241022'), matchKey('claude-3-5-sonnet'));
  assert.equal(matchKey('claude-3-5-sonnet-latest'), matchKey('claude-3-5-sonnet'));
  assert.equal(matchKey('deepseek-chat-preview'), matchKey('deepseek-chat'));
});

test('a prefixed catalog id still matches an unprefixed listing', () => {
  // The bare form is an *additional* key, so matching works in that direction.
  const { service } = serviceWith(parseArtificialAnalysis({ data: [{ name: 'o3-mini', evaluations: { artificial_analysis_intelligence_index: 62 } }] }));
  assert.equal(service.opinionsFor([spec('openai/o3-mini')]).size, 1);
});

test('matching is used to attach opinions, preferring the vendor-prefixed id', () => {
  const { service } = serviceWith(parseArtificialAnalysis(AA_RESPONSE));
  const opinions = service.opinionsFor([spec('openai/o3-mini'), spec('o3-mini', 'o3-mini')]);
  assert.equal(opinions.size, 2, 'both spellings should match the one listing');
});

test('a model the aggregator does not list gets no opinion at all', () => {
  const { service } = serviceWith(parseArtificialAnalysis(AA_RESPONSE));
  const opinions = service.opinionsFor([spec('some/never-benchmarked-model')]);
  assert.equal(opinions.size, 0, 'no opinion beats an invented one');
});

// ------------------------------------------------------------------ opinions

test('an opinion carries its attribution, as the terms require', () => {
  const { service } = serviceWith(parseArtificialAnalysis(AA_RESPONSE));
  const opinion = service.opinionsFor([spec('o3-mini')]).get('o3-mini');
  assert.ok(opinion);
  assert.equal(opinion.source, 'pooled');
  assert.match(opinion.attribution ?? '', /artificialanalysis\.ai/);
  assert.match(opinion.attribution ?? '', /intelligence 62\.9/);
});

test('fitness is derived only where the correspondence is real', () => {
  const { service } = serviceWith(parseArtificialAnalysis(AA_RESPONSE));
  const opinion = service.opinionsFor([spec('o3-mini')]).get('o3-mini');
  assert.ok(opinion);
  assert.ok(opinion.fitness.coding !== undefined, 'a coding index says something about coding');
  assert.ok(opinion.fitness.testing !== undefined);
  assert.ok(opinion.fitness.planning !== undefined, 'and a math index about planning');
  // A benchmark says nothing about whether a model is good in a debate, so no
  // number is invented for it.
  assert.equal(opinion.fitness.debate, undefined);
  assert.equal(opinion.fitness.design, undefined);
});

test('pooled confidence sits below an operator and level with its evidence', () => {
  const { service } = serviceWith(parseArtificialAnalysis(AA_RESPONSE));
  const opinion = service.opinionsFor([spec('o3-mini')]).get('o3-mini');
  assert.equal(opinion?.confidence, 0.55);
});

test('an entry with no intelligence index produces no opinion', () => {
  const entries = parseArtificialAnalysis({ data: [{ name: 'coded-only', evaluations: { artificial_analysis_coding_index: 50 } }] });
  const { service } = serviceWith(entries);
  assert.equal(service.opinionsFor([spec('coded-only')]).size, 0);
});

// ------------------------------------------------------------------ fetching

test('no API key means no request is made at all', async () => {
  let called = 0;
  const service = createPooledService({
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
  assert.match(result.error ?? '', /no Artificial Analysis API key/);
  assert.equal(called, 0, 'a default install must make no outbound call');
});

test('a successful refresh records the index', async () => {
  const service = createPooledService({
    apiKey: 'k',
    cachePath: null,
    ttlMs: 60_000,
    fetchImpl: (async () => new Response(JSON.stringify(AA_RESPONSE), { status: 200 })) as typeof fetch,
  });
  const result = await service.refresh();
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(service.status().count, 2);
  assert.ok(service.opinionsFor([spec('o3-mini')]).size > 0);
});

test('an HTTP failure is reported and leaves the office unharmed', async () => {
  const service = createPooledService({
    apiKey: 'k',
    cachePath: null,
    ttlMs: 0,
    fetchImpl: (async () => new Response('rate limited', { status: 429 })) as typeof fetch,
  });
  const result = await service.refresh();
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /429/);
  assert.equal(service.status().count, 0);
});

test('a network throw is caught rather than propagated', async () => {
  const service = createPooledService({
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

test('a fresh index is not re-fetched', async () => {
  let calls = 0;
  const service = createPooledService({
    apiKey: 'k',
    cachePath: null,
    ttlMs: 60_000,
    fetchImpl: (async () => {
      calls += 1;
      return new Response(JSON.stringify(AA_RESPONSE), { status: 200 });
    }) as typeof fetch,
  });
  await service.refresh();
  await service.refresh();
  assert.equal(calls, 1);
});

// --------------------------------------------------------------------- cache

test('the cache round-trips an index', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-pooled-'));
  const path = join(dir, 'pooled.json');
  try {
    const first = createPooledService({
      apiKey: 'k',
      cachePath: path,
      ttlMs: 60_000,
      fetchImpl: (async () => new Response(JSON.stringify(AA_RESPONSE), { status: 200 })) as typeof fetch,
    });
    await first.refresh();
    first.saveCache();

    const second = createPooledService({ apiKey: 'k', cachePath: path, ttlMs: 60_000 });
    assert.equal(second.loadCache(), 2);
    assert.equal(second.opinionsFor([spec('o3-mini')]).size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt or foreign cache is ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-pooled-'));
  const path = join(dir, 'pooled.json');
  try {
    for (const content of ['nope', '{"version":2,"entries":[]}', '{"version":1}', '[]']) {
      writeFileSync(path, content, 'utf8');
      const service = createPooledService({ apiKey: 'k', cachePath: path, ttlMs: 60_000 });
      assert.equal(service.loadCache(), 0, `should ignore: ${content}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a cache that cannot be written is not fatal', () => {
  const service = createPooledService({
    apiKey: 'k',
    cachePath: join(process.cwd(), 'package.json', 'nested', 'pooled.json'),
    ttlMs: 0,
  });
  assert.doesNotThrow(() => service.saveCache());
});
