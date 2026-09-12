/**
 * Router behaviour that is new: choosing a concrete model, how a plugin
 * preference is allowed to influence the choice, and whether the `reason` string
 * is honest about where a quality number came from.
 *
 * The pre-existing routing rules are covered in `llm.test.ts` and still pass
 * untouched; this file is only about the parts that did not exist before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ModelPolicy,
  ModelQuality,
  ModelSpec,
  ModelTier,
  RoutingHint,
  TaskClass,
} from '@dev3d/core';
import { routeModel } from './modelRouter.ts';

function makeModel(id: string, tier: ModelTier, o: Partial<ModelSpec> = {}): ModelSpec {
  return {
    id,
    providerId: o.providerId ?? 'p',
    label: o.label ?? id,
    tier,
    contextWindow: o.contextWindow ?? 128_000,
    maxOutputTokens: o.maxOutputTokens ?? 4_096,
    costPerMTokIn: o.costPerMTokIn ?? 1,
    costPerMTokOut: o.costPerMTokOut ?? 1,
    capabilities: o.capabilities ?? { tools: true, vision: false, reasoning: false, streaming: true },
    strengths: o.strengths ?? [],
    ...(o.quality !== undefined ? { quality: o.quality } : {}),
  };
}

function quality(
  overall: number,
  fitness: Partial<Record<TaskClass, number>> = {},
  source: 'curated' | 'learned' | 'pooled' = 'curated',
  confidence = 0.6,
): ModelQuality {
  return {
    quality: overall,
    fitness,
    opinions: [{ source, quality: overall, fitness, confidence, attribution: `${source} fixture` }],
  };
}

function makePolicy(o: Partial<ModelPolicy> = {}): ModelPolicy {
  return {
    defaultTier: o.defaultTier ?? 'standard',
    maxTier: o.maxTier ?? 'max',
    minTier: o.minTier ?? 'nano',
    byTaskClass: o.byTaskClass,
    escalateAtComplexity: o.escalateAtComplexity,
    escalateTo: o.escalateTo,
    maxOutputTokens: o.maxOutputTokens,
    pin: o.pin,
    preferredModelId: o.preferredModelId,
  };
}

function hint(o: Partial<RoutingHint> = {}): RoutingHint {
  return {
    pluginId: 'test.plugin',
    ruleId: 'rule',
    taskClass: o.taskClass,
    tier: o.tier,
    preferProviderIds: o.preferProviderIds ?? [],
    preferModelIds: o.preferModelIds ?? [],
    avoidModelIds: o.avoidModelIds ?? [],
  };
}

// ------------------------------------------------------------------ pinning

test('a role pinned to a concrete model gets that model', () => {
  const best = makeModel('best', 'standard', { quality: quality(0.95, { coding: 0.95 }) });
  const wanted = makeModel('wanted', 'standard', { quality: quality(0.5, { coding: 0.5 }) });
  const d = routeModel(
    { taskClass: 'coding', complexity: 0.5, policy: makePolicy({ preferredModelId: 'wanted' }) },
    { models: [best, wanted] },
  );
  assert.equal(d.modelId, 'wanted', 'a pin outranks the score');
  assert.equal(d.pinned, true);
  assert.ok(d.reason.includes('pinned'), 'the reason must say a pin decided it');
});

test('a pin outside the policy bounds is refused, with the reason stated', () => {
  // The bounds are the statement about how much model this role may have. A pin
  // that contradicts them is a mistake worth reporting, not one worth obeying.
  const nano = makeModel('nano-model', 'nano');
  const standard = makeModel('std-model', 'standard');
  const d = routeModel(
    { taskClass: 'coding', complexity: 0.5, policy: makePolicy({ minTier: 'standard', preferredModelId: 'nano-model' }) },
    { models: [nano, standard] },
  );
  assert.equal(d.pinned, false);
  assert.equal(d.modelId, 'std-model', 'the normal selection stands');
  assert.ok(d.reason.includes('nano-model'), 'the reason names the pin that was refused');
  assert.ok(d.reason.includes('outside'), `expected an out-of-bounds explanation, got: ${d.reason}`);
});

test('a pin to a model the catalog does not have is reported, not silently dropped', () => {
  const standard = makeModel('std-model', 'standard');
  const d = routeModel(
    { taskClass: 'coding', complexity: 0.5, policy: makePolicy({ preferredModelId: 'ghost/does-not-exist' }) },
    { models: [standard] },
  );
  assert.equal(d.pinned, false);
  assert.equal(d.modelId, 'std-model');
  assert.ok(d.reason.includes('not in the catalog'), `expected a missing-model note, got: ${d.reason}`);
});

test('a pin to a model lacking a required capability is reported', () => {
  const noTools = makeModel('no-tools', 'standard', {
    capabilities: { tools: false, vision: false, reasoning: false, streaming: false },
  });
  const withTools = makeModel('with-tools', 'standard');
  const d = routeModel(
    {
      taskClass: 'coding',
      complexity: 0.5,
      requiresTools: true,
      policy: makePolicy({ preferredModelId: 'no-tools' }),
    },
    { models: [noTools, withTools] },
  );
  assert.equal(d.pinned, false);
  assert.equal(d.modelId, 'with-tools');
  assert.ok(d.reason.includes('no-tools'), `expected the pin named, got: ${d.reason}`);
});

test('a pin to an excluded model is reported', () => {
  const a = makeModel('a', 'standard');
  const b = makeModel('b', 'standard');
  const d = routeModel(
    { taskClass: 'coding', complexity: 0.5, policy: makePolicy({ preferredModelId: 'a' }) },
    { models: [a, b], excludeModelIds: ['a'] },
  );
  assert.equal(d.pinned, false);
  assert.equal(d.modelId, 'b');
  assert.ok(d.reason.includes("pinned model 'a'"), `expected the pin named, got: ${d.reason}`);
});

test('no pin means no pin note in the reason', () => {
  const a = makeModel('a', 'standard');
  const d = routeModel({ taskClass: 'coding', complexity: 0.5, policy: makePolicy() }, { models: [a] });
  assert.equal(d.pinned, false);
  assert.ok(!d.reason.includes('pinned'), `unexpected pin note: ${d.reason}`);
});

test('a pin is not applied when the policy is pinned to a tier', () => {
  // `pin: true` means "honour byTaskClass exactly". A preferredModelId still
  // wins there - the two are independent, and the concrete model is the more
  // specific instruction.
  const wanted = makeModel('wanted', 'standard');
  const other = makeModel('other', 'standard');
  const d = routeModel(
    {
      taskClass: 'coding',
      complexity: 0.9,
      policy: makePolicy({
        pin: true,
        defaultTier: 'standard',
        minTier: 'standard',
        maxTier: 'standard',
        byTaskClass: { coding: 'standard' },
        preferredModelId: 'wanted',
        escalateAtComplexity: 0.5,
        escalateTo: 'max',
      }),
    },
    { models: [wanted, other] },
  );
  assert.equal(d.modelId, 'wanted');
  assert.equal(d.pinned, true);
  assert.ok(!d.reason.includes('escalated'), 'pin:true must suppress escalation');
});

// ------------------------------------------------------------ plugin hints

test('a preference reorders candidates within its tier', () => {
  const cheap = makeModel('cheap', 'standard', { providerId: 'a', costPerMTokIn: 1, costPerMTokOut: 1 });
  const preferred = makeModel('preferred', 'standard', { providerId: 'b', costPerMTokIn: 9, costPerMTokOut: 9 });
  const d = routeModel(
    { taskClass: 'coding', complexity: 0.5, policy: makePolicy() },
    { models: [cheap, preferred], hints: [hint({ tier: 'standard', preferProviderIds: ['b'] })] },
  );
  assert.equal(d.modelId, 'preferred');
});

test('a preference cannot move a turn to a different tier', () => {
  // The documented promise: a rule reorders the candidates the router already
  // considers. A provider preference with no `tier` of its own is scoped to the
  // policy's target tier, so a nano model the rule loves cannot beat the
  // standard tier the policy chose.
  const nanoPreferred = makeModel('nano-preferred', 'nano', { providerId: 'local' });
  const stdPlain = makeModel('std-plain', 'standard', { providerId: 'x' });
  const d = routeModel(
    { taskClass: 'coding', complexity: 0.5, policy: makePolicy({ defaultTier: 'standard' }) },
    { models: [nanoPreferred, stdPlain], hints: [hint({ preferProviderIds: ['local'] })] },
  );
  assert.equal(d.modelId, 'std-plain', 'the tier the policy chose must hold');
});

test('a rule that *names* a tier still moves the walk, as it always has', () => {
  // This is the pre-existing hint mechanism, preserved deliberately: naming a
  // tier is how a plugin asks for cheaper work on one task class, and it is the
  // only way a rule is allowed to change which tier is preferred.
  const localNano = makeModel('local-nano', 'nano', { providerId: 'local' });
  const stdPlain = makeModel('std-plain', 'standard', { providerId: 'x' });
  const d = routeModel(
    { taskClass: 'intake', complexity: 0.2, policy: makePolicy({ defaultTier: 'standard' }) },
    { models: [localNano, stdPlain], hints: [hint({ taskClass: 'intake', tier: 'nano', preferProviderIds: ['local'] })] },
  );
  assert.equal(d.modelId, 'local-nano');
  assert.ok(d.reason.includes('nano'), `expected the walk to be explained, got: ${d.reason}`);
});

test('an avoidance demotes within its tier without crossing tiers', () => {
  const avoided = makeModel('avoided', 'standard', { providerId: 'a', costPerMTokIn: 1, costPerMTokOut: 1 });
  const other = makeModel('other', 'standard', { providerId: 'b', costPerMTokIn: 9, costPerMTokOut: 9 });
  const d = routeModel(
    { taskClass: 'coding', complexity: 0.5, policy: makePolicy() },
    { models: [avoided, other], hints: [hint({ tier: 'standard', avoidModelIds: ['avoided'] })] },
  );
  assert.equal(d.modelId, 'other');
});

test('a task-class-scoped rule leaves other classes alone', () => {
  const localNano = makeModel('local-nano', 'nano', { providerId: 'local' });
  const stdA = makeModel('std-a', 'standard', { providerId: 'a' });
  const models = [localNano, stdA];
  const rules = [hint({ taskClass: 'intake', tier: 'nano', preferProviderIds: ['local'] })];

  const intake = routeModel(
    { taskClass: 'intake', complexity: 0.2, policy: makePolicy({ defaultTier: 'standard' }) },
    { models, hints: rules },
  );
  assert.equal(intake.modelId, 'local-nano', 'intake follows its own rule');

  const coding = routeModel(
    { taskClass: 'coding', complexity: 0.2, policy: makePolicy({ defaultTier: 'standard' }) },
    { models, hints: rules },
  );
  assert.equal(coding.modelId, 'std-a', 'coding must be untouched by an intake rule');
});

test('a rule with no tier applies to the policy target tier', () => {
  const wanted = makeModel('wanted', 'standard', { providerId: 'b', costPerMTokIn: 9, costPerMTokOut: 9 });
  const cheap = makeModel('cheap', 'standard', { providerId: 'a', costPerMTokIn: 1, costPerMTokOut: 1 });
  const d = routeModel(
    { taskClass: 'coding', complexity: 0.5, policy: makePolicy({ defaultTier: 'standard' }) },
    { models: [cheap, wanted], hints: [hint({ preferModelIds: ['wanted'] })] },
  );
  assert.equal(d.modelId, 'wanted');
});

// --------------------------------------------------------- reason and detail

test('the reason names where the quality numbers came from', () => {
  const pooled = makeModel('pooled-model', 'standard', {
    quality: quality(0.8, { coding: 0.8 }, 'pooled'),
  });
  const d = routeModel(
    { taskClass: 'coding', complexity: 0.5, policy: makePolicy() },
    { models: [pooled] },
  );
  assert.ok(d.reason.includes('pooled'), `expected provenance in the reason, got: ${d.reason}`);
});

test('a learned rating is named as learned, not as curated', () => {
  const learned = makeModel('learned-model', 'standard', {
    quality: quality(0.8, { coding: 0.8 }, 'learned'),
  });
  const d = routeModel(
    { taskClass: 'coding', complexity: 0.5, policy: makePolicy() },
    { models: [learned] },
  );
  assert.ok(d.reason.includes('learned'), `expected 'learned' in the reason, got: ${d.reason}`);
  assert.ok(!d.reason.includes('curated+learned'), 'a single source must not be reported as a blend');
});

test('the decision carries the score it won on', () => {
  const model = makeModel('m', 'standard', { quality: quality(0.8, { coding: 0.77 }) });
  const d = routeModel({ taskClass: 'coding', complexity: 0.5, policy: makePolicy() }, { models: [model] });
  assert.equal(d.fitness, 0.77);
  assert.equal(d.quality, 0.8);
  assert.equal(typeof d.score, 'number');
  assert.ok(d.score! > 0);
});

test('considered candidates carry their own scores so the routing page can explain', () => {
  const good = makeModel('good', 'standard', { quality: quality(0.9, { coding: 0.9 }) });
  const bad = makeModel('bad', 'standard', { quality: quality(0.3, { coding: 0.3 }) });
  const d = routeModel({ taskClass: 'coding', complexity: 0.5, policy: makePolicy() }, { models: [good, bad] });
  assert.equal(d.modelId, 'good');
  const rejected = d.considered.find((c) => c.modelId === 'bad');
  assert.ok(rejected, 'the loser must appear in considered');
  assert.equal(typeof rejected.score, 'number');
  assert.equal(rejected.fitness, 0.3, 'with the fitness it actually scored');
  assert.ok(rejected.reason.length > 0);
});

test('with no quality information the reason says so rather than implying a measurement', () => {
  const a = makeModel('a', 'standard');
  const d = routeModel({ taskClass: 'coding', complexity: 0.5, policy: makePolicy() }, { models: [a] });
  assert.ok(d.reason.includes('unrated'), `expected an honest unrated note, got: ${d.reason}`);
});

test('the reason always explains itself', () => {
  const models = [
    makeModel('a', 'nano'),
    makeModel('b', 'standard', { quality: quality(0.7, { coding: 0.8 }) }),
  ];
  for (const taskClass of ['intake', 'coding', 'design'] as TaskClass[]) {
    const d = routeModel({ taskClass, complexity: 0.4, policy: makePolicy() }, { models });
    assert.ok(d.reason.length > 0, `no reason for ${taskClass}`);
    assert.ok(d.reason.includes(taskClass), `reason should name the task class: ${d.reason}`);
  }
});

// ------------------------------------------------------------------- fallbacks

test('fallbacks are ordered by fitness, not merely by price', () => {
  const chosen = makeModel('chosen', 'standard', { providerId: 'a', quality: quality(0.9, { coding: 0.95 }) });
  const betterFallback = makeModel('better-fallback', 'standard', {
    providerId: 'b',
    costPerMTokIn: 9,
    costPerMTokOut: 9,
    quality: quality(0.85, { coding: 0.85 }),
  });
  const cheaperWorse = makeModel('cheaper-worse', 'standard', {
    providerId: 'c',
    costPerMTokIn: 1,
    costPerMTokOut: 1,
    quality: quality(0.2, { coding: 0.2 }),
  });
  const d = routeModel(
    { taskClass: 'coding', complexity: 0.5, policy: makePolicy() },
    { models: [chosen, betterFallback, cheaperWorse] },
  );
  assert.equal(d.modelId, 'chosen');
  assert.equal(d.fallbacks[0]?.modelId, 'better-fallback', 'the next-best model, not the next-cheapest');
});

test('fallbacks still never include the chosen model', () => {
  const models = [
    makeModel('a', 'standard', { providerId: 'a' }),
    makeModel('b', 'standard', { providerId: 'b' }),
    makeModel('c', 'standard', { providerId: 'c' }),
    makeModel('d', 'standard', { providerId: 'd' }),
  ];
  const d = routeModel({ taskClass: 'coding', complexity: 0.5, policy: makePolicy() }, { models });
  for (const f of d.fallbacks) {
    assert.notEqual(`${f.providerId}/${f.modelId}`, `${d.providerId}/${d.modelId}`);
  }
  assert.ok(d.fallbacks.length <= 4, `expected a bounded fallback list, got ${d.fallbacks.length}`);
});
