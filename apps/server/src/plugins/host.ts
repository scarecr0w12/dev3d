/**
 * The plugin host.
 *
 * It owns the whole lifecycle: discover plugin directories, validate their
 * manifests, load the ones that are enabled, publish what they contribute, and
 * take it all back when they are disabled. The office's other subsystems do not
 * know plugins exist - they ask the host for extra models, skills, tools and
 * routing hints, and get a flat list.
 *
 * Three rules the code is built around:
 *
 *  - **A bad plugin is contained.** A manifest that will not validate, a module
 *    that throws on import, or a plugin that fails halfway through `activate`
 *    becomes a record with `status: 'error'` and a message. It never stops the
 *    office from starting, and it never stops the other plugins from loading.
 *  - **Contributions are recomputed, never patched.** `contributions()` derives
 *    everything from the currently loaded set, so a disable cannot leave a stale
 *    model in the catalog.
 *  - **Unloading is best effort, and says so.** Node cannot unload an ES module,
 *    so disabling a code plugin drops its contributions and calls `deactivate`,
 *    but the module stays in memory. That is a documented limit, not a pretence.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  ModelSpec,
  Pipeline,
  PluginApi,
  PluginCatalog,
  PluginCatalogEntry,
  PluginContributionCounts,
  PluginManifest,
  PluginModule,
  PluginPermission,
  PluginPersistedState,
  PluginProvider,
  PluginRecord,
  PluginSkill,
  PluginSourceRecord,
  PluginSystemState,
  PluginTool,
  PluginUpdateInfo,
  Role,
  RoutingHint,
  RoutingRule,
  ServerEvent,
  Skill,
  UiPanelContribution,
} from '@dev3d/core';
import { PLUGIN_API_VERSION } from '@dev3d/core';
// The naming rule lives in core so the console checks a manifest's declared tool
// names against the host's registrations using *this* function, not a copy of it.
import { namespacedToolName, toolNamespace } from '@dev3d/core';
export { namespacedToolName, toolNamespace };
import type { ServerConfig } from '../config.ts';
import type { Tool, ToolRegistry } from '../tools/types.ts';
import { BundleError, extractTarGz, findPluginRoot, sha256Hex } from './bundle.ts';
import { coercePersistedState, coerceSettings, defaultSettings, validateManifest } from './manifest.ts';
import { createPanelReader, type PanelReadResult } from './panels.ts';
import { isPathInside, assertNoReparsePoint } from '../tools/paths.ts';
import { checkHostIsPublic, fetchGuarded } from '../security/webGuard.ts';

export interface ActiveContributions {
  providers: Array<{ pluginId: string; provider: PluginProvider }>;
  models: ModelSpec[];
  skills: Skill[];
  /** Plugin code has already been namespaced by the time it appears here. */
  tools: Tool[];
  toolNames: string[];
  /** Which plugin registered which tool, so a grant list can show provenance. */
  toolOwners: Array<{ pluginId: string; toolName: string }>;
  routingHints: RoutingHint[];
  roleTemplates: Array<{ pluginId: string; role: Role }>;
  pipelines: Array<{ pluginId: string; pipeline: Pipeline }>;
  uiPanels: Array<{ pluginId: string; panel: UiPanelContribution }>;
}

const EMPTY_COUNTS: PluginContributionCounts = {
  providers: 0,
  models: 0,
  skills: 0,
  roleTemplates: 0,
  pipelines: 0,
  routingRules: 0,
  tools: 0,
  uiPanels: 0,
};

interface LoadedPlugin {
  record: PluginRecord;
  directory: string;
  /** Registered tool names, so disabling can take them back out. */
  registeredTools: string[];
  /** Event observers this plugin installed. */
  unsubscribes: Array<() => void>;
  deactivate?: () => void | Promise<void>;
  warnings: string[];
}

export interface PluginHost {
  /** Scan both plugin directories and load everything enabled. */
  load(): Promise<void>;
  state(): PluginSystemState;
  records(): PluginRecord[];
  contributions(): ActiveContributions;
  /** Just the skills, which is all the runtime needs to merge into its catalog. */
  pluginSkills(): Skill[];
  /** Read one contributed panel's widgets. Never throws; a failure is a state. */
  readPanel(pluginId: string, panelId: string): Promise<PanelReadResult>;
  persisted(): PluginPersistedState;
  hydrate(state: PluginPersistedState): void;

  enable(pluginId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  configure(pluginId: string, values: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  refresh(): Promise<{ ok: boolean; error?: string }>;
  remove(pluginId: string): Promise<{ ok: boolean; error?: string }>;

  addSource(label: string, url: string): { ok: boolean; source?: PluginSourceRecord; error?: string };
  removeSource(sourceId: string): { ok: boolean; error?: string };
  fetchCatalog(url: string): Promise<{ ok: boolean; catalog?: PluginCatalog; error?: string }>;
  install(catalogUrl: string, pluginId: string, upgrade?: boolean): Promise<{ ok: boolean; record?: PluginRecord; error?: string }>;
  /** Ask every registered marketplace what it is offering, and record updates. */
  checkForUpdates(): Promise<{ ok: boolean; checked: number; found: number; error?: string }>;
}

/** `dev3d.cost-guard` -> `dev3d_cost_guard`, so tool names cannot collide. */
function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Compare two dotted versions. Returns < 0, 0 or > 0, like a sort comparator.
 *
 * Deliberately not a semver implementation: a plugin version is three numbers and
 * an optional pre-release tag, and the only question ever asked is "is this
 * newer". A missing or unparseable part counts as zero, so `1.2` and `1.2.0` are
 * the same version rather than one being "invalid".
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): { parts: number[]; pre: string } => {
    const [core = '', pre = ''] = value.trim().split('-', 2);
    return { parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  // A pre-release is older than the release it leads up to.
  if (left.pre === right.pre) return 0;
  if (left.pre === '') return 1;
  if (right.pre === '') return -1;
  return left.pre > right.pre ? 1 : -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A plugin's skills presented in the shape the skill loader already produces. */
function toSkill(pluginId: string, skill: PluginSkill): Skill {
  const out: Skill = {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: [...skill.tags],
    body: skill.body,
    sourcePath: `plugin:${pluginId}`,
    estimatedTokens: Math.max(1, Math.ceil(skill.body.length / 4)),
  };
  if (skill.taskClasses) out.taskClasses = [...skill.taskClasses];
  return out;
}

export function createPluginHost(options: {
  config: ServerConfig;
  tools: ToolRegistry;
  log: (level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string) => void;
  /** Subscribe to the office event stream, for code plugins. */
  subscribe: (fn: (event: ServerEvent) => void) => () => void;
  /** Called after any change, so the runtime can persist and broadcast. */
  onChange: () => void;
}): PluginHost {
  const { config, tools, log } = options;

  const loaded = new Map<string, LoadedPlugin>();
  let persisted: PluginPersistedState = { enabled: {}, settings: {}, sources: [] };
  /** Ids that failed to load, kept so the UI can see and fix them. */
  const failures = new Map<string, { directory: string; source: PluginRecord['source']; error: string }>();
  /**
   * What the marketplaces are offering, per plugin id, and when they were last
   * asked. Kept beside the records rather than on them so that a rescan or an
   * enable/disable does not quietly forget an update it already found.
   */
  const updates = new Map<string, PluginUpdateInfo>();
  let lastCheckedAt: number | null = null;

  const panelReader = createPanelReader({
    panels: () => contributions().uiPanels,
    log: (level, scope, message) => log(level, scope, message),
    // Off unless the operator opted in: a panel source is fetched by the server and
    // drawn on the operator's screen, so a plugin could otherwise probe the machine.
    allowPrivateHosts: config.allowPrivatePanelHosts,
  });

  function sourceDirectories(): Array<{ dir: string; source: PluginRecord['source'] }> {
    return [
      { dir: config.pluginsDir, source: 'bundled' },
      { dir: config.pluginInstallDir, source: 'marketplace' },
    ];
  }

  function readManifest(directory: string): { manifest: PluginManifest; warnings: string[] } {
    const manifestPath = join(directory, 'plugin.json');
    if (!existsSync(manifestPath)) throw new Error('no plugin.json in the directory.');
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw new Error(`plugin.json is not valid JSON: ${errMsg(error)}`);
    }
    const result = validateManifest(raw);
    if (!result.ok) {
      const summary = result.problems.map((problem) => `${problem.field}: ${problem.message}`).join('; ');
      throw new Error(summary);
    }
    return { manifest: result.manifest, warnings: result.warnings };
  }

  function effectiveSettings(manifest: PluginManifest): Record<string, unknown> {
    const stored = persisted.settings[manifest.id];
    if (stored === undefined) return defaultSettings(manifest);
    return coerceSettings(manifest, stored).settings;
  }

  function buildRecord(
    manifest: PluginManifest,
    directory: string,
    source: PluginRecord['source'],
    enabled: boolean,
    status: PluginRecord['status'],
    error: string | null,
  ): PluginRecord {
    const contributions = manifest.contributes ?? {};
    const record: PluginRecord = {
      manifest,
      directory,
      source,
      enabled,
      status,
      error,
      hasCode: typeof manifest.entry === 'string' && manifest.entry !== '',
      contributions: {
        providers: contributions.providers?.length ?? 0,
        models: contributions.models?.length ?? 0,
        skills: contributions.skills?.length ?? 0,
        roleTemplates: contributions.roleTemplates?.length ?? 0,
        pipelines: contributions.pipelines?.length ?? 0,
        routingRules: contributions.routingRules?.length ?? 0,
        // Deliberately not the declared `contributes.toolNames` count: a manifest
        // claiming six tools that registers none must not read as six. The real
        // number is published by `publishToolContributions` once activate() ran.
        tools: 0,
        uiPanels: contributions.uiPanels?.length ?? 0,
      },
      registeredToolNames: [],
      // The endpoints, filled in by `buildRecord` itself below — a record built for a
      // manifest that declares providers must name them from the start, because the
      // card renders before activation.
      contributedProviderHosts: [],
      settings: effectiveSettings(manifest),
      installedAt: Date.now(),
    };
    publishProviderHosts(record, contributions.providers ?? []);
    return record;
  }

  /**
   * Publish the tools a plugin actually holds, for the consent screen.
   *
   * `contributions.tools` and `registeredToolNames` are always written together
   * so the count and the list can never disagree.
   */
  function publishToolContributions(plugin: LoadedPlugin): void {
    plugin.record.contributions.tools = plugin.registeredTools.length;
    plugin.record.registeredToolNames = [...plugin.registeredTools];
  }

  /**
   * Publish where a plugin would send the office's prompts.
   *
   * A contributed provider is a destination for *everything the model sees*, and the
   * card showed only a count. Each host is taken from the manifest as validated
   * (https, or loopback for a keyless local runtime), so what is displayed is what
   * the registry will actually dial.
   */
  function publishProviderHosts(record: PluginRecord, providers: readonly PluginProvider[]): void {
    record.contributedProviderHosts = providers.map((provider) => {
      let host = provider.baseUrl;
      try {
        host = new URL(provider.baseUrl).host;
      } catch {
        /* keep the raw string: a URL this malformed is worth seeing as-is */
      }
      return { id: provider.id, label: provider.label, host, keyless: provider.keyless === true };
    });
  }

  /**
   * Take back everything a half-finished `activate()` managed to register.
   *
   * A plugin that throws halfway through activation must leave no trace: a tool
   * it registered before throwing would otherwise stay callable by the engine
   * while its record reads `error`. Every activation failure path goes through
   * here so no fix can be applied to one and forgotten in another.
   */
  function rollbackActivation(plugin: LoadedPlugin): void {
    for (const name of plugin.registeredTools) tools.unregister(name);
    for (const unsubscribe of plugin.unsubscribes) {
      try {
        unsubscribe();
      } catch {
        /* an observer that cannot unsubscribe is already gone */
      }
    }
    plugin.registeredTools = [];
    plugin.unsubscribes = [];
    publishToolContributions(plugin);
  }

  /** Wrap a plugin tool so the engine sees an ordinary `Tool`. */
  function adaptTool(plugin: LoadedPlugin, tool: PluginTool, name: string): Tool {
    const pluginId = plugin.record.manifest.id;
    return {
      name,
      description: `[${pluginId}] ${tool.description}`,
      parameters: tool.parameters,
      async run(args, ctx) {
        const result = await tool.run(args, {
          workspaceRoot: ctx.workspaceRoot,
          settings: plugin.record.settings,
          signal: ctx.signal,
          log: ctx.log,
        });
        return {
          ok: result.ok,
          content: result.content,
          preview: result.preview ?? (result.ok ? 'ok' : 'failed'),
          affectsPaths: result.affectsPaths ?? [],
        };
      },
    };
  }

  async function activatePlugin(plugin: LoadedPlugin): Promise<void> {
    const { manifest, directory } = plugin.record;
    if (manifest.entry === undefined || manifest.entry === '') return;

    const entryPath = resolve(directory, manifest.entry);
    // Boundary-aware, not a bare string prefix: `C:\plugins\foo-evil\x.js` starts
    // with `C:\plugins\foo`, so a sibling directory used to satisfy a check whose
    // whole job was to prove the entry stayed inside the plugin's own directory.
    if (!isPathInside(directory, entryPath)) {
      throw new Error(`entry "${manifest.entry}" escapes the plugin directory.`);
    }
    // And the path being inside is not enough, because a component of it can be a
    // link: `plugins/foo/lib` as a junction to `plugins/foo-evil` makes
    // `lib/x.js` a path inside `foo` that imports a module from a directory the
    // plugin does not own. The manifest's `..` check cannot see it either.
    assertNoReparsePoint(directory, entryPath, 'the plugin directory');
    if (!existsSync(entryPath)) throw new Error(`entry module "${manifest.entry}" does not exist.`);

    const module = (await import(pathToFileURL(entryPath).href)) as Partial<PluginModule>;
    if (typeof module.activate !== 'function') {
      throw new Error(`entry module "${manifest.entry}" does not export activate().`);
    }
    if (typeof module.deactivate === 'function') {
      plugin.deactivate = module.deactivate;
    }

    /**
     * The manifest's permission list, enforced rather than displayed.
     *
     * `permissions` was written into the manifest and then read by exactly two
     * *warnings* and the console's descriptive copy — nothing in this host
     * consulted it. So the consent screen told an operator that a plugin "asks
     * for" a set of capabilities while the runtime drew no boundary at all: a
     * plugin declaring `["models"]` could register a tool and subscribe to the
     * event stream, and one that declared nothing could do the same. A consent
     * record that nothing enforces is worse than no record, because it is
     * believed.
     *
     * `activate()` itself remains unmediated code in this process — Node cannot
     * unload an ES module and there is no sandbox around the import — and that is
     * stated plainly in the docs and badged in the console. What this closes is
     * the narrower, fixable gap: the *host's own* API surface now honours the
     * declaration, so a plugin cannot acquire a capability through the supported
     * path that its manifest did not ask for.
     */
    const granted = new Set<PluginPermission>(manifest.permissions ?? []);
    const requirePermission = (permission: PluginPermission, what: string): void => {
      if (granted.has(permission)) return;
      throw new Error(
        `${manifest.id}: ${what} needs the "${permission}" permission, which its manifest does not declare. ` +
          `Declared: ${granted.size === 0 ? '(none)' : [...granted].join(', ')}.`,
      );
    };

    const api: PluginApi = {
      manifest,
      settings: plugin.record.settings,
      log: (level, message) => log(level, `plugin:${manifest.id}`, message),
      registerTool: (tool) => {
        requirePermission('tools', 'registerTool');
        if (typeof tool?.name !== 'string' || tool.name.trim() === '') {
          throw new Error('registerTool needs a tool with a name.');
        }
        if (typeof tool.run !== 'function') {
          throw new Error(`tool "${tool.name}" has no run function.`);
        }
        const name = namespacedToolName(manifest.id, tool.name);
        if (tools.get(name) !== undefined) {
          throw new Error(`tool "${name}" is already registered.`);
        }
        tools.register(adaptTool(plugin, tool, name));
        plugin.registeredTools.push(name);
      },
      on: (type, handler) => {
        requirePermission('events', 'subscribing to the event stream');
        const unsubscribe = options.subscribe((event) => {
          if (event.type !== type) return;
          try {
            handler(event);
          } catch (error) {
            log('warn', `plugin:${manifest.id}`, `event handler threw: ${errMsg(error)}`);
          }
        });
        plugin.unsubscribes.push(unsubscribe);
        return unsubscribe;
      },
    };

    await module.activate(api);
  }

  async function unloadPlugin(pluginId: string): Promise<void> {
    const plugin = loaded.get(pluginId);
    if (!plugin) return;
    for (const name of plugin.registeredTools) tools.unregister(name);
    for (const unsubscribe of plugin.unsubscribes) {
      try {
        unsubscribe();
      } catch {
        /* an observer that cannot unsubscribe is already gone */
      }
    }
    if (plugin.deactivate) {
      try {
        await plugin.deactivate();
      } catch (error) {
        log('warn', 'plugins', `${pluginId}: deactivate() threw: ${errMsg(error)}`);
      }
    }
    loaded.delete(pluginId);
  }

  async function loadDirectory(directory: string, source: PluginRecord['source']): Promise<void> {
    let manifest: PluginManifest;
    let warnings: string[] = [];
    try {
      const read = readManifest(directory);
      manifest = read.manifest;
      warnings = read.warnings;
    } catch (error) {
      // Without an id there is nothing to key a record on, so this is only
      // reportable as a directory-level failure.
      failures.set(directory, { directory, source, error: errMsg(error) });
      log('warn', 'plugins', `${directory}: ${errMsg(error)}`);
      return;
    }

    if (loaded.has(manifest.id) || failures.has(manifest.id)) {
      log('warn', 'plugins', `"${manifest.id}" is already provided by another directory; ignoring ${directory}.`);
      return;
    }

    const enabled = persisted.enabled[manifest.id] ?? true;
    const plugin: LoadedPlugin = {
      record: buildRecord(manifest, directory, source, enabled, enabled ? 'loaded' : 'disabled', null),
      directory,
      registeredTools: [],
      unsubscribes: [],
      warnings,
    };

    for (const warning of warnings) log('warn', `plugin:${manifest.id}`, warning);

    if (enabled) {
      try {
        await activatePlugin(plugin);
      } catch (error) {
        // Contain it: take back whatever activate() managed before it threw.
        rollbackActivation(plugin);
        plugin.record.status = 'error';
        plugin.record.error = errMsg(error);
        log('error', `plugin:${manifest.id}`, `failed to activate: ${errMsg(error)}`);
      }
    }

    publishToolContributions(plugin);
    loaded.set(manifest.id, plugin);
  }

  async function discover(): Promise<void> {
    for (const { dir, source } of sourceDirectories()) {
      let entries;
      try {
        mkdirSync(dir, { recursive: true });
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        log('warn', 'plugins', `cannot read ${dir}: ${errMsg(error)}`);
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        await loadDirectory(join(dir, entry.name), source);
      }
    }
  }

  function manifestOf(pluginId: string): PluginManifest | null {
    return loaded.get(pluginId)?.record.manifest ?? null;
  }

  // ------------------------------------------------------------------ state

  function records(): PluginRecord[] {
    const ok = [...loaded.values()].map((plugin) =>
      withUpdates({ ...plugin.record, settings: { ...plugin.record.settings } }),
    );
    const bad: PluginRecord[] = [];
    for (const failure of failures.values()) {
      // A directory that could not be read at all still deserves a row.
      bad.push({
        manifest: {
          id: failure.directory,
          name: failure.directory.split(/[\\/]/).pop() ?? failure.directory,
          version: '—',
          description: 'This directory could not be loaded.',
          apiVersion: '—',
        },
        directory: failure.directory,
        source: failure.source,
        enabled: false,
        status: 'error',
        error: failure.error,
        hasCode: false,
        contributions: { ...EMPTY_COUNTS },
        // A directory that never yielded a manifest never registered anything, and
        // never named an endpoint.
        registeredToolNames: [],
        contributedProviderHosts: [],
        settings: {},
        installedAt: Date.now(),
      });
    }
    return [...ok, ...bad].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  }

  /** Attach whatever a marketplace is offering, so the console can say so. */
  function withUpdates(record: PluginRecord): PluginRecord {
    const update = updates.get(record.manifest.id);
    return update === undefined ? record : { ...record, update };
  }

  function contributions(): ActiveContributions {
    const out: ActiveContributions = {
      providers: [],
      models: [],
      skills: [],
      tools: [],
      toolNames: [],
      toolOwners: [],
      routingHints: [],
      roleTemplates: [],
      pipelines: [],
      uiPanels: [],
    };
    for (const plugin of loaded.values()) {
      const record = plugin.record;
      if (!record.enabled || record.status !== 'loaded') continue;
      const { manifest } = record;
      const contributes = manifest.contributes ?? {};
      for (const provider of contributes.providers ?? []) {
        out.providers.push({ pluginId: manifest.id, provider });
      }
      for (const model of contributes.models ?? []) out.models.push(model);
      for (const skill of contributes.skills ?? []) out.skills.push(toSkill(manifest.id, skill));
      for (const rule of contributes.routingRules ?? []) out.routingHints.push(toHint(manifest.id, rule));
      for (const role of contributes.roleTemplates ?? []) out.roleTemplates.push({ pluginId: manifest.id, role });
      for (const pipeline of contributes.pipelines ?? []) out.pipelines.push({ pluginId: manifest.id, pipeline });
      for (const panel of contributes.uiPanels ?? []) out.uiPanels.push({ pluginId: manifest.id, panel });
      for (const name of plugin.registeredTools) {
        const tool = tools.get(name);
        if (tool) {
          out.tools.push(tool);
          out.toolNames.push(name);
          out.toolOwners.push({ pluginId: manifest.id, toolName: name });
        }
      }
    }
    return out;
  }

  function toHint(pluginId: string, rule: RoutingRule): RoutingHint {
    return {
      pluginId,
      ruleId: rule.id,
      ...(rule.taskClass !== undefined ? { taskClass: rule.taskClass } : {}),
      ...(rule.tier !== undefined ? { tier: rule.tier } : {}),
      preferProviderIds: rule.preferProviderIds ?? [],
      preferModelIds: rule.preferModelIds ?? [],
      avoidModelIds: rule.avoidModelIds ?? [],
    };
  }

  function state(): PluginSystemState {
    return {
      apiVersion: PLUGIN_API_VERSION,
      pluginsRoot: config.pluginsDir,
      allowInstall: config.allowPluginInstall,
      records: records(),
      sources: persisted.sources.map((source) => ({ ...source })),
      ...(lastCheckedAt === null ? {} : { lastCheckedAt }),
    };
  }

  // ------------------------------------------------------------- mutations

  async function enable(pluginId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    const plugin = loaded.get(pluginId);
    if (!plugin) return { ok: false, error: `No plugin "${pluginId}".` };
    // A plugin sitting in 'error' is enabled on paper but not running, so
    // "enable it again" is the only way an operator can retry it. Reporting a
    // no-op success there would make the retry button a lie.
    if (plugin.record.enabled === enabled && plugin.record.status !== 'error') return { ok: true };

    persisted.enabled[pluginId] = enabled;
    if (!enabled) {
      await unloadPlugin(pluginId);
      // Re-register the row without its contributions so the UI still lists it.
      const record = buildRecord(plugin.record.manifest, plugin.directory, plugin.record.source, false, 'disabled', null);
      loaded.set(pluginId, {
        record,
        directory: plugin.directory,
        registeredTools: [],
        unsubscribes: [],
        warnings: plugin.warnings,
      });
      options.onChange();
      return { ok: true };
    }

    // Enabling re-reads and re-activates from disk: the state may have changed.
    const fresh: LoadedPlugin = {
      record: buildRecord(plugin.record.manifest, plugin.directory, plugin.record.source, true, 'loaded', null),
      directory: plugin.directory,
      registeredTools: [],
      unsubscribes: [],
      warnings: plugin.warnings,
    };
    try {
      await activatePlugin(fresh);
    } catch (error) {
      rollbackActivation(fresh);
      fresh.record.status = 'error';
      fresh.record.error = errMsg(error);
      loaded.set(pluginId, fresh);
      options.onChange();
      return { ok: false, error: errMsg(error) };
    }
    publishToolContributions(fresh);
    loaded.set(pluginId, fresh);
    options.onChange();
    return { ok: true };
  }

  async function configure(
    pluginId: string,
    values: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    const plugin = loaded.get(pluginId);
    if (!plugin) return { ok: false, error: `No plugin "${pluginId}".` };
    const manifest = plugin.record.manifest;
    const merged = { ...plugin.record.settings, ...values };
    const { settings, dropped } = coerceSettings(manifest, merged);
    if (dropped.length > 0) {
      return { ok: false, error: `Rejected setting(s): ${dropped.join(', ')}.` };
    }
    persisted.settings[pluginId] = { ...settings };
    plugin.record.settings = settings;

    // A code plugin may have read its settings at activate time, so reload it.
    if (plugin.record.enabled && plugin.record.hasCode) {
      const source = plugin.record.source;
      const directory = plugin.directory;
      await unloadPlugin(pluginId);
      const fresh: LoadedPlugin = {
        record: buildRecord(manifest, directory, source, true, 'loaded', null),
        directory,
        registeredTools: [],
        unsubscribes: [],
        warnings: plugin.warnings,
      };
      try {
        await activatePlugin(fresh);
        publishToolContributions(fresh);
        loaded.set(pluginId, fresh);
      } catch (error) {
        rollbackActivation(fresh);
        fresh.record.status = 'error';
        fresh.record.error = errMsg(error);
        loaded.set(pluginId, fresh);
        options.onChange();
        return { ok: false, error: errMsg(error) };
      }
    }
    options.onChange();
    return { ok: true };
  }

  async function refresh(): Promise<{ ok: boolean; error?: string }> {
    for (const pluginId of [...loaded.keys()]) await unloadPlugin(pluginId);
    loaded.clear();
    failures.clear();
    // A re-read manifest may point a panel at a different URL or body, and the
    // cached widgets would then be a lie about what the plugin now declares.
    panelReader.invalidate();
    await discover();
    options.onChange();
    return { ok: true };
  }

  async function remove(pluginId: string): Promise<{ ok: boolean; error?: string }> {
    const plugin = loaded.get(pluginId);
    if (!plugin) return { ok: false, error: `No plugin "${pluginId}".` };
    if (plugin.record.source === 'bundled') {
      return {
        ok: false,
        error: 'This plugin ships with the office in DEV3D_PLUGINS_DIR. Disable it, or remove the directory yourself.',
      };
    }
    await unloadPlugin(pluginId);
    try {
      rmSync(plugin.directory, { recursive: true, force: true });
    } catch (error) {
      return { ok: false, error: `could not remove ${plugin.directory}: ${errMsg(error)}` };
    }
    delete persisted.enabled[pluginId];
    delete persisted.settings[pluginId];
    options.onChange();
    log('info', 'plugins', `removed ${pluginId}`);
    return { ok: true };
  }

  // ---------------------------------------------------------- marketplaces

  /**
   * A marketplace URL, and whether an operator may register it.
   *
   * **https only, plus plaintext http on loopback.** A catalog fetched over
   * plaintext is a catalog somebody on the path can rewrite, and it is the thing
   * that decides which bundle gets downloaded and run — so its integrity is the
   * integrity of the whole install path. Loopback is exempt because a local
   * marketplace is a real thing to run while developing one, and there is no path
   * to intercept there.
   */
  function checkSourceUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
    const clean = raw.trim();
    let parsed: URL;
    try {
      parsed = new URL(clean);
    } catch {
      return { ok: false, error: 'A marketplace URL must be an absolute http:// or https:// URL.' };
    }
    if (parsed.protocol === 'https:') return { ok: true, url: parsed.toString() };
    if (parsed.protocol !== 'http:') {
      return { ok: false, error: `A marketplace URL must be http:// or https:// (got ${parsed.protocol}//).` };
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return { ok: true, url: parsed.toString() };
    return {
      ok: false,
      error:
        'A marketplace URL must be https:// — a catalog fetched over plaintext can be rewritten in transit, ' +
        'and it is what decides which bundle is downloaded and run. (Plain http is allowed on localhost.)',
    };
  }

  function addSource(label: string, url: string): { ok: boolean; source?: PluginSourceRecord; error?: string } {
    const checked = checkSourceUrl(url);
    if (!checked.ok) return { ok: false, error: checked.error };
    const clean = checked.url;
    const name = label.trim() === '' ? new URL(clean).hostname : label.trim();
    if (persisted.sources.some((source) => source.url === clean)) {
      return { ok: false, error: 'That marketplace is already registered.' };
    }
    const source: PluginSourceRecord = {
      id: `src_${Math.random().toString(36).slice(2, 10)}`,
      label: name,
      url: clean,
      enabled: true,
      lastFetchedAt: null,
      lastError: null,
      pluginCount: 0,
    };
    persisted.sources.push(source);
    options.onChange();
    return { ok: true, source };
  }

  function removeSource(sourceId: string): { ok: boolean; error?: string } {
    const before = persisted.sources.length;
    persisted.sources = persisted.sources.filter((source) => source.id !== sourceId);
    if (persisted.sources.length === before) return { ok: false, error: `No marketplace "${sourceId}".` };
    options.onChange();
    return { ok: true };
  }

  /** Whether a URL's origin is one a bundle may be served from. */
  function isTrustedOrigin(url: URL): boolean {
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }

  function parseCatalog(raw: unknown, baseUrl: string): PluginCatalog {
    if (!isRecord(raw)) throw new Error('the catalog is not a JSON object.');
    const plugins = raw['plugins'];
    if (!Array.isArray(plugins)) throw new Error('the catalog has no "plugins" array.');
    const catalogUrl = new URL(baseUrl);
    const catalogOrigin = catalogUrl.origin;
    /**
     * A loopback catalog may serve its bundles over plain http, because there is
     * no path to intercept and a local marketplace is a real thing to run while
     * building one. Anything else must be https at both ends.
     */
    const loopbackCatalog = catalogUrl.protocol === 'http:' && isTrustedOrigin(catalogUrl);
    const entries: PluginCatalogEntry[] = [];
    plugins.forEach((entry, index) => {
      if (!isRecord(entry)) throw new Error(`plugins[${index}] is not an object.`);
      const validated = validateManifest(entry['manifest']);
      if (!validated.ok) {
        const summary = validated.problems.map((problem) => `${problem.field}: ${problem.message}`).join('; ');
        throw new Error(`plugins[${index}].manifest is invalid — ${summary}`);
      }
      const downloadUrl = typeof entry['downloadUrl'] === 'string' ? entry['downloadUrl'] : '';
      if (downloadUrl === '') throw new Error(`plugins[${index}] has no downloadUrl.`);
      const absolute = new URL(downloadUrl, baseUrl).toString();
      const item: PluginCatalogEntry = { manifest: validated.manifest, downloadUrl: absolute };

      /**
       * The bundle must come from the marketplace that listed it, over https.
       *
       * A catalog could otherwise point the download at any host it named —
       * including one on the operator's intranet — and `new URL(relative, base)`
       * preserves an absolute URL, so a single line in a catalog was enough to
       * redirect an install somewhere the operator never chose. Pinning to the
       * catalog's own origin means the party who vetted the entry is the party who
       * serves it.
       */
      const download = new URL(absolute);
      const sameOrigin = download.origin === catalogOrigin;
      const trusted = download.protocol === 'https:' || (loopbackCatalog && isTrustedOrigin(download));
      if (!sameOrigin || !trusted) {
        throw new Error(
          `plugins[${index}] (${validated.manifest.id}) downloads from ${download.origin} over ` +
            `${download.protocol}//, but it is listed by ${catalogOrigin}. A bundle must be served by the ` +
            'marketplace that lists it, over https (plain http is allowed only between loopback addresses).',
        );
      }

      /**
       * The bundle hash is **required**, not optional.
       *
       * When it was optional, the only integrity check on the code about to be
       * loaded and run was one the marketplace itself supplied — which protects
       * against corruption and not against a hostile marketplace. Requiring it
       * does not make a hostile marketplace safe, but it does make a tampered or
       * truncated bundle detectable, which is the failure this can actually catch.
       */
      if (typeof entry['sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(entry['sha256'])) {
        throw new Error(
          `plugins[${index}] (${validated.manifest.id}) has no valid sha256. An install will not run a ` +
            'bundle whose hash the marketplace did not publish.',
        );
      }
      item.sha256 = entry['sha256'];
      if (Array.isArray(entry['tags'])) item.tags = (entry['tags'] as unknown[]).map(String);
      if (typeof entry['sizeBytes'] === 'number') item.sizeBytes = entry['sizeBytes'];
      if (typeof entry['readme'] === 'string') item.readme = entry['readme'];
      entries.push(item);
    });
    const catalog: PluginCatalog = {
      version: 1,
      name: typeof raw['name'] === 'string' ? raw['name'] : new URL(baseUrl).hostname,
      plugins: entries,
    };
    const homepage = raw['homepage'];
    if (typeof homepage === 'string') catalog.homepage = homepage;
    return catalog;
  }

  async function fetchCatalog(url: string): Promise<{ ok: boolean; catalog?: PluginCatalog; error?: string }> {
    const clean = url.trim();
    if (!/^https?:\/\//i.test(clean)) return { ok: false, error: 'A catalog URL must start with http:// or https://.' };
    try {
      // The URL the operator registered is the URL that answers, or the answer is
      // not from where they think. A redirect here is reported with its target
      // rather than followed: `parseCatalog` pins bundle downloads to the
      // catalog's own origin, and a followed redirect would hand that pin to
      // whoever the first hop chose.
      const response = await fetch(clean, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        return {
          ok: false,
          error:
            `the marketplace redirected to ${response.headers.get('location') ?? '(no Location header)'}. ` +
            'Register the URL it redirects to, so the catalog and its bundles come from one origin.',
        };
      }
      if (!response.ok) return { ok: false, error: `the marketplace returned HTTP ${response.status}.` };
      const raw = (await response.json()) as unknown;
      return { ok: true, catalog: parseCatalog(raw, clean) };
    } catch (error) {
      return { ok: false, error: `could not reach the marketplace: ${errMsg(error)}` };
    }
  }

  /**
   * Ask every registered marketplace what it is offering.
   *
   * A source that cannot be reached is recorded as such and skipped: one dead
   * marketplace must not stop the others being checked, and it must not be
   * mistaken for "nothing newer exists".
   */
  async function checkForUpdates(): Promise<{ ok: boolean; checked: number; found: number; error?: string }> {
    updates.clear();
    let checked = 0;
    const failuresSeen: string[] = [];

    for (const source of persisted.sources) {
      if (!source.enabled) continue;
      const fetched = await fetchCatalog(source.url);
      source.lastFetchedAt = Date.now();
      if (!fetched.ok || !fetched.catalog) {
        source.lastError = fetched.error ?? 'the catalog could not be read';
        failuresSeen.push(`${source.label}: ${source.lastError}`);
        continue;
      }
      source.lastError = null;
      source.pluginCount = fetched.catalog.plugins.length;
      checked += 1;

      for (const entry of fetched.catalog.plugins) {
        const id = entry.manifest.id;
        // Only for something actually installed: offering an update to a plugin
        // nobody has is what the marketplace panel is for.
        const installed = loaded.get(id);
        if (!installed) continue;
        if (compareVersions(entry.manifest.version, installed.record.manifest.version) <= 0) continue;
        const info: PluginUpdateInfo = {
          latest: entry.manifest.version,
          installed: installed.record.manifest.version,
          downloadUrl: entry.downloadUrl,
          sourceId: source.id,
          sourceLabel: source.label,
        };
        if (entry.sha256 !== undefined) info.sha256 = entry.sha256;
        updates.set(id, info);
      }
    }

    lastCheckedAt = Date.now();
    options.onChange();
    if (updates.size > 0) {
      log(
        'info',
        'plugins',
        `${updates.size} update(s) available: ${[...updates].map(([id, info]) => `${id} ${info.installed} → ${info.latest}`).join(', ')}`,
      );
    }
    const result: { ok: boolean; checked: number; found: number; error?: string } = {
      ok: true,
      checked,
      found: updates.size,
    };
    if (failuresSeen.length > 0) result.error = failuresSeen.join('; ');
    return result;
  }

  async function install(
    catalogUrl: string,
    pluginId: string,
    upgrade = false,
  ): Promise<{ ok: boolean; record?: PluginRecord; error?: string }> {
    if (!config.allowPluginInstall) {
      return {
        ok: false,
        error:
          'Installing plugins is disabled. Set DEV3D_ALLOW_PLUGIN_INSTALL=true to allow running code downloaded from a marketplace.',
      };
    }

    const fetched = await fetchCatalog(catalogUrl);
    if (!fetched.ok || !fetched.catalog) return { ok: false, error: fetched.error ?? 'the catalog could not be read' };
    const entry = fetched.catalog.plugins.find((candidate) => candidate.manifest.id === pluginId);
    if (!entry) return { ok: false, error: `"${pluginId}" is not in that marketplace.` };

    const existing = loaded.get(pluginId);
    if (existing && !upgrade) {
      return {
        ok: false,
        error: `"${pluginId}" ${existing.record.manifest.version} is already installed.`,
      };
    }
    // An upgrade only moves forward, and only over something that came from a
    // marketplace: replacing a plugin that ships with the office would leave the
    // checkout and the loaded set disagreeing.
    if (existing && upgrade) {
      if (existing.record.source === 'bundled') {
        return { ok: false, error: `"${pluginId}" ships with the office; update it by updating dev3d.` };
      }
      if (compareVersions(entry.manifest.version, existing.record.manifest.version) <= 0) {
        return {
          ok: false,
          error: `"${pluginId}" is already at ${existing.record.manifest.version}; the marketplace offers ${entry.manifest.version}.`,
        };
      }
    }

    let archive: Buffer;
    try {
      // The origin pin in `parseCatalog` checks the URL the catalog *declared*.
      // Following a redirect from there would hand the actual download to whoever
      // the first hop chose — a CDN is the legitimate version of that, and
      // `http://169.254.169.254/` is the illegitimate one. So each hop is
      // re-checked against the same rule as the declared URL, and a hop that
      // leaves the public internet is refused. A local marketplace (loopback) is
      // exempt from the address check and nothing else, because there is no path
      // to intercept and no metadata service to reach.
      const declared = new URL(entry.downloadUrl);
      const loopbackCatalog = declared.protocol === 'http:' && isTrustedOrigin(declared);
      const attempt = await fetchGuarded(declared, {
        headers: {},
        timeoutMs: 30_000,
        check:
          declared.protocol === 'https:'
            ? checkHostIsPublic
            : async (url) =>
                url.protocol === 'http:' && isTrustedOrigin(url)
                  ? { ok: true, reason: '', addresses: [] }
                  : {
                      ok: false,
                      reason:
                        'a redirect left the loopback marketplace this bundle was listed by, and a bundle ' +
                        'must be served by the party that listed it',
                      addresses: [],
                    },
      });
      if (!attempt.ok) {
        return {
          ok: false,
          error: attempt.refused
            ? `the bundle download was refused: ${attempt.reason}`
            : `could not download the bundle: ${attempt.error}`,
        };
      }
      if (loopbackCatalog && attempt.finalUrl.host !== declared.host) {
        return {
          ok: false,
          error: `the bundle download left ${declared.host} for ${attempt.finalUrl.host}.`,
        };
      }
      const response = attempt.response;
      if (!response.ok) return { ok: false, error: `the download returned HTTP ${response.status}.` };
      archive = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      return { ok: false, error: `could not download the bundle: ${errMsg(error)}` };
    }

    // Required rather than conditional: `parseCatalog` refuses an entry without
    // one, so this is the belt to that brace — a catalog built by some other path
    // must not slip past with no integrity check at all.
    if (entry.sha256 === undefined) {
      return { ok: false, error: `"${pluginId}" publishes no sha256, so its bundle cannot be verified.` };
    }
    {
      const actual = sha256Hex(archive);
      if (actual !== entry.sha256) {
        return {
          ok: false,
          error: `checksum mismatch: the marketplace published ${entry.sha256.slice(0, 16)}… but the bundle hashes to ${actual.slice(0, 16)}….`,
        };
      }
    }

    // Unpack into a staging directory, then move it into place, so a failed or
    // partial extraction never leaves a half-installed plugin behind.
    mkdirSync(config.pluginInstallDir, { recursive: true });
    const staging = join(config.pluginInstallDir, `.staging-${Date.now().toString(36)}`);
    try {
      extractTarGz(archive, staging);
      const root = findPluginRoot(staging);
      if (!root) throw new BundleError('the bundle has no plugin.json at its root or in a single wrapping directory.');

      const installed = readManifest(root);
      if (installed.manifest.id !== pluginId) {
        throw new BundleError(`the bundle declares "${installed.manifest.id}" but "${pluginId}" was requested.`);
      }
      // An upgrade has to withdraw the old plugin *before* the swap: its tools and
      // event subscriptions belong to the code being replaced, and leaving them
      // registered would let a run keep calling into the version just deleted.
      if (existing) await unloadPlugin(pluginId);
      const target = join(config.pluginInstallDir, pluginId);
      rmSync(target, { recursive: true, force: true });
      renameSync(root, target);
      if (root !== staging) rmSync(staging, { recursive: true, force: true });

      await loadDirectory(target, 'marketplace');
      const record = loaded.get(pluginId)?.record;
      if (!record) return { ok: false, error: 'the bundle was unpacked but could not be loaded.' };
      updates.delete(pluginId);
      options.onChange();
      log(
        'info',
        'plugins',
        `${existing ? 'upgraded' : 'installed'} ${pluginId} ${record.manifest.version} from ${catalogUrl}`,
      );
      return { ok: true, record: withUpdates(record) };
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      return { ok: false, error: errMsg(error) };
    }
  }

  return {
    async load() {
      await discover();
      log('info', 'plugins', `${loaded.size} plugin(s) from ${sourceDirectories().map((s) => s.dir).join(' and ')}`);
      // Announce the initial set. This is not cosmetic: a plugin can contribute a
      // whole provider, and the registry builds its adapters from what the host
      // reports, so without this the provider would exist on disk and nowhere
      // else until the next unrelated change.
      options.onChange();
    },
    state,
    records,
    contributions,
    pluginSkills: () => contributions().skills,
    readPanel: (pluginId, panelId) => panelReader.read(pluginId, panelId),
    persisted: () => ({ ...persisted, sources: persisted.sources.map((source) => ({ ...source })) }),
    hydrate(next) {
      // Shape-checked on read, and anything dropped is reported: the stored
      // document is written by an older version, edited by hand, or restored from a
      // backup, and a malformed value that silently takes effect is configuration
      // the operator cannot see.
      const { state, dropped } = coercePersistedState(next);
      if (dropped.length > 0) {
        log('warn', 'plugins', `ignored malformed saved plugin state: ${dropped.join('; ')}`);
      }
      persisted = state;
    },
    enable,
    configure,
    refresh,
    remove,
    addSource,
    removeSource,
    fetchCatalog,
    install,
    checkForUpdates,
  };
}
