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
  /** Task classes this model is especially good at. */
  strengths: TaskClass[];
  /** Optional preferred reasoning effort for adapters that support it. */
  defaultEffort?: 'low' | 'medium' | 'high';
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
