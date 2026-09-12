/**
 * The provider registry: one adapter per configured provider, the merged model
 * catalog, and the fail-over chat loop.
 *
 * In `mock` mode every provider is served by the mock implementation but keeps
 * its real id/label/models, so the full catalog stays routable and the UI still
 * shows the true provider list (just scripted, not billed).
 */

import type { ModelOverride, ModelSignals, ModelSpec, QualityOpinion } from '@dev3d/core';
import type { ProviderConfig, ServerConfig } from '../config.ts';
import { isProviderConfigured } from '../config.ts';
import type { ChatRequest, ChatResult, LlmProvider } from './types.ts';
import { modelsForProvider } from './catalog.ts';
import { createDiscoveryService, type DiscoveryMode, type DiscoveryService } from './discovery.ts';
import { applyOpinions, blendQuality, operatorOpinion } from './quality.ts';
import { createOpenAICompatProvider } from './openaiCompat.ts';
import { createAnthropicProvider } from './anthropic.ts';
import { createMockProvider } from './mock.ts';

export interface RegistryStatus {
  id: string;
  label: string;
  configured: boolean;
  ok: boolean | null;
  detail: string | null;
  modelCount: number;
  /** The plugin that contributed this provider, or null for a built-in one. */
  pluginId: string | null;
  /**
   * How this provider's model list was obtained. `discovered` means the vendor
   * told us; `seed` means we never asked; `degraded` means we asked and could
   * not get an answer, so the curated catalog is standing in.
   */
  modelSource: DiscoveryMode;
  /** Why discovery failed, when it did. */
  modelSourceDetail: string | null;
  /** When the model list was last obtained, in epoch milliseconds. */
  discoveredAt: number | null;
}

export interface ProviderRegistry {
  all(): LlmProvider[];
  get(id: string): LlmProvider | undefined;
  status(): RegistryStatus[];
  models(): ModelSpec[];
  /** The subset of `models()` that is actually reachable, for routing. */
  routableModels(): ModelSpec[];
  findModel(modelId: string): ModelSpec | undefined;
  /** Rebuild the adapter list, picking up providers plugins have contributed. */
  refreshProviders(): void;
  /** The discovery service, so the console can trigger and read it. */
  discovery: DiscoveryService;
  /**
   * Observed upstream uptime for a model, or undefined when nothing is known.
   * Undefined for every model when endpoint health is switched off.
   */
  reliability(spec: ModelSpec): number | undefined;
  /** Coverage of the quality signals the router weighs. */
  signals(): ModelSignals;
  /** True when the whole office is running scripted (no billing). */
  mock: boolean;
  /** Walk `primary` then `fallbacks` on provider/transport failure. */
  chat(
    primary: { providerId: string; modelId: string },
    fallbacks: Array<{ providerId: string; modelId: string }>,
    req: Omit<ChatRequest, 'model'>,
  ): Promise<{ result: ChatResult; used: { providerId: string; modelId: string }; attempted: string[] }>;
}

export interface RegistryOptions {
  /**
   * Extra catalog entries, typically contributed by plugins. Read on every use
   * rather than captured, so enabling or disabling a plugin takes effect at once.
   */
  extraModels?: () => ModelSpec[];
  /** Model ids switched off for the whole installation, from office settings. */
  disabledModelIds?: () => string[];
  /**
   * Per-model corrections from office settings, keyed by model id. Read on every
   * use, so a price edited on the Settings page changes routing and reporting on
   * the next turn rather than on the next restart.
   */
  modelOverrides?: () => Record<string, ModelOverride>;
  /**
   * Whole providers contributed by plugins. Read when the list is (re)built:
   * unlike models, an adapter is an object with a base URL and a credential, so
   * the registry rebuilds rather than overlaying. `refreshProviders()` is how a
   * plugin being enabled or disabled takes effect without a restart.
   */
  extraProviders?: () => ProviderConfig[];
  /**
   * Where to report a plugin model aimed at a provider nobody declared. Such a
   * model can never be served, and silently dropping it would leave an operator
   * looking at a plugin that says it contributes three models and a catalog that
   * shows none.
   */
  log?: (level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string) => void;
  /**
   * Quality opinions from sources outside the catalog: what the office has
   * observed from its own turns, and what a benchmark aggregator published.
   *
   * Asked for **one model at a time**, and read on every use, so a finished turn
   * or a refreshed index shows up in routing without a restart. It is a
   * resolver rather than a map on purpose: a map would have to be built for the
   * whole catalog before the catalog exists.
   *
   * It may return several opinions, and they all blend: an office with an
   * OpenRouter key has a benchmark-derived opinion *and* whatever it learned
   * from its own turns, and keeping the sources distinct is the point.
   */
  extraOpinions?: (spec: ModelSpec) => readonly QualityOpinion[];
  /**
   * Observed upstream uptime for a model, 0..1, or undefined when unknown.
   *
   * A demotion signal, not a filter: see `router/score.ts`. Undefined must mean
   * "no opinion", never "zero", or every model outside the measured provider set
   * would lose to every model inside it.
   */
  reliability?: (spec: ModelSpec) => number | undefined;
  /**
   * Coverage of the quality signals, for the console.
   *
   * Supplied from outside because the registry owns only discovery and the
   * catalog; the learned, benchmark and health services live with the runtime
   * that starts them.
   */
  signals?: () => ModelSignals;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Apply an operator's correction to a catalog model.
 *
 * Returns the same object when there is nothing to change, so the common case
 * costs no allocation and the catalog's own description of a model survives
 * untouched.
 */
function applyOverride(model: ModelSpec, override: ModelOverride | undefined): ModelSpec {
  if (override === undefined) return model;
  const next: ModelSpec = { ...model };
  if (override.tier !== undefined) next.tier = override.tier;
  if (override.costPerMTokIn !== undefined) next.costPerMTokIn = override.costPerMTokIn;
  if (override.costPerMTokOut !== undefined) next.costPerMTokOut = override.costPerMTokOut;
  // A quality correction joins the blend as the loudest opinion, so an operator
  // who has actually run the model outranks a benchmark that measured somebody
  // else's workload. The measured opinions are kept for display, not discarded.
  if (override.quality !== undefined || override.fitness !== undefined) {
    next.quality = blendQuality([
      ...(next.quality?.opinions ?? []),
      operatorOpinion(override.quality ?? next.quality?.quality ?? 0.5, override.fitness ?? {}),
    ]);
  }
  return next;
}

export function createProviderRegistry(config: ServerConfig, options: RegistryOptions = {}): ProviderRegistry {  let providerConfigs: ProviderConfig[] = [];
  let providers: LlmProvider[] = [];
  let byId = new Map<string, LlmProvider>();

  /**
   * What each provider actually serves.
   *
   * Built before the adapters so `build()` can consult it, and given a thunk
   * over the live adapter list rather than a snapshot, because a plugin being
   * enabled or disabled replaces that list.
   */
  const discovery = createDiscoveryService({
    providers: () => providers,
    isConfigured: (providerId) => {
      const cfg = providerConfigs.find((c) => c.id === providerId);
      return cfg !== undefined && isProviderConfigured(cfg);
    },
    ttlMs: config.discoveryTtlMs,
    cachePath: config.discoveryCachePath,
    ...(options.log !== undefined ? { log: options.log } : {}),
  });

  // Pick up whatever the last run cached, so a restart does not need every
  // vendor to be reachable before the catalog is right.
  if (config.modelDiscovery) discovery.loadCache();

  /**
   * (Re)build every adapter. A plugin cannot shadow a built-in provider: the
   * first declaration of an id wins, and the built-ins are always first, so
   * `DEV3D_*` configuration stays authoritative over a manifest.
   */
  function build(): void {
    const next: LlmProvider[] = [];
    const nextById = new Map<string, LlmProvider>();
    const configs: ProviderConfig[] = [];
    for (const cfg of [...config.providers, ...(options.extraProviders?.() ?? [])]) {
      if (nextById.has(cfg.id)) continue;
      const catalogModels = modelsForProvider(cfg.id);
      let provider: LlmProvider;
      if (config.llmMode === 'mock' || cfg.kind === 'mock') {
        provider = createMockProvider(cfg, catalogModels);
      } else if (cfg.kind === 'anthropic') {
        provider = createAnthropicProvider(cfg);
        provider.models = catalogModels;
      } else {
        provider = createOpenAICompatProvider(cfg);
        provider.models = catalogModels;
      }
      configs.push(cfg);
      next.push(provider);
      nextById.set(cfg.id, provider);
    }
    providerConfigs = configs;
    providers = next;
    byId = nextById;

    // A plugin model for a provider that does not exist is invisible, because
    // the catalog is built per provider. Say so once per rebuild rather than
    // letting a plugin's model count disagree with the catalog in silence.
    const known = new Set(configs.map((cfg) => cfg.id));
    const orphans = (options.extraModels?.() ?? []).filter((model) => !known.has(model.providerId));
    if (orphans.length > 0) {
      const ids = [...new Set(orphans.map((model) => model.providerId))];
      options.log?.(
        'warn',
        'registry',
        `${orphans.length} plugin model(s) target ${ids.join(', ')}, which no provider serves; ` +
          'a plugin must contribute the provider as well as its models.',
      );
    }
  }

  build();

  /**
   * The catalog a provider actually serves.
   *
   * Membership comes from discovery when we have it, and from the curated seed
   * when we do not - a provider with no list endpoint, an install with discovery
   * switched off, a vendor that is down, or an office running in `mock` mode,
   * where the whole catalog must stay demonstrable without a key.
   *
   * Plugin entries and operator corrections are applied on top either way. Plugin
   * models for a provider that is not configured are still catalogued so the UI
   * can show them, but no adapter will serve them.
   */
  function modelsFor(providerId: string): ModelSpec[] {
    const disabled = new Set(options.disabledModelIds?.() ?? []);
    const overrides = options.modelOverrides?.() ?? {};
    const base = modelBasisFor(providerId);
    const extra = (options.extraModels?.() ?? []).filter((model) => model.providerId === providerId);
    const seen = new Set<string>();
    const out: ModelSpec[] = [];
    for (const model of [...base, ...extra]) {
      if (disabled.has(model.id) || seen.has(model.id)) continue;
      seen.add(model.id);
      out.push(applyOverride(model, overrides[model.id]));
    }
    // Learned and pooled opinions blend over whatever the catalog and the
    // operator established, so the router ranks on everything known about a
    // model rather than only the part that shipped with the checkout.
    if (options.extraOpinions === undefined) return out;
    return applyOpinions(out, options.extraOpinions);
  }

  /**
   * What a provider offers before plugins and corrections: what it told us, or
   * the curated seed.
   *
   * `mock` mode always uses the seed. The mock adapter serves every provider, so
   * excluding a model because a *real* vendor does not offer it would make the
   * keyless office less capable than the billed one - the opposite of the
   * promise that the whole pipeline is demonstrable with no keys.
   */
  function modelBasisFor(providerId: string): ModelSpec[] {
    if (config.llmMode !== 'mock' && config.modelDiscovery) {
      const discovered = discovery.modelsFor(providerId);
      if (discovered !== null) return discovered;
    }
    return providers.find((p) => p.id === providerId)?.models ?? [];
  }

  const allModels = (): ModelSpec[] => providers.flatMap((p) => modelsFor(p.id));

  /**
   * The models a turn may actually be routed to.
   *
   * In `live` mode that excludes every provider the installation cannot reach -
   * one with no key and no keyless base URL. Routing to one of those is not a
   * fallback, it is a guaranteed failed turn, and with plugins able to add
   * providers it became easy to do by accident: declare a provider, forget the
   * key, and every turn aimed at it dies.
   *
   * In `mock` mode there is nothing to exclude: the mock adapter serves every
   * provider, so the full catalog stays routable and the office remains
   * demonstrable without a single key.
   */
  function routableModels(): ModelSpec[] {
    if (config.llmMode === 'mock') return allModels();
    return providers
      .filter((p) => {
        const cfg = providerConfigs.find((c) => c.id === p.id);
        return cfg !== undefined && isProviderConfigured(cfg);
      })
      .flatMap((p) => modelsFor(p.id));
  }

  return {
    mock: config.llmMode === 'mock',
    all: () => providers.slice(),
    get: (id) => byId.get(id),
    refreshProviders: build,
    discovery,
    reliability: (spec) => options.reliability?.(spec),
    signals: () =>
      options.signals?.() ?? {
        benchmarks: {
          enabled: false,
          entries: 0,
          models: 0,
          measured: 0,
          fetchedAt: null,
          attribution: '',
          detail: 'benchmark quality is switched off',
        },
        health: { enabled: false, known: 0, fetchedAt: null },
        learned: { models: 0, samples: 0 },
      },
    status: () =>
      providers.map((p) => {
        const cfg = providerConfigs.find((c) => c.id === p.id);
        const report = discovery.report(p.id);
        const mode = discovery.modeFor(p.id);
        return {
          id: p.id,
          label: p.label,
          configured: cfg ? isProviderConfigured(cfg) : false,
          ok: report === undefined ? null : report.ok,
          detail: report?.error ?? null,
          // The merged catalog, not just what the adapter shipped with: a
          // plugin can add models to a built-in provider, and a count that
          // disagreed with the model list would be a bug report waiting to happen.
          modelCount: modelsFor(p.id).length,
          pluginId: cfg?.pluginId ?? null,
          modelSource: mode,
          modelSourceDetail:
            mode === 'degraded' ? (report?.error ?? 'discovery failed') : null,
          discoveredAt: report?.at ?? null,
        };
      }),
    models: allModels,
    routableModels,
    findModel: (modelId) => allModels().find((m) => m.id === modelId),

    async chat(primary, fallbacks, req) {
      const candidates = [primary, ...fallbacks];
      const attempted: string[] = [];

      for (const cand of candidates) {
        const provider = byId.get(cand.providerId);
        // Look the model up in the merged catalog, so a plugin-contributed model
        // is callable through the same failover loop as a built-in one.
        const model = modelsFor(cand.providerId).find((m) => m.id === cand.modelId);
        const key = `${cand.providerId}/${cand.modelId}`;

        if (!provider || !model) {
          attempted.push(`${key} (unavailable)`);
          continue;
        }

        try {
          const result = await provider.chat({ ...req, model });
          return {
            result,
            used: { providerId: cand.providerId, modelId: cand.modelId },
            attempted,
          };
        } catch (err) {
          // A user-initiated abort is not a transport failure to route around.
          if (req.signal?.aborted) throw err;
          attempted.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const summary = attempted.length > 0 ? attempted.join('; ') : 'no candidates';
      throw new Error(`all model routes failed: ${summary}`);
    },
  };
}
