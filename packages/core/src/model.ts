/**
 * Model routing vocabulary.
 *
 * dev3d prices every kind of work and every model, then matches them. A CEO
 * writing a one-line task summary must not burn a frontier model, and a
 * developer untangling a hard concurrency bug must not be handed a nano model.
 * These types are the shared language between the org chart (which declares
 * what a role needs) and the router (which picks what to actually call).
 */

/** Coarse capability/cost bands. Cheapest first. */
export type ModelTier = 'nano' | 'small' | 'standard' | 'strong' | 'max';

export const MODEL_TIER_ORDER: readonly ModelTier[] = ['nano', 'small', 'standard', 'strong', 'max'];

export function tierRank(tier: ModelTier): number {
  return MODEL_TIER_ORDER.indexOf(tier);
}

/** What kind of thinking a turn needs. Drives model selection. */
export type TaskClass =
  | 'intake' // parse a raw brief into a structured objective
  | 'routing' // meta: decide who should own a piece of work
  | 'summarize' // condense a transcript or thread
  | 'planning' // decompose an objective into workstreams
  | 'research' // gather external/documentary evidence
  | 'debate' // argue a position against another employee
  | 'workshop' // converge a debate into a decision
  | 'design' // visual/product design
  | 'architecture' // technical/system design
  | 'coding' // write or modify code
  | 'review' // critique code or a plan
  | 'testing' // write and run tests
  | 'ops'; // build/deploy/infra

export const TASK_CLASSES: readonly TaskClass[] = [
  'intake',
  'routing',
  'summarize',
  'planning',
  'research',
  'debate',
  'workshop',
  'design',
  'architecture',
  'coding',
  'review',
  'testing',
  'ops',
];

export interface ModelCapabilities {
  /** Can emit tool/function calls. */
  tools: boolean;
  /** Accepts image input. */
  vision: boolean;
  /** Exposes a reasoning/thinking channel. */
  reasoning: boolean;
  /** Supports incremental streaming. */
  streaming: boolean;
}

/**
 * Where a quality number came from.
 *
 * Three sources, deliberately kept distinguishable rather than averaged into
 * one anonymous score, because they fail differently:
 *
 *  - `curated`  a hand-written baseline that ships with the office. Always
 *               available, never wrong about a model's existence, but it cannot
 *               know about a model released after the checkout was cut.
 *  - `learned`  what this office observed from its own turns. The most honest
 *               signal for *this* codebase and *these* prompts, but it starts
 *               with no evidence and must not be trusted at n=1.
 *  - `pooled`   a public benchmark aggregator. Broad coverage and genuine
 *               measurement, but it ages, it is about a different workload, and
 *               it can be missing or unreachable entirely.
 */
export type QualitySource = 'curated' | 'learned' | 'pooled';

/** One source's opinion about one model. */
export interface QualityOpinion {
  source: QualitySource;
  /** Overall capability, 0..1. */
  quality: number;
  /**
   * Per-task-class fitness, 0..1, partial. A class that is absent here means
   * "this source expressed no opinion about it", which is not the same as zero.
   */
  fitness: Partial<Record<TaskClass, number>>;
  /**
   * How much this number should be believed, 0..1. A curated baseline is
   * confident; a learned score starts near zero and grows with observations; a
   * pooled score decays as it ages.
   */
  confidence: number;
  /** How many observations stand behind it, when that is meaningful. */
  samples?: number;
  /** Where it came from, for the console and the router's reasoning. */
  attribution?: string;
  /** When this opinion was formed or last refreshed. */
  at?: number;
}

/** The blended quality the router actually ranks on. */
export interface ModelQuality {
  quality: number;
  fitness: Partial<Record<TaskClass, number>>;
  /** Every opinion that produced the blend, so any number can be explained. */
  opinions: QualityOpinion[];
}

/**
 * Where a catalog entry came from. Membership and metadata are separate
 * questions: a provider's own `/models` list decides *that* a model exists, and
 * a curated table decides what it costs and how good it is.
 */
export type ModelOrigin =
  /** Written down in the shipped metadata table. */
  | 'catalog'
  /** Reported by the provider's own model-list endpoint. */
  | 'discovered'
  /** Contributed by a plugin manifest. */
  | 'plugin';

/** A concrete, callable model. */
export interface ModelSpec {
  id: string;
  /** Which provider adapter must serve it. */
  providerId: string;
  label: string;
  tier: ModelTier;
  contextWindow: number;
  maxOutputTokens: number;
  /** USD per million input tokens. */
  costPerMTokIn: number;
  /** USD per million output tokens. */
  costPerMTokOut: number;
  capabilities: ModelCapabilities;
  /**
   * Task classes this model is especially good at, as a flat list. Kept because
   * it is what plugin manifests write and what the console searches; the router
   * ranks on the richer `quality.fitness` when one is present.
   */
  strengths: TaskClass[];
  /** Optional preferred reasoning effort for adapters that support it. */
  defaultEffort?: 'low' | 'medium' | 'high';
  /** Blended quality, absent when nothing has expressed an opinion. */
  quality?: ModelQuality;
  /** How this entry entered the catalog. */
  origin?: ModelOrigin;
  /**
   * True when a provider serves this model but no metadata table describes it,
   * so its tier and prices are inferred rather than known. The console says so
   * instead of presenting a guess as a fact.
   */
  unrated?: boolean;
}

/**
 * One model as reported by a provider's own model-list endpoint.
 *
 * Deliberately all-optional except the id: a vendor tells us what it chooses to
 * tell us, and a missing field has to mean "unknown" rather than a zero that
 * would win a cheapest-model routing tie.
 */
export interface DiscoveredModel {
  id: string;
  label?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** USD per million input tokens. */
  costPerMTokIn?: number;
  /** USD per million output tokens. */
  costPerMTokOut?: number;
  capabilities?: Partial<ModelCapabilities>;
  /** Vendor creation timestamp, when it reports one. */
  created?: number;
  /** The vendor's own owner/author string, shown in discovery results. */
  ownedBy?: string;
}

/** What one discovery attempt against one provider produced. */
export interface DiscoveryReport {
  providerId: string;
  ok: boolean;
  /** Models the provider reported, or none when the attempt failed. */
  models: DiscoveredModel[];
  /** Why the attempt failed, in the provider's own words where possible. */
  error: string | null;
  /** How long the attempt took, in milliseconds. */
  durationMs: number;
  at: number;
}

/**
 * A role's standing preference about which models it should get.
 * The router starts here and may escalate based on observed complexity.
 */
export interface ModelPolicy {
  defaultTier: ModelTier;
  /** Per-task-class overrides, e.g. a developer is 'standard' but 'strong' at coding. */
  byTaskClass?: Partial<Record<TaskClass, ModelTier>>;
  /** Never select a tier above this, even under pressure. */
  maxTier: ModelTier;
  /** Never select a tier below this. */
  minTier: ModelTier;
  /**
   * Escalate to `escalateTo` when the router's complexity estimate for a turn
   * reaches `escalateAtComplexity` (0..1).
   */
  escalateAtComplexity?: number;
  escalateTo?: ModelTier;
  maxOutputTokens?: number;
  /** When true the router must honour `byTaskClass` exactly and never escalate. */
  pin?: boolean;
  /**
   * Pin this role to one concrete model by id, rather than letting the router
   * choose within a tier.
   *
   * Tiers answer "how much model does this work deserve" without naming a
   * vendor, which is what keeps a policy portable across a changing catalog. But
   * sometimes an operator does know: this role must run on the local model, or on
   * the one model that handles this codebase. A pin is honoured inside the
   * policy's own `minTier`/`maxTier` bounds, so pinning to a model the bounds
   * exclude is reported rather than silently obeyed or silently dropped.
   */
  preferredModelId?: string;
}

export interface RouteRequest {
  taskClass: TaskClass;
  /** Estimated difficulty of this specific turn, 0..1. */
  complexity: number;
  policy: ModelPolicy;
  requiresTools?: boolean;
  requiresVision?: boolean;
  minContextTokens?: number;
  /** Spend left in the current run; the router avoids routing itself broke. */
  budgetRemainingUsd?: number;
  /** Global posture, which can loosen or tighten the policy. */
  posture?: RoutingPosture;
}

/**
 * cheap     - always take the least capable model that satisfies the request
 * balanced  - honour policies, escalate only when complexity demands it
 * quality   - bias every turn one tier up
 */
export type RoutingPosture = 'cheap' | 'balanced' | 'quality';

export interface RouteCandidate {
  providerId: string;
  modelId: string;
  tier: ModelTier;
  /** Blended USD per 1k tokens, used for tie-breaking and reporting. */
  blendedCostPerKTok: number;
  reason: string;
  /**
   * The blended quality the ranking used, when anything had an opinion about
   * this model. Absent means it was ranked on tier and cost alone.
   */
  quality?: number;
  /** The fitness this candidate scored for the request's task class, 0..1. */
  fitness?: number;
  /** The single score the router ordered candidates by, for the routing UI. */
  score?: number;
}

export interface RouteDecision {
  providerId: string;
  modelId: string;
  tier: ModelTier;
  taskClass: TaskClass;
  reason: string;
  /** Human-readable ordered fallbacks the engine may use on provider failure. */
  fallbacks: RouteCandidate[];
  /** Why cheaper/stronger models were rejected - surfaced in the routing UI. */
  considered: RouteCandidate[];
  /**
   * True when the role's `preferredModelId` was honoured. False with a reason in
   * `reason` when a pin could not be used, so a pin that is not in force is
   * visible rather than a silent fallback.
   */
  pinned?: boolean;
  /** The blended quality of the chosen model, when one is known. */
  quality?: number;
  /** The fitness the chosen model scored for this task class, when known. */
  fitness?: number;
  /** The score the chosen model won on. */
  score?: number;
}

/** Token/cost accounting for a single model call. */
export interface UsageRecord {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/** Mirrors the OpenAI chat-completions message shape so adapters stay thin. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on assistant turns that requested tools. */
  toolCalls?: ToolCallRequest[];
  /** Present on tool-result messages. */
  toolCallId?: string;
  name?: string;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  /** Raw JSON string as returned by the model. */
  argumentsJson: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}
