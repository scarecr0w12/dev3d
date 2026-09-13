/**
 * What the office state frame says about its models.
 *
 * The model catalog is 240 kB of a 299 kB `hello`, and 87 kB of that is
 * `quality.opinions` — every opinion that produced each model's blended score. The
 * console reads exactly one thing out of the whole array: the set of source names
 * behind the number, so it can print "curated + learned" instead of "rated". The
 * remaining 30% of the payload bought nothing but a label.
 *
 * So the frame carries the label's worth of it (`quality.sources`) and the full
 * list is served on demand by `GET /api/models`, which is what an interface that
 * wants to *explain* a score should ask for.
 *
 * ## Why this is a projection and not a smaller type
 *
 * `OfficeState.models` is `ModelSpec[]`, and narrowing it would have rippled
 * through every consumer of the state — the store, the console, every test
 * fixture. The projection happens at the **wire boundary** instead: the registry
 * keeps the full specs, the router ranks on the full specs, and only the bytes
 * handed to a client are trimmed. That is the same choke point the heartbeat fix
 * used, and it is why a spread of `structuredClone(registry.models())` no longer
 * appears in `state()`.
 */

import type { ModelSpec } from '@dev3d/core';

/**
 * The distinct sources behind a model's blended quality.
 *
 * Deduplicated and order-preserving, because the console joins them into one
 * label and a source that appears twice would be printed twice.
 */
export function qualitySources(model: ModelSpec): string[] {
  const seen: string[] = [];
  for (const opinion of model.quality?.opinions ?? []) {
    if (!seen.includes(opinion.source)) seen.push(opinion.source);
  }
  return seen;
}

/**
 * One model, as the state frame carries it: everything except the opinion list,
 * with the label the console derives from it kept instead.
 *
 * A model with no quality, or with quality but no opinions, comes through
 * unchanged — an absent `quality` means "nothing has expressed an opinion", which
 * the console already renders as `unrated`, and inventing `{ sources: [] }` there
 * would turn "unrated" into "rated by nobody".
 */
export function projectModel(model: ModelSpec): ModelSpec {
  const quality = model.quality;
  if (quality === undefined || quality.opinions === undefined) return model;
  const { opinions: _dropped, ...rest } = quality;
  return { ...model, quality: { ...rest, sources: qualitySources(model) } };
}

/** The whole catalog, projected. */
export function projectModelsForState(models: readonly ModelSpec[]): ModelSpec[] {
  return models.map(projectModel);
}
