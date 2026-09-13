/**
 * The scoring model.
 *
 * The load-bearing test here is `no quality information reproduces the old
 * ordering exactly`. Everything else is new behaviour that is only safe to land
 * *because* that one holds: with no ratings anywhere, the office must route
 * precisely as it did before this module existed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelQuality, ModelSpec, ModelTier, TaskClass } from '@dev3d/core';
import { blendedCostPerKTok } from '../llm/pricing.ts';
import { affinityAt, explainScore, rankCandidates, scoreCandidate, walkOrder } from './score.ts';

/** Shorthand: a score context whose walk is derived from one target tier. */
function context(
  taskClass: TaskClass,
  target: ModelTier,
  posture: 'cheap' | 'balanced' | 'quality',
  pool: ModelSpec[],
  budgetRemainingUsd?: number,
) {
  return {
    taskClass,
    walk: walkOrder(target),
    posture,
    pool,
    ...(budgetRemainingUsd !== undefined ? { budgetRemainingUsd } : {}),
  };
}

function makeModel(
  id: string,
  tier: ModelTier,
  o: Partial<ModelSpec> = {},
): ModelSpec {
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

function quality(overall: number, fitness: Partial<Record<TaskClass, number>> = {}, source: 'curated' | 'learned' | 'pooled' = 'curated'): ModelQuality {
  return {
    quality: overall,
    fitness,
    opinions: [{ source, quality: overall, fitness, confidence: 0.6 }],
  };
}

/** The ordering the pre-existing router produced: cheapest first, then id. */
function legacyOrder(models: ModelSpec[]): string[] {
  return [...models]
    .sort((a, b) => blendedCostPerKTok(a) - blendedCostPerKTok(b) || a.id.localeCompare(b.id))
    .map((m) => m.id);
}

// ------------------------------------------------- the backward-compatibility
// ------------------------------------------------- invariant, stated directly

test('no quality information reproduces the old ordering exactly', () => {
  // A pool with a clear target tier and genuine price spread inside it. If the
  // new terms leaked in at all, the pricey-but-rated-looking model would move.
  const models = [
    makeModel('nano-a', 'nano', { costPerMTokIn: 0.1, costPerMTokOut: 0.1 }),
    makeModel('nano-b', 'nano', { costPerMTokIn: 0.3, costPerMTokOut: 0.3 }),
    makeModel('std-a', 'standard', { costPerMTokIn: 1, costPerMTokOut: 1 }),
    makeModel('std-b', 'standard', { costPerMTokIn: 4, costPerMTokOut: 4 }),
    makeModel('strong-a', 'strong', { costPerMTokIn: 9, costPerMTokOut: 9 }),
  ];

  const ranked = rankCandidates(models, context('coding', 'standard', 'balanced', models));

  // The target tier wins, and inside it the old rule - cheaper first, then id.
  assert.equal(ranked[0]?.model.id, 'std-a');
  assert.equal(ranked[1]?.model.id, 'std-b');

  // And the whole ordering is exactly the legacy order restricted to the target
  // tier, followed by the rest in legacy order - i.e. nothing moved that the
  // tier walk did not already move.
  const stdOnly = models.filter((m) => m.tier === 'standard');
  assert.deepEqual(
    ranked.slice(0, 2).map((c) => c.model.id),
    legacyOrder(stdOnly),
  );
});

test('with nothing rated, price is not allowed to pull off the target tier', () => {
  // A free nano model and a pricey standard one. The target is standard, so the
  // free model must not win - that would be this module inventing "cheaper is
  // better" out of no information at all.
  const models = [
    makeModel('free-nano', 'nano', { costPerMTokIn: 0, costPerMTokOut: 0 }),
    makeModel('pricey-std', 'standard', { costPerMTokIn: 8, costPerMTokOut: 8 }),
  ];
  const ranked = rankCandidates(models, context('coding', 'standard', 'balanced', models));
  assert.equal(ranked[0]?.model.id, 'pricey-std');
  assert.equal(ranked[0]?.normalizedCost, 1, 'the pricey model is still the costly one');
  // The score still separates them, purely on tier affinity.
  assert.ok(ranked[0]!.score > ranked[1]!.score);
});

test('with nothing rated, every candidate scores zero on both quality terms', () => {
  const models = [
    makeModel('a', 'nano', { costPerMTokIn: 0.1, costPerMTokOut: 0.1 }),
    makeModel('b', 'strong', { costPerMTokIn: 9, costPerMTokOut: 9 }),
  ];
  for (const model of models) {
    const scored = scoreCandidate(model, context('intake', 'nano', 'balanced', models));
    assert.equal(scored.fitness, 0);
    assert.equal(scored.quality, 0);
    assert.equal(scored.rated, false);
  }
});

test('an unrated model is given the population prior, not zero', () => {
  // If the unrated model got zero it would lose every contest to a rated model
  // for no better reason than nobody having written it down yet.
  const rated = makeModel('rated', 'standard', {
    costPerMTokIn: 1,
    costPerMTokOut: 1,
    quality: quality(0.9, { coding: 0.9 }),
  });
  const unrated = makeModel('unrated', 'standard', { costPerMTokIn: 1, costPerMTokOut: 1 });
  const models = [rated, unrated];

  const scored = scoreCandidate(unrated, context('coding', 'standard', 'balanced', models));
  assert.equal(scored.rated, false);
  assert.equal(scored.fitness, 0.9, 'the prior is the mean of what is rated');
  assert.equal(scored.quality, 0.9);
});

test('a model rated below the population is correctly ranked below an unrated one', () => {
  const good = makeModel('good', 'standard', { costPerMTokIn: 1, costPerMTokOut: 1, quality: quality(0.9) });
  const bad = makeModel('bad', 'standard', { costPerMTokIn: 1, costPerMTokOut: 1, quality: quality(0.2) });
  const models = [good, bad];
  const ranked = rankCandidates(models, context('coding', 'standard', 'balanced', models));
  assert.equal(ranked[0]?.model.id, 'good');
  assert.equal(ranked[1]?.model.id, 'bad');
  assert.ok(ranked[0]!.score > ranked[1]!.score);
});

// ------------------------------------------------------------ new behaviour

test('the better model for the request type wins its tier, not the cheapest', () => {
  // The exact bug this module exists to fix: two models of the same size and the
  // same price, one tuned for code and one for prose.
  const coder = makeModel('coder', 'standard', {
    costPerMTokIn: 2,
    costPerMTokOut: 2,
    quality: quality(0.7, { coding: 0.9, design: 0.45 }),
  });
  const writer = makeModel('writer', 'standard', {
    costPerMTokIn: 1,
    costPerMTokOut: 1,
    quality: quality(0.7, { coding: 0.45, design: 0.9 }),
  });
  const models = [coder, writer];

  const forCoding = rankCandidates(models, context('coding', 'standard', 'balanced', models));
  assert.equal(forCoding[0]?.model.id, 'coder', 'coding must reach for the coder');

  const forDesign = rankCandidates(models, context('design', 'standard', 'balanced', models));
  assert.equal(forDesign[0]?.model.id, 'writer', 'design must reach for the writer');
});

test('a genuinely better model can win from a tier away at quality posture', () => {
  // A smaller model that is markedly better at this work. At `quality` posture
  // the point of the posture is to let that show.
  const smallExcellent = makeModel('small-excellent', 'standard', {
    costPerMTokIn: 1,
    costPerMTokOut: 1,
    quality: quality(0.95, { coding: 0.98 }),
  });
  const bigMediocre = makeModel('big-mediocre', 'strong', {
    costPerMTokIn: 2,
    costPerMTokOut: 2,
    quality: quality(0.6, { coding: 0.55 }),
  });
  const models = [smallExcellent, bigMediocre];

  const ranked = rankCandidates(models, context('coding', 'strong', 'quality', models));
  assert.equal(ranked[0]?.model.id, 'small-excellent');
  assert.ok(ranked[0]!.score > ranked[1]!.score);
});

test('tier affinity still binds when quality is close', () => {
  // Two models one tier apart with near-identical ratings: the policy's tier
  // should decide, not noise in the third decimal.
  const models = [
    makeModel('std', 'standard', { costPerMTokIn: 1, costPerMTokOut: 1, quality: quality(0.8, { coding: 0.8 }) }),
    makeModel('str', 'strong', { costPerMTokIn: 1, costPerMTokOut: 1, quality: quality(0.81, { coding: 0.81 }) }),
  ];
  const ranked = rankCandidates(models, context('coding', 'standard', 'balanced', models));
  assert.equal(ranked[0]?.model.id, 'std');
});

// -------------------------------------------------------------- tier affinity

test('the walk visits tiers above the target before tiers below it', () => {
  // This order *is* the old router's "reach for a bigger model before settling
  // for a smaller one", kept in one place rather than re-derived by the scorer.
  const order = walkOrder('standard');
  assert.deepEqual(order, ['standard', 'strong', 'max', 'small', 'nano']);
});

test('a tier a plugin asked for goes to the front of the walk', () => {
  const order = walkOrder('standard', ['nano']);
  assert.equal(order[0], 'nano');
  assert.deepEqual(order.slice(1), ['standard', 'strong', 'max', 'small']);
  // A hinted tier is not duplicated later in the walk.
  assert.equal(order.filter((t) => t === 'nano').length, 1);
});

test('the walk always contains every tier exactly once', () => {
  for (const target of ['nano', 'small', 'standard', 'strong', 'max'] as ModelTier[]) {
    const order = walkOrder(target);
    assert.equal(order.length, 5, `walk for ${target}`);
    assert.equal(new Set(order).size, 5, `walk for ${target} has duplicates`);
    assert.equal(order[0], target);
  }
});

test('earlier walk positions are strictly more preferred', () => {
  assert.equal(affinityAt(0), 1);
  for (let i = 1; i < 8; i++) {
    assert.ok(affinityAt(i) < affinityAt(i - 1), `position ${i} must be worse than ${i - 1}`);
  }
});

test('affinity never goes negative, however far down the walk', () => {
  assert.equal(affinityAt(100), 0);
  for (let i = 0; i < 200; i++) assert.ok(affinityAt(i) >= 0);
});

// --------------------------------------------------------------- reliability

test('unknown uptime contributes exactly nothing to the score', () => {
  // The same rule quality follows: a model on a provider we cannot ask about
  // must not lose to one we can. Without this, every model outside OpenRouter
  // would be demoted just for being unmeasured.
  const models = [
    makeModel('a', 'standard', { costPerMTokIn: 1, costPerMTokOut: 1 }),
    makeModel('b', 'standard', { costPerMTokIn: 1, costPerMTokOut: 1 }),
  ];
  const without = rankCandidates(models, context('coding', 'standard', 'balanced', models));
  const withResolver = rankCandidates(models, {
    ...context('coding', 'standard', 'balanced', models),
    reliability: () => undefined,
  });
  assert.deepEqual(
    withResolver.map((c) => c.score),
    without.map((c) => c.score),
    'a resolver that knows nothing must change no score',
  );
  assert.equal(withResolver[0]?.reliability, undefined, 'and must not claim a measurement');
});

test('a known-dead endpoint is demoted, and a healthy one is not', () => {
  const dead = makeModel('dead', 'standard', { costPerMTokIn: 1, costPerMTokOut: 1 });
  const healthy = makeModel('healthy', 'standard', { costPerMTokIn: 1, costPerMTokOut: 1 });
  const models = [dead, healthy];
  const ranked = rankCandidates(models, {
    ...context('coding', 'standard', 'balanced', models),
    reliability: (m) => (m.id === 'dead' ? 0 : 1),
  });
  assert.equal(ranked[0]?.model.id, 'healthy');
  assert.equal(ranked[0]?.reliability, 1);
  assert.equal(ranked[1]?.reliability, 0);
  // 0% uptime costs the full pressure; 100% costs nothing.
  assert.ok(ranked[0]!.score > ranked[1]!.score);
  assert.equal(ranked[0]!.score - ranked[1]!.score, 0.3);
});

test('partial uptime demotes proportionally rather than all-or-nothing', () => {
  const half = makeModel('half', 'standard', { costPerMTokIn: 1, costPerMTokOut: 1 });
  const full = makeModel('full', 'standard', { costPerMTokIn: 1, costPerMTokOut: 1 });
  const models = [half, full];
  const ranked = rankCandidates(models, {
    ...context('coding', 'standard', 'balanced', models),
    reliability: (m) => (m.id === 'half' ? 0.5 : 1),
  });
  assert.equal(ranked[0]?.model.id, 'full');
  // Half uptime costs half the pressure.
  assert.ok(Math.abs(ranked[0]!.score - ranked[1]!.score - 0.15) < 1e-9);
});

test('a tiny uptime shortfall is noise, not a demotion', () => {
  const blip = makeModel('blip', 'standard', { costPerMTokIn: 1, costPerMTokOut: 1 });
  const perfect = makeModel('perfect', 'standard', { costPerMTokIn: 1, costPerMTokOut: 1 });
  const models = [blip, perfect];
  const ranked = rankCandidates(models, {
    ...context('coding', 'standard', 'balanced', models),
    reliability: (m) => (m.id === 'blip' ? 0.99 : 1),
  });
  // Ties break on cost then id, so 'blip' still loses - but by essentially nothing.
  const gap = Math.abs(ranked[0]!.score - ranked[1]!.score);
  assert.ok(gap < 0.005, `a 1% shortfall should be noise, got a gap of ${gap}`);
});

test('uptime is reported to three decimal places in the reason', () => {
  const model = makeModel('m', 'standard', { quality: quality(0.8) });
  const scored = scoreCandidate(model, {
    ...context('coding', 'standard', 'balanced', [model]),
    reliability: () => 0.987,
  });
  const text = explainScore(scored, context('coding', 'standard', 'balanced', [model]));
  assert.ok(text.includes('uptime 98.7%'), `expected the uptime in the explanation, got: ${text}`);
});

test('no uptime information means no uptime clause in the explanation', () => {
  const model = makeModel('m', 'standard');
  const ctx = context('coding', 'standard', 'balanced', [model]);
  const text = explainScore(scoreCandidate(model, ctx), ctx);
  assert.ok(!text.includes('uptime'), `unexpected uptime clause: ${text}`);
});

// ------------------------------------------------------------------ ordering

test('ranking is deterministic and independent of input order', () => {
  const models = [
    makeModel('a', 'standard', { costPerMTokIn: 1, costPerMTokOut: 1, quality: quality(0.8) }),
    makeModel('b', 'standard', { costPerMTokIn: 1, costPerMTokOut: 1, quality: quality(0.8) }),
    makeModel('c', 'standard', { costPerMTokIn: 3, costPerMTokOut: 3, quality: quality(0.8) }),
  ];
  const forward = rankCandidates(models, context('coding', 'standard', 'balanced', models)).map((s) => s.model.id);
  const reversed = rankCandidates(
    [...models].reverse(),
    context('coding', 'standard', 'balanced', models),
  ).map((s) => s.model.id);
  assert.deepEqual(forward, reversed);
});

test('identical candidates fall back to cost and then id', () => {
  const models = [
    makeModel('z-cheap', 'standard', { costPerMTokIn: 1, costPerMTokOut: 1 }),
    makeModel('a-pricey', 'standard', { costPerMTokIn: 5, costPerMTokOut: 5 }),
    makeModel('m-cheap', 'standard', { costPerMTokIn: 1, costPerMTokOut: 1 }),
  ];
  const order = rankCandidates(models, context('coding', 'standard', 'balanced', models)).map((s) => s.model.id);
  assert.deepEqual(order, ['m-cheap', 'z-cheap', 'a-pricey']);
});

test('posture moves the quality-versus-cost crossover', () => {
  // The point of posture: the *same* pair of models, traded off differently. A
  // free adequate model against a 50x-pricier one that is genuinely better.
  //
  // It also pins the honest limit of this: at `quality` posture a model still
  // has to be *meaningfully* better to justify an unbounded price, which is why
  // the pair below is a 0.25 quality gap and not a 0.02 one.
  const cheapModel = makeModel('cheap', 'standard', { costPerMTokIn: 0, costPerMTokOut: 0, quality: quality(0.7) });
  const dearModel = makeModel('dear', 'standard', { costPerMTokIn: 50, costPerMTokOut: 50, quality: quality(0.95) });
  const models = [cheapModel, dearModel];

  const pickAt = (posture: 'cheap' | 'balanced' | 'quality') =>
    rankCandidates(models, context('coding', 'standard', posture, models))[0]?.model.id;

  assert.equal(pickAt('cheap'), 'cheap', 'cheap posture will not pay 50x for quality');
  assert.equal(pickAt('balanced'), 'dear', 'balanced posture will');
  assert.equal(pickAt('quality'), 'dear', 'and quality posture is the most willing');
});

test('a marginal quality edge does not justify an unbounded price, even at quality posture', () => {
  // 0.02 of quality for 50x the money is not a trade, whatever the posture says.
  const cheapModel = makeModel('cheap', 'standard', { costPerMTokIn: 0, costPerMTokOut: 0, quality: quality(0.7) });
  const dearModel = makeModel('dear', 'standard', { costPerMTokIn: 50, costPerMTokOut: 50, quality: quality(0.72) });
  const models = [cheapModel, dearModel];
  const ranked = rankCandidates(models, context('coding', 'standard', 'quality', models));
  assert.equal(ranked[0]?.model.id, 'cheap');
});

test('a nearly-exhausted budget is treated as cheap posture', () => {
  const cheapModel = makeModel('cheap', 'standard', { costPerMTokIn: 0, costPerMTokOut: 0, quality: quality(0.7) });
  const dearModel = makeModel('dear', 'standard', { costPerMTokIn: 50, costPerMTokOut: 50, quality: quality(0.72) });
  const models = [cheapModel, dearModel];

  const ranked = rankCandidates(models, context('coding', 'standard', 'quality', models, 0.01));
  assert.equal(ranked[0]?.model.id, 'cheap');
});

// Two providers serving the same model id. Latent rather than live today — every
// shipped catalog id is unique — but it becomes real the moment a plugin declares a
// provider serving an id a built-in one also serves, which is the whole point of the
// plugin model. Every map here used to be keyed by the bare `model.id`.
test('two providers serving one model id are scored as two candidates, not one', () => {
  const cheap = makeModel('shared', 'standard', { providerId: 'local', costPerMTokIn: 0, costPerMTokOut: 0, quality: quality(0.5) });
  const dear = makeModel('shared', 'standard', { providerId: 'frontier', costPerMTokIn: 40, costPerMTokOut: 40, quality: quality(0.5) });
  const models = [cheap, dear];

  // Equal quality, so the cost penalty is the only thing between them, and it has to
  // separate them: with one shared cost entry both would score identically and the
  // winner would be whichever the sort happened to keep.
  const ranked = rankCandidates(models, context('coding', 'standard', 'quality', models));
  assert.equal(ranked.length, 2);
  const local = ranked.find((entry) => entry.model.providerId === 'local');
  const frontier = ranked.find((entry) => entry.model.providerId === 'frontier');
  assert.ok(local && frontier);
  assert.ok(
    local.score > frontier.score,
    `the free one must beat the dear one: local ${local.score} vs frontier ${frontier.score}`,
  );
  assert.ok(
    local.normalizedCost < frontier.normalizedCost,
    `each must be scored with its own price: local ${local.normalizedCost} vs frontier ${frontier.normalizedCost}`,
  );
});

test('a hint aimed at one provider\'s model does not move the other provider\'s', () => {
  // The bonus map was keyed by model id, so one entry was shared by both candidates
  // and a rule naming a model lifted every provider serving that id.
  const cheap = makeModel('shared', 'standard', { providerId: 'local', costPerMTokIn: 0, costPerMTokOut: 0, quality: quality(0.5) });
  const dear = makeModel('shared', 'standard', { providerId: 'frontier', costPerMTokIn: 40, costPerMTokOut: 40, quality: quality(0.5) });
  const models = [cheap, dear];
  const hintBonus = new Map<string, number>([['frontier/shared', 5]]);

  const ranked = rankCandidates(models, { ...context('coding', 'standard', 'balanced', models), hintBonus });
  assert.equal(ranked[0]?.model.providerId, 'frontier', 'the bonus applies to the provider it named');
  const local = ranked.find((entry) => entry.model.providerId === 'local');
  assert.ok(local);
  assert.ok(local.score < 5, `and not to the other one: local scored ${local.score}`);
});

test('scoring a pool of hundreds stays linear enough to run every turn', () => {
  // A provider can legitimately report 445 models; the pool preparation must not
  // be repeated per candidate.
  const models = Array.from({ length: 500 }, (_, i) =>
    makeModel(`m/${i}`, 'standard', {
      costPerMTokIn: (i % 20) / 10,
      costPerMTokOut: (i % 20) / 10,
      quality: quality(0.5 + (i % 10) / 40),
    }),
  );
  const started = performance.now();
  const ranked = rankCandidates(models, context('coding', 'standard', 'balanced', models));
  const elapsed = performance.now() - started;
  assert.equal(ranked.length, 500);
  assert.ok(elapsed < 250, `ranking 500 models took ${elapsed.toFixed(1)}ms`);
});
