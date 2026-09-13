/**
 * The blended quality layer, tested on the properties that make it safe:
 * confidence actually gates influence, smoothing actually prevents a single
 * observation from dominating, and a cancelled turn votes on nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelSpec, QualityOpinion, RouteDecision, TaskClass, TurnRecord } from '@dev3d/core';
import {
  applyOpinions,
  blendQuality,
  DEFAULT_PRIOR_STRENGTH,
  learnedOpinions,
  operatorOpinion,
} from './quality.ts';

function opinion(
  source: QualityOpinion['source'],
  quality: number,
  confidence: number,
  fitness: Partial<Record<TaskClass, number>> = {},
): QualityOpinion {
  return { source, quality, fitness, confidence };
}

/** A minimal turn record; only the fields the learner reads are meaningful. */
function turn(o: {
  taskClass: TaskClass;
  status?: TurnRecord['status'];
  error?: string | null;
  routed?: string;
  served?: string;
}): TurnRecord {
  const routed = o.routed ?? 'model-a';
  const route = { modelId: routed, taskClass: o.taskClass, providerId: 'p' } as RouteDecision;
  const served = o.served ?? routed;
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    runId: 'r',
    stageId: 's',
    employeeId: 'e',
    roleId: 'role',
    purpose: 'test',
    route,
    servedBy: { providerId: 'p', modelId: served },
    status: o.status ?? 'done',
    startedAt: 0,
    endedAt: 1,
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    text: '',
    reasoning: null,
    toolCalls: [],
    skills: [],
    wroteFiles: [],
    error: o.error ?? null,
  };
}

// --------------------------------------------------------------------- blend

test('confidence decides influence, not the number of opinions', () => {
  // A confident 0.2 must outvote a diffident 1.0.
  const blended = blendQuality([opinion('learned', 1, 0.05), opinion('curated', 0.2, 0.95)]);
  assert.ok(blended);
  assert.ok(blended.quality < 0.3, `expected the confident opinion to win, got ${blended.quality}`);
});

test('an operator correction outvotes every automatic source', () => {
  const blended = blendQuality([
    opinion('pooled', 0.9, 0.9),
    opinion('learned', 0.9, 0.9),
    operatorOpinion(0.2),
  ]);
  assert.ok(blended);
  // Weighted: (0.9*0.9 + 0.9*0.9 + 0.2*1) / 2.8 = 0.65. The operator pulls it
  // down decisively without pretending the measurements do not exist.
  assert.ok(blended.quality < 0.7, `expected the operator to dominate, got ${blended.quality}`);
  assert.ok(blended.quality > 0.2, 'the measurements are still reported, not discarded');
});

test('a source that named no class does not vote on that class', () => {
  const blended = blendQuality([
    opinion('curated', 0.8, 0.5, { coding: 0.9 }),
    opinion('pooled', 0.4, 0.5, { design: 0.3 }),
  ]);
  assert.ok(blended);
  // Each class reflects only the source that had something to say about it.
  assert.equal(blended.fitness.coding, 0.9);
  assert.equal(blended.fitness.design, 0.3);
  // A class nobody named is simply absent - which is not a vote for zero.
  assert.equal(blended.fitness.ops, undefined);
});

test('every opinion is kept so any number can be explained', () => {
  const blended = blendQuality([opinion('curated', 0.7, 0.5), opinion('learned', 0.6, 0.3)]);
  assert.ok(blended);
  // `opinions` is optional on the type only because the *state frame* projects it
  // away; the blend that the router ranks on always carries all of them.
  const opinions = blended.opinions ?? [];
  assert.equal(opinions.length, 2, 'the blend keeps every opinion');
  assert.deepEqual(
    opinions.map((o) => o.source),
    ['curated', 'learned'],
  );
});

test('no usable opinion yields nothing rather than a confident zero', () => {
  assert.equal(blendQuality([]), undefined);
  assert.equal(blendQuality([opinion('learned', 0.5, 0)]), undefined);
  assert.equal(blendQuality([opinion('learned', Number.NaN, 0.5)]), undefined);
});

// ------------------------------------------------------------------- learned

test('a model that always answers accumulates a high learned quality', () => {
  const turns = Array.from({ length: 20 }, () => turn({ taskClass: 'coding' }));
  const learned = learnedOpinions(turns).get('model-a');
  assert.ok(learned);
  assert.equal(learned.samples, 20);
  assert.ok(learned.quality > 0.85, `expected a high estimate, got ${learned.quality}`);
});

test('smoothing stops one bad turn condemning a model', () => {
  const good = learnedOpinions(Array.from({ length: 20 }, () => turn({ taskClass: 'coding' }))).get('model-a');
  const oneBad = learnedOpinions([
    ...Array.from({ length: 19 }, () => turn({ taskClass: 'coding' })),
    turn({ taskClass: 'coding', status: 'failed' }),
  ]).get('model-a');
  assert.ok(good && oneBad);
  // 19/20 is still a good record, and the estimate must say so.
  assert.ok(oneBad.quality > 0.8, `one failure out of twenty must not be damning, got ${oneBad.quality}`);
});

test('smoothing stops one success making an unproven model look proven', () => {
  const learned = learnedOpinions([turn({ taskClass: 'coding' })]).get('model-a');
  assert.ok(learned);
  assert.equal(learned.samples, 1);
  // Shrunk hard towards the 0.5 prior rather than reporting a triumphant 1.0.
  assert.ok(learned.quality < 0.7, `expected heavy shrinkage at n=1, got ${learned.quality}`);
  assert.equal(learned.confidence, Math.round((1 / (1 + DEFAULT_PRIOR_STRENGTH)) * 1000) / 1000);
});

test('a cancelled turn votes on nothing', () => {
  const learned = learnedOpinions([
    turn({ taskClass: 'coding', status: 'cancelled' }),
    turn({ taskClass: 'coding', status: 'cancelled' }),
  ]);
  assert.equal(learned.size, 0, 'an operator cancelling is not evidence about a model');
});

test('a turn served by a fallback is a failure for the routed model', () => {
  // Without this, a model that fails every single time would have no
  // observations at all - invisible exactly where it should be most visible.
  const learned = learnedOpinions([
    turn({ taskClass: 'coding', routed: 'broken', served: 'backup' }),
    turn({ taskClass: 'coding', routed: 'broken', served: 'backup' }),
  ]);
  const broken = learned.get('broken');
  const backup = learned.get('backup');
  assert.ok(broken, 'the routed-but-never-answering model must be recorded');
  assert.equal(broken.samples, 2);
  assert.equal(broken.fitness.coding! < 0.5, true, 'and recorded as a failure');
  assert.ok(backup);
  assert.equal(backup.fitness.coding! > 0.5, true);
});

test('statistics are per model and per task class', () => {
  const learned = learnedOpinions([
    ...Array.from({ length: 10 }, () => turn({ taskClass: 'coding' })),
    ...Array.from({ length: 10 }, () => turn({ taskClass: 'design', status: 'failed' })),
    ...Array.from({ length: 10 }, () => turn({ taskClass: 'coding', routed: 'model-b', served: 'model-b' })),
  ]);
  const a = learned.get('model-a');
  const b = learned.get('model-b');
  assert.ok(a && b);
  assert.ok(a.fitness.coding! > 0.8, 'good at coding');
  assert.ok(a.fitness.design! < 0.3, 'bad at design');
  assert.equal(b.samples, 10, 'model-b only has its own turns');
});

test('a running turn is not counted as an outcome', () => {
  const learned = learnedOpinions([turn({ taskClass: 'coding', status: 'running' })]);
  assert.equal(learned.size, 0);
});

test('a turn carrying an error counts as a failure even when it completed', () => {
  // A model that hit its output limit returned a partial work product.
  const learned = learnedOpinions([
    turn({ taskClass: 'coding', status: 'done', error: 'The model hit its output limit mid-turn.' }),
  ]);
  assert.ok(learned.get('model-a'));
  assert.ok(learned.get('model-a')!.fitness.coding! < 0.5);
});

// -------------------------------------------------------------- application

function spec(id: string, quality?: ModelSpec['quality']): ModelSpec {
  return {
    id,
    providerId: 'p',
    label: id,
    tier: 'standard',
    contextWindow: 1,
    maxOutputTokens: 1,
    costPerMTokIn: 1,
    costPerMTokOut: 1,
    capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
    strengths: [],
    ...(quality !== undefined ? { quality } : {}),
  };
}

/** A resolver from a plain map, for the tests that think in terms of one. */
function fromMap(map: ReadonlyMap<string, QualityOpinion>) {
  return (spec: ModelSpec) => map.get(spec.id);
}

test('a learned opinion blends over the curated baseline', () => {
  const curated = blendQuality([opinion('curated', 0.5, 0.5)]);
  const specs = applyOpinions([spec('m', curated)], fromMap(new Map([['m', opinion('learned', 0.9, 0.5)]])));
  const result = specs[0]?.quality;
  assert.ok(result);
  assert.equal(result.opinions?.length, 2, 'the curated baseline and the learned opinion both survive');
  assert.equal(result.quality, 0.7, 'the midpoint of two equally confident opinions');
});

test('a model with no opinion anywhere keeps quality undefined', () => {
  // This is what keeps the router's naive case exactly as it was.
  const specs = applyOpinions([spec('m')], fromMap(new Map()));
  assert.equal(specs[0]?.quality, undefined);
});

test('a spec with only its curated opinion is returned unchanged', () => {
  // Identity stability matters: the console memoises on these objects.
  const curated = blendQuality([opinion('curated', 0.5, 0.5)]);
  const original = spec('m', curated);
  const specs = applyOpinions([original], fromMap(new Map()));
  assert.equal(specs[0], original);
});

test('the resolver is asked per model, so a source can consult what it enriches', () => {
  // The shape that matters: a source that needs the spec it is rating cannot be
  // handed a finished whole-catalog map without recursing into itself.
  const seen: string[] = [];
  const specs = applyOpinions([spec('a'), spec('b')], (s) => {
    seen.push(s.id);
    return undefined;
  });
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(specs.length, 2);
});

test('an operator override is applied even with no other opinion', () => {
  const specs = applyOpinions([spec('m')], fromMap(new Map([['m', operatorOpinion(0.33, { coding: 0.9 })]])));
  assert.equal(specs[0]?.quality?.quality, 0.33);
  assert.equal(specs[0]?.quality?.fitness.coding, 0.9);
});

test('learned opinions for a model not in the catalog are simply unused', () => {
  const specs = applyOpinions([spec('m')], fromMap(new Map([['absent', opinion('learned', 0.9, 0.9)]])));
  assert.equal(specs[0]?.quality, undefined);
});
