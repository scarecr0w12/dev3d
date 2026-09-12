/**
 * Pooled quality: what public benchmarking says about a model, in preference to
 * guessing.
 *
 * ## What is actually available, verified rather than assumed
 *
 *  - **OpenRouter's model list** (`/api/v1/models`) needs no key and returns 445
 *    models with *real* per-token prices, context windows and capability lists.
 *    It carries **no benchmark scores**, so it is a metadata source, not a
 *    quality one. It is already used that way: `openrouter` is a configured
 *    provider, so discovery reads it directly.
 *  - **OpenRouter's benchmark endpoint** (`/api/v1/benchmarks`) returns
 *    `401 No cookie auth credentials found` - it is for their web app, not for
 *    API clients, so it is not usable here.
 *  - **Artificial Analysis** publishes a free API with independent
 *    intelligence, coding and math indices, rate-limited to 1,000 requests a
 *    day, which **requires an API key and attribution**. That is the source this
 *    module uses.
 *
 * ## The rules this layer obeys
 *
 *  - **Off unless asked for.** No key means no requests, so a default install
 *    still makes no outbound call it did not have to.
 *  - **Cached on disk.** 1,000 requests a day is ample, but a benchmark index
 *    moves on the scale of weeks; re-fetching per boot would be rude and
 *    pointless.
 *  - **A failure is a shrug.** An unreachable aggregator costs the pooled
 *    opinion and nothing else. The curated and learned layers are untouched.
 *  - **Attribution is kept and carried through** to the opinion, because
 *    Artificial Analysis's terms require it and because a number whose source is
 *    invisible is a number nobody can check.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ModelSpec, QualityOpinion, TaskClass } from '@dev3d/core';

/** Artificial Analysis's free data endpoint. */
const AA_ENDPOINT = 'https://artificialanalysis.ai/api/v2/data/llms/models';

/** Required by their terms, and surfaced on every opinion this produces. */
export const AA_ATTRIBUTION = 'Artificial Analysis (artificialanalysis.ai)';

/** The cache's on-disk shape. Versioned so a future change can refuse an old file. */
interface PooledCache {
  version: 1;
  fetchedAt: number;
  attribution: string;
  /** Normalized key -> the indices that were reported for it. */
  entries: Array<{
    key: string;
    name: string;
    intelligence: number | null;
    coding: number | null;
    math: number | null;
    /** USD per million tokens, as published. */
    costIn: number | null;
    costOut: number | null;
  }>;
}

const CACHE_VERSION = 1;

export interface PooledOptions {
  apiKey: string | null;
  cachePath: string | null;
  ttlMs: number;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string) => void;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface PooledService {
  /** The benchmark opinion for one model, or undefined when it is not listed. */
  opinionFor(spec: ModelSpec): QualityOpinion | undefined;
  /** Quality opinions keyed by *catalog model id*, for the specs given. */
  opinionsFor(specs: readonly ModelSpec[]): Map<string, QualityOpinion>;
  /** Fetch if stale, and report what happened. Never throws. */
  refresh(): Promise<{ ok: boolean; count: number; error: string | null }>;
  /** Load a previously saved index. */
  loadCache(): number;
  saveCache(): void;
  /** How many benchmark entries are held, and when they were fetched. */
  status(): { count: number; fetchedAt: number | null; attribution: string };
}

interface IndexEntry {
  key: string;
  name: string;
  intelligence: number | null;
  coding: number | null;
  math: number | null;
  costIn: number | null;
  costOut: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * A key two model names can be matched on.
 *
 * Vendor naming is a mess - casing, separators, a `vendor/` prefix, a date
 * suffix, a `-latest` alias. This strips the parts that carry no identity and
 * lowercases the rest.
 *
 * It deliberately does **not** strip a `vendor/` prefix: two vendors can ship a
 * model with the same bare name, and folding them together would attach one
 * model's benchmark scores to another's. `keysFor` adds the bare form as an
 * *additional* candidate key, so a prefixed id still matches an unprefixed
 * listing, in that direction only.
 */
export function matchKey(name: string): string {
  return name
    .toLowerCase()
    .trim()
    // A full date, dashed or not: `2024-11-20`, `20241120`.
    .replace(/[-_ .]?\d{4}[-_ .]?\d{2}[-_ .]?\d{2}$/, '')
    // A compact date or version: `20241022`, `202411`.
    .replace(/[-_ .]?\d{6,8}$/, '')
    // An alias suffix rather than part of the name.
    .replace(/[-_ .]?(latest|preview|exp|experimental|instruct)$/, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Every key a catalog model could plausibly be listed under. */
function keysFor(spec: ModelSpec): string[] {
  const keys = new Set<string>([matchKey(spec.id), matchKey(spec.label)]);
  // `vendor/model` -> `model`, which is how a non-OpenRouter provider's own id
  // usually appears in an aggregator listing.
  const bare = spec.id.includes('/') ? spec.id.slice(spec.id.lastIndexOf('/') + 1) : spec.id;
  keys.add(matchKey(bare));
  return [...keys].filter((key) => key.length >= 3);
}

/**
 * Scale an aggregate index onto 0..1.
 *
 * Artificial Analysis publishes an intelligence index that runs roughly 0..100
 * for current models. The anchors are deliberately generous at the bottom: a
 * score of 20 is a weak model, not 20% of the way to a good one, and compressing
 * the scale into the top half would make everything look equivalent.
 */
export function scaleIndex(value: number): number {
  const floor = 15;
  const ceiling = 80;
  return Math.max(0, Math.min(1, (value - floor) / (ceiling - floor)));
}

/** Parse Artificial Analysis's response into index entries. */
export function parseArtificialAnalysis(json: unknown): IndexEntry[] {
  if (!isRecord(json) || !Array.isArray(json['data'])) return [];
  const out: IndexEntry[] = [];
  for (const raw of json['data']) {
    if (!isRecord(raw)) continue;
    const name = typeof raw['name'] === 'string' ? raw['name'] : typeof raw['slug'] === 'string' ? raw['slug'] : null;
    if (name === null || name.length === 0) continue;

    const evaluations = isRecord(raw['evaluations']) ? raw['evaluations'] : {};
    const pricing = isRecord(raw['pricing']) ? raw['pricing'] : {};

    out.push({
      key: matchKey(name),
      name,
      intelligence: num(evaluations['artificial_analysis_intelligence_index']),
      coding: num(evaluations['artificial_analysis_coding_index']),
      math: num(evaluations['artificial_analysis_math_index']),
      costIn: num(pricing['price_1m_input_tokens']),
      costOut: num(pricing['price_1m_output_tokens']),
    });
  }
  return out;
}

export function createPooledService(options: PooledOptions): PooledService {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const byKey = new Map<string, IndexEntry>();
  let fetchedAt: number | null = null;

  function record(entries: IndexEntry[], at: number): void {
    byKey.clear();
    for (const entry of entries) {
      // First listing wins, so a model listed twice under the same key does not
      // have its scores overwritten by whichever row happened to come last.
      if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
    }
    fetchedAt = at;
  }

  function isFresh(): boolean {
    if (fetchedAt === null) return false;
    if (options.ttlMs <= 0) return false;
    return now() - fetchedAt < options.ttlMs;
  }

  return {
    async refresh() {
      if (options.apiKey === null || options.apiKey === '') {
        return { ok: false, count: 0, error: 'no Artificial Analysis API key is configured' };
      }
      if (isFresh()) {
        return { ok: true, count: byKey.size, error: null };
      }

      try {
        const resp = await doFetch(AA_ENDPOINT, {
          method: 'GET',
          headers: { 'x-api-key': options.apiKey, accept: 'application/json' },
        });
        if (!resp.ok) {
          const detail = await resp.text().catch(() => '');
          const error = `HTTP ${resp.status} from Artificial Analysis${detail ? `: ${detail.slice(0, 160)}` : ''}`;
          options.log?.('warn', 'pooled', `${error} — pooled quality is unavailable`);
          return { ok: false, count: byKey.size, error };
        }
        const entries = parseArtificialAnalysis(await resp.json());
        record(entries, now());
        options.log?.('info', 'pooled', `Artificial Analysis: ${entries.length} benchmarked model(s)`);
        return { ok: true, count: entries.length, error: null };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        options.log?.('warn', 'pooled', `could not reach Artificial Analysis (${error}) — pooled quality is unavailable`);
        return { ok: false, count: byKey.size, error };
      }
    },

    opinionFor(spec) {
      if (byKey.size === 0) return undefined;

      let entry: IndexEntry | undefined;
      for (const key of keysFor(spec)) {
        entry = byKey.get(key);
        if (entry !== undefined) break;
      }
      if (entry === undefined || entry.intelligence === null) return undefined;

      const quality = scaleIndex(entry.intelligence);

      // The indices map onto task classes where the correspondence is real
      // rather than decorative. A coding index says something about coding; it
      // says nothing about whether a model is good at a debate, so no class is
      // invented for it.
      const fitness: Partial<Record<TaskClass, number>> = {};
      if (entry.coding !== null) {
        const coding = scaleIndex(entry.coding);
        fitness.coding = round3(coding);
        fitness.review = round3((coding + quality) / 2);
        fitness.testing = round3((coding + quality) / 2);
        fitness.architecture = round3((coding + quality) / 2);
      }
      if (entry.math !== null) {
        const math = scaleIndex(entry.math);
        fitness.planning = round3((math + quality) / 2);
        fitness.workshop = round3((math + quality) / 2);
      }

      const at = fetchedAt ?? undefined;
      return {
        source: 'pooled',
        quality: round3(quality),
        fitness,
        // A benchmark is a real measurement of a different workload, so it is
        // believed - but less than an operator and no more than the office's
        // own observations of its own work.
        confidence: 0.55,
        attribution: `${AA_ATTRIBUTION} — intelligence ${entry.intelligence}${
          entry.coding === null ? '' : `, coding ${entry.coding}`
        }`,
        ...(at !== undefined ? { at } : {}),
      };
    },

    opinionsFor(specs) {
      const out = new Map<string, QualityOpinion>();
      for (const spec of specs) {
        const opinion = this.opinionFor(spec);
        if (opinion !== undefined) out.set(spec.id, opinion);
      }
      return out;
    },

    loadCache(): number {
      if (options.cachePath === null) return 0;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(options.cachePath, 'utf8')) as unknown;
      } catch {
        return 0;
      }
      if (!isRecord(parsed) || parsed['version'] !== CACHE_VERSION || !Array.isArray(parsed['entries'])) {
        options.log?.('warn', 'pooled', 'pooled quality cache was not a version 1 file; ignoring it');
        return 0;
      }
      const at = num(parsed['fetchedAt']);
      const entries: IndexEntry[] = [];
      for (const raw of parsed['entries']) {
        if (!isRecord(raw) || typeof raw['key'] !== 'string' || typeof raw['name'] !== 'string') continue;
        entries.push({
          key: raw['key'],
          name: raw['name'],
          intelligence: num(raw['intelligence']),
          coding: num(raw['coding']),
          math: num(raw['math']),
          costIn: num(raw['costIn']),
          costOut: num(raw['costOut']),
        });
      }
      if (entries.length === 0) return 0;
      record(entries, at ?? now());
      return entries.length;
    },

    saveCache(): void {
      if (options.cachePath === null) return;
      const file: PooledCache = {
        version: CACHE_VERSION,
        fetchedAt: fetchedAt ?? now(),
        attribution: AA_ATTRIBUTION,
        entries: [...byKey.values()],
      };
      try {
        mkdirSync(dirname(options.cachePath), { recursive: true });
        writeFileSync(options.cachePath, JSON.stringify(file), 'utf8');
      } catch (err) {
        options.log?.(
          'warn',
          'pooled',
          `could not save the pooled quality cache: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    status: () => ({ count: byKey.size, fetchedAt, attribution: AA_ATTRIBUTION }),
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
