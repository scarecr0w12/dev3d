/**
 * How reliably a model can actually be served, from OpenRouter's endpoint list.
 *
 * `GET /api/v1/models/{author}/{slug}/endpoints` needs **no API key** and reports
 * every upstream OpenRouter would route a model to. Measured across 34 endpoints
 * for six models, the field coverage is the whole story:
 *
 * | field | populated |
 * |---|---|
 * | `uptime_last_30m` | **79%** |
 * | `latency_last_30m` | **0%** |
 * | `throughput_last_30m` | **0%** |
 *
 * So this tracks **uptime and nothing else**. Latency and throughput are
 * documented fields that are simply empty in the live payload; building a
 * speed-aware router on them would have been building on zeros. The reader is
 * written to pick them up if they ever appear, but nothing depends on them.
 *
 * ## Why "best uptime" is the right aggregate
 *
 * A model on OpenRouter has several upstream endpoints, and OpenRouter routes
 * around a sick one. So the question the router needs answered is "will a call
 * to this model succeed", and the answer is the health of the *best* endpoint
 * available, not the average. The count of healthy endpoints is kept alongside
 * it, because "the only one of twelve still standing" is a fragile position that
 * an average would hide and a count makes visible.
 *
 * ## Fetching is on demand, and never blocks a turn
 *
 * This is one HTTP request per model, so polling the whole catalog is not an
 * option: the OpenRouter list alone is 445 models. Instead the router asks for a
 * model's health as it considers it; a model nobody asks about is never fetched,
 * and the set that gets polled is exactly the set in play. An unknown model
 * contributes **nothing** to the score - the same rule quality follows - so the
 * first turn on a new model routes exactly as it would have before this existed,
 * and later turns can see what was learned.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ModelSpec } from '@dev3d/core';

const CACHE_VERSION = 1;

/** The endpoint list lives under the models path, unauthenticated. */
const ENDPOINTS_BASE = 'https://openrouter.ai/api/v1/models';

/**
 * Uptime at or above which an endpoint counts as healthy.
 *
 * 90% over 30 minutes allows for the ordinary blips a provider has; below that a
 * model is genuinely degraded rather than momentarily unlucky.
 */
export const HEALTHY_UPTIME = 0.9;

/** How many models may be in flight at once. Polite, and bounded. */
const MAX_CONCURRENT = 4;

export interface HealthRecord {
  /** Our catalog id, which is what the router looks up. */
  modelId: string;
  /** OpenRouter's own `author/slug`. */
  permaslug: string;
  /** Best uptime across the model's endpoints, 0..1. Null when none reported. */
  uptime: number | null;
  endpointCount: number;
  /** Endpoints at or above `HEALTHY_UPTIME`. */
  healthyCount: number;
  at: number;
}

export interface HealthService {
  /**
   * The best uptime for a model, or undefined when nothing is known.
   *
   * Schedules a background fetch when the answer is unknown or stale, and
   * returns immediately either way.
   */
  uptimeFor(spec: ModelSpec): number | undefined;
  /** The full record, for the console. */
  recordFor(spec: ModelSpec): HealthRecord | undefined;
  /** Fetch now. Awaitable, for tests and the explicit refresh action. */
  refresh(specs: readonly ModelSpec[]): Promise<{ fetched: number; failed: number }>;
  loadCache(): number;
  saveCache(): void;
  status(): { known: number; fetchedAt: number | null; enabled: boolean };
}

export interface HealthOptions {
  /**
   * Provider ids whose models are OpenRouter permaslugs underneath.
   *
   * Only those can be asked about: for a direct DeepSeek or Anthropic key,
   * OpenRouter's upstream routing is somebody else's infrastructure and says
   * nothing about the call this office will make.
   */
  providerIds: readonly string[];
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

/** The model id the router knows, and the slug OpenRouter does. */
export function slugFor(spec: ModelSpec, providerIds: readonly string[]): { modelId: string; permaslug: string } | null {
  if (!providerIds.includes(spec.providerId)) return null;
  const prefix = `${spec.providerId}/`;
  const rest = spec.id.startsWith(prefix) ? spec.id.slice(prefix.length) : spec.id;
  // OpenRouter slugs are always `author/slug`; anything else is not one.
  if (!rest.includes('/') || rest.length < 3) return null;
  return { modelId: spec.id, permaslug: rest };
}

/** Aggregate one model's endpoint list into a single reliability record. */
export function aggregateEndpoints(modelId: string, permaslug: string, endpoints: unknown[], at: number): HealthRecord {
  let best: number | null = null;
  let healthy = 0;

  for (const raw of endpoints) {
    if (!isRecord(raw)) continue;
    // Prefer the 30-minute window: long enough to be stable, short enough to
    // notice a provider having a bad afternoon.
    const uptime = num(raw['uptime_last_30m']) ?? num(raw['uptime_last_5m']) ?? num(raw['uptime_last_1d']);
    if (uptime === null) continue;
    // The API reports a percentage, but accept a fraction if one ever appears.
    const fraction = uptime > 1 ? uptime / 100 : uptime;
    if (fraction < 0 || fraction > 1) continue;
    if (best === null || fraction > best) best = fraction;
    if (fraction >= HEALTHY_UPTIME) healthy += 1;
  }

  return { modelId, permaslug, uptime: best, endpointCount: endpoints.length, healthyCount: healthy, at };
}

export function createHealthService(options: HealthOptions): HealthService {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const records = new Map<string, HealthRecord>();
  /** Model ids with a request in flight, so one model is never fetched twice. */
  const inFlight = new Set<string>();
  const queue: ModelSpec[] = [];
  let active = 0;
  let lastFetchAt: number | null = null;

  function isFresh(record: HealthRecord | undefined): boolean {
    if (record === undefined) return false;
    if (options.ttlMs <= 0) return false;
    return now() - record.at < options.ttlMs;
  }

  async function fetchOne(spec: ModelSpec): Promise<boolean> {
    const slug = slugFor(spec, options.providerIds);
    if (slug === null) return false;

    // Each path segment is encoded separately: a slug is two segments with a
    // slash between them, and encoding the whole thing would encode the slash.
    const url = `${ENDPOINTS_BASE}/${slug.permaslug.split('/').map(encodeURIComponent).join('/')}/endpoints`;
    try {
      const resp = await doFetch(url, { method: 'GET', headers: { accept: 'application/json' } });
      if (!resp.ok) {
        options.log?.('debug', 'health', `${spec.id}: endpoint list returned HTTP ${resp.status}`);
        return false;
      }
      const body = (await resp.json()) as unknown;
      const endpoints = isRecord(body) && isRecord(body['data']) && Array.isArray(body['data']['endpoints'])
        ? (body['data']['endpoints'] as unknown[])
        : [];
      records.set(slug.modelId, aggregateEndpoints(slug.modelId, slug.permaslug, endpoints, now()));
      lastFetchAt = now();
      return true;
    } catch (err) {
      // A health lookup is a nicety. It never fails a turn and never logs loudly.
      options.log?.('debug', 'health', `${spec.id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Drain the queue, bounded.
   *
   * Recursive rather than a loop so the concurrency cap is enforced by the
   * number of live chains; each chain pulls the next item when it finishes.
   */
  function pump(): void {
    while (active < MAX_CONCURRENT && queue.length > 0) {
      const spec = queue.shift();
      if (spec === undefined) return;
      if (records.has(spec.id) && isFresh(records.get(spec.id))) {
        inFlight.delete(spec.id);
        continue;
      }
      active += 1;
      void fetchOne(spec).finally(() => {
        active -= 1;
        inFlight.delete(spec.id);
        pump();
      });
    }
  }

  return {
    uptimeFor(spec) {
      const key = slugFor(spec, options.providerIds)?.modelId;
      if (key === undefined) return undefined;

      const record = records.get(key);
      if (isFresh(record)) return record?.uptime ?? undefined;

      // Unknown or stale: queue it and answer with what we have, which may be
      // nothing. Never awaited - routing must not wait on a network round trip.
      if (!inFlight.has(key)) {
        inFlight.add(key);
        queue.push(spec);
        pump();
      }
      return record?.uptime ?? undefined;
    },

    recordFor(spec) {
      const key = slugFor(spec, options.providerIds)?.modelId;
      return key === undefined ? undefined : records.get(key);
    },

    async refresh(specs) {
      const targets = specs.filter((spec) => slugFor(spec, options.providerIds) !== null);
      let fetched = 0;
      let failed = 0;
      // Sequential here rather than through the queue: an explicit refresh is
      // allowed to take a moment, and awaiting it gives the caller a real answer.
      for (const spec of targets) {
        const ok = await fetchOne(spec);
        if (ok) fetched += 1;
        else failed += 1;
      }
      return { fetched, failed };
    },

    loadCache(): number {
      if (options.cachePath === null) return 0;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(options.cachePath, 'utf8')) as unknown;
      } catch {
        return 0;
      }
      if (!isRecord(parsed) || parsed['version'] !== CACHE_VERSION || !Array.isArray(parsed['records'])) {
        options.log?.('warn', 'health', 'endpoint health cache was not a version 1 file; ignoring it');
        return 0;
      }
      let loaded = 0;
      for (const raw of parsed['records']) {
        if (!isRecord(raw)) continue;
        const modelId = raw['modelId'];
        const permaslug = raw['permaslug'];
        const at = num(raw['at']);
        if (typeof modelId !== 'string' || typeof permaslug !== 'string' || at === null) continue;
        const uptime = num(raw['uptime']);
        records.set(modelId, {
          modelId,
          permaslug,
          uptime: uptime === null ? null : Math.max(0, Math.min(1, uptime > 1 ? uptime / 100 : uptime)),
          endpointCount: num(raw['endpointCount']) ?? 0,
          healthyCount: num(raw['healthyCount']) ?? 0,
          at,
        });
        loaded += 1;
      }
      const fetched = num(parsed['fetchedAt']);
      if (fetched !== null) lastFetchAt = fetched;
      return loaded;
    },

    saveCache(): void {
      if (options.cachePath === null) return;
      const file = {
        version: CACHE_VERSION,
        fetchedAt: lastFetchAt ?? now(),
        records: [...records.values()],
      };
      try {
        mkdirSync(dirname(options.cachePath), { recursive: true });
        writeFileSync(options.cachePath, JSON.stringify(file), 'utf8');
      } catch (err) {
        options.log?.(
          'warn',
          'health',
          `could not save the endpoint health cache: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    status: () => ({ known: records.size, fetchedAt: lastFetchAt, enabled: options.cachePath !== null }),
  };
}
