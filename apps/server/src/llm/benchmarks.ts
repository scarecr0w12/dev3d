/**
 * Pooled quality from OpenRouter's benchmark aggregation.
 *
 * `GET /api/v1/benchmarks` (bearer API key) returns three differently-shaped
 * sources in one payload, all measured against 250-odd models:
 *
 *  - **artificial-analysis** - `intelligence_index`, `coding_index`,
 *    `agentic_index`. This is the good one: three independent, documented
 *    indices that map onto our task classes almost directly, and it is what
 *    `pooled.ts` used to fetch from Artificial Analysis directly. Going through
 *    OpenRouter means one credential instead of two.
 *  - **design-arena** - Elo, win rate and timing per arena and category. The
 *    creative counterpart to a coding index, which is exactly the "creative vs
 *    coding" distinction the router is supposed to make.
 *  - **openrouter** - OpenRouter's own benchmark runs (`benchmark_type`,
 *    `accuracy`, `avg_cost_per_task`).
 *
 * ## The scale is calibrated from the data, because a fixed one is wrong
 *
 * The published example for these indices shows values around 60-90, which
 * invites a hardcoded `(value - 15) / 65`. Measured against the live payload,
 * that is badly wrong. The real distribution is:
 *
 * ```
 * intelligence_index   min  3.8   p50 22.3   max 53.4
 * coding_index         min  2.7   p50 42.8   max 81.6
 * agentic_index        min  0.1   p50 17.2   max 58.0
 * ```
 *
 * A fixed window would place the *median* model at 0.11 and would never award a
 * top score to anything. So every index is converted to a **percentile within
 * the population that was actually returned**: 0 is the weakest benchmarked
 * model, 1 the strongest, 0.5 the median. That is self-calibrating as the field
 * moves, needs no invented constants, and is honest about what it is - a
 * standing among benchmarked models, not an absolute capability. The attribution
 * says so.
 *
 * ## Coverage is the real limitation, and it is stated rather than hidden
 *
 * Measured: **31 of OpenRouter's 445 models carry an Artificial Analysis entry**
 * (7%). The benchmark set uses dated snapshots (`anthropic/claude-fable-5.1-20260831`)
 * that often do not match the current model id, so the great majority of models a
 * router can pick have no pooled opinion at all. `coverage()` reports the real
 * numbers so the console can say "31 of 445" rather than implying the catalog is
 * fully measured.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ModelSpec, QualityOpinion, TaskClass } from '@dev3d/core';
import { matchKey } from './pooled.ts';

const BENCHMARKS_ENDPOINT = 'https://openrouter.ai/api/v1/benchmarks';

/** Carried on every opinion, because the indices originate with them. */
export const BENCHMARK_ATTRIBUTION =
  'OpenRouter benchmarks — Artificial Analysis indices (artificialanalysis.ai) via openrouter.ai';

const CACHE_VERSION = 1;

/** A benchmark row, reduced to the fields this module maps. */
interface BenchmarkEntry {
  source: string;
  permaslug: string;
  displayName: string;
  /** Every full-slug key this row can be found under. */
  keys: string[];
  /** The last-segment key, usable only when it is unambiguous. */
  bareKey: string;
  // Artificial Analysis
  intelligence: number | null;
  coding: number | null;
  agentic: number | null;
  /** Percentile of each index within the returned population, 0..1. */
  pIntelligence: number | null;
  pCoding: number | null;
  pAgentic: number | null;
  // Design Arena
  arena: string | null;
  category: string | null;
  elo: number | null;
  pElo: number | null;
  // OpenRouter's own runs
  benchmarkType: string | null;
  accuracy: number | null;
  pAccuracy: number | null;
}

export interface BenchmarkCoverage {
  /** Rows returned by the provider, across all sources. */
  entries: number;
  /** Distinct models the rows describe. */
  models: number;
  /** Rows carrying an Artificial Analysis index. */
  measured: number;
  /** When the payload was fetched. */
  fetchedAt: number | null;
  /** Highest percentile in the population, for scale sanity. */
  attribution: string;
}

export interface BenchmarkService {
  /** The pooled opinion for one model, or undefined when it is not benchmarked. */
  opinionFor(spec: ModelSpec): QualityOpinion | undefined;
  /** Fetch if stale. Never throws. */
  refresh(): Promise<{ ok: boolean; entries: number; error: string | null }>;
  loadCache(): number;
  saveCache(): void;
  coverage(): BenchmarkCoverage;
}

export interface BenchmarkOptions {
  apiKey: string | null;
  cachePath: string | null;
  ttlMs: number;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The **full-slug** key for a benchmark row: `deepseek/deepseek-chat` becomes
 * `deepseekdeepseekchat`, which is unambiguous across vendors.
 */
export function fullKey(slug: string): string {
  return matchKey(slug);
}

/**
 * The **bare** key: the last path segment only.
 *
 * Weaker than the full slug and dangerous on its own - `vendorA/llama-3.3-70b`
 * and `vendorB/llama-3.3-70b` both reduce to `llama3370b` - so a bare key is
 * only ever used when it is unambiguous in the whole payload. See `record`.
 */
export function bareKey(slug: string): string {
  return matchKey(slug.slice(slug.lastIndexOf('/') + 1));
}

/**
 * The full-slug keys a catalog model could be listed under.
 *
 * The important case is the provider prefix: our OpenRouter catalog ids are
 * namespaced `openrouter/deepseek/deepseek-chat`, while the benchmark payload
 * uses OpenRouter's own `deepseek/deepseek-chat`. Stripping the prefix turns our
 * id into exactly the slug the payload uses.
 */
export function fullKeysForSpec(spec: ModelSpec): string[] {
  const out = new Set<string>([fullKey(spec.id)]);
  const prefix = `${spec.providerId}/`;
  if (spec.id.startsWith(prefix)) out.add(fullKey(spec.id.slice(prefix.length)));
  return [...out].filter((key) => key.length >= 3);
}

/** The bare keys a catalog model could be found under, for the fallback path. */
export function bareKeysForSpec(spec: ModelSpec): string[] {
  const out = new Set<string>([bareKey(spec.id), matchKey(spec.label)]);
  return [...out].filter((key) => key.length >= 3);
}

/**
 * Percentile of every value within the population, as a map from value to 0..1.
 *
 * Uses "count strictly below / (n - 1)" so the weakest scores 0 and the
 * strongest 1. Ties share a percentile, which is what makes two models with
 * identical indices rank identically rather than by accident of order.
 */
function percentilesOf(values: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (values.length === 0) return out;
  const sorted = [...values].sort((a, b) => a - b);
  const span = Math.max(1, sorted.length - 1);
  for (const value of sorted) {
    if (out.has(value)) continue;
    out.set(value, sorted.findIndex((v) => v === value) / span);
  }
  return out;
}

/** Percentile within each group, so an Elo is ranked against its own arena. */
function percentilesWithin<T>(rows: T[], groupOf: (row: T) => string, valueOf: (row: T) => number | null): Map<T, number> {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const value = valueOf(row);
    if (value === null) continue;
    const key = groupOf(row);
    const list = groups.get(key) ?? [];
    list.push(value);
    groups.set(key, list);
  }
  const scales = new Map<string, Map<number, number>>();
  for (const [key, list] of groups) scales.set(key, percentilesOf(list));

  const out = new Map<T, number>();
  for (const row of rows) {
    const value = valueOf(row);
    if (value === null) continue;
    const scale = scales.get(groupOf(row));
    const p = scale?.get(value);
    if (p !== undefined) out.set(row, round3(p));
  }
  return out;
}

/** Parse the payload into entries with their percentiles already computed. */
export function parseBenchmarks(json: unknown): BenchmarkEntry[] {
  if (!isRecord(json) || !Array.isArray(json['data'])) return [];

  const raw: Array<Omit<BenchmarkEntry, 'pIntelligence' | 'pCoding' | 'pAgentic' | 'pElo' | 'pAccuracy'>> = [];

  for (const row of json['data']) {
    if (!isRecord(row)) continue;
    const permaslug = str(row['model_permaslug']);
    if (permaslug === null) continue;
    raw.push({
      source: str(row['source']) ?? 'unknown',
      permaslug,
      displayName: str(row['display_name']) ?? permaslug,
      keys: [fullKey(permaslug)],
      bareKey: bareKey(permaslug),
      intelligence: num(row['intelligence_index']),
      coding: num(row['coding_index']),
      agentic: num(row['agentic_index']),
      arena: str(row['arena']),
      category: str(row['category']),
      elo: num(row['elo']),
      benchmarkType: str(row['benchmark_type']),
      accuracy: num(row['accuracy']),
    });
  }

  // One population per index across every row that reported it.
  const pick = (f: (r: (typeof raw)[number]) => number | null): number[] =>
    raw.map(f).filter((v): v is number => v !== null);

  const pIntelligence = percentilesOf(pick((r) => r.intelligence));
  const pCoding = percentilesOf(pick((r) => r.coding));
  const pAgentic = percentilesOf(pick((r) => r.agentic));

  // Elo and benchmark accuracy are only comparable inside their own group: a
  // graphic-design arena score and a UI-component one are different scales, and
  // so are gpqa_diamond and some other benchmark type.
  const pElo = percentilesWithin(raw, (r) => `${r.arena ?? ''}::${r.category ?? ''}`, (r) => r.elo);
  const pAccuracy = percentilesWithin(raw, (r) => r.benchmarkType ?? '', (r) => r.accuracy);

  return raw.map((r) => ({
    ...r,
    pIntelligence: pIntelligence.get(r.intelligence ?? Number.NaN) ?? null,
    pCoding: pCoding.get(r.coding ?? Number.NaN) ?? null,
    pAgentic: pAgentic.get(r.agentic ?? Number.NaN) ?? null,
    pElo: pElo.get(r) ?? null,
    pAccuracy: pAccuracy.get(r) ?? null,
  }));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function createBenchmarkService(options: BenchmarkOptions): BenchmarkService {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  /** Best entry per full-slug key. Artificial Analysis wins a key collision. */
  const byKey = new Map<string, BenchmarkEntry>();
  /**
   * Bare-key index, where `null` means the key is claimed by more than one
   * distinct model and is therefore unusable.
   *
   * This is the guard against the worst failure this module could have: two
   * vendors ship a model with the same bare name, and one of them is handed the
   * other's benchmark scores. A miss costs a pooled opinion; a false match
   * misleads routing while looking authoritative.
   */
  const byBareKey = new Map<string, BenchmarkEntry | null>();
  let fetchedAt: number | null = null;
  let modelCount = 0;
  let measuredCount = 0;
  let rowCount = 0;

  const SOURCE_RANK: Record<string, number> = { 'artificial-analysis': 0, 'design-arena': 1, openrouter: 2 };

  function record(entries: BenchmarkEntry[], at: number): void {
    byKey.clear();
    byBareKey.clear();
    rowCount = entries.length;
    modelCount = new Set(entries.map((e) => e.permaslug)).size;
    measuredCount = new Set(
      entries.filter((e) => e.intelligence !== null || e.coding !== null).map((e) => e.permaslug),
    ).size;

    const ordered = [...entries].sort(
      (a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9),
    );
    for (const entry of ordered) {
      for (const key of entry.keys) {
        if (!byKey.has(key)) byKey.set(key, entry);
      }
      const existing = byBareKey.get(entry.bareKey);
      if (existing === undefined) {
        byBareKey.set(entry.bareKey, entry);
      } else if (existing !== null && existing.permaslug !== entry.permaslug) {
        // Two different models reduce to the same bare name. Poison the key
        // rather than let whichever row happened to come first win.
        byBareKey.set(entry.bareKey, null);
      }
    }
    fetchedAt = at;
  }

  /** Full-slug match first, then an unambiguous bare-key match. */
  function findEntry(spec: ModelSpec): BenchmarkEntry | undefined {
    for (const key of fullKeysForSpec(spec)) {
      const found = byKey.get(key);
      if (found !== undefined) return found;
    }
    for (const key of bareKeysForSpec(spec)) {
      const found = byBareKey.get(key);
      if (found !== undefined && found !== null) return found;
    }
    return undefined;
  }

  function isFresh(): boolean {
    if (fetchedAt === null) return false;
    if (options.ttlMs <= 0) return false;
    return now() - fetchedAt < options.ttlMs;
  }

  return {
    async refresh() {
      if (options.apiKey === null || options.apiKey === '') {
        return { ok: false, entries: 0, error: 'no OpenRouter API key is configured' };
      }
      if (isFresh()) return { ok: true, entries: byKey.size, error: null };

      try {
        const resp = await doFetch(BENCHMARKS_ENDPOINT, {
          method: 'GET',
          headers: { Authorization: `Bearer ${options.apiKey}`, accept: 'application/json' },
        });
        if (!resp.ok) {
          const detail = await resp.text().catch(() => '');
          const error = `HTTP ${resp.status} from OpenRouter benchmarks${detail ? `: ${detail.slice(0, 160)}` : ''}`;
          options.log?.('warn', 'benchmarks', `${error} — pooled quality is unavailable`);
          return { ok: false, entries: byKey.size, error };
        }
        const entries = parseBenchmarks(await resp.json());
        record(entries, now());
        options.log?.(
          'info',
          'benchmarks',
          `${entries.length} row(s) covering ${modelCount} model(s); ${measuredCount} carry an index`,
        );
        return { ok: true, entries: entries.length, error: null };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        options.log?.('warn', 'benchmarks', `could not reach OpenRouter benchmarks (${error})`);
        return { ok: false, entries: byKey.size, error };
      }
    },

    opinionFor(spec) {
      if (byKey.size === 0) return undefined;

      const entry = findEntry(spec);
      if (entry === undefined) return undefined;

      // Overall quality: an intelligence index if there is one, else the mean of
      // whatever else was measured. Never a zero for "not measured", and never
      // nothing at all when a source measured *something* - a design-arena Elo
      // is a real measurement of design, and refusing to emit an opinion because
      // it is not an intelligence index would leave 1102 parsed rows unused.
      const [pIntelligence, pCoding, pAgentic, pElo, pAccuracy] = [
        entry.pIntelligence,
        entry.pCoding,
        entry.pAgentic,
        entry.pElo,
        entry.pAccuracy,
      ];
      const signals = [pIntelligence, pCoding, pAgentic, pElo, pAccuracy].filter(
        (v): v is number => v !== null,
      );
      if (signals.length === 0) return undefined;
      const quality = pIntelligence ?? signals.reduce((a, b) => a + b, 0) / signals.length;

      const fitness: Partial<Record<TaskClass, number>> = {};
      const pair = (a: number | null, b: number | null): number | null =>
        a === null && b === null ? null : round3(((a ?? (b as number)) + (b ?? (a as number))) / 2);

      // A coding index is a direct measure of coding, and partial evidence for
      // the classes that surround it. The correspondences are limited to where
      // they are real: a coding index says nothing about debate or design.
      if (entry.pCoding !== null) {
        fitness.coding = entry.pCoding;
        const review = pair(entry.pCoding, quality);
        if (review !== null) {
          fitness.review = review;
          fitness.testing = review;
          fitness.architecture = review;
        }
      }
      // Agentic measures tool use and multi-step execution, which is what ops,
      // planning and a convergence workshop are.
      if (entry.pAgentic !== null) {
        fitness.ops = entry.pAgentic;
        const plan = pair(entry.pAgentic, quality);
        if (plan !== null) {
          fitness.planning = plan;
          fitness.workshop = plan;
        }
      }
      // The creative counterpart, and the reason design-arena is worth parsing.
      if (entry.pElo !== null) fitness.design = entry.pElo;
      // A knowledge benchmark is the nearest thing to `research` we have.
      if (entry.pAccuracy !== null) fitness.research = entry.pAccuracy;

      // More independent indices means more to go on. A model measured only by a
      // design arena gets the least confidence of all, because its overall
      // quality is standing in on a single peripheral measurement.
      const indices = [entry.pIntelligence, entry.pCoding, entry.pAgentic].filter((v) => v !== null).length;
      const confidence = indices >= 2 ? 0.6 : indices === 1 ? 0.5 : 0.35;

      const percentile = Math.round(quality * 100);
      return {
        source: 'pooled',
        quality: round3(clamp01(quality)),
        fitness,
        // Below an operator's correction and no higher than this office's own
        // observations: a benchmark measured somebody else's workload.
        confidence,
        attribution: `${BENCHMARK_ATTRIBUTION} — top ${100 - percentile}% of ${modelCount} benchmarked model(s), ${entry.displayName}`,
        ...(fetchedAt !== null ? { at: fetchedAt } : {}),
      };
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
        options.log?.('warn', 'benchmarks', 'benchmark cache was not a version 1 file; ignoring it');
        return 0;
      }
      const at = num(parsed['fetchedAt']) ?? now();
      const entries: BenchmarkEntry[] = [];
      for (const raw of parsed['entries']) {
        if (!isRecord(raw) || typeof raw['permaslug'] !== 'string' || !Array.isArray(raw['keys'])) continue;
        entries.push({
          source: typeof raw['source'] === 'string' ? raw['source'] : 'unknown',
          permaslug: raw['permaslug'],
          displayName: typeof raw['displayName'] === 'string' ? raw['displayName'] : raw['permaslug'],
          keys: raw['keys'].filter((k): k is string => typeof k === 'string'),
          bareKey: typeof raw['bareKey'] === 'string' ? raw['bareKey'] : bareKey(raw['permaslug']),
          intelligence: num(raw['intelligence']),
          coding: num(raw['coding']),
          agentic: num(raw['agentic']),
          pIntelligence: num(raw['pIntelligence']),
          pCoding: num(raw['pCoding']),
          pAgentic: num(raw['pAgentic']),
          arena: typeof raw['arena'] === 'string' ? raw['arena'] : null,
          category: typeof raw['category'] === 'string' ? raw['category'] : null,
          elo: num(raw['elo']),
          pElo: num(raw['pElo']),
          benchmarkType: typeof raw['benchmarkType'] === 'string' ? raw['benchmarkType'] : null,
          accuracy: num(raw['accuracy']),
          pAccuracy: num(raw['pAccuracy']),
        });
      }
      if (entries.length === 0) return 0;
      record(entries, at);
      return entries.length;
    },

    saveCache(): void {
      if (options.cachePath === null) return;
      const file = {
        version: CACHE_VERSION,
        fetchedAt: fetchedAt ?? now(),
        attribution: BENCHMARK_ATTRIBUTION,
        entries: [...new Map([...byKey.values()].map((e) => [e.permaslug + '::' + e.source, e])).values()],
      };
      try {
        mkdirSync(dirname(options.cachePath), { recursive: true });
        writeFileSync(options.cachePath, JSON.stringify(file), 'utf8');
      } catch (err) {
        options.log?.(
          'warn',
          'benchmarks',
          `could not save the benchmark cache: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    coverage: () => ({
      entries: rowCount,
      models: modelCount,
      measured: measuredCount,
      fetchedAt,
      attribution: BENCHMARK_ATTRIBUTION,
    }),
  };
}
