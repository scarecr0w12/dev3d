/**
 * Model selection: turn a role policy + task class + complexity estimate into
 * a concrete model, a human-readable reason, and ordered fallbacks.
 *
 * The router never throws on an empty catalog — it returns an empty decision so
 * the caller can surface a clear error instead of crashing the turn.
 *
 * ## What changed, and what deliberately did not
 *
 * Ranking used to be a tier walk with a cost tiebreak: `ModelSpec.strengths` was
 * populated and displayed but never read, so size and price decided everything.
 * It now ranks on a score (see `score.ts`) built from the model's quality, its
 * fitness for *this* task class, how close its tier is to the one the policy
 * asked for, and its price. A model that is genuinely better at the work can win
 * from a tier away.
 *
 * Three things are deliberately unchanged, because they are contracts other
 * parts of the office rely on:
 *
 *  - **The policy still decides the tier.** Complexity, escalation threshold,
 *    `posture`, budget pressure and the min/max clamp all resolve a target tier
 *    exactly as before, and that target is the front of the walk.
 *  - **A plugin rule still cannot move a turn to another tier.** A rule's tier
 *    joins the front of the walk and its model/provider preferences apply as
 *    score bonuses *confined to that tier*, so it can reorder candidates without
 *    being able to make the router pick something the policy did not allow.
 *  - **With no quality information anywhere, the outcome is identical to the old
 *    one.** This is pinned by test, not asserted in a comment.
 */

import type {
  ModelSpec,
  ModelTier,
  RouteCandidate,
  RouteDecision,
  RouteRequest,
  RoutingHint,
  RoutingPosture,
} from '@dev3d/core';
import { MODEL_TIER_ORDER, applyRoutingHints, hintsForTaskClass, tierRank } from '@dev3d/core';
import { blendedCostPerKTok } from '../llm/pricing.ts';
import {
  explainScore,
  provenanceOf,
  rankCandidates,
  walkOrder,
  type ScoredCandidate,
} from './score.ts';

export interface RouteOptions {
  models: ModelSpec[];
  posture?: RoutingPosture;
  /** Model ids to skip, e.g. providers observed to be down. */
  excludeModelIds?: string[];
  /**
   * Preferences contributed by plugins. They reorder candidates and can pull the
   * target tier, but they never widen what the request allows: a hint cannot
   * make the router pick a model that lacks tools or context.
   */
  hints?: RoutingHint[];
  /**
   * Observed upstream uptime for a model, 0..1, or undefined when unknown.
   * Undefined contributes nothing to the score.
   */
  reliability?: (model: ModelSpec) => number | undefined;
}

/**
 * What a plugin preference is worth, as a score bonus.
 *
 * Sized against `SCORE_WEIGHTS`: a fitness term spans 0.45, so 0.08 is a real
 * pull within a tier without being able to outweigh a tier step (0.35 x 0.15 =
 * 0.0525 for the affinity alone). Since a bonus is only ever applied to models in
 * the rule's own tier, it cannot move the decision across tiers at all.
 */
const HINT_BONUS = {
  /** This exact model. */
  model: 0.08,
  /** A provider the rule named. */
  provider: 0.04,
  /** A model the rule asked to avoid. */
  avoid: -0.12,
} as const;

function tierAt(rank: number): ModelTier {
  const clamped = Math.max(0, Math.min(MODEL_TIER_ORDER.length - 1, rank));
  return MODEL_TIER_ORDER[clamped] ?? 'nano';
}

function oneTierUp(t: ModelTier): ModelTier {
  return tierAt(tierRank(t) + 1);
}

function toCandidate(scored: ScoredCandidate, reason: string): RouteCandidate {
  const out: RouteCandidate = {
    providerId: scored.model.providerId,
    modelId: scored.model.id,
    tier: scored.model.tier,
    blendedCostPerKTok: blendedCostPerKTok(scored.model),
    reason,
    fitness: scored.fitness,
    quality: scored.quality,
    score: scored.score,
  };
  return out;
}

interface FilterFlags {
  needTools: boolean;
  needVision: boolean;
  needContext: boolean;
  excluded: Set<string>;
}

function applyFilters(
  all: ModelSpec[],
  req: RouteRequest,
  flags: FilterFlags,
): ModelSpec[] {
  return all.filter((m) => {
    if (flags.excluded.has(m.id)) return false;
    if (flags.needTools && !m.capabilities.tools) return false;
    if (flags.needVision && !m.capabilities.vision) return false;
    if (flags.needContext && req.minContextTokens !== undefined && m.contextWindow < req.minContextTokens) {
      return false;
    }
    return true;
  });
}

/**
 * Build the per-model score bonuses a task class's plugin rules ask for.
 *
 * A rule's preferences are confined to one tier: the tier it declares, or the
 * policy's target tier when it declares none. That is what keeps the documented
 * promise - a rule reorders the candidates the router already considers, and
 * cannot re-price the pipeline or move a turn to a tier the policy did not ask
 * for.
 */
function hintBonuses(
  hints: RoutingHint[],
  target: ModelTier,
  pool: ModelSpec[],
): Map<string, number> {
  const bonuses = new Map<string, number>();
  if (hints.length === 0) return bonuses;

  const add = (modelId: string, amount: number): void => {
    bonuses.set(modelId, (bonuses.get(modelId) ?? 0) + amount);
  };

  for (const hint of hints) {
    const scopedTier = hint.tier ?? target;
    const inScope = pool.filter((model) => model.tier === scopedTier);
    const preferredProviders = new Set(hint.preferProviderIds);
    const preferredModels = new Set(hint.preferModelIds);
    const avoidedModels = new Set(hint.avoidModelIds);

    for (const model of inScope) {
      if (preferredModels.has(model.id)) add(model.id, HINT_BONUS.model);
      if (preferredProviders.has(model.providerId)) add(model.id, HINT_BONUS.provider);
      if (avoidedModels.has(model.id)) add(model.id, HINT_BONUS.avoid);
    }
  }

  return bonuses;
}

export function routeModel(req: RouteRequest, opts: RouteOptions): RouteDecision {
  const { models } = opts;
  const posture: RoutingPosture = req.posture ?? opts.posture ?? 'balanced';
  const policy = req.policy;

  if (models.length === 0) {
    return {
      providerId: '',
      modelId: '',
      tier: policy.defaultTier,
      taskClass: req.taskClass,
      reason: 'model catalog is empty; no model can be routed.',
      fallbacks: [],
      considered: [],
    };
  }

  // 1. target from policy.
  let target: ModelTier = policy.byTaskClass?.[req.taskClass] ?? policy.defaultTier;
  const origin = target;
  const notes: string[] = [];

  // 2 + 3. posture and escalation (skipped entirely when the policy is pinned).
  if (policy.pin !== true) {
    let effective = posture;
    if ((req.budgetRemainingUsd ?? Number.POSITIVE_INFINITY) < 0.05) {
      effective = 'cheap';
      notes.push('budget nearly exhausted');
    }
    if (effective === 'cheap') {
      target = policy.minTier;
      if (tierRank(target) !== tierRank(origin)) notes.push(`posture 'cheap' lowered to ${target}`);
    } else if (effective === 'quality') {
      target = oneTierUp(origin);
      if (tierRank(target) !== tierRank(origin)) notes.push(`posture 'quality' raised to ${target}`);
    }

    if (
      policy.escalateAtComplexity !== undefined &&
      req.complexity >= policy.escalateAtComplexity &&
      policy.escalateTo !== undefined
    ) {
      target = policy.escalateTo;
      notes.push(`complexity ${req.complexity} >= ${policy.escalateAtComplexity} escalated to ${policy.escalateTo}`);
    }
  }

  // 4. clamp into policy bounds.
  const minRank = tierRank(policy.minTier);
  const maxRank = tierRank(policy.maxTier);
  const clamped = tierAt(Math.min(maxRank, Math.max(minRank, tierRank(target))));
  if (clamped !== target) notes.push(`clamped to ${clamped} (policy bounds ${policy.minTier}..${policy.maxTier})`);
  target = clamped;

  // 5. filter, relaxing capability requirements rather than returning nothing.
  const excluded = new Set(opts.excludeModelIds ?? []);
  let pool = applyFilters(models, req, {
    needTools: req.requiresTools === true,
    needVision: req.requiresVision === true,
    needContext: true,
    excluded,
  });
  let relaxNote: string | null = null;

  if (pool.length === 0) {
    pool = applyFilters(models, req, { needTools: false, needVision: false, needContext: true, excluded });
    relaxNote = 'no model met the capability requirements; dropped tool/vision requirements';
  }
  if (pool.length === 0) {
    pool = applyFilters(models, req, { needTools: false, needVision: false, needContext: false, excluded });
    relaxNote = 'no model met capability or context requirements; dropped both';
  }
  if (pool.length === 0) {
    pool = models.slice();
    relaxNote = 'no model satisfied the request; fell back to the full catalog';
  }

  const hints = hintsForTaskClass(opts.hints ?? [], req.taskClass);

  // 6. Everything the walk and the score need, derived once.
  //
  // A plugin rule that names a tier pulls it to the front of the walk, which is
  // the only way a hint can move the chosen tier. A rule scoped to one task
  // class must not touch any other, or a tweak meant for intake would silently
  // re-price the whole pipeline.
  const hintedTiers = hints
    .filter((hint) => hint.tier !== undefined)
    .map((hint) => hint.tier as ModelTier);
  const walk = walkOrder(target, hintedTiers);
  const scoreCtx = {
    taskClass: req.taskClass,
    walk,
    posture,
    pool,
    hintBonus: hintBonuses(hints, target, pool),
    ...(opts.reliability !== undefined ? { reliability: opts.reliability } : {}),
    ...(req.budgetRemainingUsd !== undefined ? { budgetRemainingUsd: req.budgetRemainingUsd } : {}),
  };

  const ranked = rankCandidates(pool, scoreCtx);
  const byId = new Map(ranked.map((scored) => [scored.model.id, scored]));

  // 7. A role pinned to one concrete model, when the operator has set one.
  //
  // The pin is honoured inside the policy's own bounds rather than above them:
  // `minTier`/`maxTier` are the statement about how much model this role may
  // have, and a pin that contradicts them is a mistake worth reporting, not a
  // silently honoured instruction that makes the bounds a lie.
  let chosen: ScoredCandidate | undefined;
  let pinned = false;
  if (policy.preferredModelId !== undefined && policy.preferredModelId !== '') {
    const wanted = policy.preferredModelId;
    const candidate = byId.get(wanted);
    if (candidate === undefined) {
      const known = models.some((model) => model.id === wanted);
      notes.push(
        known
          ? `pinned model '${wanted}' is excluded or lacks a required capability; chose normally instead`
          : `pinned model '${wanted}' is not in the catalog; chose normally instead`,
      );
    } else if (tierRank(candidate.model.tier) < minRank || tierRank(candidate.model.tier) > maxRank) {
      notes.push(
        `pinned model '${wanted}' is a ${candidate.model.tier} model, outside this policy's ` +
          `${policy.minTier}..${policy.maxTier} bounds; chose normally instead`,
      );
    } else {
      chosen = candidate;
      pinned = true;
    }
  }

  // 8. Otherwise the best score wins.
  if (chosen === undefined) chosen = ranked[0];

  if (chosen === undefined) {
    // Unreachable when the catalog is non-empty, but kept as a hard guard.
    return {
      providerId: '',
      modelId: '',
      tier: target,
      taskClass: req.taskClass,
      reason: 'no model in the catalog satisfied the request.',
      fallbacks: [],
      considered: [],
    };
  }

  const chosenKey = `${chosen.model.providerId}/${chosen.model.id}`;

  // 9. Fallbacks: same tier on another provider first, then one tier up.
  //
  // Ordered by score rather than by price, so the first thing the engine reaches
  // for when a provider dies is the next-best model for this work, not merely
  // the next-cheapest one. Plugin preferences reorder within that, which is what
  // keeps `applyRoutingHints` doing something real.
  const fallbacks: RouteCandidate[] = [];
  const seen = new Set<string>([chosenKey]);
  const sameTier = ranked
    .filter((scored) => scored.model.tier === chosen!.model.tier && scored.model.providerId !== chosen!.model.providerId)
    .map((scored) => toCandidate(scored, 'same-tier fallback'));
  for (const candidate of applyRoutingHints(sameTier, hints)) {
    if (fallbacks.length >= 3) break;
    const key = `${candidate.providerId}/${candidate.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fallbacks.push(candidate);
  }
  if (fallbacks.length < 3 && tierRank(chosen.model.tier) < MODEL_TIER_ORDER.length - 1) {
    const up = ranked.filter((scored) => scored.model.tier === oneTierUp(chosen!.model.tier))[0];
    if (up !== undefined) {
      const key = `${up.model.providerId}/${up.model.id}`;
      if (!seen.has(key)) fallbacks.push(toCandidate(up, 'next tier up fallback'));
    }
  }

  // 10. Everything else, with the honest reason it lost.
  const considered: RouteCandidate[] = ranked
    .filter((scored) => scored.model.id !== chosen!.model.id || scored.model.providerId !== chosen!.model.providerId)
    .map((scored) => toCandidate(scored, rejectReason(scored)));
  considered.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.blendedCostPerKTok - b.blendedCostPerKTok);

  function rejectReason(scored: ScoredCandidate): string {
    const m = scored.model;
    if (excluded.has(m.id)) return 'excluded';
    if (req.requiresTools && !m.capabilities.tools) return 'lacks tool calling';
    if (req.requiresVision && !m.capabilities.vision) return 'lacks vision';
    if (req.minContextTokens !== undefined && m.contextWindow < req.minContextTokens) {
      return 'context window too small';
    }
    if (pinned) return 'a pin is in force for this role';
    if (scored.walkPosition < 0) return 'tier is not on this policy\u2019s walk';
    if (scored.score < chosen!.score) {
      return `scored ${scored.score.toFixed(3)} against the chosen ${chosen!.score.toFixed(3)}`;
    }
    return 'tied on score; more expensive, or later by id';
  }

  const clauses: string[] = [`task '${req.taskClass}' maps to ${target} under this role's policy`];
  for (const n of notes) clauses.push(n);
  if (relaxNote) clauses.push(relaxNote);
  if (pinned) clauses.push(`pinned by this role's model policy`);
  clauses.push(`chose ${chosen.model.label} (${chosen.model.providerId}/${chosen.model.id})`);
  clauses.push(explainScore(chosen, scoreCtx));
  const provenance = provenanceOf(chosen.model);
  if (provenance !== null) clauses.push(`quality from ${provenance}`);

  const decision: RouteDecision = {
    providerId: chosen.model.providerId,
    modelId: chosen.model.id,
    tier: chosen.model.tier,
    taskClass: req.taskClass,
    reason: clauses.join(' — '),
    fallbacks,
    considered,
    pinned,
    quality: chosen.quality,
    fitness: chosen.fitness,
    score: chosen.score,
  };
  return decision;
}
