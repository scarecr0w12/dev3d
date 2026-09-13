/**
 * The state frame's model projection.
 *
 * The catalog was 240 kB of a 299 kB `hello` — 80% of the initial payload on every
 * WebSocket connection and every `GET /api/state` — and 87 kB of it was
 * `quality.opinions`, an array the console reduced to a set of source names for a
 * one-line label. These tests pin the trim, the thing it keeps, and the thing it
 * must not touch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { ModelSpec } from '@dev3d/core';
import { projectModel, projectModelsForState, qualitySources } from './stateProjection.ts';

function model(quality?: ModelSpec['quality']): ModelSpec {
  return {
    id: 'vendor/model',
    providerId: 'vendor',
    label: 'Model',
    tier: 'standard',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPerMTokIn: 1,
    costPerMTokOut: 2,
    capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
    strengths: ['coding'],
    origin: 'catalog',
    ...(quality === undefined ? {} : { quality }),
  };
}

const withOpinions: ModelSpec['quality'] = {
  quality: 0.7,
  fitness: { coding: 0.8 },
  opinions: [
    { source: 'curated', confidence: 0.9, quality: 0.6, fitness: { coding: 0.7 } },
    { source: 'learned', confidence: 0.4, quality: 0.8, fitness: { coding: 0.9 } },
    { source: 'curated', confidence: 0.85, quality: 0.65, fitness: { coding: 0.75 }, attribution: 'benchmarks' },
  ],
};

test('the projection drops the opinion list and keeps the label derived from it', () => {
  const projected = projectModel(model(withOpinions));
  assert.equal(projected.quality?.opinions, undefined, 'the 87 kB array is what the frame no longer carries');
  assert.deepEqual(projected.quality?.sources, ['curated', 'learned'], 'deduplicated, in order of first sight');
  // Everything the Routing & cost page renders is untouched.
  assert.equal(projected.quality?.quality, 0.7);
  assert.deepEqual(projected.quality?.fitness, { coding: 0.8 });
  assert.equal(projected.id, 'vendor/model');
  assert.equal(projected.tier, 'standard');
  assert.equal(projected.costPerMTokIn, 1);
  assert.deepEqual(projected.capabilities, { tools: true, vision: false, reasoning: false, streaming: true });
});

test('an unrated model stays unrated rather than becoming a rated-by-nobody one', () => {
  // `quality` absent means "nothing has expressed an opinion", which the console
  // renders as `unrated`. Inventing `sources: []` here would turn that into
  // "rated, by nobody", which is a different claim.
  const plain = projectModel(model());
  assert.equal(plain.quality, undefined);
  assert.deepEqual(plain, model());

  // A quality object whose opinion list is empty projects to an empty source
  // list, which the console's label already renders as `unrated`. The blend never
  // produces this shape — no usable opinion yields no `quality` at all — but the
  // projection must not invent a difference for a shape it can be handed.
  const empty = { quality: 0.5, fitness: {}, opinions: [] };
  assert.deepEqual(projectModel(model(empty)).quality, { quality: 0.5, fitness: {}, sources: [] });
});

test('the projection does not mutate the registry it reads from', () => {
  // The registry keeps the full specs and the router ranks on them, so a
  // projection that edited in place would quietly strip the router's data.
  const original = model(withOpinions);
  const projected = projectModel(original);
  assert.equal(original.quality?.opinions?.length, 3, 'the source object still holds every opinion');
  assert.notEqual(projected, original, 'and the projection is a copy');
  assert.deepEqual(projected.quality?.sources, qualitySources(original));
});

test('the whole catalog is projected in one pass', () => {
  const catalog = [model(withOpinions), model(), model({ quality: 0.4, fitness: {}, opinions: [{ source: 'pooled', confidence: 0.5, quality: 0.4, fitness: {} }] })];
  const projected = projectModelsForState(catalog);
  assert.equal(projected.length, 3);
  assert.deepEqual(projected.map((m) => m.quality?.sources), [['curated', 'learned'], undefined, ['pooled']]);
  assert.equal(projected[1]?.quality, undefined);
});

test('the projection is what actually shrinks the frame', () => {
  // A size assertion rather than a shape assertion, because size is the entire
  // point: the opinion array on a real catalog is ~190 bytes per model.
  const opinions: ModelSpec['quality'] = {
    quality: 0.5,
    fitness: {},
    opinions: Array.from({ length: 10 }, (_, i) => ({
      source: 'pooled' as const,
      confidence: 0.5,
      quality: 0.5,
      fitness: {},
      attribution: `source ${i} with a reasonably long attribution string`,
    })),
  };
  const before = Buffer.byteLength(JSON.stringify(model(opinions)));
  const after = Buffer.byteLength(JSON.stringify(projectModel(model(opinions))));
  assert.ok(after < before / 2, `projection should more than halve it: ${before} → ${after}`);
});
