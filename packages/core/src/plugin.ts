/**
 * The plugin system's vocabulary.
 *
 * A plugin is a directory with a `plugin.json` manifest and, optionally, a code
 * entry module. It extends the office by *contributing* to the seams the system
 * already has: the model catalog, the skill library, the tool registry, routing
 * policy, agent templates, pipelines, settings and UI.
 *
 * Two deliberate shapes:
 *
 *  - **Declarative plugins** ship only data. A plugin that adds models, skills,
 *    role templates or routing rules needs no code at all, which means it cannot
 *    do anything the manifest does not describe.
 *  - **Code plugins** declare an `entry` and export `activate(api)`. They run in
 *    the orchestrator's process and can register tools and providers, so a plugin
 *    that carries code is marked as such everywhere it is shown.
 *
 * `PLUGIN_API_VERSION` is the compatibility contract. A plugin states the API it
 * was built against; the host refuses a mismatch rather than loading something
 * whose expectations it cannot honour.
 */

import type { ModelSpec, RouteCandidate, TaskClass } from './model.ts';
import type { Pipeline } from './run.ts';
import type { Role } from './org.ts';
import type { ServerEvent } from './events.ts';

/** The plugin API this build implements. Bump only for a breaking change. */
export const PLUGIN_API_VERSION = '1';

/**
 * What a plugin asks to be allowed to touch. Declared in the manifest and shown
 * to the operator before enabling: a plugin that registers tools is asking for
 * something categorically different from one that adds two models.
 */
export type PluginPermission =
  | 'models' // add or retune catalog entries
  | 'providers' // register a provider adapter
  | 'tools' // register tools that execute in the server
  | 'routing' // influence which model a turn gets
  | 'skills' // add skill documents
  | 'agents' // contribute agent/role templates
  | 'pipelines' // contribute pipelines
  | 'settings' // add operator-facing configuration
  | 'ui' // contribute panels and visual tokens
  | 'events'; // observe the event stream

/** A markdown skill contributed by a plugin, inlined in the manifest. */
export interface PluginSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  taskClasses?: string[];
  /** Markdown body, exactly as a `skills/*.md` file would carry. */
  body: string;
}

/**
 * A routing rule. Rules are *preferences*, not overrides: they are consulted
 * when the router builds its candidate order, and the router still refuses to
 * pick a model that cannot do the job.
 */
export interface RoutingRule {
  id: string;
  description: string;
  /** Only apply to this task class. Absent means every task class. */
  taskClass?: TaskClass;
  /** Pin the tier the router aims for. */
  tier?: 'nano' | 'small' | 'standard' | 'strong' | 'max';
  /** Prefer these providers, in order, when several models qualify. */
  preferProviderIds?: string[];
  /** Prefer these exact model ids above everything else that qualifies. */
  preferModelIds?: string[];
  /** A plugin's own model ids that should never be chosen. */
  avoidModelIds?: string[];
}

/**
 * One widget in a declarative panel body.
 *
 * Deliberately a closed set of shapes the console already knows how to draw.
 * A plugin describes *what it wants shown*; the host decides how it looks and
 * never evaluates plugin code in the browser. That is the whole trust model:
 * a marketplace plugin cannot reach the page, the socket or the session,
 * because all it ever contributes is data.
 *
 * Every string here is length-capped by the validator, and every list is
 * row-capped, so a hostile manifest cannot wedge the console with a million-row
 * table.
 */
export type PanelWidget =
  | { kind: 'metric'; label: string; value: string; unit?: string; hint?: string }
  | { kind: 'keyValue'; label: string; rows: Array<{ key: string; value: string }> }
  | { kind: 'table'; label: string; columns: string[]; rows: string[][] }
  | { kind: 'list'; label: string; items: string[] }
  | { kind: 'bars'; label: string; bars: Array<{ label: string; value: number; max?: number }> }
  | { kind: 'note'; text: string };

export type PanelWidgetKind = PanelWidget['kind'];

/** A panel a plugin wants the console to show. */
export interface UiPanelContribution {
  id: string;
  title: string;
  /** Where it belongs. The console decides how to render it. */
  placement: 'inspector' | 'runs' | 'office-overlay' | 'settings';
  summary: string;
  /** A fixed body, declared in the manifest. */
  body?: PanelWidget[];
  /**
   * Live values: an http(s) URL the *server* fetches and validates, returning
   * `{ widgets: PanelWidget[] }`. The browser never sees this URL, so a plugin
   * endpoint cannot be used to reach the operator's machine, and a slow or dead
   * one costs a panel, not the console.
   */
  source?: { url: string; refreshMs?: number };
  /** Optional CSS custom properties this panel needs. */
  tokens?: Record<string, string>;
}

/** One operator-facing setting, rendered as a form control. */
export interface PluginSettingField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  description?: string;
  default: string | number | boolean;
  options?: string[];
  min?: number;
  max?: number;
}

/** A tool a code plugin registers. Mirrors the engine's tool shape, in core. */
export interface PluginToolContext {
  /** The workspace of the run this tool is serving; paths must stay inside it. */
  workspaceRoot: string;
  /** This plugin's current settings. */
  settings: Record<string, unknown>;
  signal: AbortSignal | undefined;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

export interface PluginToolResult {
  ok: boolean;
  /** Text handed back to the model. */
  content: string;
  /** Short UI-safe one-liner. */
  preview?: string;
  /** Workspace-relative paths this call touched. */
  affectsPaths?: string[];
}

export interface PluginTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: PluginToolContext): Promise<PluginToolResult>;
}

/** What a plugin contributes, declared in the manifest. */
export interface PluginContributions {
  providers?: PluginProvider[];
  models?: ModelSpec[];
  skills?: PluginSkill[];
  roleTemplates?: Role[];
  pipelines?: Pipeline[];
  routingRules?: RoutingRule[];
  uiPanels?: UiPanelContribution[];
  /** Names of the tools an `entry` module registers, for the consent screen. */
  toolNames?: string[];
}

/**
 * A whole provider, contributed by a plugin.
 *
 * The credential is deliberately **not** part of this: a manifest names the
 * environment variable that holds the key, and the server reads it. That keeps
 * a plugin from shipping a secret, and keeps the secret out of a marketplace
 * bundle where anyone could read it.
 *
 * Models are *not* declared here either — they go in `contributes.models` with a
 * matching `providerId`, so there is exactly one channel for a model entry.
 */
export interface PluginProvider {
  /** Must not collide with a built-in provider; the built-in one wins if it does. */
  id: string;
  label: string;
  /** 'anthropic' speaks the Messages API; everything else is OpenAI-shaped. */
  kind: 'openai-compat' | 'anthropic';
  /** Base URL including the version segment, e.g. `https://api.example.com/v1`. */
  baseUrl: string;
  /** Name of the environment variable holding the key, e.g. `MYLLM_API_KEY`. */
  keyEnvVar?: string;
  /** True for a runtime that needs no key, such as a local server. */
  keyless?: boolean;
  /** Extra headers the gateway requires, e.g. OpenRouter's referer/title. */
  extraHeaders?: Record<string, string>;
}

export interface PluginManifest {
  /** Stable id, reverse-dns style: 'dev3d.cost-guard'. */
  id: string;
  name: string;
  /** Semver. */
  version: string;
  description: string;
  /** The `PLUGIN_API_VERSION` this plugin was built against. */
  apiVersion: string;
  author?: string;
  homepage?: string;
  license?: string;
  /** Relative path to the module that exports `activate(api)`. */
  entry?: string;
  permissions?: PluginPermission[];
  contributes?: PluginContributions;
  settings?: PluginSettingField[];
}

/** Where a plugin came from, which is also how much it should be trusted. */
export type PluginSource = 'bundled' | 'local' | 'marketplace';

export type PluginStatus = 'loaded' | 'disabled' | 'error';

/** What a plugin actually contributed once loaded. */
export interface PluginContributionCounts {
  providers: number;
  models: number;
  skills: number;
  roleTemplates: number;
  pipelines: number;
  routingRules: number;
  tools: number;
  uiPanels: number;
}

/** A newer version of an installed plugin, as a marketplace is offering it. */
export interface PluginUpdateInfo {
  /** The version the marketplace has. */
  latest: string;
  /** The version that is installed, for the "x → y" the console shows. */
  installed: string;
  downloadUrl: string;
  sha256?: string;
  /** The source it was found in, so an operator knows where an update comes from. */
  sourceId: string;
  sourceLabel: string;
}

/** The live state of one installed plugin. */
export interface PluginRecord {
  manifest: PluginManifest;
  /** Absolute path it was loaded from. */
  directory: string;
  source: PluginSource;
  enabled: boolean;
  status: PluginStatus;
  /** Why it failed, when status is 'error'. */
  error: string | null;
  /** True when it ships code that runs in the orchestrator's process. */
  hasCode: boolean;
  contributions: PluginContributionCounts;
  /** Current settings, already merged over the manifest defaults. */
  settings: Record<string, unknown>;
  installedAt: number;
  /**
   * Set when a registered marketplace is offering a newer version. Absent means
   * either nothing newer was found, or no marketplace has been checked yet -
   * `lastCheckedAt` on the state is what tells those apart.
   */
  update?: PluginUpdateInfo;
}

/** The api handed to a code plugin's `activate`. */
export interface PluginApi {
  manifest: PluginManifest;
  /** The plugin's current settings, defaults already applied. */
  settings: Record<string, unknown>;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  /** Register a tool. Its name is namespaced so two plugins cannot collide. */
  registerTool(tool: PluginTool): void;
  /** Observe the event stream. Returns an unsubscribe function. */
  on(type: ServerEvent['type'], handler: (event: ServerEvent) => void): () => void;
}

/** What an `entry` module must export. */
export interface PluginModule {
  activate(api: PluginApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// the marketplace contract
// ---------------------------------------------------------------------------

/**
 * One entry in a marketplace catalog. A marketplace website is anything that can
 * serve this JSON at a URL; nothing else about it is assumed.
 */
export interface PluginCatalogEntry {
  manifest: PluginManifest;
  /**
   * Where to fetch the plugin bundle. Absolute, or relative to the catalog URL.
   * A bundle is a `.zip` (or `.tar.gz`) of a plugin directory.
   */
  downloadUrl: string;
  /** Lowercase hex sha256 of the bundle. The host refuses a mismatch. */
  sha256?: string;
  /** Free-form tags a marketplace can filter on. */
  tags?: string[];
  /** Total bytes, so a UI can show size before downloading. */
  sizeBytes?: number;
  /** Whatever the marketplace wants to say about it. */
  readme?: string;
}

/** The document a marketplace serves at its catalog URL. */
export interface PluginCatalog {
  /** Catalog format version, independent of the plugin API version. */
  version: 1;
  name: string;
  homepage?: string;
  plugins: PluginCatalogEntry[];
}

/** A marketplace the operator has pointed the office at. */
export interface PluginSourceRecord {
  id: string;
  label: string;
  /** Absolute http(s) URL of the catalog document. */
  url: string;
  enabled: boolean;
  /** Last fetch outcome, for the UI. */
  lastFetchedAt: number | null;
  lastError: string | null;
  pluginCount: number;
}

/**
 * What the office remembers about plugins across restarts. Deliberately not
 * derived from disk: an operator's enable/disable decision and their settings
 * must survive the plugin directory being re-scanned.
 */
export interface PluginPersistedState {
  /** plugin id -> enabled. An absent id means the plugin's own default. */
  enabled: Record<string, boolean>;
  /** plugin id -> operator settings, merged over the manifest defaults. */
  settings: Record<string, Record<string, unknown>>;
  /** Marketplaces the operator registered. */
  sources: PluginSourceRecord[];
}

/** What the console sees about the plugin system. */
export interface PluginSystemState {
  apiVersion: string;
  /** Where plugins are loaded from, and where installs land. */
  pluginsRoot: string;
  /** Whether installing from a marketplace URL is permitted at all. */
  allowInstall: boolean;
  records: PluginRecord[];
  sources: PluginSourceRecord[];
  /**
   * When the marketplaces were last asked what they are offering. Absent means
   * never, which is how a console distinguishes "up to date" from "not checked".
   */
  lastCheckedAt?: number;
}

/**
 * The state of one configured MCP server, as the console shows it.
 *
 * `state` is deliberately coarse — connecting, ready, failed, disabled — because
 * the useful question an operator asks is "is it working, and if not why", and
 * `error` carries the why.
 */
export interface McpServerStatus {
  id: string;
  state: 'connecting' | 'ready' | 'failed' | 'disabled';
  /** How it is reached: a command line, or a URL. */
  transport: string;
  /** Present once the server has introduced itself. */
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  /** How many tools it published. */
  toolCount: number;
  /** Why it is not ready, when it is not. */
  error?: string;
  /** Recent stderr or unparseable output, for diagnosis. */
  notes: string[];
}

/** Every MCP server this office knows about. */
export interface McpState {
  /** Whether MCP connections are enabled at all. */
  enabled: boolean;
  /** The config file that was read, when one was. */
  configPath: string | null;
  /** Role ids that may call MCP tools. `['*']` means every role. */
  grantRoles: string[];
  servers: McpServerStatus[];
}

/** A routing hint a plugin asked for, resolved against a task class. */
export interface RoutingHint {
  pluginId: string;
  ruleId: string;
  /** The rule applies only here. Absent means every task class. */
  taskClass?: TaskClass;
  tier?: RoutingRule['tier'];
  preferProviderIds: string[];
  preferModelIds: string[];
  avoidModelIds: string[];
}

/** The hints that actually apply to this task class. */
export function hintsForTaskClass(
  hints: readonly RoutingHint[],
  taskClass: TaskClass,
): RoutingHint[] {
  return hints.filter((hint) => hint.taskClass === undefined || hint.taskClass === taskClass);
}

/** Reorders candidate models according to every matching plugin rule. */
export function applyRoutingHints(
  candidates: RouteCandidate[],
  hints: readonly RoutingHint[],
): RouteCandidate[] {
  if (hints.length === 0) return candidates;
  const preferred = new Set(hints.flatMap((hint) => hint.preferModelIds));
  const avoided = new Set(hints.flatMap((hint) => hint.avoidModelIds));
  const providerOrder = new Map<string, number>();
  for (const hint of hints) {
    for (const [index, providerId] of hint.preferProviderIds.entries()) {
      if (!providerOrder.has(providerId)) providerOrder.set(providerId, index);
    }
  }

  const rank = (candidate: RouteCandidate): number => {
    if (preferred.has(candidate.modelId)) return 0;
    if (avoided.has(candidate.modelId)) return 3;
    if (providerOrder.has(candidate.providerId)) return 1;
    return 2;
  };

  return [...candidates].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const byProvider =
      (providerOrder.get(a.providerId) ?? Number.MAX_SAFE_INTEGER) -
      (providerOrder.get(b.providerId) ?? Number.MAX_SAFE_INTEGER);
    if (byProvider !== 0) return byProvider;
    return a.blendedCostPerKTok - b.blendedCostPerKTok;
  });
}
