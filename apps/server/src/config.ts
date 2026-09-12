/**
 * Runtime configuration for the orchestrator.
 *
 * Everything is env-driven with sane defaults so `pnpm dev` works on a clean
 * checkout. With no API keys present the server boots in `mock` mode: the whole
 * pipeline still runs, employees are just scripted instead of calling a model.
 * That keeps the office demonstrable and the engine testable without a bill.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OfficeSettings, RoutingPosture } from '@dev3d/core';

const here = fileURLToPath(new URL('.', import.meta.url));

/** `<repo>/apps/server` */
export const SERVER_ROOT = resolve(here, '..');
/** `<repo>` */
export const REPO_ROOT = resolve(here, '../../..');

/**
 * The version the office reports, read from the package it ships as.
 *
 * It used to be a literal here, which made it a third place to bump and meant
 * `/api/health` and the Settings page could advertise a version the repository
 * disagreed with. A release number that can go stale is worse than none.
 */
export function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : 'unknown';
  } catch {
    // A version is informational; not being able to read one must not stop the
    // office from opening.
    return 'unknown';
  }
}

/**
 * Tiny `.env` reader - the standard library only, no dependency.
 * Real environment variables always win over the file.
 */
function loadDotEnv(path: string): number {
  if (!existsSync(path)) return 0;
  let applied = 0;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied += 1;
    }
  }
  return applied;
}

const dotEnvCount = loadDotEnv(resolve(REPO_ROOT, '.env'));

/** The `.env` this process read, and when it last changed. */
const envFilePath = resolve(REPO_ROOT, '.env');
const envFileMtimeMs = mtimeOf(envFilePath);

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function abs(name: string, fallback: string): string {
  const v = str(name, fallback);
  return resolve(REPO_ROOT, v);
}

export type ProviderKind = 'openai-compat' | 'anthropic' | 'mock';

export interface ProviderConfig {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Base URL including the version segment, e.g. `https://api.deepseek.com/v1`. */
  baseUrl: string;
  apiKey: string | null;
  /**
   * The environment variable this provider's key is read from.
   *
   * Kept so the office can re-check whether a key has appeared since boot
   * without guessing at names. Only ever the *name*; the value lives in
   * `apiKey` and never leaves the process.
   */
  keyEnvVar?: string;
  /** Shown in the UI when the provider is unconfigured. */
  hint: string;
  /** Extra headers some gateways require (OpenRouter wants a referer/title). */
  extraHeaders?: Record<string, string>;
  /**
   * True for a runtime that needs no credential at all, such as a local server.
   * Its presence is what makes "configured" mean something other than "has a
   * key", so a keyless provider is only counted as configured when the operator
   * has actually pointed the office at one.
   */
  keyless?: boolean;
  /** Set when a plugin contributed this provider, so the console can say so. */
  pluginId?: string;
}

export type LlmMode = 'mock' | 'live';
export type LlmModeSetting = 'auto' | LlmMode;

export interface ServerConfig {
  host: string;
  port: number;
  repoRoot: string;
  workspace: string;
  /**
   * Where new projects are created. A workspace folder name is resolved under
   * this root, which is what stops "create a project" from becoming a way to
   * hand employees the whole disk.
   */
  workspacesRoot: string;
  /**
   * Whether a workspace may point at an absolute path outside `workspacesRoot`.
   * On by default, because the point of the office is working on real projects
   * that already exist elsewhere - and the operator typing that path is the
   * consent. Set false to make the root a hard boundary.
   */
  allowExternalWorkspaces: boolean;
  dbPath: string;
  skillsDir: string;
  /**
   * Plugins that ship with the office, and any dropped in by hand. Scanned as
   * source 'bundled'.
   */
  pluginsDir: string;
  /**
   * Where installed plugins land. Kept out of `pluginsDir` so the shipped set
   * cannot be confused with something downloaded from a marketplace.
   */
  pluginInstallDir: string;
  /**
   * Whether the server will download and install a plugin from a marketplace at
   * all. Off by default: installing runs someone else's code in this process.
   */
  allowPluginInstall: boolean;
  /** Resolved mode: `live` only when a provider is actually configured. */
  llmMode: LlmMode;
  /** What the operator asked for, before resolving `auto`. */
  llmModeSetting: LlmModeSetting;
  /**
   * **Why** `llmMode` came out as it did, in words.
   *
   * This exists because the office used to log "no provider keys found" whenever
   * it was in mock mode - including when mock had been *forced* while keys were
   * plainly present. That message sent an operator looking for a configuration
   * problem that was not there. A mode without its reason is a riddle.
   */
  llmModeReason: string;
  /** Provider ids that were configured when the mode was resolved. */
  configuredProviderIds: string[];
  /** The `.env` consulted at boot, for drift detection. */
  envFilePath: string;
  /** Its modification time at boot, or null when there was no file. */
  envFileMtimeMs: number | null;
  routingPosture: RoutingPosture;
  runBudgetUsd: number;
  softSpendApprovalUsd: number;
  maxConcurrency: number;
  /**
   * When true `run_shell` skips the human approval round trip. Off by default:
   * an employee holding a shell is the single most dangerous thing in the
   * system, so a human has to say yes unless the operator explicitly opts out.
   */
  autoApproveShell: boolean;
  /**
   * How long an approval request waits for a human before the engine treats it
   * as refused. A pending approval that nothing can answer must not wedge a run
   * forever, so it always resolves - the run just gets an honest "declined".
   */
  approvalTimeoutMs: number;
  /**
   * Whether the office asks each provider what models it serves.
   *
   * On by default. It is the only thing that knows when a vendor ships or
   * retires a model, and a static list was already wrong in this checkout. Turn
   * it off to keep the office entirely offline: the curated table then stands
   * alone, exactly as the old hardcoded catalog did.
   */
  modelDiscovery: boolean;
  /**
   * How long a discovered model list stays fresh before being asked for again,
   * in milliseconds. `0` re-asks every time.
   */
  discoveryTtlMs: number;
  /**
   * Where discovered lists are cached between restarts. `null` disables the
   * cache, which costs a network round trip per provider on every boot.
   */
  discoveryCachePath: string | null;
  /**
   * The environment variable holding the pooled-quality API key.
   *
   * Only the *name* is here; the key is read from the environment at the point
   * it is used, so a secret never lands in a settings document, a log line or a
   * `hello` frame.
   */
  pooledQualityKeyVar: string;
  /** Where pooled benchmark scores are cached. `null` disables the cache. */
  pooledQualityCachePath: string | null;
  /** How long a pooled index stays fresh, in milliseconds. */
  pooledQualityTtlMs: number;
  /**
   * Whether to read OpenRouter's benchmark aggregation for pooled quality.
   *
   * Needs `OPENROUTER_API_KEY`. It subsumes the direct Artificial Analysis
   * source, because the Artificial Analysis indices are one of the three sources
   * OpenRouter returns.
   */
  benchmarks: boolean;
  /** Where the OpenRouter benchmark payload is cached. `null` disables it. */
  benchmarkCachePath: string | null;
  /** How long the OpenRouter benchmark payload stays fresh, in milliseconds. */
  benchmarkTtlMs: number;
  /**
   * Whether to track upstream endpoint uptime as a routing signal.
   *
   * Needs no key: the endpoint list is public. Measured coverage is 79% of
   * endpoints for `uptime_last_30m`, and 0% for latency and throughput, so this
   * is uptime and nothing else.
   */
  endpointHealth: boolean;
  /** Provider ids whose models are OpenRouter slugs underneath. */
  endpointHealthProviderIds: string[];
  endpointHealthCachePath: string | null;
  endpointHealthTtlMs: number;
  providers: ProviderConfig[];
  /** Number of keys loaded from .env, reported at boot. */
  dotEnvCount: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  version: string;
}

function buildProviders(): ProviderConfig[] {
  return [
    {
      id: 'deepseek',
      label: 'DeepSeek',
      kind: 'openai-compat',
      baseUrl: str('DEV3D_DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'),
      apiKey: process.env.DEEPSEEK_API_KEY?.trim() || null,
      keyEnvVar: 'DEEPSEEK_API_KEY',
      hint: 'Set DEEPSEEK_API_KEY in .env to enable DeepSeek models.',
    },
    {
      id: 'openai',
      label: 'OpenAI',
      kind: 'openai-compat',
      baseUrl: str('DEV3D_OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      apiKey: process.env.OPENAI_API_KEY?.trim() || null,
      keyEnvVar: 'OPENAI_API_KEY',
      hint: 'Set OPENAI_API_KEY in .env to enable OpenAI models.',
    },
    {
      id: 'openrouter',
      label: 'OpenRouter',
      kind: 'openai-compat',
      baseUrl: str('DEV3D_OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
      apiKey: process.env.OPENROUTER_API_KEY?.trim() || null,
      keyEnvVar: 'OPENROUTER_API_KEY',
      hint: 'Set OPENROUTER_API_KEY to reach many vendors through one route.',
      extraHeaders: {
        'HTTP-Referer': 'https://github.com/dev3d',
        'X-Title': 'dev3d office',
      },
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      kind: 'anthropic',
      baseUrl: str('DEV3D_ANTHROPIC_BASE_URL', 'https://api.anthropic.com/v1'),
      apiKey: process.env.ANTHROPIC_API_KEY?.trim() || null,
      keyEnvVar: 'ANTHROPIC_API_KEY',
      hint: 'Set ANTHROPIC_API_KEY in .env to enable Claude models.',
    },
    {
      id: 'local',
      label: 'Local (OpenAI-compatible)',
      kind: 'openai-compat',
      baseUrl: str('DEV3D_LOCAL_BASE_URL', 'http://127.0.0.1:11434/v1'),
      apiKey: process.env.DEV3D_LOCAL_API_KEY?.trim() || null,
      keyEnvVar: 'DEV3D_LOCAL_API_KEY',
      keyless: process.env.DEV3D_LOCAL_BASE_URL !== undefined && process.env.DEV3D_LOCAL_BASE_URL !== '',
      // A local runtime needs no key, so it counts as configured once a base
      // URL is explicitly provided.
      hint: 'Set DEV3D_LOCAL_BASE_URL (e.g. Ollama, vLLM, LM Studio) to use local models.',
    },
  ];
}

function isProviderConfigured(p: ProviderConfig): boolean {
  if (p.apiKey) return true;
  // An explicitly keyless provider - a local runtime, or one a plugin declared
  // with "keyless": true - counts as configured on the strength of its base URL.
  return p.keyless === true;
}

export function loadConfig(): ServerConfig {
  const providers = buildProviders();
  const configuredProviderIds = providers.filter(isProviderConfigured).map((p) => p.id);
  const anyConfigured = configuredProviderIds.length > 0;

  const rawMode = str('DEV3D_LLM_MODE', 'auto').toLowerCase();
  const llmModeSetting: LlmModeSetting =
    rawMode === 'mock' || rawMode === 'live' ? rawMode : 'auto';

  let llmMode: LlmMode;
  let llmModeReason: string;
  const listed = configuredProviderIds.join(', ');
  if (llmModeSetting === 'auto') {
    llmMode = anyConfigured ? 'live' : 'mock';
    llmModeReason = anyConfigured
      ? `DEV3D_LLM_MODE=auto, and ${listed} ${configuredProviderIds.length === 1 ? 'is' : 'are'} configured`
      : 'DEV3D_LLM_MODE=auto, and no provider key or keyless base URL was found';
  } else if (llmModeSetting === 'mock') {
    llmMode = 'mock';
    // The case that used to be reported wrongly. Forcing mock while keys exist is
    // a legitimate choice - an operator demonstrating the office without billing
    // - but it is not "no keys found", and saying so wastes somebody's afternoon.
    llmModeReason = anyConfigured
      ? `DEV3D_LLM_MODE=mock forces scripted employees even though ${listed} ${configuredProviderIds.length === 1 ? 'is' : 'are'} configured`
      : 'DEV3D_LLM_MODE=mock forces scripted employees';
  } else {
    llmMode = 'live';
    llmModeReason = anyConfigured
      ? `DEV3D_LLM_MODE=live, with ${listed} configured`
      : 'DEV3D_LLM_MODE=live, but no provider is configured — every turn will fail';
  }

  const rawPosture = str('DEV3D_ROUTING', 'balanced').toLowerCase();
  const routingPosture: RoutingPosture =
    rawPosture === 'cheap' || rawPosture === 'quality' ? rawPosture : 'balanced';

  const autoApproveShell = str('DEV3D_AUTO_APPROVE_SHELL', 'false').toLowerCase() === 'true';

  const rawLog = str('DEV3D_LOG_LEVEL', 'info').toLowerCase();
  const logLevel =
    rawLog === 'debug' || rawLog === 'warn' || rawLog === 'error' ? rawLog : 'info';

  const workspace = abs('DEV3D_WORKSPACE', './workspace');
  const workspacesRoot = abs('DEV3D_WORKSPACES_ROOT', './workspaces');
  const allowExternalWorkspaces = str('DEV3D_ALLOW_EXTERNAL_WORKSPACES', 'true').toLowerCase() !== 'false';
  const dbPath = abs('DEV3D_DB', './data/dev3d.sqlite');

  return {
    host: str('HOST', '127.0.0.1'),
    port: num('PORT', 8787),
    repoRoot: REPO_ROOT,
    workspace,
    workspacesRoot,
    allowExternalWorkspaces,
    dbPath,
    skillsDir: abs('DEV3D_SKILLS_DIR', './skills'),
    pluginsDir: abs('DEV3D_PLUGINS_DIR', './plugins'),
    pluginInstallDir: abs('DEV3D_PLUGIN_INSTALL_DIR', './data/plugins'),
    allowPluginInstall: str('DEV3D_ALLOW_PLUGIN_INSTALL', 'false').toLowerCase() === 'true',
    modelDiscovery: str('DEV3D_MODEL_DISCOVERY', 'true').toLowerCase() !== 'false',
    discoveryTtlMs: Math.max(0, num('DEV3D_MODEL_DISCOVERY_TTL_MS', 6 * 60 * 60 * 1000)),
    discoveryCachePath: (() => {
      // Caching is on by default so a restart does not depend on every vendor
      // being reachable. `off` is the escape hatch for a locked-down install
      // that should not write a file it does not have to.
      const raw = str('DEV3D_MODEL_DISCOVERY_CACHE', './data/model-discovery.json');
      return raw.toLowerCase() === 'off' || raw.toLowerCase() === 'none' ? null : abs('DEV3D_MODEL_DISCOVERY_CACHE', raw);
    })(),
    pooledQualityKeyVar: str('DEV3D_POOLED_QUALITY_KEY_VAR', 'ARTIFICIAL_ANALYSIS_API_KEY'),
    pooledQualityCachePath: (() => {
      const raw = str('DEV3D_POOLED_QUALITY_CACHE', './data/pooled-quality.json');
      return raw.toLowerCase() === 'off' || raw.toLowerCase() === 'none' ? null : abs('DEV3D_POOLED_QUALITY_CACHE', raw);
    })(),
    // A week: a benchmark index moves on the scale of weeks, and the free API is
    // rate-limited to 1,000 requests a day across every user of a key.
    pooledQualityTtlMs: Math.max(0, num('DEV3D_POOLED_QUALITY_TTL_MS', 7 * 24 * 60 * 60 * 1000)),
    benchmarks: str('DEV3D_BENCHMARKS', 'true').toLowerCase() !== 'false',
    benchmarkCachePath: (() => {
      const raw = str('DEV3D_BENCHMARK_CACHE', './data/benchmarks.json');
      return raw.toLowerCase() === 'off' || raw.toLowerCase() === 'none' ? null : abs('DEV3D_BENCHMARK_CACHE', raw);
    })(),
    // A day: benchmarks are re-run continuously, but an index that matters for
    // routing does not move hour to hour.
    benchmarkTtlMs: Math.max(0, num('DEV3D_BENCHMARK_TTL_MS', 24 * 60 * 60 * 1000)),
    endpointHealth: str('DEV3D_ENDPOINT_HEALTH', 'true').toLowerCase() !== 'false',
    endpointHealthProviderIds: str('DEV3D_ENDPOINT_HEALTH_PROVIDERS', 'openrouter')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
    endpointHealthCachePath: (() => {
      const raw = str('DEV3D_ENDPOINT_HEALTH_CACHE', './data/endpoint-health.json');
      return raw.toLowerCase() === 'off' || raw.toLowerCase() === 'none' ? null : abs('DEV3D_ENDPOINT_HEALTH_CACHE', raw);
    })(),
    // Ten minutes: uptime is a rolling 30-minute figure, so refreshing much
    // faster than that would re-ask for a number that has barely moved.
    endpointHealthTtlMs: Math.max(0, num('DEV3D_ENDPOINT_HEALTH_TTL_MS', 10 * 60 * 1000)),
    llmMode,
    llmModeSetting,
    llmModeReason,
    configuredProviderIds,
    envFilePath,
    envFileMtimeMs,
    routingPosture,
    runBudgetUsd: num('DEV3D_RUN_BUDGET_USD', 5),
    softSpendApprovalUsd: num('DEV3D_SOFT_SPEND_APPROVAL_USD', 1.5),
    maxConcurrency: Math.max(1, Math.min(16, num('DEV3D_MAX_CONCURRENCY', 4))),
    autoApproveShell,
    approvalTimeoutMs: Math.max(1_000, num('DEV3D_APPROVAL_TIMEOUT_MS', 600_000)),
    providers,
    dotEnvCount,
    logLevel,
    version: readVersion(),
  };
}

/**
 * Installation settings for a first boot.
 *
 * `.env` is the *bootstrap*: once the office has saved settings of its own, those
 * win, and the Settings page is how they change. The environment stays the
 * authority for anything secret (provider keys) and for where the database and
 * the working directories live, because those have to be known before the
 * database can be opened.
 */
export function defaultOfficeSettings(config: ServerConfig): OfficeSettings {
  return {
    workspacesRoot: config.workspacesRoot,
    allowExternalWorkspaces: config.allowExternalWorkspaces,
    defaultRoutingPosture: config.routingPosture,
    maxConcurrency: config.maxConcurrency,
    softSpendApprovalUsd: config.softSpendApprovalUsd,
    autoApproveShell: config.autoApproveShell,
    approvalTimeoutMs: config.approvalTimeoutMs,
    logLevel: config.logLevel,
    disabledModelIds: [],
    // Empty means "the catalog's word for every model", which is what a fresh
    // installation should believe until an operator corrects something.
    modelOverrides: {},
    updatedAt: Date.now(),
  };
}

export { isProviderConfigured };

/** Whether the environment has moved on since this process read it. */
export interface ConfigDrift {
  /** True when a restart would resolve something differently. */
  stale: boolean;
  /** What changed, in words, for an operator looking at a badge that says mock. */
  detail: string | null;
}

/**
 * Has the environment changed since boot?
 *
 * `.env` is read exactly once, at module load, so editing it does nothing to a
 * running server - which is correct and completely invisible. This is what turns
 * "why is it still in mock mode?" into "you edited `.env` 56 minutes after this
 * process started; restart it".
 *
 * Two signals, because there are two ways to change the answer:
 *
 *  - the **file** was modified, which covers anything at all being edited;
 *  - a **provider key appeared** in the process environment, which covers an
 *    operator exporting a key in a shell rather than writing it to `.env`.
 *
 * The reverse (a key being *removed*) is deliberately not reported: `process.env`
 * for a running process is not observably mutable from outside, so claiming to
 * detect it would be a guess dressed as a fact.
 */
export function detectConfigDrift(config: ServerConfig): ConfigDrift {
  const reasons: string[] = [];

  const now = mtimeOf(config.envFilePath);
  if (now !== null && config.envFileMtimeMs !== null && now > config.envFileMtimeMs) {
    reasons.push('.env has been modified since this process started');
  }

  const appeared: string[] = [];
  for (const provider of config.providers) {
    if (provider.keyEnvVar === undefined) continue;
    const present = (process.env[provider.keyEnvVar] ?? '').trim() !== '';
    const wasConfigured = config.configuredProviderIds.includes(provider.id);
    // A keyless provider counts as configured from its base URL, so only a key
    // that has *appeared* is drift.
    if (present && !wasConfigured) appeared.push(`${provider.keyEnvVar} is now set for '${provider.id}'`);
  }
  if (appeared.length > 0) reasons.push(appeared.join('; '));

  if (reasons.length === 0) return { stale: false, detail: null };
  return {
    stale: true,
    detail: `${reasons.join(', and ')}. The environment is read once at startup, so restart the orchestrator to apply it.`,
  };
}
