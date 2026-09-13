/**
 * The plugin console's vocabulary.
 *
 * A plugin asks for *permissions* and makes *contributions*, and both of those
 * are lists of machine names in the manifest. This module is the one place that
 * turns them into English, so a permission reads identically on the card, in the
 * settings form and in the marketplace row - the operator should never have to
 * learn a second spelling of "this runs code in the server".
 */

import { apiCompatible, namespacedToolName } from '@dev3d/core';
import type {
  PluginContributionCounts,
  PluginPermission,
  PluginRecord,
  PluginSource,
  PluginStatus,
} from '@dev3d/core';

// The explicit `.ts` matters: this module is imported by the verify harness,
// which runs under plain `node`, where an extensionless specifier does not
// resolve. Vite is happy either way.
import { formatInt } from '../../app/format.ts';

// --------------------------------------------------------------- permissions

export interface PermissionCopy {
  label: string;
  /** One line, shown as a chip tooltip and as visible help text. */
  detail: string;
  /** True when granting it lets the plugin reach outside its own data. */
  elevated: boolean;
}

/**
 * Every `PluginPermission`, spelled out. The order is deliberate: everything
 * that can execute or reach out comes first, so the dangerous ones are the ones
 * an operator reads.
 */
const PERMISSIONS: Record<PluginPermission, PermissionCopy> = {
  tools: {
    label: 'tools',
    detail: 'registers tools that execute in the orchestrator',
    elevated: true,
  },
  providers: {
    label: 'providers',
    detail: 'registers a whole provider — a model endpoint, its base URL, and which environment variable holds the key',
    elevated: true,
  },
  events: {
    label: 'events',
    detail: 'observes the whole event stream, including employee turns and tool calls',
    elevated: true,
  },
  routing: {
    label: 'routing',
    detail: 'influences which model a turn is routed to',
    elevated: false,
  },
  models: {
    label: 'models',
    detail: 'adds or retunes entries in the model catalog',
    elevated: false,
  },
  skills: {
    label: 'skills',
    detail: 'contributes skill documents employees can be given',
    elevated: false,
  },
  agents: {
    label: 'agents',
    detail: 'contributes role and agent templates to a floor',
    elevated: false,
  },
  pipelines: {
    label: 'pipelines',
    detail: 'contributes pipelines a run can be submitted to',
    elevated: false,
  },
  settings: {
    label: 'settings',
    detail: 'adds operator-facing configuration, rendered on this page',
    elevated: false,
  },
  ui: {
    label: 'ui',
    detail: 'contributes console panels and visual tokens',
    elevated: false,
  },
};

export function permissionCopy(permission: PluginPermission): PermissionCopy {
  return PERMISSIONS[permission];
}

/** Empty when the manifest asked for nothing at all. */
export function describePermissions(permissions: readonly PluginPermission[] | undefined): PermissionCopy[] {
  return (permissions ?? []).map(permissionCopy);
}

// --------------------------------------------------------------------- status

export type PluginTone = 'ok' | 'neutral' | 'warn' | 'danger' | 'info' | 'accent';

export interface StatusCopy {
  label: string;
  tone: PluginTone;
  hint: string;
}

export function statusCopy(status: PluginStatus): StatusCopy {
  switch (status) {
    case 'loaded':
      return { label: 'loaded', tone: 'ok', hint: 'active: everything it contributes is in the office' };
    case 'disabled':
      return { label: 'disabled', tone: 'neutral', hint: 'installed but not loaded: it contributes nothing' };
    case 'error':
      return { label: 'error', tone: 'danger', hint: 'the host refused or failed to load it' };
    default:
      return { label: String(status), tone: 'warn', hint: 'unrecognised status' };
  }
}

// -------------------------------------------------------------------- sources

export function sourceCopy(source: PluginSource): { label: string; tone: PluginTone; hint: string } {
  switch (source) {
    case 'bundled':
      return { label: 'bundled', tone: 'info', hint: 'ships with the installation' };
    case 'local':
      return { label: 'local', tone: 'neutral', hint: 'a directory you put in the plugins root' };
    case 'marketplace':
      return { label: 'marketplace', tone: 'accent', hint: 'downloaded from a catalog and verified on install' };
    default:
      return { label: String(source), tone: 'neutral', hint: 'unknown provenance' };
  }
}

// -------------------------------------------------------------- contributions

export interface ContributionRow {
  label: string;
  count: number;
}

/** Only the non-zero rows: a card should not list seven kinds of nothing. */
export function contributionRows(counts: PluginContributionCounts): ContributionRow[] {
  const rows: ContributionRow[] = [
    { label: 'providers', count: counts.providers },
    { label: 'models', count: counts.models },
    { label: 'skills', count: counts.skills },
    { label: 'role templates', count: counts.roleTemplates },
    { label: 'pipelines', count: counts.pipelines },
    { label: 'routing rules', count: counts.routingRules },
    { label: 'tools', count: counts.tools },
    { label: 'UI panels', count: counts.uiPanels },
  ];
  return rows.filter((row) => row.count > 0);
}

/** `3 models · 1 skill`, or "nothing" - the card's one-line contribution summary. */
export function contributionLine(counts: PluginContributionCounts): string {
  const rows = contributionRows(counts);
  if (rows.length === 0) return 'nothing';
  return rows.map((row) => `${formatInt(row.count)} ${row.label}`).join(' · ');
}

// ------------------------------------------------------------- tool consent

export interface ToolConsent {
  /** The names the host actually registered. Authoritative — from the host, not the manifest. */
  registered: string[];
  /**
   * Names the manifest *declared* that the host has no registration for.
   *
   * Empty while the plugin is not loaded: a disabled plugin has registered
   * nothing by definition, and calling that a discrepancy would put a warning on
   * every disabled row.
   */
  unbacked: string[];
  /** True when the manifest's claim and the host's observation disagree. */
  mismatch: boolean;
  /** One line for the tooltip, or `null` when there is nothing to say. */
  hint: string | null;
}

/**
 * What a plugin has *actually* registered, against what its manifest claimed.
 *
 * `contributes.toolNames` was documented as being for the consent screen and was
 * read by nothing, while the host separately tracked the real registrations and
 * published only their count. An operator deciding whether to trust a plugin
 * needs the names of the tools it now holds — the bare count of "3 tools" cannot
 * tell a file reader from a shell wrapper.
 *
 * The comparison uses `namespacedToolName` from `@dev3d/core`, the same function
 * the host registers with. A hand-written approximation here would silently
 * accuse a correct plugin of claiming a tool it never registered whenever the two
 * spellings of "clean a name" disagreed.
 */
export function toolConsent(record: PluginRecord): ToolConsent {
  const declared = record.manifest.contributes?.toolNames ?? [];
  const registered = [...record.registeredToolNames].sort();
  const loaded = record.status === 'loaded';

  if (!loaded) {
    return {
      registered,
      unbacked: [],
      mismatch: false,
      hint:
        declared.length === 0
          ? null
          : `Its manifest names ${formatInt(declared.length)} tool(s), but it is not loaded, so it holds none.`,
    };
  }

  const held = new Set(registered);
  const unbacked = declared.filter((name) => !held.has(namespacedToolName(record.manifest.id, name)));

  const mismatch = unbacked.length > 0;
  return {
    registered,
    unbacked,
    mismatch,
    hint:
      declared.length === 0
        ? null
        : mismatch
          ? `Its manifest names ${unbacked.map((name) => `"${name}"`).join(', ')}, which the host did not see register. ` +
            'A declared tool name is a claim, not a registration: what it holds is the list above.'
          : 'Every tool its manifest named did register.',
  };
}

// ------------------------------------------------------------------ api version

export interface ApiVersionCheck {
  matches: boolean;
  plugin: string;
  host: string;
  detail: string;
}

/**
 * Whether the host would load this plugin.
 *
 * The rule is `apiCompatible` from `@dev3d/core` — the *same* function the host
 * gates on. This used to compare exact strings (`plugin === hostApiVersion`) while
 * the host compared major versions, so a plugin declaring `apiVersion: "1.2"`
 * loaded perfectly and the console painted its card red with "host implements 1 —
 * mismatch". A console that accuses a correct plugin of an incompatibility it does
 * not have is worse than one that says nothing.
 */
export function checkApiVersion(record: PluginRecord, hostApiVersion: string): ApiVersionCheck {
  const plugin = record.manifest.apiVersion;
  const matches = apiCompatible(plugin, hostApiVersion);
  return {
    matches,
    plugin,
    host: hostApiVersion,
    detail: matches
      ? `built against plugin API ${plugin}, which this host implements`
      : `built against plugin API ${plugin}; this host implements ${hostApiVersion}`,
  };
}

// ----------------------------------------------------------------- formatting

/** `412 kB`, `1.4 MB` - decimal units, which is what a download size means. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const kb = bytes / 1000;
  if (kb < 1000) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} kB`;
  const mb = kb / 1000;
  if (mb < 1000) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1000).toFixed(1)} GB`;
}

/** The first 12 hex characters of a digest, which is enough to eyeball one. */
export function shortenDigest(sha256: string): string {
  const hex = sha256.trim().toLowerCase();
  return hex.length <= 12 ? hex : `${hex.slice(0, 12)}…`;
}

/** A catalog url is a real url; refuse anything that is not http(s). */
export function isCatalogUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
