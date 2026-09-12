/**
 * Parsing a provider's model-list response.
 *
 * This is the one place in the model layer that reads a document written by
 * somebody else, so it is written the way the plugin bundle reader is: the
 * response is attacker-shaped data, every field is optional and untrusted, and a
 * number that is missing must stay *missing* rather than becoming a zero that
 * would win a cheapest-model routing tie.
 *
 * It is deliberately separate from the adapters so it can be tested against real
 * captured payloads - DeepSeek's two-field answer, OpenRouter's 445-entry one,
 * Anthropic's `display_name` spelling - without a network.
 *
 * Two failure modes are kept distinct, because they have opposite consequences:
 *
 *   - A response we cannot recognise as a model list **throws**. The caller
 *     reports a failed discovery and keeps the curated seed.
 *   - A recognised list with no usable entries **returns []**. The provider
 *     genuinely served nothing, and that is a fact about the provider.
 */

import type { DiscoveredModel } from '@dev3d/core';

/**
 * A hard cap on how many models one provider may contribute.
 *
 * OpenRouter legitimately serves 445. The cap exists so a hostile or broken
 * gateway cannot make the office hold a million specs in memory and ship them
 * all in every `hello` frame.
 */
export const MAX_DISCOVERED_MODELS = 2_000;

/** $10,000 per million tokens: above this a number is a bug, not a price. */
const MAX_PRICE_PER_MTOK = 10_000;
/** A context window past this is a mangled integer. */
const MAX_CONTEXT_TOKENS = 100_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A positive integer bounded by `max`, or undefined when it is not one. */
function posInt(value: unknown, max: number): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  const floored = Math.floor(n);
  return floored > max ? undefined : floored;
}

/** A finite number in [0, max], or undefined. */
function bounded(value: unknown, max: number): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
  return n > max ? undefined : n;
}

/**
 * A price per million tokens.
 *
 * Two unit conventions are accepted, because gateways disagree and guessing
 * wrong is a routing error rather than a cosmetic one:
 *
 *  - `pricing.prompt` / `pricing.completion` are **per token**, as decimal
 *    strings. This is OpenRouter's documented shape and what several gateways
 *    copied; `0.0000025` is $2.50 per million.
 *  - `cost_per_mtok_*` and `price_1m_*` are already **per million**, which is
 *    what Artificial Analysis and price-list-shaped documents use.
 *
 * The per-token form is only trusted when it lands inside a plausible band after
 * scaling; a value that would become an absurd per-million price is dropped
 * rather than believed.
 */
function perMTok(perToken: unknown, perMillion: unknown): number | undefined {
  const direct = bounded(perMillion, MAX_PRICE_PER_MTOK);
  if (direct !== undefined) return direct;

  const raw = bounded(perToken, Number.MAX_SAFE_INTEGER);
  if (raw === undefined) return undefined;
  const scaled = raw * 1_000_000;
  if (!Number.isFinite(scaled) || scaled > MAX_PRICE_PER_MTOK) return undefined;
  // Round to 6 dp: a per-token decimal becomes a clean per-million figure, so a
  // displayed price does not read as 2.5000000000000004.
  return Math.round(scaled * 1e6) / 1e6;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** A context window under any of the spellings vendors use. */
function contextWindowOf(entry: Record<string, unknown>): number | undefined {
  for (const key of ['context_length', 'context_window', 'max_context_length', 'contextWindow']) {
    const found = posInt(entry[key], MAX_CONTEXT_TOKENS);
    if (found !== undefined) return found;
  }
  const top = entry['top_provider'];
  if (isRecord(top)) {
    const found = posInt(top['context_length'], MAX_CONTEXT_TOKENS);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A max-output limit under any of the spellings vendors use. */
function maxOutputOf(entry: Record<string, unknown>): number | undefined {
  for (const key of ['max_output_tokens', 'max_completion_tokens', 'max_tokens', 'maxOutputTokens']) {
    const found = posInt(entry[key], MAX_CONTEXT_TOKENS);
    if (found !== undefined) return found;
  }
  const top = entry['top_provider'];
  if (isRecord(top)) {
    const found = posInt(top['max_completion_tokens'], MAX_CONTEXT_TOKENS);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Capabilities a model list *can* evidence.
 *
 * Only fields that are actually present produce a claim. A vendor that says
 * nothing about tools yields `tools: undefined`, which lets the curated table
 * answer; it must not yield `false`, which would silently disqualify a perfectly
 * good model from every coding turn.
 */
function capabilitiesOf(entry: Record<string, unknown>): DiscoveredModel['capabilities'] {
  const out: NonNullable<DiscoveredModel['capabilities']> = {};

  const params = asStringArray(entry['supported_parameters']);
  if (params.length > 0) {
    out.tools = params.includes('tools') || params.includes('tool_choice');
    out.reasoning = params.includes('reasoning') || params.includes('include_reasoning');
    out.streaming = params.includes('stream');
  }

  const architecture = entry['architecture'];
  if (isRecord(architecture)) {
    const modalities = asStringArray(architecture['input_modalities']);
    if (modalities.length > 0) out.vision = modalities.includes('image');
    const modality = architecture['modality'];
    // The older `"text+image->text"` spelling, still emitted by some gateways.
    if (typeof modality === 'string' && modality.includes('image')) out.vision = true;
  }

  // A top-level `capabilities` object, which some gateways emit directly.
  const caps = entry['capabilities'];
  if (isRecord(caps)) {
    if (typeof caps['tools'] === 'boolean') out.tools = caps['tools'];
    if (typeof caps['vision'] === 'boolean') out.vision = caps['vision'];
    if (typeof caps['reasoning'] === 'boolean') out.reasoning = caps['reasoning'];
    if (typeof caps['streaming'] === 'boolean') out.streaming = caps['streaming'];
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function labelOf(entry: Record<string, unknown>, id: string): string | undefined {
  for (const key of ['name', 'display_name', 'label', 'title']) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  // Ollama's `/api/tags` shape: `model` mirrors the id, `name` is the tag.
  const model = entry['model'];
  if (typeof model === 'string' && model.length > 0 && model !== id) return model;
  return undefined;
}

function createdOf(entry: Record<string, unknown>): number | undefined {
  const created = posInt(entry['created'], 4_102_444_800);
  if (created !== undefined) return created;
  const createdAt = entry['created_at'];
  if (typeof createdAt === 'string') {
    const parsed = Date.parse(createdAt);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return undefined;
}

/** One entry, or undefined when it carries no usable id. */
function parseEntry(entry: unknown): DiscoveredModel | undefined {
  if (!isRecord(entry)) return undefined;
  const rawId = entry['id'] ?? entry['model'] ?? entry['name'];
  if (typeof rawId !== 'string') return undefined;
  const id = rawId.trim();
  if (id.length === 0 || id.length > 256) return undefined;

  const pricing = isRecord(entry['pricing']) ? entry['pricing'] : {};

  const model: DiscoveredModel = { id };

  const label = labelOf(entry, id);
  if (label !== undefined) model.label = label;

  const contextWindow = contextWindowOf(entry);
  if (contextWindow !== undefined) model.contextWindow = contextWindow;

  const maxOutputTokens = maxOutputOf(entry);
  if (maxOutputTokens !== undefined) model.maxOutputTokens = maxOutputTokens;

  const costIn = perMTok(pricing['prompt'], entry['cost_per_mtok_in'] ?? entry['price_1m_input_tokens']);
  if (costIn !== undefined) model.costPerMTokIn = costIn;

  const costOut = perMTok(
    pricing['completion'],
    entry['cost_per_mtok_out'] ?? entry['price_1m_output_tokens'],
  );
  if (costOut !== undefined) model.costPerMTokOut = costOut;

  const capabilities = capabilitiesOf(entry);
  if (capabilities !== undefined) model.capabilities = capabilities;

  const created = createdOf(entry);
  if (created !== undefined) model.created = created;

  const ownedBy = entry['owned_by'];
  if (typeof ownedBy === 'string' && ownedBy.length > 0) model.ownedBy = ownedBy;

  return model;
}

/**
 * Pull the model array out of a list response.
 *
 * Accepts `{ data: [...] }` (OpenAI, DeepSeek, OpenRouter, Anthropic),
 * `{ models: [...] }` (Ollama and several gateways) and a bare array. Anything
 * else throws, because "I do not understand this" and "there are no models" must
 * not be the same answer.
 */
function modelArrayOf(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (isRecord(json)) {
    for (const key of ['data', 'models', 'items']) {
      const value = json[key];
      if (Array.isArray(value)) return value;
    }
    // An OpenAI-shaped error body, which is worth surfacing verbatim.
    const error = json['error'];
    if (isRecord(error) && typeof error['message'] === 'string') {
      throw new Error(error['message']);
    }
    if (typeof error === 'string' && error.length > 0) throw new Error(error);
  }
  throw new Error('response was not a model list (no data/models array)');
}

/**
 * Parse a model-list response into discovered models.
 *
 * Duplicate ids collapse to the first occurrence: a gateway that lists one model
 * once per region must not produce two catalog entries the router then treats as
 * two independent fallbacks.
 */
export function parseModelList(json: unknown): DiscoveredModel[] {
  const entries = modelArrayOf(json);
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (out.length >= MAX_DISCOVERED_MODELS) break;
    const model = parseEntry(entry);
    if (model === undefined || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }

  return out;
}
