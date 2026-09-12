/**
 * Model selection: turn a role policy + task class + complexity estimate into
 * a concrete model, a human-readable reason, and ordered fallbacks.
 *
 * The router never throws on an empty catalog — it returns an empty decision so
 * the caller can surface a clear error instead of crashing the turn.
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
}

function tierAt(rank: number): ModelTier {
  const clamped = Math.max(0, Math.min(MODEL_TIER_ORDER.length - 1, rank));
  return MODEL_TIER_ORDER[clamped] ?? 'nano';
}

function oneTierUp(t: ModelTier): ModelTier {
  return tierAt(tierRank(t) + 1);
}

function byCost(a: ModelSpec, b: ModelSpec): number {
  return blendedCostPerKTok(a) - blendedCostPerKTok(b) || a.id.localeCompare(b.id);
}

function toCandidate(m: ModelSpec, reason: string): RouteCandidate {
  return {
    providerId: m.providerId,
    modelId: m.id,
    tier: m.tier,
    blendedCostPerKTok: blendedCostPerKTok(m),
    reason,
  };
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

  // 6. cheapest at exactly target, then step up, then down.
  // A plugin rule that names a tier for this task class pulls it to the front of
  // the walk, which is the only way a hint can move the chosen tier. A rule
  // scoped to one task class must not touch any other, or a tweak meant for
  // intake would silently re-price the whole pipeline.
  const hints = hintsForTaskClass(opts.hints ?? [], req.taskClass);
  const hintedTiers = hints
    .filter((hint) => hint.tier !== undefined)
    .map((hint) => hint.tier as ModelTier);
  const targetRank = tierRank(target);
  const order: ModelTier[] = [];
  for (const tier of hintedTiers) {
    if (!order.includes(tier)) order.push(tier);
  }
  if (!order.includes(target)) order.push(target);
  for (let r = targetRank + 1; r < MODEL_TIER_ORDER.length; r++) {
    const tier = tierAt(r);
    if (!order.includes(tier)) order.push(tier);
  }
  for (let r = targetRank - 1; r >= 0; r--) {
    const tier = tierAt(r);
    if (!order.includes(tier)) order.push(tier);
  }

  /** Order one tier's models so plugin preferences come first, cost breaking ties. */
  const orderTier = (models: ModelSpec[]): ModelSpec[] => {
    const byCostFirst = [...models].sort(byCost);
    if (hints.length === 0) return byCostFirst;
    const byId = new Map(models.map((model) => [model.id, model]));
    const ordered = applyRoutingHints(
      byCostFirst.map((model) => toCandidate(model, '')),
      hints,
    );
    return ordered
      .map((candidate) => byId.get(candidate.modelId))
      .filter((model): model is ModelSpec => model !== undefined);
  };

  let chosen: ModelSpec | undefined;
  for (const tier of order) {
    const first = orderTier(pool.filter((m) => m.tier === tier))[0];
    if (first) {
      chosen = first;
      break;
    }
  }

  if (!chosen) {
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

  // 7. build the decision.
  const chosenKey = `${chosen.providerId}/${chosen.id}`;

  const fallbacks: RouteCandidate[] = [];
  const seen = new Set<string>([chosenKey]);
  const sameTier = pool
    .filter((m) => m.tier === chosen!.tier && m.providerId !== chosen!.providerId)
    .sort(byCost);
  for (const m of sameTier) {
    if (fallbacks.length >= 3) break;
    const key = `${m.providerId}/${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fallbacks.push(toCandidate(m, 'same-tier fallback'));
  }
  if (fallbacks.length < 3 && tierRank(chosen!.tier) < MODEL_TIER_ORDER.length - 1) {
    const up = pool.filter((m) => m.tier === oneTierUp(chosen!.tier)).sort(byCost)[0];
    if (up) {
      const key = `${up.providerId}/${up.id}`;
      if (!seen.has(key)) fallbacks.push(toCandidate(up, 'next tier up fallback'));
    }
  }

  const considered: RouteCandidate[] = [];
  for (const m of models) {
    if (`${m.providerId}/${m.id}` === chosenKey) continue;
    considered.push(toCandidate(m, rejectReason(m)));
  }
  considered.sort((a, b) => a.blendedCostPerKTok - b.blendedCostPerKTok);

  function rejectReason(m: ModelSpec): string {
    if (excluded.has(m.id)) return 'excluded';
    if (req.requiresTools && !m.capabilities.tools) return 'lacks tool calling';
    if (req.requiresVision && !m.capabilities.vision) return 'lacks vision';
    if (req.minContextTokens !== undefined && m.contextWindow < req.minContextTokens) {
      return 'context window too small';
    }
    const r = tierRank(m.tier);
    const cr = tierRank(chosen!.tier);
    if (r < cr) return 'tier too low';
    if (r === cr) return 'more expensive than the chosen model at the same tier';
    return 'above the selected tier';
  }

  const clauses: string[] = [
    `task '${req.taskClass}' maps to ${target} under this role's policy`,
  ];
  for (const n of notes) clauses.push(n);
  if (relaxNote) clauses.push(relaxNote);
  clauses.push(`chose ${chosen.label} (${chosen.providerId}/${chosen.id})`);

  return {
    providerId: chosen.providerId,
    modelId: chosen.id,
    tier: chosen.tier,
    taskClass: req.taskClass,
    reason: clauses.join(' — '),
    fallbacks,
    considered,
  };
}
