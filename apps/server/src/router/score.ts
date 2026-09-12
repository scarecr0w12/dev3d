/**
 * How good is this model for *this* job, and what is that worth against its
 * price?
 *
 * The router used to rank candidates by one thing - where the model's tier sat
 * in a fixed walk - and break ties by blended cost. `ModelSpec.strengths` was
 * declared, populated and displayed but never read, so two nano models, one
 * tuned for intake and one for code, were interchangeable to the router. Size
 * and price were doing all the work.
 *
 * This module turns a model into a score, so a model that is genuinely better at
 * the kind of work in front of it can win even when it is not the cheapest thing
 * in its tier.
 *
 * ## The property that makes this safe to land
 *
 * **With no quality information at all, this scoring reproduces the old
 * behaviour exactly**: the policy's chosen tier wins, and the cheapest model in
 * it is chosen. That is not a coincidence to be hoped for - it falls out of two
 * explicit decisions, and `router/score.test.ts` pins it:
 *
 *   1. The quality terms are computed from a *prior* that is the mean of the
 *      rated population, so when nothing is rated every candidate gets the same
 *      priors and the terms cancel.
 *   2. Cost pressure is switched **off** when nothing is rated. Letting price
 *      pull a turn off the tier the policy asked for is only meaningful when
 *      something is known about what that money buys.
 *
 * The consequence is that a checkout with no keys, no network and no history
 * routes precisely as it did before, and every existing routing test keeps
 * passing for the reason it always passed.
 */

import type { ModelSpec, ModelTier, RoutingPosture, TaskClass } from '@dev3d/core';
import { MODEL_TIER_ORDER, tierRank } from '@dev3d/core';
import { blendedCostPerKTok } from '../llm/pricing.ts';

/** How much each term is worth. They sum to 1 so a score reads as a 0..1 figure. */
export const SCORE_WEIGHTS = {
  /** Fitness for the request's own task class. The headline signal. */
  fitness: 0.45,
  /** Overall capability, which matters even when the class is a perfect match. */
  quality: 0.2,
  /** How close the tier is to the one the policy asked for. */
  tier: 0.35,
} as const;

/**
 * How much money is allowed to move the decision, by posture, 0..1.
 *
 * Zero is not among these on purpose: an operator who has expressed an opinion
 * about quality still wants cost to matter at *some* posture. The zero case is
 * handled separately, and only when no model has a quality opinion at all.
 */
const COST_PRESSURE: Record<RoutingPosture, number> = {
  cheap: 0.3,
  balanced: 0.12,
  quality: 0.03,
};

/**
 * How much an unreliable provider is demoted, at worst.
 *
 * A model whose best upstream endpoint is at 0% uptime loses 0.30 - comparable
 * to a full tier step and a half, which is the right order of magnitude for
 * "this will probably fail". At 99% it loses 0.003, which is noise.
 *
 * It is a **penalty, not an exclusion**, and deliberately so. Uptime is a
 * rolling measurement that can be stale, and hard-excluding a model on a stale
 * reading would remove a perfectly good option from a pinned role with no way
 * back. Demoting it lets the retry-and-fail-over loop handle a genuinely dead
 * provider, which it is already built to do.
 */
const RELIABILITY_PRESSURE = 0.3;

/**
 * How fast preference falls off along the tier walk.
 *
 * The walk itself carries the asymmetry that matters - it visits tiers *above*
 * the target before tiers below it, which is the old router's "reach for a
 * bigger model before settling for a smaller one". This constant only says how
 * much each further step is worth; it does not need to re-encode the direction,
 * because the walk already did.
 */
const AFFINITY_STEP = 0.15;

/**
 * The tiers to consider, in the order they are preferred.
 *
 * This is the pre-existing routing walk, given one home so the router and the
 * scorer cannot disagree about it:
 *
 *   1. tiers a plugin rule asked for, in the order it asked for them;
 *   2. the policy's target tier;
 *   3. every tier **above** the target, weakest first;
 *   4. every tier **below** the target, strongest first.
 *
 * Steps 3 and 4 are why a hint cannot quietly re-price the whole pipeline: a
 * rule scoped to one task class contributes tiers at the front for that class
 * only, and the remaining order is untouched.
 */
export function walkOrder(target: ModelTier, hinted: readonly ModelTier[] = []): ModelTier[] {
  const order: ModelTier[] = [];
  for (const tier of hinted) {
    if (!order.includes(tier)) order.push(tier);
  }
  if (!order.includes(target)) order.push(target);
  const targetRank = tierRank(target);
  for (let r = targetRank + 1; r < MODEL_TIER_ORDER.length; r++) {
    const tier = MODEL_TIER_ORDER[r];
    if (tier !== undefined && !order.includes(tier)) order.push(tier);
  }
  for (let r = targetRank - 1; r >= 0; r--) {
    const tier = MODEL_TIER_ORDER[r];
    if (tier !== undefined && !order.includes(tier)) order.push(tier);
  }
  return order;
}

/**
 * Affinity in (0,1] for a tier's position in the walk.
 *
 * Position 0 is fully preferred. Each further position is worth 15% less, which
 * bounds how far quality can move a decision: a model six places down the walk
 * has given up most of its tier advantage but not all of it, so the policy still
 * means something.
 */
export function affinityAt(position: number): number {
  return Math.max(0, 1 - position * AFFINITY_STEP);
}

/** The quality a model has for a class, or undefined when nothing has an opinion. */
export function fitnessOf(model: ModelSpec, taskClass: TaskClass): number | undefined {
  const fitness = model.quality?.fitness?.[taskClass];
  if (typeof fitness === 'number' && Number.isFinite(fitness)) return fitness;
  // A quality with no per-class entry is still an opinion about the model - just
  // not a claim that the class is special to it.
  const overall = model.quality?.quality;
  return typeof overall === 'number' && Number.isFinite(overall) ? overall : undefined;
}

/** The model's overall quality, or undefined when nothing has an opinion. */
export function qualityOf(model: ModelSpec): number | undefined {
  const quality = model.quality?.quality;
  return typeof quality === 'number' && Number.isFinite(quality) ? quality : undefined;
}

/** Compressed 0..1 cost of each model within one pool, for the cost penalty. */
function normalizedCosts(models: ModelSpec[]): Map<string, number> {
  const out = new Map<string, number>();
  if (models.length === 0) return out;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const logged = models.map((model) => {
    const cost = blendedCostPerKTok(model);
    // log1p compresses the enormous spread between a free local model and a
    // frontier one, so the penalty separates models rather than collapsing
    // everything above the cheapest into one bucket.
    const value = Math.log1p(Math.max(0, cost));
    if (value < min) min = value;
    if (value > max) max = value;
    return { id: model.id, value };
  });

  const span = max - min;
  for (const { id, value } of logged) {
    out.set(id, span > 0 ? (value - min) / span : 0);
  }
  return out;
}

export interface ScoreContext {
  taskClass: TaskClass;
  /**
   * The tiers to prefer, best first - see `walkOrder`. The *position* of a
   * model's tier here is what the tier term scores, not its distance from a
   * single target tier, which is what lets plugin hints and the
   * up-before-down rule keep working unchanged.
   */
  walk: ModelTier[];
  posture: RoutingPosture;
  /** Spend left in the run; a nearly-broke run is treated as `cheap`. */
  budgetRemainingUsd?: number;
  /** Every candidate the score is being computed across. */
  pool: ModelSpec[];
  /**
   * Additive adjustments from plugin routing rules, keyed by model id.
   *
   * The *router* builds this map, because scoping a rule to a tier is plugin
   * semantics and this module should not need to know about them. What arrives
   * here is already confined to one tier per rule, which is what keeps a
   * preference able to reorder its own tier without being able to move a turn to
   * a different one.
   */
  hintBonus?: Map<string, number>;
  /**
   * Observed uptime for a model, 0..1, or undefined when nothing is known.
   *
   * A resolver rather than a map because the source is keyed per model and
   * fetches lazily, and because it must be cheap to ask about models that turn
   * out not to matter.
   */
  reliability?: (model: ModelSpec) => number | undefined;
}

export interface ScoredCandidate {
  model: ModelSpec;
  /** Fitness used, after priors filled in for unrated models. */
  fitness: number;
  /** Overall quality used, after priors. */
  quality: number;
  /** Position of this model's tier in the walk, or -1 when it is not on it. */
  walkPosition: number;
  tierAffinity: number;
  /** 0..1 within the pool; the penalty is this times the pressure. */
  normalizedCost: number;
  /**
   * The uptime the ranking used, 0..1, or undefined when nothing was known.
   * Absent means the reliability term contributed exactly zero.
   */
  reliability?: number;
  score: number;
  /**
   * True when this model's numbers are its own rather than the population
   * prior. The console and the router's reason both say which it was.
   */
  rated: boolean;
}

/**
 * The prior an unrated model is given: the mean of what *is* rated.
 *
 * Deliberately not the tier's baseline. Tier already contributes through
 * `tierAffinity`, so seeding the quality term from tier too would double-count
 * size and let a big dumb model outrank a small good one for no better reason
 * than being big. The population mean is a genuinely neutral fill.
 */
interface Prior {
  quality: number;
  fitness: number;
  /** False when nothing in the pool is rated, which switches cost pressure off. */
  informed: boolean;
}

function priorFor(pool: ModelSpec[], taskClass: TaskClass): Prior {
  let qualitySum = 0;
  let qualityCount = 0;
  let fitnessSum = 0;
  let fitnessCount = 0;

  for (const model of pool) {
    const quality = qualityOf(model);
    if (quality !== undefined) {
      qualitySum += quality;
      qualityCount += 1;
    }
    const fitness = fitnessOf(model, taskClass);
    if (fitness !== undefined) {
      fitnessSum += fitness;
      fitnessCount += 1;
    }
  }

  return {
    quality: qualityCount > 0 ? qualitySum / qualityCount : 0,
    fitness: fitnessCount > 0 ? fitnessSum / fitnessCount : 0,
    informed: qualityCount > 0 || fitnessCount > 0,
  };
}

function costPressureFor(ctx: ScoreContext, informed: boolean): number {
  // The degeneracy rule: with nothing known about quality, price must not be
  // allowed to pull the turn off the tier the policy asked for.
  if (!informed) return 0;
  if ((ctx.budgetRemainingUsd ?? Number.POSITIVE_INFINITY) < 0.05) return COST_PRESSURE.cheap;
  return COST_PRESSURE[ctx.posture];
}

/** Score one model against a pool, preparing the pool's priors once. */
function scoreWith(model: ModelSpec, ctx: ScoreContext, prepared: PreparedPool): ScoredCandidate {
  const ownQuality = qualityOf(model);
  const ownFitness = fitnessOf(model, ctx.taskClass);
  const rated = ownQuality !== undefined || ownFitness !== undefined;

  const fitness = ownFitness ?? prepared.prior.fitness;
  const quality = ownQuality ?? prepared.prior.quality;
  const walkPosition = ctx.walk.indexOf(model.tier);
  // A tier that is not on the walk at all is still scorable - the walk is a
  // preference order, not an allow-list - but it sits behind everything on it.
  const affinity = walkPosition >= 0 ? affinityAt(walkPosition) : 0;
  const normalizedCost = prepared.costs.get(model.id) ?? 0;

  // Uptime demotes, and only when it is actually known. An unknown provider must
  // not be penalised for being unmeasured, or every model outside OpenRouter
  // would lose to every model inside it.
  const reliability = ctx.reliability?.(model);
  const reliabilityPenalty = reliability === undefined ? 0 : RELIABILITY_PRESSURE * (1 - clamp01(reliability));

  const score =
    SCORE_WEIGHTS.fitness * fitness +
    SCORE_WEIGHTS.quality * quality +
    SCORE_WEIGHTS.tier * affinity -
    prepared.pressure * normalizedCost -
    reliabilityPenalty +
    (ctx.hintBonus?.get(model.id) ?? 0);

  return {
    model,
    fitness: round4(fitness),
    quality: round4(quality),
    walkPosition,
    tierAffinity: round4(affinity),
    normalizedCost: round4(normalizedCost),
    ...(reliability !== undefined ? { reliability: round4(clamp01(reliability)) } : {}),
    score: round4(score),
    rated,
  };
}

/**
 * Pool-wide inputs, computed once.
 *
 * They are O(pool) each, and a provider can legitimately report hundreds of
 * models - OpenRouter reports 445 - so recomputing them per candidate would make
 * every routing decision quadratic in the size of the catalog for no benefit.
 */
interface PreparedPool {
  prior: Prior;
  costs: Map<string, number>;
  pressure: number;
}

function prepare(ctx: ScoreContext): PreparedPool {
  const prior = priorFor(ctx.pool, ctx.taskClass);
  return {
    prior,
    costs: normalizedCosts(ctx.pool),
    pressure: costPressureFor(ctx, prior.informed),
  };
}

/** Score one model. See the module comment for why the naive case is exact. */
export function scoreCandidate(model: ModelSpec, ctx: ScoreContext): ScoredCandidate {
  const pool = ctx.pool.length > 0 ? ctx.pool : [model];
  return scoreWith(model, { ...ctx, pool }, prepare({ ...ctx, pool }));
}

/**
 * Rank a pool best-first.
 *
 * The tiebreaks are what carry the backward-compatibility guarantee: when every
 * score is equal, the ordering must come out identical to the old
 * "cheapest first, then by id" rule, so this falls through to blended cost and
 * then to the id exactly as `byCost` always did.
 */
export function rankCandidates(models: ModelSpec[], ctx: ScoreContext): ScoredCandidate[] {
  const pool = ctx.pool.length > 0 ? ctx.pool : models;
  const prepared = prepare({ ...ctx, pool });
  const scored = models.map((model) => scoreWith(model, { ...ctx, pool }, prepared));
  return scored.sort(
    (a, b) =>
      b.score - a.score ||
      blendedCostPerKTok(a.model) - blendedCostPerKTok(b.model) ||
      a.model.id.localeCompare(b.model.id),
  );
}

/** Human-readable summary of the terms that produced a winner. */
export function explainScore(scored: ScoredCandidate, ctx: ScoreContext): string {
  const bits: string[] = [];
  if (scored.rated) {
    bits.push(`fitness ${scored.fitness.toFixed(2)} for ${ctx.taskClass}`);
    bits.push(`quality ${scored.quality.toFixed(2)}`);
  } else {
    bits.push(`unrated, ranked on tier and cost`);
  }
  bits.push(`tier affinity ${scored.tierAffinity.toFixed(2)} at walk position ${scored.walkPosition}`);
  if (scored.normalizedCost > 0) bits.push(`relative cost ${scored.normalizedCost.toFixed(2)}`);
  if (scored.reliability !== undefined) {
    bits.push(`uptime ${(scored.reliability * 100).toFixed(1)}%`);
  }
  bits.push(`score ${scored.score.toFixed(3)}`);
  return bits.join(', ');
}

/**
 * A one-line provenance note for the router's `reason`.
 *
 * Naming the source matters: "0.88 because an operator typed it" and "0.88
 * because a benchmark aggregator said so" should not read the same to whoever is
 * looking at the routing page wondering why a turn cost what it did.
 */
export function provenanceOf(model: ModelSpec): string | null {
  const opinions = model.quality?.opinions ?? [];
  if (opinions.length === 0) return null;
  const rated = opinions.filter((opinion) => opinion.source !== 'curated' || opinion.confidence > 0.5);
  const named = (rated.length > 0 ? rated : opinions).map((opinion) => opinion.source);
  return [...new Set(named)].join('+');
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
