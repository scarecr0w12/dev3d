/**
 * Blending what we know about a model into one score the router can rank on.
 *
 * Three sources feed this, and they are kept as separate *opinions* rather than
 * averaged into one anonymous number, because they fail in different ways and a
 * reader deserves to know which one is speaking:
 *
 *   - **curated** - a hand-written baseline that ships with the office. Always
 *     available, and it cannot know about a model released after the checkout
 *     was cut.
 *   - **learned** - what this office observed from its own turns. The most
 *     honest signal for *this* codebase and *these* prompts, and the one that
 *     starts with no evidence at all.
 *   - **pooled** - a public benchmark aggregator. Broad and genuinely measured,
 *     but it ages, it measured a different workload, and it may be unreachable.
 *
 * Two decisions make the blend safe rather than merely clever:
 *
 *  1. **A prior, not a blank.** Each source states its own confidence, and the
 *     blend is confidence-weighted. A learned estimate built on two turns cannot
 *     shout down a curated baseline, and an authoritative operator correction
 *     outranks both.
 *  2. **Smoothing, not a raw rate.** A learned score is a Beta-style estimate
 *     shrunk towards its prior, so one failed turn does not make a good model
 *     look broken, and one success does not make a bad one look fixed.
 */

import type { ModelQuality, ModelSpec, QualityOpinion, TaskClass, TurnRecord } from '@dev3d/core';
import { ALL_TASK_CLASSES } from './catalog.ts';

/**
 * How many observations it takes to move a learned estimate halfway from its
 * prior.
 *
 * Five is a deliberate middle: high enough that a couple of bad turns cannot
 * condemn a model, low enough that a genuine pattern shows up inside a working
 * day rather than a quarter.
 */
export const DEFAULT_PRIOR_STRENGTH = 5;

/** The floor on an opinion's confidence, so a source is never entirely mute. */
const MIN_CONFIDENCE = 0.02;

/**
 * Blend opinions into one quality, weighted by how much each should be believed.
 *
 * Fitness is blended *per task class*, and a source that expressed no opinion
 * about a class simply does not vote on it - which is not the same as voting for
 * zero. A model whose only rating is a general one keeps that general number in
 * every class rather than collapsing to nothing in the classes nobody named.
 */
export function blendQuality(opinions: readonly QualityOpinion[]): ModelQuality | undefined {
  const usable = opinions.filter(
    (opinion) => Number.isFinite(opinion.quality) && Number.isFinite(opinion.confidence) && opinion.confidence > 0,
  );
  if (usable.length === 0) return undefined;

  const totalWeight = usable.reduce((sum, opinion) => sum + opinion.confidence, 0);
  const quality = usable.reduce((sum, opinion) => sum + opinion.quality * opinion.confidence, 0) / totalWeight;

  const fitness: Partial<Record<TaskClass, number>> = {};
  for (const taskClass of ALL_TASK_CLASSES) {
    let weight = 0;
    let sum = 0;
    for (const opinion of usable) {
      const value = opinion.fitness[taskClass];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      weight += opinion.confidence;
      sum += value * opinion.confidence;
    }
    if (weight > 0) fitness[taskClass] = round3(sum / weight);
  }

  return { quality: round3(clamp01(quality)), fitness, opinions: [...opinions] };
}

/**
 * An operator's own correction, expressed as the loudest opinion there is.
 *
 * Given a confidence above every automatic source on purpose: a human who has
 * actually run the model on their own work outranks a benchmark that measured
 * somebody else's, and an override that could be outvoted would not be an
 * override.
 */
export function operatorOpinion(quality: number, fitness: Partial<Record<TaskClass, number>> = {}): QualityOpinion {
  return {
    source: 'curated',
    quality: clamp01(quality),
    fitness,
    // Above the curated baseline's 0.5-0.7 and every pooled/learned estimate.
    confidence: 1,
    attribution: 'set by the operator in Settings',
  };
}

/**
 * What the office has observed about each model, from its own turns.
 *
 * The signals, and why each is trusted or not:
 *
 *  - A `done` turn with no error is a success for the model that answered.
 *  - A `cancelled` turn is the operator's decision, not evidence about a model,
 *    so it votes on nothing.
 *  - A turn whose `servedBy` differs from its routed model is a **failure for
 *    the routed model** and a success for whatever actually answered. Recording
 *    only the winner would leave a model that fails every single time with no
 *    observations at all - invisible precisely where it should be most visible.
 *
 * Outcome is deliberately coarse. Whether a turn was *good* is not something
 * this can know; whether it completed is.
 */
export function learnedOpinions(
  turns: readonly TurnRecord[],
  opts: { priorStrength?: number } = {},
): Map<string, QualityOpinion> {
  const strength = opts.priorStrength ?? DEFAULT_PRIOR_STRENGTH;

  interface Tally {
    taskClass: TaskClass;
    successes: number;
    total: number;
  }

  /** modelId -> taskClass -> tally */
  const tallies = new Map<string, Map<TaskClass, Tally>>();

  const record = (modelId: string, taskClass: TaskClass, success: boolean): void => {
    if (modelId === '') return;
    const byClass = tallies.get(modelId) ?? new Map<TaskClass, Tally>();
    const tally = byClass.get(taskClass) ?? { taskClass, successes: 0, total: 0 };
    tally.total += 1;
    if (success) tally.successes += 1;
    byClass.set(taskClass, tally);
    tallies.set(modelId, byClass);
  };

  for (const turn of turns) {
    // An operator cancelling says nothing about the model.
    if (turn.status === 'cancelled') continue;
    if (turn.status !== 'done' && turn.status !== 'failed') continue;

    const taskClass = turn.route?.taskClass;
    if (taskClass === undefined) continue;

    const success = turn.status === 'done' && turn.error === null;
    const answered = turn.servedBy?.modelId;
    const routed = turn.route.modelId;

    if (answered !== undefined && answered !== routed && routed !== '') {
      // The routed model was tried first and did not answer.
      record(routed, taskClass, false);
    }
    record(answered ?? routed, taskClass, success);
  }

  const out = new Map<string, QualityOpinion>();
  for (const [modelId, byClass] of tallies) {
    let successes = 0;
    let total = 0;
    const fitness: Partial<Record<TaskClass, number>> = {};
    for (const [taskClass, tally] of byClass) {
      successes += tally.successes;
      total += tally.total;
      // The prior for a class is the model's overall observed rate, so a class
      // with one observation is pulled towards the model's own behaviour rather
      // than towards an arbitrary 0.5.
      const prior = total > 0 ? successes / total : 0.5;
      fitness[taskClass] = round3(smoothed(tally.successes, tally.total, prior, strength));
    }

    const overall = smoothed(successes, total, 0.5, strength);
    out.set(modelId, {
      source: 'learned',
      quality: round3(clamp01(overall)),
      fitness,
      // Grows with evidence and never reaches certainty: this office's sample is
      // never the whole story about a model.
      confidence: round3(clamp01(total / (total + strength))),
      samples: total,
      attribution: `${total} observed turn${total === 1 ? '' : 's'} in this office`,
    });
  }

  return out;
}

/** Beta-style shrinkage towards `prior`. */
function smoothed(successes: number, total: number, prior: number, strength: number): number {
  return (successes + prior * strength) / (total + strength);
}

/**
 * Fold opinions onto a catalog.
 *
 * `resolve` is asked for one model at a time rather than being handed a finished
 * map, and that is deliberate rather than stylistic: the sources behind it are
 * keyed per model, and building a whole-catalog map on the router's hot path
 * would also mean a source could not consult the catalog it is enriching without
 * recursing into itself.
 *
 * Curated metadata on the spec is kept as the base opinion, then anything else
 * is blended over it. A spec with no curated quality and no other opinion keeps
 * `quality: undefined`, which is what lets the router's naive case stay exactly
 * as it was.
 */
export function applyOpinions(
  specs: readonly ModelSpec[],
  resolve: (spec: ModelSpec) => QualityOpinion | readonly QualityOpinion[] | undefined,
): ModelSpec[] {
  return specs.map((spec) => {
    const opinions: QualityOpinion[] = [...(spec.quality?.opinions ?? [])];

    const extra = resolve(spec);
    if (extra !== undefined) {
      // A resolver may return several: an office with an OpenRouter key has a
      // benchmark-derived opinion *and* whatever it learned from its own turns,
      // and blending both is the whole point of keeping sources separate.
      if (Array.isArray(extra)) opinions.push(...extra);
      else opinions.push(extra as QualityOpinion);
    }

    if (opinions.length === 0) return spec;

    // A single unchanged opinion means nothing to recompute, and returning the
    // same object keeps identity stable for the console's memoisation.
    if (opinions.length === 1 && opinions[0] === spec.quality?.opinions?.[0]) return spec;

    const blended = blendQuality(opinions);
    if (blended === undefined) return spec;
    return { ...spec, quality: blended };
  });
}

/**
 * Learned opinions, recomputed at most once per interval.
 *
 * The router asks for the catalog on every turn, and re-deriving every model's
 * record from the turn table each time would put a database read in the middle
 * of routing. Outcomes only change when a turn finishes, so a short window
 * costs nothing real: at worst a just-finished turn is not yet reflected, and
 * the next turn sees it.
 */
export function createLearnedProvider(options: {
  turns: () => TurnRecord[];
  ttlMs: number;
  now?: () => number;
  priorStrength?: number;
}): { opinions(): Map<string, QualityOpinion>; invalidate(): void } {
  const now = options.now ?? (() => Date.now());
  let cached: Map<string, QualityOpinion> | null = null;
  let computedAt = 0;

  function compute(): Map<string, QualityOpinion> {
    const stamp = now();
    if (cached !== null && stamp - computedAt < options.ttlMs) return cached;
    cached = learnedOpinions(options.turns(), {
      ...(options.priorStrength !== undefined ? { priorStrength: options.priorStrength } : {}),
    });
    computedAt = stamp;
    return cached;
  }

  return {
    opinions: compute,
    invalidate() {
      cached = null;
    },
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
