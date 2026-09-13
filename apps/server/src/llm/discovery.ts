/**
 * Asking each provider what it actually serves, and remembering the answer.
 *
 * The catalog used to be a literal, which meant it was wrong the moment a vendor
 * shipped or retired a model. A live office was routing to
 * `deepseek-v4-flash-vision-exp`, a model the DeepSeek endpoint does not serve
 * and never did - the kind of bug that only shows up as a failed turn.
 *
 * Three rules shape this module, and all three are about not making things
 * worse than the static list was:
 *
 *  1. **Discovery is optional and never fatal.** No list endpoint, no key, no
 *     network, a hostile response - every one of those degrades to the curated
 *     seed. The office boots and routes either way.
 *  2. **"I could not ask" is not "there are none".** A failed attempt is recorded
 *     *as a failure* and the curated seed is kept, so a vendor outage cannot
 *     empty the catalog and halt every run.
 *  3. **A result is cached on disk.** Discovery is a network round trip per
 *     provider; doing it on every boot would make startup depend on somebody
 *     else's uptime.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DiscoveredModel, DiscoveryReport, ModelSpec } from '@dev3d/core';
import type { LlmProvider } from './types.ts';
import { curatedEntry, curatedIdsForProvider, mergeCurated } from './catalog.ts';

/** How a provider's catalog entries were obtained. */
export type DiscoveryMode =
  /** The provider told us, and we believe it. */
  | 'discovered'
  /** We asked and could not get an answer; the curated seed is standing in. */
  | 'degraded'
  /** We never asked - mock mode, or a provider with no list endpoint. */
  | 'seed';

export interface DiscoveryService {
  /**
   * Ask one provider. Never throws: a failure becomes a report with `ok: false`.
   * Returns null when no such provider is loaded.
   */
  discover(providerId: string, opts?: { force?: boolean }): Promise<DiscoveryReport | null>;
  /** Ask every provider that has a list endpoint. */
  discoverAll(opts?: { force?: boolean; onlyConfigured?: boolean }): Promise<DiscoveryReport[]>;
  /** The latest report for a provider, if one has ever run. */
  report(providerId: string): DiscoveryReport | undefined;
  reports(): DiscoveryReport[];
  /** How this provider's entries were obtained. */
  modeFor(providerId: string): DiscoveryMode;
  /**
   * The catalog this provider serves, or null when discovery has nothing to say
   * and the caller should use the curated seed.
   */
  modelsFor(providerId: string): ModelSpec[] | null;
  /** Read a previously saved result set, ignoring anything malformed. */
  loadCache(): number;
  /** Write the current results for the next boot. Best effort. */
  saveCache(): void;
}

export interface DiscoveryOptions {
  /** Resolves the loaded adapters, which changes when plugins reload. */
  providers: () => LlmProvider[];
  /** Providers an operator actually configured, for `onlyConfigured`. */
  isConfigured?: (providerId: string) => boolean;
  /**
   * Whether this provider is a local runtime, such as LM Studio or Ollama.
   *
   * Used only to choose a log level. A keyless local endpoint is reachable in
   * principle but usually is not running, so a failed list is the expected state
   * of an install rather than a fault to report at every boot: nothing here is
   * misconfigured, and the step that would fix it is starting a program the
   * office does not manage. The fallback is the same either way - the curated
   * catalog stands in - so the report is kept and only the volume changes.
   */
  isLocal?: (providerId: string) => boolean;
  /** How long a result stays fresh. `0` always re-asks. */
  ttlMs: number;
  /** Where results are cached. */
  cachePath: string | null;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string) => void;
  /** Injected for tests; defaults to the global fetch through the adapter. */
  now?: () => number;
}

/** The on-disk shape. Versioned so a future change can refuse an old file. */
interface CacheFile {
  version: 1;
  savedAt: number;
  reports: Array<{ providerId: string; at: number; ok: boolean; error: string | null; models: DiscoveredModel[] }>;
}

const CACHE_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turn a provider's model list into catalog entries.
 *
 * Membership comes from the provider; tier, quality and (where the provider is
 * silent) price come from the curated overlay. A model the overlay has never
 * heard of is still returned, flagged `unrated`, so a brand-new release is
 * routable immediately instead of waiting for somebody to edit a table.
 */
export function specsFromDiscovered(providerId: string, models: DiscoveredModel[]): ModelSpec[] {
  return models.map((model) => mergeCurated(providerId, model, curatedEntry(providerId, model.id)));
}

/**
 * Models the curated table describes for this provider but discovery did not
 * report.
 *
 * Surfaced rather than deleted: an operator who has been paying for a model that
 * their provider no longer offers should be told, not left wondering why their
 * routing changed. It is also how a stale curated entry becomes visible instead
 * of silently vanishing.
 */
export function curatedButMissing(providerId: string, discovered: DiscoveredModel[]): string[] {
  const seen = new Set(discovered.map((model) => model.id));
  return curatedIdsForProvider(providerId).filter((id) => !seen.has(id));
}

/**
 * Bound one provider's model-list call.
 *
 * The built-in adapters bound their own `fetch`, so this is the backstop for a
 * provider contributed by a plugin: a `listModels` that returns a promise which
 * never settles must not stall discovery for every provider behind it in the
 * sequential walk.
 */
function withDiscoveryDeadline<T>(work: Promise<T>, providerId: string): Promise<T> {
  return new Promise<T>((settle, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${providerId}: the model list did not answer within ${DISCOVERY_DEADLINE_MS}ms.`));
    }, DISCOVERY_DEADLINE_MS);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        settle(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** How long one provider's model list may take before it is written off. */
const DISCOVERY_DEADLINE_MS = 90_000;

export function createDiscoveryService(options: DiscoveryOptions): DiscoveryService {  const now = options.now ?? (() => Date.now());
  const reports = new Map<string, DiscoveryReport>();
  /** The merged catalog per provider, kept beside the raw report. */
  const specs = new Map<string, ModelSpec[]>();

  function providerFor(id: string): LlmProvider | undefined {
    return options.providers().find((provider) => provider.id === id);
  }

  function isFresh(report: DiscoveryReport | undefined): boolean {
    if (report === undefined) return false;
    if (options.ttlMs <= 0) return false;
    return now() - report.at < options.ttlMs;
  }

  function record(report: DiscoveryReport): void {
    reports.set(report.providerId, report);
    if (report.ok) {
      specs.set(report.providerId, specsFromDiscovered(report.providerId, report.models));
    } else {
      // A failure withdraws the discovered set so the caller falls back to the
      // seed, rather than keeping a stale answer we can no longer vouch for.
      specs.delete(report.providerId);
    }
  }

  async function discover(
    providerId: string,
    opts: { force?: boolean } = {},
  ): Promise<DiscoveryReport | null> {
    const provider = providerFor(providerId);
    if (provider === undefined) return null;

    const existing = reports.get(providerId);
    // A caller may still need the *call* to happen when it asked explicitly;
    // `force` is what the Discover button sends.
    if (!opts.force && isFresh(existing)) return existing ?? null;

    const started = now();

    if (typeof provider.listModels !== 'function') {
      const report: DiscoveryReport = {
        providerId,
        ok: false,
        models: [],
        error: 'this provider has no model-list endpoint; the curated catalog is in use',
        durationMs: 0,
        at: started,
      };
      reports.set(providerId, report);
      specs.delete(providerId);
      return report;
    }

    try {
      // An outer bound as well as the adapters' own timeouts. The adapters are
      // bounded, but a plugin may contribute a provider of its own, and one
      // that never answers must not hold up every provider after it in this
      // sequential walk.
      const models = await withDiscoveryDeadline(provider.listModels(), providerId);
      const report: DiscoveryReport = {
        providerId,
        ok: true,
        models,
        error: null,
        durationMs: now() - started,
        at: now(),
      };
      record(report);

      const missing = curatedButMissing(providerId, models);
      if (missing.length > 0) {
        options.log?.(
          'info',
          'discovery',
          `${providerId}: ${missing.length} curated model(s) were not reported and are no longer routable: ${missing.join(', ')}`,
        );
      }
      options.log?.('debug', 'discovery', `${providerId}: ${models.length} model(s) in ${report.durationMs}ms`);
      return report;
    } catch (err) {
      const report: DiscoveryReport = {
        providerId,
        ok: false,
        models: [],
        error: err instanceof Error ? err.message : String(err),
        durationMs: now() - started,
        at: now(),
      };
      record(report);
      // A local runtime that is not running is the normal case, not a fault, so
      // it does not get a warning. Everything else does, because an unreachable
      // remote provider is something an operator can and should act on.
      const level = options.isLocal?.(providerId) === true ? 'debug' : 'warn';
      options.log?.(
        level,
        'discovery',
        `${providerId}: model list unavailable (${report.error}); using the curated catalog`,
      );
      return report;
    }
  }

  return {
    discover,

    async discoverAll(opts: { force?: boolean; onlyConfigured?: boolean } = {}) {
      const targets = options
        .providers()
        .filter((provider) => (opts.onlyConfigured === true ? options.isConfigured?.(provider.id) === true : true));
      // Sequential on purpose: a handful of providers, and a burst of parallel
      // requests at boot is the fastest way to get rate-limited by all of them.
      const out: DiscoveryReport[] = [];
      for (const provider of targets) {
        const report = await discover(provider.id, opts.force === true ? { force: true } : {});
        if (report !== null) out.push(report);
      }
      return out;
    },

    report: (providerId) => reports.get(providerId),
    reports: () => [...reports.values()],

    modeFor(providerId) {
      const report = reports.get(providerId);
      if (report === undefined) return 'seed';
      return report.ok ? 'discovered' : 'degraded';
    },

    modelsFor: (providerId) => specs.get(providerId) ?? null,

    loadCache(): number {
      if (options.cachePath === null) return 0;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(options.cachePath, 'utf8')) as unknown;
      } catch {
        // No cache, or an unreadable one. Not worth a warning: a cold cache is
        // the normal first-boot state.
        return 0;
      }
      if (!isRecord(parsed) || parsed['version'] !== CACHE_VERSION || !Array.isArray(parsed['reports'])) {
        options.log?.('warn', 'discovery', 'model cache was not a version 1 cache file; ignoring it');
        return 0;
      }

      let loaded = 0;
      for (const raw of parsed['reports']) {
        if (!isRecord(raw)) continue;
        const providerId = raw['providerId'];
        const at = raw['at'];
        const ok = raw['ok'];
        if (typeof providerId !== 'string' || typeof at !== 'number' || typeof ok !== 'boolean') continue;
        const models = Array.isArray(raw['models']) ? (raw['models'] as DiscoveredModel[]) : [];
        const error = typeof raw['error'] === 'string' ? raw['error'] : null;
        const report: DiscoveryReport = { providerId, ok, models, error, at, durationMs: 0 };
        // A cached *failure* is loaded too, so `modeFor` can report `degraded`
        // rather than pretending the provider was never asked.
        if (ok) record(report);
        else reports.set(providerId, report);
        loaded += 1;
      }
      return loaded;
    },

    saveCache(): void {
      if (options.cachePath === null) return;
      const file: CacheFile = {
        version: CACHE_VERSION,
        savedAt: now(),
        reports: [...reports.values()].map((report) => ({
          providerId: report.providerId,
          at: report.at,
          ok: report.ok,
          error: report.error,
          // A failed report carries nothing worth persisting beyond the fact of
          // it, so the file stays small when a provider is down.
          models: report.ok ? report.models : [],
        })),
      };
      try {
        mkdirSync(dirname(options.cachePath), { recursive: true });
        writeFileSync(options.cachePath, JSON.stringify(file), 'utf8');
      } catch (err) {
        // A cache that cannot be written costs a network round trip, not a boot.
        options.log?.('warn', 'discovery', `could not save the model cache: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
