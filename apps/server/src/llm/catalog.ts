/**
 * The curated metadata table.
 *
 * This used to be *the* catalog: a static array that both decided which models
 * exist and what they cost. That conflated two questions with different answers:
 *
 *   - **Which models exist?** Only the provider knows. It changes without a
 *     commit, and a static list is wrong the moment a vendor ships or retires a
 *     model. A live office was routing to `deepseek-v4-flash-vision-exp`, which
 *     the DeepSeek endpoint does not serve and never did.
 *   - **What do they cost and how good are they?** No `/models` endpoint answers
 *     this. Prices and capability have to be curated, measured, or pooled.
 *
 * So membership now comes from discovery (`discovery.ts`) and *metadata* comes
 * from here. This table is a keyed overlay, not a roster: a model the provider
 * serves but the table has never heard of is still routable, with its tier and
 * prices inferred from the vendor's own numbers and a `unrated` flag that says
 * so rather than presenting a guess as a fact.
 *
 * The full table is also the **offline seed**. With no keys, or against a
 * provider we cannot reach, `seedCatalog()` reproduces exactly the catalog this
 * file used to be, which is what keeps "no API keys are required" true.
 *
 * PRICES ARE ESTIMATES FOR ROUTING DECISIONS AND COST DISPLAY, NOT BILLING
 * TRUTH. They only need to be ordered plausibly. Where a provider publishes real
 * prices - OpenRouter does, with no key - the pooled layer overwrites them.
 */

import type {
  DiscoveredModel,
  ModelCapabilities,
  ModelQuality,
  ModelSpec,
  ModelTier,
  TaskClass,
} from '@dev3d/core';

const TOOLS: ModelCapabilities = { tools: true, vision: false, reasoning: false, streaming: true };
const TOOLS_VISION: ModelCapabilities = { tools: true, vision: true, reasoning: false, streaming: true };
const TOOLS_REASONING: ModelCapabilities = { tools: true, vision: false, reasoning: true, streaming: true };

/**
 * A curated entry: the seed's shape plus optional quality.
 *
 * `fitness` is deliberately *partial and optional*. Where a model's character is
 * genuinely known - a coder-tuned model is worse at open-ended design than its
 * raw capability suggests - it is written down. Where it is not, `curatedQuality`
 * derives fitness from the model's tier and its `strengths`, which is honest
 * about being a derivation rather than a measurement.
 */
interface CuratedEntry {
  providerId: string;
  id: string;
  label: string;
  tier: ModelTier;
  contextWindow: number;
  maxOutputTokens: number;
  costPerMTokIn: number;
  costPerMTokOut: number;
  capabilities: ModelCapabilities;
  strengths: TaskClass[];
  defaultEffort?: 'low' | 'medium' | 'high';
  /** An operator-quality overall score; defaults to the tier's baseline. */
  quality?: number;
  /** Explicit per-class fitness, overriding the derived value. */
  fitness?: Partial<Record<TaskClass, number>>;
}

export const CURATED_MODELS: CuratedEntry[] = [
  // ---------------------------------------------------------------- DeepSeek
  {
    providerId: 'deepseek',
    id: 'deepseek-flash',
    label: 'DeepSeek Flash',
    tier: 'nano',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPerMTokIn: 0.14,
    costPerMTokOut: 0.28,
    capabilities: TOOLS,
    strengths: ['intake', 'routing', 'summarize'],
  },
  {
    providerId: 'deepseek',
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    tier: 'strong',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPerMTokIn: 0.55,
    costPerMTokOut: 2.19,
    capabilities: TOOLS_REASONING,
    strengths: ['coding', 'architecture', 'debate', 'review', 'testing', 'planning'],
    defaultEffort: 'medium',
    // A reasoning-first model. Excellent at work with a right answer; noticeably
    // less good than a generalist of the same capability at open-ended design.
    fitness: { coding: 0.88, testing: 0.86, architecture: 0.85, review: 0.84, design: 0.6, research: 0.68 },
  },
  {
    providerId: 'deepseek',
    id: 'deepseek-v4-flash-vision-exp',
    label: 'DeepSeek V4 Flash Vision (exp)',
    tier: 'standard',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPerMTokIn: 0.28,
    costPerMTokOut: 0.42,
    capabilities: TOOLS_VISION,
    strengths: ['design', 'research', 'summarize'],
  },

  // ------------------------------------------------------------------- OpenAI
  {
    providerId: 'openai',
    id: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    tier: 'small',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMTokIn: 0.15,
    costPerMTokOut: 0.6,
    capabilities: TOOLS_VISION,
    strengths: ['intake', 'routing', 'summarize', 'research'],
  },
  {
    providerId: 'openai',
    id: 'o3-mini',
    label: 'o3-mini',
    tier: 'strong',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    costPerMTokIn: 1.1,
    costPerMTokOut: 4.4,
    capabilities: TOOLS_REASONING,
    strengths: ['coding', 'architecture', 'review', 'testing'],
    defaultEffort: 'high',
    fitness: { coding: 0.86, testing: 0.84, architecture: 0.82, design: 0.52, debate: 0.58 },
  },
  {
    providerId: 'openai',
    id: 'gpt-4o',
    label: 'GPT-4o',
    tier: 'strong',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMTokIn: 2.5,
    costPerMTokOut: 10,
    capabilities: TOOLS_VISION,
    strengths: ['coding', 'architecture', 'design', 'review', 'debate'],
    // The generalist counterpoint to o3-mini: better at design, debate and
    // research, slightly behind on pure reasoning-heavy coding.
    fitness: { design: 0.86, debate: 0.85, research: 0.84, coding: 0.78, testing: 0.74 },
  },

  // --------------------------------------------------------------- Anthropic
  {
    providerId: 'anthropic',
    id: 'claude-3-5-haiku-latest',
    label: 'Claude 3.5 Haiku',
    tier: 'small',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    costPerMTokIn: 0.8,
    costPerMTokOut: 4,
    capabilities: TOOLS_VISION,
    strengths: ['intake', 'routing', 'summarize', 'testing'],
  },
  {
    providerId: 'anthropic',
    id: 'claude-3-5-sonnet-latest',
    label: 'Claude 3.5 Sonnet',
    tier: 'strong',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    costPerMTokIn: 3,
    costPerMTokOut: 15,
    capabilities: TOOLS_VISION,
    strengths: ['coding', 'architecture', 'design', 'debate', 'review'],
    fitness: { coding: 0.88, review: 0.86, design: 0.84, debate: 0.84, architecture: 0.85 },
  },

  // -------------------------------------------------------------- OpenRouter
  {
    providerId: 'openrouter',
    id: 'openrouter/deepseek/deepseek-chat',
    label: 'DeepSeek Chat (OpenRouter)',
    tier: 'small',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPerMTokIn: 0.14,
    costPerMTokOut: 0.28,
    capabilities: TOOLS,
    strengths: ['intake', 'routing', 'summarize'],
  },
  {
    providerId: 'openrouter',
    id: 'openrouter/qwen/qwen2.5-coder-32b-instruct',
    label: 'Qwen 2.5 Coder 32B (OpenRouter)',
    tier: 'standard',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    costPerMTokIn: 0.18,
    costPerMTokOut: 0.18,
    capabilities: TOOLS,
    strengths: ['coding', 'review', 'testing'],
    // The clearest case for explicit fitness: coder-tuned models are very good
    // at code and markedly weaker at open-ended argument and product design, in
    // a way that its tier alone cannot express.
    fitness: { coding: 0.82, testing: 0.8, review: 0.76, design: 0.4, debate: 0.42, research: 0.44 },
  },
  {
    providerId: 'openrouter',
    id: 'openrouter/meta-llama/llama-3.3-70b-instruct',
    label: 'Llama 3.3 70B (OpenRouter)',
    tier: 'strong',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    costPerMTokIn: 0.23,
    costPerMTokOut: 0.4,
    capabilities: TOOLS,
    strengths: ['coding', 'planning', 'research', 'debate'],
  },

  // ------------------------------------------------------------------- Local
  {
    providerId: 'local',
    id: 'local/default',
    label: 'Local model (OpenAI-compatible)',
    tier: 'small',
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    capabilities: TOOLS,
    strengths: ['intake', 'routing', 'summarize'],
    // Free to run, so cost-aware routing will reach for it constantly. Its
    // capability is genuinely unknown - it depends entirely on what the operator
    // loaded - so its quality is left deliberately modest and the learned layer
    // is what will correct it.
    quality: 0.4,
  },
];

/** The tier's baseline quality, used when a curated entry states none. */
const TIER_QUALITY: Record<ModelTier, number> = {
  nano: 0.25,
  small: 0.45,
  standard: 0.62,
  strong: 0.82,
  max: 0.95,
};

export function tierBaselineQuality(tier: ModelTier): number {
  return TIER_QUALITY[tier];
}

/** How much a declared strength lifts fitness above the model's base quality. */
const STRENGTH_BONUS = 0.15;
/** How much a declared *specialisation elsewhere* pulls fitness down. */
const MISMATCH_PENALTY = 0.08;

/**
 * Derive a curated opinion from an entry.
 *
 * Fitness starts at the model's quality and is nudged by `strengths`: a declared
 * strength lifts a class, and a model that declares strengths elsewhere but not
 * here is pulled down slightly. That asymmetry is the point - "not listed as a
 * strength" is weak evidence, while "listed as a strength somewhere else" is a
 * real signal that the model is specialised.
 *
 * Explicit `fitness` entries win outright.
 */
export function curatedQuality(entry: {
  tier: ModelTier;
  strengths: TaskClass[];
  quality?: number;
  fitness?: Partial<Record<TaskClass, number>>;
}): ModelQuality {
  const quality = entry.quality ?? tierBaselineQuality(entry.tier);
  const fitness: Partial<Record<TaskClass, number>> = {};
  const declared = new Set(entry.strengths);

  for (const taskClass of ALL_TASK_CLASSES) {
    let value = quality;
    if (declared.has(taskClass)) value += STRENGTH_BONUS;
    else if (declared.size > 0) value -= MISMATCH_PENALTY;
    fitness[taskClass] = clamp01(round3(value));
  }

  // An explicit correction is the last word, per class.
  if (entry.fitness) {
    for (const [taskClass, value] of Object.entries(entry.fitness)) {
      if (typeof value === 'number') fitness[taskClass as TaskClass] = clamp01(round3(value));
    }
  }

  return {
    quality: clamp01(round3(quality)),
    fitness,
    opinions: [
      {
        source: 'curated',
        quality: clamp01(round3(quality)),
        fitness,
        confidence: entry.fitness ? 0.7 : 0.5,
        attribution: entry.fitness
          ? 'curated baseline with explicit per-task corrections'
          : 'curated baseline derived from tier and declared strengths',
      },
    ],
  };
}

/**
 * Every task class, in one place.
 *
 * Duplicated from `@dev3d/core`'s `TASK_CLASSES` as a literal because this file
 * iterates it to build a complete fitness matrix, and a runtime import of a
 * const array would make the matrix depend on import order. A test asserts the
 * two agree, so they cannot drift apart in silence.
 */
export const ALL_TASK_CLASSES: readonly TaskClass[] = [
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

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Key an entry can be found by: provider-scoped first, then bare id. */
function keysFor(providerId: string, id: string): string[] {
  return [`${providerId}::${id}`, id];
}

const BY_KEY = new Map<string, CuratedEntry>();
for (const entry of CURATED_MODELS) {
  BY_KEY.set(`${entry.providerId}::${entry.id}`, entry);
  // A bare-id alias, so a plugin that contributes the same model under the same
  // id still picks up the curated metadata. First write wins, so two providers
  // shipping one id cannot have the later one hijack the earlier one's metadata.
  if (!BY_KEY.has(entry.id)) BY_KEY.set(entry.id, entry);
}

/** The curated entry for a model, or undefined when nothing describes it. */
export function curatedEntry(providerId: string, id: string): CuratedEntry | undefined {
  for (const key of keysFor(providerId, id)) {
    const found = BY_KEY.get(key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Guess a tier from a model id.
 *
 * Only used when the provider published no price, because **price is the better
 * signal**: it is the vendor's own statement about where the model sits, while a
 * name is marketing. When a price is available `tierFromPrice` wins.
 */
export function tierFromName(id: string): ModelTier {
  const hay = id.toLowerCase();

  // Parameter counts are the most literal signal a name can carry.
  const params = /(\d+(?:\.\d+)?)\s*b\b/.exec(hay);
  if (params?.[1] !== undefined) {
    const billions = Number.parseFloat(params[1]);
    if (Number.isFinite(billions)) {
      if (billions <= 4) return 'nano';
      if (billions <= 14) return 'small';
      if (billions <= 40) return 'standard';
      if (billions <= 120) return 'strong';
      return 'max';
    }
  }

  if (/(nano|tiny|micro|flash|mini|small|lite|haiku|instant|turbo)/.test(hay)) return 'small';
  if (/(opus|ultra|max|405b|reasoner|thinking|o1|o3|o4)/.test(hay)) return 'strong';
  if (/(pro|large|plus|sonnet|70b|72b)/.test(hay)) return 'strong';
  return 'standard';
}

/**
 * Price bands separating the tiers, for a model nobody has described.
 *
 * This is a rough proxy and it is knowingly imperfect. It does **not**
 * reproduce the curated table's judgement, because that judgement is editorial
 * rather than price-derived: several curated entries are cheap *and* capable
 * (an open 70B instruct model costs a fraction of a frontier one and is still
 * `strong`), so any price ladder understates them, and the local runtime is
 * free regardless of what it can do.
 *
 * It only has to be *ordered roughly right* - the same standard the prices
 * themselves are held to - so that a $15-per-million model never lands in
 * `nano`. Every tier it produces is flagged `unrated`, which is the console's
 * cue that this is a guess, and the learned layer is what corrects it once the
 * office has actually run the model.
 */
const TIER_PRICE_LADDER: Array<{ max: number; tier: ModelTier }> = [
  { max: 0.0003, tier: 'nano' },
  { max: 0.001, tier: 'small' },
  { max: 0.003, tier: 'standard' },
  { max: 0.01, tier: 'strong' },
  { max: Number.POSITIVE_INFINITY, tier: 'max' },
];

/** A tier inferred from a published price. See `TIER_PRICE_LADDER`. */
export function tierFromPrice(blendedCostPerKTok: number): ModelTier {
  for (const step of TIER_PRICE_LADDER) {
    if (blendedCostPerKTok <= step.max) return step.tier;
  }
  return 'standard';
}

/** The default shape for a model nobody has described. */
export function inferredSpec(providerId: string, discovered: DiscoveredModel): ModelSpec {
  const costIn = discovered.costPerMTokIn;
  const costOut = discovered.costPerMTokOut;
  const hasPrice = typeof costIn === 'number' || typeof costOut === 'number';
  const blended = ((costIn ?? 0) + (costOut ?? 0)) / 2 / 1000;
  const tier = hasPrice ? tierFromPrice(blended) : tierFromName(discovered.id);

  const label = discovered.label ?? discovered.id;

  // A discovered model inherits its vendor's own capability claims, and
  // otherwise assumes the safe minimum: tools off, because a model that cannot
  // call tools must not be handed a coding turn.
  const capabilities: ModelCapabilities = {
    tools: discovered.capabilities?.tools ?? false,
    vision: discovered.capabilities?.vision ?? false,
    reasoning: discovered.capabilities?.reasoning ?? false,
    streaming: discovered.capabilities?.streaming ?? true,
  };

  return {
    id: discovered.id,
    providerId,
    label,
    tier,
    contextWindow: discovered.contextWindow ?? 32_768,
    maxOutputTokens: discovered.maxOutputTokens ?? 4_096,
    costPerMTokIn: costIn ?? 0,
    costPerMTokOut: costOut ?? 0,
    capabilities,
    strengths: [],
    origin: 'discovered',
    // The honest flag: nobody has curated or measured this model, so its tier is
    // a guess from its price or its name and its quality carries no opinion.
    unrated: true,
  };
}

/** Build a full `ModelSpec` from a curated entry, quality included. */
export function specFromCurated(entry: CuratedEntry): ModelSpec {
  const spec: ModelSpec = {
    id: entry.id,
    providerId: entry.providerId,
    label: entry.label,
    tier: entry.tier,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    costPerMTokIn: entry.costPerMTokIn,
    costPerMTokOut: entry.costPerMTokOut,
    capabilities: entry.capabilities,
    strengths: entry.strengths,
    quality: curatedQuality(entry),
    origin: 'catalog',
  };
  if (entry.defaultEffort !== undefined) spec.defaultEffort = entry.defaultEffort;
  return spec;
}

/**
 * The whole curated table as specs: the offline seed.
 *
 * Used in mock mode, and for any provider whose model list we cannot obtain, so
 * that a keyless or unreachable office is still fully demonstrable instead of
 * routing against an empty catalog.
 */
export function seedCatalog(): ModelSpec[] {
  return CURATED_MODELS.map(specFromCurated);
}

/**
 * Apply curated metadata over a discovered model.
 *
 * The discovered model supplies *facts only the vendor knows* - that it exists,
 * its context window, its price. The curated table supplies *judgement* - its
 * tier, its strengths, its quality. Where both speak, the vendor wins on facts
 * and curation wins on judgement, which is exactly the split that makes a stale
 * price self-correcting.
 */
export function mergeCurated(
  providerId: string,
  discovered: DiscoveredModel,
  curated: CuratedEntry | undefined,
): ModelSpec {
  if (curated === undefined) return inferredSpec(providerId, discovered);

  const spec: ModelSpec = {
    id: discovered.id,
    providerId,
    label: discovered.label ?? curated.label,
    // Judgement the vendor cannot state: tier and quality come from curation.
    tier: curated.tier,
    // Facts the vendor knows better, falling back to curation when it is silent.
    contextWindow: discovered.contextWindow ?? curated.contextWindow,
    maxOutputTokens: discovered.maxOutputTokens ?? curated.maxOutputTokens,
    costPerMTokIn: discovered.costPerMTokIn ?? curated.costPerMTokIn,
    costPerMTokOut: discovered.costPerMTokOut ?? curated.costPerMTokOut,
    capabilities: {
      tools: discovered.capabilities?.tools ?? curated.capabilities.tools,
      vision: discovered.capabilities?.vision ?? curated.capabilities.vision,
      reasoning: discovered.capabilities?.reasoning ?? curated.capabilities.reasoning,
      streaming: discovered.capabilities?.streaming ?? curated.capabilities.streaming,
    },
    strengths: curated.strengths,
    quality: curatedQuality(curated),
    origin: 'discovered',
  };
  if (curated.defaultEffort !== undefined) spec.defaultEffort = curated.defaultEffort;
  return spec;
}

/** The specs a single provider serves, from the curated table alone. */
export function modelsForProvider(id: string): ModelSpec[] {
  return CURATED_MODELS.filter((entry) => entry.providerId === id).map(specFromCurated);
}

/**
 * Curated ids for one provider.
 *
 * Used to report a model the table describes that the provider no longer offers:
 * an operator paying for a retired model should be told, and a stale curated
 * entry should become visible rather than silently vanish from the catalog.
 */
export function curatedIdsForProvider(providerId: string): string[] {
  return CURATED_MODELS.filter((entry) => entry.providerId === providerId).map((entry) => entry.id);
}
