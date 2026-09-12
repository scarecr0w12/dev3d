/**
 * Vendor configuration.
 *
 * Two sources, for the same reason MCP has two: `DEV3D_VENDORS` in the
 * environment for one or two entries and for deployments that configure
 * everything through env, and a JSON file (`DEV3D_VENDORS_CONFIG`, default
 * `./vendors.json`) for anything richer. Both are merged, and the file wins on
 * an id collision.
 *
 * A malformed entry is skipped with a reason rather than taking the list down:
 * one bad vendor must not stop the others working.
 *
 * ## Presets, and why they exist
 *
 * Every harness here is invoked as `<command> <args...> <prompt>`, but the
 * args are the part nobody remembers: `codex exec --json -s read-only`, not
 * `codex run`. Getting one wrong produces a process that starts, exits non-zero
 * and explains nothing, which is a bad first experience for a feature whose
 * whole promise is "connect to a harness you already have".
 *
 * So a `preset` fills in the command and args for the three harnesses with a
 * documented headless mode, and an explicit `command` overrides it. The presets
 * are evidence-backed invocations, not guesses - see `docs/external-agents.md`
 * for the sources - and each carries the capability declarations that follow
 * from what that invocation actually does.
 *
 * A harness with no one-shot mode is deliberately **not** given a preset. A
 * preset that fails is worse than no preset: it teaches an operator that the
 * integration is broken rather than that this vendor needs a different
 * transport.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReadOnlyEnforcement } from '@dev3d/core';
import type { VendorOutputFormat } from './output.ts';

/** How the prompt reaches the vendor's process. */
export type VendorPromptTransport = 'argv' | 'stdin';

/**
 * How the office talks to a vendor.
 *
 *  - **`command`** — run it once with a prompt and read stdout. The lowest
 *    common denominator, and what every harness with a headless mode supports.
 *  - **`acp`** — speak the Agent Client Protocol over stdio. One implementation
 *    reaches a whole registry of agents, and it buys three things a command
 *    cannot: the agent's tool calls are visible as they happen, its read paths
 *    can be confined to the run's workspace by the office itself, and its write
 *    path can be refused outright.
 */
export type VendorTransport = 'command' | 'acp';

/** One vendor, as the config declares it. */
export interface VendorConfig {
  id: string;
  label: string;
  /** Who operates it. Shown in the console so "whose machine is this" is never a guess. */
  operator: string;
  transport: VendorTransport;
  command: string;
  args: string[];
  promptTransport: VendorPromptTransport;
  /**
   * How to read the answer out of what it printed.
   *
   * `text` is the common case - the harness prints the final assistant message
   * and nothing else. `codex-jsonl` reads the `--json` event stream, where the
   * answer is one event among dozens. See `output.ts`; every parser degrades to
   * the raw text rather than returning nothing.
   */
  outputFormat: VendorOutputFormat;
  /**
   * How the office checks the vendor is actually installed and runnable.
   *
   * Defaults to `--version`, which all three presets support. An **empty array
   * means "do not probe"**: the vendor is taken as on site, and the truth arrives
   * with the first delegation. That escape hatch exists because a harness with no
   * cheap liveness command would otherwise be reported unreachable while working
   * perfectly, which is a worse lie than not checking.
   */
  probeArgs: string[];
  /**
   * Ceiling on one delegation, in milliseconds.
   *
   * This is the real control on an external agent, not the run budget: a vendor
   * on a subscription reports no cost, so the spend ceiling is inert and a
   * delegation that never returns costs wall-clock instead of dollars.
   */
  timeoutMs: number;
  enabled: boolean;
  description?: string;
  authNote?: string;
  color?: string;
  /** What dev3d promises about read-only. Defaults are per preset, then conservative. */
  capabilities: {
    readOnlyEnforcement: ReadOnlyEnforcement;
    reportsFiles: boolean;
    streams: boolean;
    reportsCost: boolean;
  };
}

export interface VendorConfigResult {
  vendors: VendorConfig[];
  /** Problems found while reading config, to be logged rather than thrown. */
  problems: string[];
  /** Where the file was read from, when one was. */
  file: string | null;
}

/**
 * A vendor id appears inside a tool name as `agent__<id>__delegate`, so it must
 * not contain `_` - that is the separator, and an id containing one would make
 * the published name ambiguous to split back apart. Lowercase, digits and `-`
 * only, which is also what keeps the name greppable.
 */
const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

const DEFAULT_TIMEOUT_MS = 300_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 3_600_000;

/**
 * The documented invocation of each harness, with the capability declarations
 * that follow from it.
 *
 * `readOnlyEnforcement` is the field that matters most and the one most likely to
 * be set wrongly by optimism. Each value below is derived from what the
 * invocation actually does, not from what the harness's marketing implies:
 *
 *  - **Codex** takes `-s read-only` as a real sandbox mode, so Codex confines
 *    itself → `sandbox`.
 *  - **DSH** and **Hermes** expose no documented per-invocation sandbox flag. The
 *    office still only ever sends them read-only work and says so in the prompt,
 *    but nothing stops them writing except their own cooperation → `requested`.
 *  - **OpenClaw** speaks ACP, so dev3d mediates it: write access is not
 *    advertised, reads are confined by the office, and every tool call the agent
 *    reports needs a human → `client`.
 */
interface VendorPreset {
  transport: VendorTransport;
  command: string;
  args: string[];
  operator: string;
  timeoutMs: number;
  outputFormat: VendorOutputFormat;
  authNote: string;
  capabilities: VendorConfig['capabilities'];
}

const NO_COST = { reportsCost: false } as const;

export const VENDOR_PRESETS: Readonly<Record<string, VendorPreset>> = {
  codex: {
    transport: 'command',
    command: 'codex',
    args: ['exec', '--json', '-s', 'read-only'],
    operator: 'OpenAI',
    timeoutMs: 300_000,
    outputFormat: 'codex-jsonl',
    authNote: 'Codex owns its own auth and billing. Run `codex login` in a terminal if it reports an auth failure; a dev3d provider key does nothing for it.',
    capabilities: { readOnlyEnforcement: 'sandbox', reportsFiles: true, streams: true, ...NO_COST },
  },
  dsh: {
    transport: 'command',
    command: 'dsh',
    args: ['--profile', 'headless'],
    operator: 'DeepSeek',
    timeoutMs: 600_000,
    outputFormat: 'text',
    authNote: 'DeepSeek Harness reads its own profile and credentials under the DSH home. Run `dsh --profile headless --dump-config` to see which provider it resolved.',
    // No documented per-invocation sandbox flag: read-only is requested, not enforced.
    capabilities: { readOnlyEnforcement: 'requested', reportsFiles: false, streams: false, ...NO_COST },
  },
  hermes: {
    transport: 'command',
    command: 'hermes',
    args: ['chat', '-q'],
    operator: 'Nous Research',
    timeoutMs: 600_000,
    outputFormat: 'text',
    authNote: 'Hermes reads ~/.hermes/config.yaml. Run `hermes config set` to point it at a provider; it bills against whatever that file names, not against dev3d.',
    capabilities: { readOnlyEnforcement: 'requested', reportsFiles: false, streams: false, ...NO_COST },
  },
  openclaw: {
    // `openclaw acp` is a Gateway-backed ACP bridge over stdio: it forwards
    // prompts to a running OpenClaw Gateway over WebSocket, so the Gateway has to
    // be up before a delegation will work. Its own compatibility matrix is
    // explicit that it implements neither the client filesystem methods nor
    // `terminal/*`, which is why the enforcement claim below is `client` and not
    // `sandbox`: dev3d refuses the write path and confines reads, but OpenClaw
    // edits files through its Gateway rather than through us, so nothing here
    // confines that.
    transport: 'acp',
    command: 'openclaw',
    args: ['acp'],
    operator: 'OpenClaw',
    timeoutMs: 600_000,
    outputFormat: 'text',
    authNote: 'OpenClaw authenticates and bills through its own Gateway. Start the Gateway first; `openclaw acp` is a bridge to it, not a standalone agent.',
    capabilities: { readOnlyEnforcement: 'client', reportsFiles: true, streams: true, ...NO_COST },
  },
};

export function presetNames(): string[] {
  return Object.keys(VENDOR_PRESETS).sort();
}

/**
 * Parse the `DEV3D_VENDORS` environment variable.
 *
 * Entries are separated by `;` and are either a bare preset name or
 * `<id>=<preset>`, so the common case is one word:
 *
 *     DEV3D_VENDORS="codex;dsh;hermes"
 *     DEV3D_VENDORS="fast=codex;cheap=dsh"
 *
 * A semicolon rather than whitespace for the same reason MCP uses one: argument
 * lists contain spaces, so anything whitespace-delimited cannot say where one
 * entry ends. Anything richer than a preset belongs in the JSON file, because a
 * command line with a `;` in it cannot be expressed here at all.
 */
export function parseVendorList(raw: string): { vendors: VendorConfig[]; problems: string[] } {
  const vendors: VendorConfig[] = [];
  const problems: string[] = [];
  const entries = raw
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '');

  for (const entry of entries) {
    const eq = entry.indexOf('=');
    const id = eq === -1 ? entry : entry.slice(0, eq).trim();
    const presetName = (eq === -1 ? entry : entry.slice(eq + 1).trim()).toLowerCase();
    const preset = VENDOR_PRESETS[presetName];
    if (preset === undefined) {
      problems.push(
        `DEV3D_VENDORS entry ${JSON.stringify(entry)} names preset ${JSON.stringify(presetName)}, ` +
          `which is not one of: ${presetNames().join(', ')}. ` +
          `Configure a custom command in vendors.json instead.`,
      );
      continue;
    }
    if (!ID_RE.test(id)) {
      problems.push(
        `DEV3D_VENDORS id ${JSON.stringify(id)} must be lowercase letters, digits or "-", ` +
          `start with a letter, and contain no "_" (it is the tool-name separator).`,
      );
      continue;
    }
    vendors.push(fromPreset(id, presetName, preset));
  }
  return { vendors, problems };
}

function fromPreset(id: string, presetName: string, preset: VendorPreset): VendorConfig {
  const label = presetName.charAt(0).toUpperCase() + presetName.slice(1);
  return {
    id,
    label,
    operator: preset.operator,
    transport: preset.transport,
    command: preset.command,
    args: [...preset.args],
    promptTransport: 'argv',
    outputFormat: preset.outputFormat,
    probeArgs: ['--version'],
    timeoutMs: preset.timeoutMs,
    enabled: true,
    authNote: preset.authNote,
    capabilities: { ...preset.capabilities },
  };
}

/** Read and validate the JSON config file. */
export function readVendorConfigFile(path: string): { vendors: VendorConfig[]; problems: string[] } {
  const problems: string[] = [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { vendors: [], problems: [`Could not read ${path}: ${e instanceof Error ? e.message : String(e)}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { vendors: [], problems: [`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }

  const record = isRecord(parsed) ? parsed : null;
  const list = record !== null && Array.isArray(record['vendors']) ? (record['vendors'] as unknown[]) : null;
  if (list === null) {
    return { vendors: [], problems: [`${path} must be an object with a "vendors" array.`] };
  }

  const vendors: VendorConfig[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i += 1) {
    const result = readVendor(list[i], `vendors[${i}]`, problems);
    if (result === null) continue;
    if (seen.has(result.id)) {
      problems.push(`vendors[${i}]: duplicate vendor id ${JSON.stringify(result.id)}.`);
      continue;
    }
    seen.add(result.id);
    vendors.push(result);
  }
  return { vendors, problems };
}

function readVendor(entry: unknown, where: string, problems: string[]): VendorConfig | null {
  if (!isRecord(entry)) {
    problems.push(`${where} is not an object.`);
    return null;
  }
  const id = entry['id'];
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    problems.push(
      `${where}.id must be lowercase letters, digits or "-", start with a letter, ` +
        `and contain no "_" (it is the tool-name separator).`,
    );
    return null;
  }

  // A preset is the default for anything the entry leaves out, which is what
  // makes `{"id":"codex","preset":"codex"}` a complete vendor.
  const presetName = typeof entry['preset'] === 'string' ? entry['preset'].toLowerCase() : null;
  const preset = presetName !== null ? VENDOR_PRESETS[presetName] : undefined;
  if (presetName !== null && preset === undefined) {
    problems.push(`${where}.preset must be one of: ${presetNames().join(', ')}.`);
    return null;
  }

  const command = typeof entry['command'] === 'string' ? entry['command'].trim() : (preset?.command ?? '');
  if (command === '') {
    problems.push(`${where} names neither a "preset" nor a non-empty "command".`);
    return null;
  }

  const args = Array.isArray(entry['args'])
    ? (entry['args'] as unknown[]).filter((a): a is string => typeof a === 'string')
    : [...(preset?.args ?? [])];

  const promptTransport: VendorPromptTransport =
    entry['promptTransport'] === 'stdin' ? 'stdin' : 'argv';

  // An unrecognised transport falls back to `command` rather than being refused:
  // a vendor run as a one-shot process is still useful even if its declared
  // transport was a typo, whereas one dropped from the bay is not.
  const declaredTransport = entry['transport'];
  const transport: VendorTransport =
    declaredTransport === 'acp' ? 'acp' : declaredTransport === 'command' ? 'command' : (preset?.transport ?? 'command');

  // Only the two known formats, and anything unrecognised falls back to `text`
  // rather than being refused: a vendor whose answer dev3d reads as prose is
  // still useful, whereas one dropped from the config is not.
  const declaredFormat = entry['outputFormat'];
  const outputFormat: VendorOutputFormat =
    declaredFormat === 'codex-jsonl' ? 'codex-jsonl' : declaredFormat === 'text' ? 'text' : (preset?.outputFormat ?? 'text');

  // An explicitly empty array is meaningful here - it is the opt-out - so this
  // distinguishes "absent" (take the default) from "[]" (do not probe).
  const probeArgs = Array.isArray(entry['probeArgs'])
    ? (entry['probeArgs'] as unknown[]).filter((a): a is string => typeof a === 'string')
    : ['--version'];

  const rawTimeout = entry['timeoutMs'];
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(rawTimeout)))
      : (preset?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const label =
    typeof entry['label'] === 'string' && entry['label'].trim() !== ''
      ? entry['label'].trim()
      : (presetName !== null ? presetName.charAt(0).toUpperCase() + presetName.slice(1) : id);
  const operator =
    typeof entry['operator'] === 'string' && entry['operator'].trim() !== ''
      ? entry['operator'].trim()
      : (preset?.operator ?? 'third party');

  const declared = isRecord(entry['capabilities']) ? (entry['capabilities'] as Record<string, unknown>) : {};
  const base: VendorConfig['capabilities'] = preset?.capabilities ?? {
    readOnlyEnforcement: 'requested',
    reportsFiles: false,
    streams: false,
    reportsCost: false,
  };
  const capabilities = {
    // Only the three known levels; anything else falls back to the preset, and
    // then to the weakest honest claim. An unrecognised value must never be read
    // as the strongest one - the whole point of the field is that overstating it
    // is the failure mode.
    readOnlyEnforcement: enforcementOr(declared['readOnlyEnforcement'], base.readOnlyEnforcement),
    reportsFiles: boolOr(declared['reportsFiles'], base.reportsFiles),
    streams: boolOr(declared['streams'], base.streams),
    reportsCost: boolOr(declared['reportsCost'], base.reportsCost),
  };

  const config: VendorConfig = {
    id,
    label,
    operator,
    transport,
    command,
    args,
    promptTransport,
    outputFormat,
    probeArgs,
    timeoutMs,
    enabled: entry['enabled'] !== false,
    capabilities,
  };
  const description = typeof entry['description'] === 'string' ? entry['description'] : undefined;
  if (description !== undefined) config.description = description;
  const authNote =
    typeof entry['authNote'] === 'string' ? entry['authNote'] : preset?.authNote;
  if (authNote !== undefined) config.authNote = authNote;
  // A colour is passed through only if it is a plain hex triple, because the
  // value reaches a shader and a material: a value that gets there is a value
  // that has to be refused at the boundary rather than rendered.
  const color = typeof entry['color'] === 'string' ? entry['color'].trim() : undefined;
  if (color !== undefined && /^#[0-9a-fA-F]{6}$/.test(color)) config.color = color;
  return config;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Read one of the three enforcement levels.
 *
 * Anything unrecognised yields the fallback, which is the preset's own level and
 * never `sandbox`. A typo must not be able to upgrade a request into a guarantee.
 */
function enforcementOr(value: unknown, fallback: ReadOnlyEnforcement): ReadOnlyEnforcement {
  if (value === 'sandbox' || value === 'client' || value === 'requested') return value;
  return fallback;
}

/**
 * Load the whole configuration.
 *
 * `repoRoot` resolves a relative config path, so the office reads the same file
 * no matter which directory it was started from.
 */
export function loadVendorConfig(env: NodeJS.ProcessEnv, repoRoot: string): VendorConfigResult {
  const problems: string[] = [];
  const byId = new Map<string, VendorConfig>();

  const inline = env['DEV3D_VENDORS'];
  if (typeof inline === 'string' && inline.trim() !== '') {
    const parsed = parseVendorList(inline);
    problems.push(...parsed.problems);
    for (const vendor of parsed.vendors) byId.set(vendor.id, vendor);
  }

  const configured = env['DEV3D_VENDORS_CONFIG'];
  const filePath =
    configured !== undefined && configured !== ''
      ? resolve(repoRoot, configured)
      : configured === ''
        ? null
        : resolve(repoRoot, 'vendors.json');

  let file: string | null = null;
  if (filePath !== null && existsSync(filePath)) {
    const parsed = readVendorConfigFile(filePath);
    problems.push(...parsed.problems);
    // The file wins on a collision: it is the richer, more explicit source.
    for (const vendor of parsed.vendors) byId.set(vendor.id, vendor);
    file = filePath;
  } else if (configured !== undefined && configured !== '' && filePath !== null) {
    // An explicitly named file that is missing is worth saying out loud; a
    // missing default `vendors.json` is simply "no vendors configured".
    problems.push(`DEV3D_VENDORS_CONFIG points at ${filePath}, which does not exist.`);
  }

  return { vendors: [...byId.values()], problems, file };
}

/** The role-grant policy, read the same way MCP's is and with the same default. */
export interface VendorGrantPolicy {
  grantRoles: string[];
  grantToDelegateRoles: boolean;
  requireCanDelegate: boolean;
}

/**
 * Parse `DEV3D_VENDOR_GRANT_ROLES`.
 *
 * Default `delegate-roles`, meaning *every role that already has
 * `Role.canDelegate`*. That marker rather than a list of role ids because role
 * ids belong to an org chart an operator can edit: a list hardcoded here would
 * stop matching after somebody renames a role, and would grant nothing at all on
 * a floor whose roles were named differently. "Whoever may already put work on
 * somebody else" keeps meaning the same thing as the chart changes - which is
 * the same reasoning `mcpGrantedForRole` documents for its own default.
 */
export function parseVendorGrantPolicy(env: NodeJS.ProcessEnv): VendorGrantPolicy {
  const raw = (env['DEV3D_VENDOR_GRANT_ROLES'] ?? 'delegate-roles').trim();
  const lower = raw.toLowerCase();
  const requireCanDelegate = env['DEV3D_VENDOR_REQUIRE_CAN_DELEGATE'] !== 'false';

  if (raw === '*') return { grantRoles: ['*'], grantToDelegateRoles: false, requireCanDelegate };
  if (lower === 'none') return { grantRoles: [], grantToDelegateRoles: false, requireCanDelegate };
  if (lower === 'delegate-roles') {
    return { grantRoles: ['delegate-roles'], grantToDelegateRoles: true, requireCanDelegate };
  }
  return {
    grantRoles: raw
      .split(/[,\s]+/)
      .map((part) => part.trim())
      .filter((part) => part !== ''),
    grantToDelegateRoles: false,
    requireCanDelegate,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
