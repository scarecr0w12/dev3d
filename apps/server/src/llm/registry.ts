/**
 * The provider registry: one adapter per configured provider, the merged model
 * catalog, and the fail-over chat loop.
 *
 * In `mock` mode every provider is served by the mock implementation but keeps
 * its real id/label/models, so the full catalog stays routable and the UI still
 * shows the true provider list (just scripted, not billed).
 */

import type { ModelOverride, ModelSpec } from '@dev3d/core';
import type { ProviderConfig, ServerConfig } from '../config.ts';
import { isProviderConfigured } from '../config.ts';
import type { ChatRequest, ChatResult, LlmProvider } from './types.ts';
import { modelsForProvider } from './catalog.ts';
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
  return next;
}

export function createProviderRegistry(config: ServerConfig, options: RegistryOptions = {}): ProviderRegistry {  let providerConfigs: ProviderConfig[] = [];
  let providers: LlmProvider[] = [];
  let byId = new Map<string, LlmProvider>();

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
   * The catalog a provider actually serves: what it shipped with, plus any
   * plugin entries aimed at it, minus whatever the operator disabled. Plugin
   * models for a provider that is not configured are still catalogued so the UI
   * can show them, but no adapter will serve them.
   */
  function modelsFor(providerId: string): ModelSpec[] {
    const disabled = new Set(options.disabledModelIds?.() ?? []);
    const overrides = options.modelOverrides?.() ?? {};
    const base = providers.find((p) => p.id === providerId)?.models ?? [];
    const extra = (options.extraModels?.() ?? []).filter((model) => model.providerId === providerId);
    const seen = new Set<string>();
    const out: ModelSpec[] = [];
    for (const model of [...base, ...extra]) {
      if (disabled.has(model.id) || seen.has(model.id)) continue;
      seen.add(model.id);
      out.push(applyOverride(model, overrides[model.id]));
    }
    return out;
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
    status: () =>
      providers.map((p) => {
        const cfg = providerConfigs.find((c) => c.id === p.id);
        return {
          id: p.id,
          label: p.label,
          configured: cfg ? isProviderConfigured(cfg) : false,
          ok: null,
          detail: null,
          // The merged catalog, not just what the adapter shipped with: a
          // plugin can add models to a built-in provider, and a count that
          // disagreed with the model list would be a bug report waiting to happen.
          modelCount: modelsFor(p.id).length,
          pluginId: cfg?.pluginId ?? null,
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
