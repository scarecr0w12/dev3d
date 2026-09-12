/**
 * The single source of truth for model ids, tiers, and prices.
 *
 * PRICES ARE ESTIMATES FOR ROUTING DECISIONS AND COST DISPLAY, NOT BILLING
 * TRUTH. They drift, vendors republish them, and the per-million rates below
 * are rounded. The router only needs them to be *ordered correctly* (nano
 * cheaper than small cheaper than standard, etc.), and the UI only needs them
 * to be plausible. Edit every id and every price in this one place so the whole
 * office, the router, and the routing UI agree.
 */

import type { ModelCapabilities, ModelSpec, ModelTier, TaskClass } from '@dev3d/core';

function spec(
  providerId: string,
  id: string,
  label: string,
  tier: ModelTier,
  contextWindow: number,
  maxOutputTokens: number,
  costPerMTokIn: number,
  costPerMTokOut: number,
  capabilities: ModelCapabilities,
  strengths: TaskClass[],
  defaultEffort?: 'low' | 'medium' | 'high',
): ModelSpec {
  const model: ModelSpec = {
    id,
    providerId,
    label,
    tier,
    contextWindow,
    maxOutputTokens,
    costPerMTokIn,
    costPerMTokOut,
    capabilities,
    strengths,
  };
  if (defaultEffort !== undefined) model.defaultEffort = defaultEffort;
  return model;
}

const TOOLS: ModelCapabilities = { tools: true, vision: false, reasoning: false, streaming: true };
const TOOLS_VISION: ModelCapabilities = { tools: true, vision: true, reasoning: false, streaming: true };
const TOOLS_REASONING: ModelCapabilities = { tools: true, vision: false, reasoning: true, streaming: true };

export const MODEL_CATALOG: ModelSpec[] = [
  // ---------------------------------------------------------------- DeepSeek
  spec(
    'deepseek',
    'deepseek-flash',
    'DeepSeek Flash',
    'nano',
    128_000,
    8_192,
    0.14,
    0.28,
    TOOLS,
    ['intake', 'routing', 'summarize'],
  ),
  spec(
    'deepseek',
    'deepseek-v4-pro',
    'DeepSeek V4 Pro',
    'strong',
    128_000,
    8_192,
    0.55,
    2.19,
    TOOLS_REASONING,
    ['coding', 'architecture', 'debate', 'review', 'testing', 'planning'],
    'medium',
  ),
  spec(
    'deepseek',
    'deepseek-v4-flash-vision-exp',
    'DeepSeek V4 Flash Vision (exp)',
    'standard',
    128_000,
    8_192,
    0.28,
    0.42,
    TOOLS_VISION,
    ['design', 'research', 'summarize'],
  ),

  // ------------------------------------------------------------------- OpenAI
  spec(
    'openai',
    'gpt-4o-mini',
    'GPT-4o mini',
    'small',
    128_000,
    16_384,
    0.15,
    0.6,
    TOOLS_VISION,
    ['intake', 'routing', 'summarize', 'research'],
  ),
  spec(
    'openai',
    'o3-mini',
    'o3-mini',
    'strong',
    200_000,
    100_000,
    1.1,
    4.4,
    TOOLS_REASONING,
    ['coding', 'architecture', 'review', 'testing'],
    'high',
  ),
  spec(
    'openai',
    'gpt-4o',
    'GPT-4o',
    'strong',
    128_000,
    16_384,
    2.5,
    10,
    TOOLS_VISION,
    ['coding', 'architecture', 'design', 'review', 'debate'],
  ),

  // --------------------------------------------------------------- Anthropic
  spec(
    'anthropic',
    'claude-3-5-haiku-latest',
    'Claude 3.5 Haiku',
    'small',
    200_000,
    8_192,
    0.8,
    4,
    TOOLS_VISION,
    ['intake', 'routing', 'summarize', 'testing'],
  ),
  spec(
    'anthropic',
    'claude-3-5-sonnet-latest',
    'Claude 3.5 Sonnet',
    'strong',
    200_000,
    8_192,
    3,
    15,
    TOOLS_VISION,
    ['coding', 'architecture', 'design', 'debate', 'review'],
  ),

  // -------------------------------------------------------------- OpenRouter
  spec(
    'openrouter',
    'openrouter/deepseek/deepseek-chat',
    'DeepSeek Chat (OpenRouter)',
    'small',
    128_000,
    8_192,
    0.14,
    0.28,
    TOOLS,
    ['intake', 'routing', 'summarize'],
  ),
  spec(
    'openrouter',
    'openrouter/qwen/qwen2.5-coder-32b-instruct',
    'Qwen 2.5 Coder 32B (OpenRouter)',
    'standard',
    131_072,
    8_192,
    0.18,
    0.18,
    TOOLS,
    ['coding', 'review', 'testing'],
  ),
  spec(
    'openrouter',
    'openrouter/meta-llama/llama-3.3-70b-instruct',
    'Llama 3.3 70B (OpenRouter)',
    'strong',
    131_072,
    8_192,
    0.23,
    0.4,
    TOOLS,
    ['coding', 'planning', 'research', 'debate'],
  ),

  // ------------------------------------------------------------------- Local
  spec(
    'local',
    'local/default',
    'Local model (OpenAI-compatible)',
    'small',
    32_768,
    4_096,
    0,
    0,
    TOOLS,
    ['intake', 'routing', 'summarize'],
  ),
];

/** Catalog entries served by a single provider id, in catalog order. */
export function modelsForProvider(id: string): ModelSpec[] {
  return MODEL_CATALOG.filter((m) => m.providerId === id);
}
