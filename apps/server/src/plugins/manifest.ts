/**
 * Manifest validation.
 *
 * A plugin manifest is untrusted input: it arrives from disk or from a
 * marketplace, and the host is about to act on it. So everything is checked
 * here, before anything is loaded, and the rules are deliberately split in two:
 *
 *  - **problems** reject the whole plugin. A bad id, a missing version, or an
 *    `apiVersion` the host cannot honour means we do not know what we would be
 *    running, so we do not run it.
 *  - **warnings** drop a single malformed contribution and keep the rest. A
 *    typo in one model entry should cost you that entry, not the plugin.
 *
 * The distinction matters: a plugin that silently loses half its models is worse
 * than one that refuses to load, but only if the loss is reported. Warnings are
 * reported.
 */

import { MODEL_TIER_ORDER, PLUGIN_API_VERSION, apiCompatible, apiMajor } from '@dev3d/core';
import type {
  ModelSpec,
  PanelWidget,
  Pipeline,
  PluginContributions,
  PluginManifest,
  PluginPermission,
  PluginPersistedState,
  PluginProvider,
  PluginSettingField,
  PluginSkill,
  PluginSourceRecord,
  Role,
  RoutingRule,
  Seniority,
  TaskClass,
  UiPanelContribution,
} from '@dev3d/core';

/** The seniority vocabulary, for validating a plugin's role template. */
const SENIORITIES: readonly Seniority[] = ['executive', 'lead', 'senior', 'mid', 'junior'];

export interface ManifestProblem {
  field: string;
  message: string;
}

export type ManifestResult =
  | { ok: true; manifest: PluginManifest; warnings: string[] }
  | { ok: false; problems: ManifestProblem[] };

/** Reverse-dns-ish: at least two dot-separated segments, lowercase. */
const ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SETTING_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
/** A provider id is a flat lowercase slug, e.g. `local` or `my-gateway`. */
const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const ENV_VAR_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

const PERMISSIONS: readonly PluginPermission[] = [
  'models',
  'providers',
  'tools',
  'routing',
  'skills',
  'agents',
  'pipelines',
  'settings',
  'ui',
  'events',
];

const TIERS: readonly string[] = ['nano', 'small', 'standard', 'strong', 'max'];
const TASK_CLASSES: readonly TaskClass[] = [
  'intake', 'routing', 'summarize', 'planning', 'research', 'debate', 'workshop',
  'design', 'architecture', 'coding', 'review', 'testing', 'ops',
];

/**
 * The compatibility rule lives in `@dev3d/core`, beside the version it compares.
 *
 * Re-exported here because this module is where the host gate reads it, and it
 * used to be defined here — but the console and the marketplace had their own
 * copies, and they disagreed with this one. See `apiCompatible` in
 * `packages/core/src/plugin.ts`.
 */
export { apiCompatible, apiMajor };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ------------------------------------------------------------- contributions

/**
 * A price, which must be zero or more.
 *
 * Returns 0 and warns rather than dropping the model: a manifest that got a sign
 * wrong should still load, so the operator can see the plugin and the message
 * together. Returns `undefined` when the field was absent, so an omitted price
 * stays omitted instead of becoming a claimed zero.
 */
function nonNegative(value: unknown, where: string, warnings: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    warnings.push(`${where} is not a finite number; treated as 0.`);
    return 0;
  }
  if (value < 0) {
    warnings.push(
      `${where} is negative (${value}); treated as 0. A negative price would refund the run budget ` +
        'instead of spending it.',
    );
    return 0;
  }
  return value;
}

function pickModels(raw: unknown, warnings: string[]): ModelSpec[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) warnings.push('contributes.models is not an array; ignored.');
    return [];
  }
  const out: ModelSpec[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`models[${index}] is not an object; dropped.`);
      return;
    }
    const id = str(entry['id']);
    const providerId = str(entry['providerId']);
    const tier = str(entry['tier']);
    if (!id || !providerId || !tier || !TIERS.includes(tier)) {
      warnings.push(`models[${index}] needs id, providerId and a valid tier; dropped.`);
      return;
    }
    const capabilities = isRecord(entry['capabilities']) ? entry['capabilities'] : {};
    const strengths = Array.isArray(entry['strengths'])
      ? (entry['strengths'] as unknown[]).filter((s): s is TaskClass => typeof s === 'string' && TASK_CLASSES.includes(s as TaskClass))
      : [];
    // A price is money spent, so it cannot be negative. It used to be read with
    // no sign check, and `computeCost` multiplies the rate by the token count —
    // so a manifest declaring `costPerMTokIn: -5` produced a *negative* cost,
    // which subtracted from `run.budget.spentUsd`. The engine's only guard is an
    // upper bound (`spentUsd >= limitUsd`), so a negative price refunded the
    // budget on every turn and the spend ceiling could never be reached.
    const costPerMTokIn = nonNegative(entry['costPerMTokIn'], `models[${index}].costPerMTokIn`, warnings);
    const costPerMTokOut = nonNegative(entry['costPerMTokOut'], `models[${index}].costPerMTokOut`, warnings);
    const model: ModelSpec = {
      id,
      providerId,
      label: str(entry['label']) ?? id,
      tier: tier as ModelSpec['tier'],
      contextWindow: num(entry['contextWindow']) ?? 128_000,
      maxOutputTokens: num(entry['maxOutputTokens']) ?? 8_192,
      costPerMTokIn: costPerMTokIn ?? 0,
      costPerMTokOut: costPerMTokOut ?? 0,
      capabilities: {
        tools: capabilities['tools'] === true,
        vision: capabilities['vision'] === true,
        reasoning: capabilities['reasoning'] === true,
        streaming: capabilities['streaming'] !== false,
      },
      strengths,
    };
    const effort = entry['defaultEffort'];
    if (effort === 'low' || effort === 'medium' || effort === 'high') model.defaultEffort = effort;
    out.push(model);
  });
  return out;
}

function pickSkills(raw: unknown, warnings: string[]): PluginSkill[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) warnings.push('contributes.skills is not an array; ignored.');
    return [];
  }
  const out: PluginSkill[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`skills[${index}] is not an object; dropped.`);
      return;
    }
    const id = str(entry['id']);
    const name = str(entry['name']);
    const description = str(entry['description']);
    const body = typeof entry['body'] === 'string' ? entry['body'] : '';
    if (!id || !name || !description || body.trim() === '') {
      warnings.push(`skills[${index}] needs id, name, description and a non-empty body; dropped.`);
      return;
    }
    const skill: PluginSkill = {
      id,
      name,
      description,
      body,
      tags: Array.isArray(entry['tags']) ? (entry['tags'] as unknown[]).map(String) : [],
    };
    if (Array.isArray(entry['taskClasses'])) {
      skill.taskClasses = (entry['taskClasses'] as unknown[]).map(String);
    }
    out.push(skill);
  });
  return out;
}

function pickRules(raw: unknown, warnings: string[]): RoutingRule[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) warnings.push('contributes.routingRules is not an array; ignored.');
    return [];
  }
  const out: RoutingRule[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`routingRules[${index}] is not an object; dropped.`);
      return;
    }
    const id = str(entry['id']);
    if (!id) {
      warnings.push(`routingRules[${index}] needs an id; dropped.`);
      return;
    }
    const rule: RoutingRule = {
      id,
      description: str(entry['description']) ?? 'no description',
    };
    const taskClass = str(entry['taskClass']);
    if (taskClass && TASK_CLASSES.includes(taskClass as TaskClass)) rule.taskClass = taskClass as TaskClass;
    const tier = str(entry['tier']);
    if (tier && TIERS.includes(tier)) rule.tier = tier as RoutingRule['tier'];
    const list = (key: string): string[] | undefined => {
      const value = entry[key];
      if (!Array.isArray(value)) return undefined;
      const cleaned = value.map(String).filter((item) => item.trim() !== '');
      return cleaned.length > 0 ? cleaned : undefined;
    };
    const prefer = list('preferProviderIds');
    if (prefer) rule.preferProviderIds = prefer;
    const models = list('preferModelIds');
    if (models) rule.preferModelIds = models;
    const avoid = list('avoidModelIds');
    if (avoid) rule.avoidModelIds = avoid;
    out.push(rule);
  });
  return out;
}

// ------------------------------------------------------------- panel widgets

/**
 * A panel body is untrusted data destined for the DOM, so it is capped hard:
 * a few hundred short strings, never a structure that can wedge a render.
 * Anything over the cap is truncated rather than rejected, because the panel is
 * decoration and losing a row must not cost the plugin.
 */
const PANEL_MAX_WIDGETS = 24;
const PANEL_MAX_ROWS = 60;
const PANEL_MAX_ITEMS = 60;
const PANEL_MAX_COLUMNS = 8;
const PANEL_TEXT_MAX = 500;
const PANEL_LABEL_MAX = 120;

function panelText(value: unknown, max = PANEL_TEXT_MAX): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (clean === '') return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function validatePanelWidgets(raw: unknown): { widgets: PanelWidget[]; dropped: number } {
  if (!Array.isArray(raw)) return { widgets: [], dropped: 0 };
  const widgets: PanelWidget[] = [];
  let dropped = 0;
  for (const entry of raw.slice(0, PANEL_MAX_WIDGETS)) {
    if (widgets.length >= PANEL_MAX_WIDGETS) break;
    if (!isRecord(entry)) {
      dropped += 1;
      continue;
    }
    const kind = str(entry['kind']);
    const label = panelText(entry['label'], PANEL_LABEL_MAX) ?? '';

    if (kind === 'metric') {
      const value = panelText(entry['value']);
      if (value === null) {
        dropped += 1;
        continue;
      }
      const widget: PanelWidget = { kind: 'metric', label: label || 'value', value };
      const unit = panelText(entry['unit'], 24);
      if (unit !== null) widget.unit = unit;
      const hint = panelText(entry['hint']);
      if (hint !== null) widget.hint = hint;
      widgets.push(widget);
      continue;
    }

    if (kind === 'keyValue') {
      const rows = Array.isArray(entry['rows']) ? entry['rows'].slice(0, PANEL_MAX_ROWS) : [];
      const clean: Array<{ key: string; value: string }> = [];
      for (const row of rows) {
        if (!isRecord(row)) continue;
        const key = panelText(row['key'], PANEL_LABEL_MAX);
        // A value of '' is legitimate: "nothing configured yet" is a real answer.
        const value = typeof row['value'] === 'string' ? row['value'] : null;
        if (key === null || value === null) continue;
        clean.push({ key, value: panelText(value) ?? '—' });
      }
      if (clean.length === 0) {
        dropped += 1;
        continue;
      }
      widgets.push({ kind: 'keyValue', label: label || 'Details', rows: clean });
      continue;
    }

    if (kind === 'table') {
      const columns = (Array.isArray(entry['columns']) ? entry['columns'] : [])
        .map((column) => panelText(column, PANEL_LABEL_MAX))
        .filter((column): column is string => column !== null)
        .slice(0, PANEL_MAX_COLUMNS);
      if (columns.length === 0) {
        dropped += 1;
        continue;
      }
      // Every row is trimmed *and padded* to the column count, so the renderer
      // can index cells positionally without a bounds check per cell, and a
      // short row shows an honest gap rather than shifting the columns.
      const rows = (Array.isArray(entry['rows']) ? entry['rows'] : [])
        .slice(0, PANEL_MAX_ROWS)
        .map((row) => {
          const cells = (Array.isArray(row) ? row : []).slice(0, columns.length).map((cell) => panelText(cell) ?? '—');
          while (cells.length < columns.length) cells.push('—');
          return cells;
        })
        .filter((row) => row.length > 0);
      widgets.push({ kind: 'table', label: label || 'Table', columns, rows });
      continue;
    }

    if (kind === 'list') {
      const items = (Array.isArray(entry['items']) ? entry['items'] : [])
        .map((item) => panelText(item))
        .filter((item): item is string => item !== null)
        .slice(0, PANEL_MAX_ITEMS);
      widgets.push({ kind: 'list', label: label || 'Items', items });
      continue;
    }

    if (kind === 'bars') {
      const bars = (Array.isArray(entry['bars']) ? entry['bars'] : [])
        .slice(0, PANEL_MAX_ITEMS)
        .map((bar) => {
          if (!isRecord(bar)) return null;
          const barLabel = panelText(bar['label'], PANEL_LABEL_MAX);
          const value = num(bar['value']);
          if (barLabel === null || value === null) return null;
          const out: { label: string; value: number; max?: number } = { label: barLabel, value };
          const max = num(bar['max']);
          if (max !== null && max > 0) out.max = max;
          return out;
        })
        .filter((bar): bar is { label: string; value: number; max?: number } => bar !== null);
      if (bars.length === 0) {
        dropped += 1;
        continue;
      }
      widgets.push({ kind: 'bars', label: label || 'Breakdown', bars });
      continue;
    }

    if (kind === 'note') {
      const text = panelText(entry['text']);
      if (text === null) {
        dropped += 1;
        continue;
      }
      widgets.push({ kind: 'note', text });
      continue;
    }

    dropped += 1;
  }
  return { widgets, dropped };
}

/** A panel's live source. Only http(s), because the *server* fetches it. */
function pickPanelSource(raw: unknown, warnings: string[], what: string): { url: string; refreshMs?: number } | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    warnings.push(`${what}.source is not an object; ignored.`);
    return undefined;
  }
  const url = str(raw['url']);
  if (url === null || !/^https?:\/\//i.test(url)) {
    warnings.push(`${what}.source.url must be an http(s) URL; ignored.`);
    return undefined;
  }
  const source: { url: string; refreshMs?: number } = { url };
  const refresh = num(raw['refreshMs']);
  // A floor on the refresh interval: a panel is decoration, and a plugin must
  // not be able to turn the console into a request amplifier.
  if (refresh !== null) source.refreshMs = Math.max(5_000, Math.min(3_600_000, Math.round(refresh)));
  return source;
}

function pickUiPanels(raw: unknown, warnings: string[]): UiPanelContribution[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) warnings.push('contributes.uiPanels is not an array; ignored.');
    return [];
  }
  const placements = new Set(['inspector', 'runs', 'office-overlay', 'settings']);
  const out: UiPanelContribution[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`uiPanels[${index}] is not an object; dropped.`);
      return;
    }
    const id = str(entry['id']);
    const title = str(entry['title']);
    const placement = str(entry['placement']);
    if (!id || !title || !placement || !placements.has(placement)) {
      warnings.push(`uiPanels[${index}] needs id, title and a known placement; dropped.`);
      return;
    }
    const what = `uiPanels[${index}]`;
    const panel: UiPanelContribution = {
      id,
      title,
      placement: placement as UiPanelContribution['placement'],
      summary: str(entry['summary']) ?? '',
    };
    if (entry['body'] !== undefined) {
      const { widgets, dropped } = validatePanelWidgets(entry['body']);
      if (dropped > 0) warnings.push(`${what}.body: ${dropped} widget(s) were not renderable and were dropped.`);
      if (widgets.length > 0) panel.body = widgets;
      else warnings.push(`${what}.body has no renderable widget; the panel will be empty.`);
    }
    const source = pickPanelSource(entry['source'], warnings, what);
    if (source !== undefined) panel.source = source;
    if (panel.body === undefined && panel.source === undefined) {
      warnings.push(`${what} declares neither a body nor a source, so it has nothing to show.`);
    }
    const tokens = pickPanelTokens(entry['tokens'], warnings, what);
    if (tokens !== undefined) panel.tokens = tokens;
    out.push(panel);
  });
  return out;
}

/**
 * The three colours a panel may ask for, and only those.
 *
 * A panel body is a closed widget vocabulary, so these are the single place a
 * plugin's styling reaches the console. Values are restricted to a colour
 * grammar: a CSS custom property can hold `url(https://…)`, which would make
 * every operator's console phone home to the plugin, and `image-set()` or a
 * `\` escape can smuggle the same thing past a naive check. Only a literal
 * colour, a colour function with numeric arguments, or a bare keyword is taken.
 */
const PANEL_TOKENS = ['accent', 'surface', 'text'] as const;

function isCssColor(value: string): boolean {
  const text = value.trim();
  if (text === '' || text.length > 64) return false;
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return true;
  const fn = /^(rgba?|hsla?)\(\s*([0-9.,%/\s+-]+)\)$/i.exec(text);
  if (fn !== null) return /^[0-9.,%/\s+-]*$/.test(fn[2] ?? '');
  // A named colour, `transparent`, `currentcolor`, or a `var(--x)` indirection
  // into the console's own palette.
  return /^[a-z][a-z0-9-]{0,31}$/i.test(text) || /^var\(--[a-z0-9-]{1,40}\)$/i.test(text);
}

function pickPanelTokens(
  raw: unknown,
  warnings: string[],
  what: string,
): UiPanelContribution['tokens'] | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    warnings.push(`${what}.tokens is not an object; ignored.`);
    return undefined;
  }
  const tokens: NonNullable<UiPanelContribution['tokens']> = {};
  let any = false;
  for (const [key, value] of Object.entries(raw)) {
    if (!(PANEL_TOKENS as readonly string[]).includes(key)) {
      warnings.push(`${what}.tokens.${key} is not a token the console paints with; ignored. Known: ${PANEL_TOKENS.join(', ')}.`);
      continue;
    }
    if (typeof value !== 'string' || !isCssColor(value)) {
      warnings.push(`${what}.tokens.${key} is not a colour; ignored.`);
      continue;
    }
    tokens[key as (typeof PANEL_TOKENS)[number]] = value.trim();
    any = true;
  }
  return any ? tokens : undefined;
}

/**
 * Role templates are normalised against the **full** `Role` contract, not merely
 * checked for a name to show.
 *
 * They used to be passed through once `id`, `displayName` and `title` were
 * present, and everything else was assumed. But the object is dereferenced as a
 * complete role in two places that a manifest author cannot see:
 *
 *  - the console's hire form spreads `responsibilities`, `skillIds`,
 *    `allowedTools` and `persona.values` — a `TypeError` in a submit handler, with
 *    no error boundary anywhere in the web app to catch it;
 *  - `engine/prompt.ts` calls `bullets(role.responsibilities)` and
 *    `role.persona.values.join(', ')` on **every turn** that employee takes, so a
 *    short template becomes a run that dies mid-flight.
 *
 * A plugin cannot change who works here automatically — hiring is a decision — so
 * this does not have to be a security boundary. It has to be a *complete* object,
 * because that is what every consumer assumes it is being handed.
 */
function pickRoles(raw: unknown, warnings: string[]): Role[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) warnings.push('contributes.roleTemplates is not an array; ignored.');
    return [];
  }
  const out: Role[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`roleTemplates[${index}] is not an object; dropped.`);
      return;
    }
    const id = str(entry['id']);
    const displayName = str(entry['displayName']);
    const title = str(entry['title']);
    if (!id || !displayName || !title) {
      warnings.push(`roleTemplates[${index}] needs id, displayName and title; dropped.`);
      return;
    }

    // Records which fields the template *omitted*, so the operator is told what
    // was filled in rather than being left to wonder how complete it was.
    const filled: string[] = [];
    const strings = (value: unknown, field: string, fallback: string[]): string[] => {
      if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
      filled.push(field);
      return fallback;
    };
    const num = (value: unknown, field: string, fallback: number): number => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      filled.push(field);
      return fallback;
    };
    const oneOf = <T extends string>(value: unknown, allowed: readonly T[], field: string, fallback: T): T => {
      if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
      filled.push(field);
      return fallback;
    };

    const persona = isRecord(entry['persona']) ? entry['persona'] : {};
    if (entry['persona'] !== undefined && !isRecord(entry['persona'])) filled.push('persona');
    const appearance = isRecord(entry['appearance']) ? entry['appearance'] : {};
    if (entry['appearance'] !== undefined && !isRecord(entry['appearance'])) filled.push('appearance');
    const policy = isRecord(entry['modelPolicy']) ? entry['modelPolicy'] : {};
    if (entry['modelPolicy'] !== undefined && !isRecord(entry['modelPolicy'])) filled.push('modelPolicy');

    const role: Role = {
      id,
      displayName,
      title,
      departmentId: str(entry['departmentId']) ?? 'unassigned',
      seniority: oneOf(entry['seniority'], SENIORITIES, 'seniority', 'mid'),
      rank: num(entry['rank'], 'rank', 50),
      reportsTo: str(entry['reportsTo']) ?? null,
      mission: str(entry['mission']) ?? '',
      responsibilities: strings(entry['responsibilities'], 'responsibilities', []),
      skillIds: strings(entry['skillIds'], 'skillIds', []),
      allowedTools: strings(entry['allowedTools'], 'allowedTools', []),
      modelPolicy: {
        defaultTier: oneOf(policy['defaultTier'], MODEL_TIER_ORDER, 'modelPolicy', 'standard'),
        minTier: oneOf(policy['minTier'], MODEL_TIER_ORDER, 'modelPolicy.minTier', 'nano'),
        maxTier: oneOf(policy['maxTier'], MODEL_TIER_ORDER, 'modelPolicy.maxTier', 'max'),
      },
      seatId: str(entry['seatId']) ?? null,
      roomId: str(entry['roomId']) ?? null,
      canDelegate: entry['canDelegate'] === true,
      maxDirectReports: num(entry['maxDirectReports'], 'maxDirectReports', 0),
      persona: {
        // A role with no voice still has to *have* one: the prompt builder reads
        // it on every turn.
        voice: str(persona['voice']) ?? `${displayName} speaks plainly and briefly.`,
        values: strings(persona['values'], 'persona.values', []),
        ...(str(persona['debateStyle']) !== undefined
          ? { debateStyle: str(persona['debateStyle']) as string }
          : {}),
      },
      appearance: {
        bodyColor: str(appearance['bodyColor']) ?? '#94a3b8',
        accentColor: str(appearance['accentColor']) ?? '#475569',
        height: num(appearance['height'], 'appearance.height', 1),
      },
      maxTurnsPerStage: num(entry['maxTurnsPerStage'], 'maxTurnsPerStage', 2),
    };
    if (filled.length > 0) {
      warnings.push(
        `roleTemplates[${index}] (${id}) did not declare ${[...new Set(filled)].join(', ')}; ` +
          'safe defaults were filled in so the template is a complete role. Hiring it is still your decision.',
      );
    }
    out.push(role);
  });
  return out;
}

function pickPipelines(raw: unknown, warnings: string[]): Pipeline[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) warnings.push('contributes.pipelines is not an array; ignored.');
    return [];
  }
  return raw.filter((entry, index): entry is Pipeline => {
    if (!isRecord(entry) || !str(entry['id']) || !str(entry['name']) || !Array.isArray(entry['stages'])) {
      warnings.push(`pipelines[${index}] needs id, name and stages; dropped.`);
      return false;
    }
    return true;
  });
}

function pickProviders(raw: unknown, warnings: string[]): PluginProvider[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) warnings.push('contributes.providers is not an array; ignored.');
    return [];
  }
  const out: PluginProvider[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`providers[${index}] is not an object; dropped.`);
      return;
    }
    const id = str(entry['id']);
    const label = str(entry['label']);
    const kind = str(entry['kind']);
    const baseUrl = str(entry['baseUrl']);
    if (!id || !label || !baseUrl) {
      warnings.push(`providers[${index}] needs id, label and baseUrl; dropped.`);
      return;
    }
    if (!PROVIDER_ID_RE.test(id)) {
      warnings.push(`providers[${index}].id "${id}" must be a lowercase slug; dropped.`);
      return;
    }
    if (seen.has(id)) {
      warnings.push(`providers[${index}].id "${id}" is declared twice; the second is dropped.`);
      return;
    }
    // Every provider is reached over https, except a keyless local runtime on the
    // loopback address. A plugin must not quietly point the office at plaintext
    // http somewhere on the network and start sending it prompts.
    const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(baseUrl);
    if (!/^https:\/\//i.test(baseUrl)) {
      if (!(isLoopback && entry['keyless'] === true)) {
        warnings.push(
          `providers[${index}].baseUrl must be https (or http on the loopback address with "keyless": true); dropped.`,
        );
        return;
      }
    }
    /*
     * `keyless` is a claim that the provider needs no credential — which also means
     * **nothing the operator does** stands between the office and that host. It was
     * accepted for any https URL, so a plugin with no code at all could name a
     * remote endpoint, be counted as "configured" by `isProviderConfigured` on the
     * strength of `keyless` alone, and receive every prompt: the brief, the stage
     * transcript, and any file the tool loop read. The loopback rule only applied to
     * plain http, which is what made it visible in the manifest and nowhere else.
     *
     * So `keyless` is now what it says: a *local* runtime. A remote provider must
     * name a `keyEnvVar`, which means the operator has to have put a credential in
     * the environment for it — an action, and one the provider's own card shows.
     */
    if (entry['keyless'] === true && !isLoopback) {
      warnings.push(
        `providers[${index}] is "keyless" but ${JSON.stringify(baseUrl)} is not a loopback address. ` +
          'A keyless provider is a local runtime; a remote one must name a "keyEnvVar" so a human has to configure it.',
      );
      return;
    }
    if (kind !== 'openai-compat' && kind !== 'anthropic') {
      warnings.push(`providers[${index}].kind must be "openai-compat" or "anthropic"; dropped.`);
      return;
    }
    const provider: PluginProvider = { id, label, kind, baseUrl };
    const keyEnvVar = str(entry['keyEnvVar']);
    if (keyEnvVar) {
      if (!ENV_VAR_RE.test(keyEnvVar)) {
        warnings.push(`providers[${index}].keyEnvVar "${keyEnvVar}" is not an environment variable name; dropped.`);
        return;
      }
      provider.keyEnvVar = keyEnvVar;
    }
    if (entry['keyless'] === true) provider.keyless = true;
    if (!provider.keyEnvVar && provider.keyless !== true) {
      warnings.push(
        `providers[${index}] names neither "keyEnvVar" nor "keyless": it would never count as configured; dropped.`,
      );
      return;
    }
    if (isRecord(entry['extraHeaders'])) {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(entry['extraHeaders'])) {
        // A header name or value that is not a simple token is a request-smuggling
        // shape, so it is refused rather than sanitised.
        if (typeof value !== 'string' || /[\r\n]/.test(key) || /[\r\n]/.test(value)) {
          warnings.push(`providers[${index}].extraHeaders["${key}"] is not a safe header; ignored.`);
          continue;
        }
        headers[key] = value;
      }
      if (Object.keys(headers).length > 0) provider.extraHeaders = headers;
    }
    seen.add(id);
    out.push(provider);
  });
  return out;
}

function pickContributions(raw: unknown, warnings: string[]): PluginContributions {
  if (!isRecord(raw)) {
    if (raw !== undefined) warnings.push('contributes is not an object; ignored.');
    return {};
  }
  const contributions: PluginContributions = {};
  const providers = pickProviders(raw['providers'], warnings);
  if (providers.length > 0) contributions.providers = providers;
  const models = pickModels(raw['models'], warnings);
  if (models.length > 0) contributions.models = models;
  const skills = pickSkills(raw['skills'], warnings);
  if (skills.length > 0) contributions.skills = skills;
  const rules = pickRules(raw['routingRules'], warnings);
  if (rules.length > 0) contributions.routingRules = rules;
  const uiPanels = pickUiPanels(raw['uiPanels'], warnings);
  if (uiPanels.length > 0) contributions.uiPanels = uiPanels;
  const roles = pickRoles(raw['roleTemplates'], warnings);
  if (roles.length > 0) contributions.roleTemplates = roles;
  const pipelines = pickPipelines(raw['pipelines'], warnings);
  if (pipelines.length > 0) contributions.pipelines = pipelines;
  if (Array.isArray(raw['toolNames'])) {
    const names = (raw['toolNames'] as unknown[]).map(String).filter((n) => n.trim() !== '');
    if (names.length > 0) contributions.toolNames = names;
  }
  return contributions;
}

function pickSettingsSchema(raw: unknown, problems: ManifestProblem[], warnings: string[]): PluginSettingField[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push({ field: 'settings', message: 'settings must be an array of fields.' });
    return [];
  }
  const out: PluginSettingField[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      problems.push({ field: `settings[${index}]`, message: 'must be an object.' });
      return;
    }
    const key = str(entry['key']);
    const label = str(entry['label']);
    const type = str(entry['type']);
    if (!key || !SETTING_KEY_RE.test(key)) {
      problems.push({ field: `settings[${index}].key`, message: 'must be a simple identifier.' });
      return;
    }
    if (seen.has(key)) {
      problems.push({ field: `settings[${index}].key`, message: `duplicate setting key "${key}".` });
      return;
    }
    if (!label) {
      problems.push({ field: `settings[${index}].label`, message: 'is required.' });
      return;
    }
    if (type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'select') {
      problems.push({ field: `settings[${index}].type`, message: 'must be string, number, boolean or select.' });
      return;
    }
    const fallback = entry['default'];
    const typeOk =
      (type === 'string' && typeof fallback === 'string') ||
      (type === 'number' && typeof fallback === 'number') ||
      (type === 'boolean' && typeof fallback === 'boolean') ||
      (type === 'select' && typeof fallback === 'string');
    if (!typeOk) {
      problems.push({ field: `settings[${index}].default`, message: `must match type "${type}".` });
      return;
    }
    const field: PluginSettingField = { key, label, type, default: fallback as string | number | boolean };
    const description = str(entry['description']);
    if (description) field.description = description;
    if (Array.isArray(entry['options'])) {
      const options = (entry['options'] as unknown[]).map(String);
      field.options = options;
      if (type === 'select' && !options.includes(String(fallback))) {
        problems.push({ field: `settings[${index}].default`, message: 'must be one of the options.' });
        return;
      }
    } else if (type === 'select') {
      problems.push({ field: `settings[${index}].options`, message: 'a select needs options.' });
      return;
    }
    const min = num(entry['min']);
    if (min !== null) field.min = min;
    const max = num(entry['max']);
    if (max !== null) field.max = max;
    seen.add(key);
    out.push(field);
  });
  if (out.length === 0 && raw.length > 0) {
    warnings.push('every settings field was rejected.');
  }
  return out;
}

// ------------------------------------------------------------------ entry point

export function validateManifest(raw: unknown): ManifestResult {
  const problems: ManifestProblem[] = [];
  const warnings: string[] = [];

  if (!isRecord(raw)) return { ok: false, problems: [{ field: 'manifest', message: 'must be a JSON object.' }] };

  const id = str(raw['id']);
  if (!id) problems.push({ field: 'id', message: 'is required.' });
  else if (id.length > 64) problems.push({ field: 'id', message: 'must be 64 characters or fewer.' });
  else if (!ID_RE.test(id)) {
    problems.push({
      field: 'id',
      message: 'must be lowercase reverse-dns style with at least two segments, e.g. "dev3d.cost-guard".',
    });
  }

  const name = str(raw['name']);
  if (!name) problems.push({ field: 'name', message: 'is required.' });

  const version = str(raw['version']);
  if (!version) problems.push({ field: 'version', message: 'is required.' });
  else if (!SEMVER_RE.test(version)) problems.push({ field: 'version', message: 'must be semver, e.g. "1.0.0".' });

  const description = str(raw['description']);
  if (!description) problems.push({ field: 'description', message: 'is required.' });

  const apiVersion = str(raw['apiVersion']);
  if (!apiVersion) {
    problems.push({ field: 'apiVersion', message: `is required; this host implements "${PLUGIN_API_VERSION}".` });
  } else if (!apiCompatible(apiVersion)) {
    problems.push({
      field: 'apiVersion',
      message: `targets API "${apiVersion}", but this host implements "${PLUGIN_API_VERSION}".`,
    });
  }

  let permissions: PluginPermission[] | undefined;
  if (raw['permissions'] !== undefined) {
    if (!Array.isArray(raw['permissions'])) {
      problems.push({ field: 'permissions', message: 'must be an array.' });
    } else {
      const bad = (raw['permissions'] as unknown[]).filter(
        (entry) => typeof entry !== 'string' || !PERMISSIONS.includes(entry as PluginPermission),
      );
      if (bad.length > 0) {
        problems.push({ field: 'permissions', message: `unknown permission(s): ${bad.map(String).join(', ')}.` });
      } else {
        permissions = raw['permissions'] as PluginPermission[];
      }
    }
  }

  let entry: string | undefined;
  if (raw['entry'] !== undefined) {
    const rawEntry = str(raw['entry']);
    if (!rawEntry) problems.push({ field: 'entry', message: 'must be a non-empty relative path.' });
    else if (rawEntry.startsWith('/') || rawEntry.startsWith('\\') || /^[A-Za-z]:/.test(rawEntry)) {
      problems.push({ field: 'entry', message: 'must be relative to the plugin directory.' });
    } else if (rawEntry.split(/[\\/]/).includes('..')) {
      problems.push({ field: 'entry', message: 'may not escape the plugin directory.' });
    } else {
      entry = rawEntry;
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  const contributes = pickContributions(raw['contributes'], warnings);
  const settings = pickSettingsSchema(raw['settings'], problems, warnings);
  if (problems.length > 0) return { ok: false, problems };

  const manifest: PluginManifest = {
    id: id as string,
    name: name as string,
    version: version as string,
    description: description as string,
    apiVersion: apiVersion as string,
  };
  const author = str(raw['author']);
  if (author) manifest.author = author;
  const homepage = str(raw['homepage']);
  if (homepage) manifest.homepage = homepage;
  const license = str(raw['license']);
  if (license) manifest.license = license;
  if (entry) manifest.entry = entry;
  if (permissions) manifest.permissions = permissions;
  if (Object.keys(contributes).length > 0) manifest.contributes = contributes;
  if (settings.length > 0) manifest.settings = settings;

  if (entry && (manifest.permissions ?? []).length === 0) {
    warnings.push('declares an entry module but no permissions.');
  }
  if (!entry && (manifest.permissions ?? []).includes('tools')) {
    warnings.push('asks for the "tools" permission but ships no code, so it cannot register one.');
  }

  return { ok: true, manifest, warnings };
}

/** The defaults from the manifest's settings schema. */
export function defaultSettings(manifest: PluginManifest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of manifest.settings ?? []) out[field.key] = field.default;
  return out;
}

/**
 * Make the *persisted* plugin document true to its type.
 *
 * `hydrate` used to copy `enabled`, `settings` and `sources` straight out of the
 * stored office document. That document is written by an older version, edited by
 * hand, or restored from a backup, so it is untrusted input — and the failure it
 * produced was the quiet kind: a non-boolean `enabled` is merely truthy, and a
 * `settings` value that is not an object still takes effect wherever
 * `coerceSettings` happens to accept it. The operator cannot see either in the UI.
 *
 * The rule is the same one `readManifest` applies to a manifest: accept what is
 * well formed, drop what is not, and **say what was dropped** rather than
 * silently reinterpreting it.
 */
export function coercePersistedState(raw: unknown): { state: PluginPersistedState; dropped: string[] } {
  const dropped: string[] = [];
  const empty: PluginPersistedState = { enabled: {}, settings: {}, sources: [] };
  if (!isRecord(raw)) {
    if (raw !== undefined && raw !== null) dropped.push('the saved plugin state is not an object');
    return { state: empty, dropped };
  }

  const enabled: Record<string, boolean> = {};
  const rawEnabled = raw['enabled'];
  if (rawEnabled !== undefined && !isRecord(rawEnabled)) {
    dropped.push('enabled is not an object');
  } else if (isRecord(rawEnabled)) {
    for (const [id, value] of Object.entries(rawEnabled)) {
      if (typeof value === 'boolean') enabled[id] = value;
      else dropped.push(`enabled["${id}"] is not a boolean`);
    }
  }

  const settings: Record<string, Record<string, unknown>> = {};
  const rawSettings = raw['settings'];
  if (rawSettings !== undefined && !isRecord(rawSettings)) {
    dropped.push('settings is not an object');
  } else if (isRecord(rawSettings)) {
    for (const [id, value] of Object.entries(rawSettings)) {
      if (isRecord(value)) settings[id] = value;
      else dropped.push(`settings["${id}"] is not an object`);
    }
  }

  const sources: PluginSourceRecord[] = [];
  const rawSources = raw['sources'];
  if (rawSources !== undefined && !Array.isArray(rawSources)) {
    dropped.push('sources is not an array');
  } else if (Array.isArray(rawSources)) {
    rawSources.forEach((entry, index) => {
      if (!isRecord(entry)) {
        dropped.push(`sources[${index}] is not an object`);
        return;
      }
      const id = str(entry['id']);
      const url = str(entry['url']);
      if (!id || !url) {
        // An id and a URL are the only two fields anything needs: without them the
        // record cannot be fetched, removed or even shown.
        dropped.push(`sources[${index}] has no id or no url`);
        return;
      }
      const last = num(entry['lastFetchedAt']);
      const count = num(entry['pluginCount']);
      let label = str(entry['label']);
      if (!label) {
        try {
          label = new URL(url).hostname;
        } catch {
          label = url;
        }
      }
      sources.push({
        id,
        label,
        url,
        // Absent means enabled: a marketplace the operator registered must not
        // become disabled because a field was added after it was written.
        enabled: entry['enabled'] !== false,
        lastFetchedAt: last === null ? null : last,
        lastError: str(entry['lastError']) ?? null,
        pluginCount: count === null ? 0 : Math.max(0, Math.round(count)),
      });
    });
  }

  return { state: { enabled, settings, sources }, dropped };
}

/**
 * Merge stored values over the defaults, keeping only keys the manifest still
 * declares and values of the right type. A plugin that renames a setting or
 * changes its type must not be handed a stale value it will misinterpret.
 */
export function coerceSettings(
  manifest: PluginManifest,
  values: unknown,
): { settings: Record<string, unknown>; dropped: string[] } {
  const settings = defaultSettings(manifest);
  const dropped: string[] = [];
  if (!isRecord(values)) return { settings, dropped };
  const fields = new Map((manifest.settings ?? []).map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(values)) {
    const field = fields.get(key);
    if (!field) {
      dropped.push(key);
      continue;
    }
    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        dropped.push(key);
        continue;
      }
      if (field.min !== undefined && value < field.min) {
        dropped.push(key);
        continue;
      }
      if (field.max !== undefined && value > field.max) {
        dropped.push(key);
        continue;
      }
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') {
        dropped.push(key);
        continue;
      }
    } else {
      if (typeof value !== 'string') {
        dropped.push(key);
        continue;
      }
      if (field.type === 'select' && field.options && !field.options.includes(value)) {
        dropped.push(key);
        continue;
      }
    }
    settings[key] = value;
  }
  return { settings, dropped };
}
