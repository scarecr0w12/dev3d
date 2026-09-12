/**
 * Runtime configuration for the orchestrator.
 *
 * Everything is env-driven with sane defaults so `pnpm dev` works on a clean
 * checkout. With no API keys present the server boots in `mock` mode: the whole
 * pipeline still runs, employees are just scripted instead of calling a model.
 * That keeps the office demonstrable and the engine testable without a bill.
 */

import { existsSync, readFileSync } from 'node:fs';
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
      hint: 'Set DEEPSEEK_API_KEY in .env to enable DeepSeek models.',
    },
    {
      id: 'openai',
      label: 'OpenAI',
      kind: 'openai-compat',
      baseUrl: str('DEV3D_OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      apiKey: process.env.OPENAI_API_KEY?.trim() || null,
      hint: 'Set OPENAI_API_KEY in .env to enable OpenAI models.',
    },
    {
      id: 'openrouter',
      label: 'OpenRouter',
      kind: 'openai-compat',
      baseUrl: str('DEV3D_OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
      apiKey: process.env.OPENROUTER_API_KEY?.trim() || null,
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
      hint: 'Set ANTHROPIC_API_KEY in .env to enable Claude models.',
    },
    {
      id: 'local',
      label: 'Local (OpenAI-compatible)',
      kind: 'openai-compat',
      baseUrl: str('DEV3D_LOCAL_BASE_URL', 'http://127.0.0.1:11434/v1'),
      apiKey: process.env.DEV3D_LOCAL_API_KEY?.trim() || null,
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
  const anyConfigured = providers.some(isProviderConfigured);

  const rawMode = str('DEV3D_LLM_MODE', 'auto').toLowerCase();
  const llmModeSetting: LlmModeSetting =
    rawMode === 'mock' || rawMode === 'live' ? rawMode : 'auto';

  let llmMode: LlmMode;
  if (llmModeSetting === 'auto') llmMode = anyConfigured ? 'live' : 'mock';
  else llmMode = llmModeSetting;

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
    llmMode,
    llmModeSetting,
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
