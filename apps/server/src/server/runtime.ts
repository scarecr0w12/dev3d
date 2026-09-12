/**
 * The office runtime: the building, the organisations inside it, and everything
 * that has to be true about them right now.
 *
 * Two layers, and the split matters:
 *
 *  - **Installation** — settings (providers, model catalog, concurrency,
 *    approval policy, where projects live) and the list of organisations. There
 *    is exactly one of these, persisted in the `office` table.
 *  - **Organisation** (a workspace) — its own company, departments, roles,
 *    enabled skills, pipelines, budget and directory. Each has its own employee
 *    roster, so 'ceo' is a different person in every floor.
 *
 * The runtime is the only thing that writes to the store, so persistence and
 * broadcast can never drift apart. Events are persisted *before* they are
 * broadcast, so a reconnecting client replaying from the log sees a superset of
 * what it already had, never a gap.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type {
  Approval,
  ApprovalKind,
  Company,
  EmployeeState,
  EmployeeUsage,
  FloorLayout,
  ModelOverride,
  ModelPolicy,
  Office,
  OfficeSettings,
  OfficeState,
  OfficeStyle,
  OrgChart,
  Pipeline,
  PlacedBlock,
  ProviderStatus,
  Role,
  Run,
  ServerEvent,
  Skill,
  UsageRecord,
  Workspace,
  WorkspaceBudget,
  WorkspaceSummary,
  PluginPersistedState,
  PluginSystemState,
} from '@dev3d/core';
import {
  DEFAULT_STYLE_PRESET,
  MODEL_TIER_ORDER,
  PLUGIN_API_VERSION,
  parseOfficeStyle,
  resolveStyle,
  stylePreset,
  toEmployeeState,
  toWorkspaceSummary,
} from '@dev3d/core';
import type { ServerConfig } from '../config.ts';
import { defaultOfficeSettings, detectConfigDrift } from '../config.ts';
import type { ProviderRegistry } from '../llm/registry.ts';
import { allSkillIds, defaultCompany, defaultOrgChart, defaultWorkspace } from '../org/defaultCompany.ts';
import { defaultPipelines } from '../org/defaultPipelines.ts';
import { loadOfficeKit, type OfficeAssetKit } from '../office/kit.ts';
import { capacityOf as capacityFrom, describeLayout, grow, planFloor, seatIdsFor, shrink } from '../office/layout.ts';
// Type-only: the runtime asks the host for contributions through the narrow
// `PluginHostAccess` slice, so there is no runtime dependency either way.
import type { ActiveContributions } from '../plugins/host.ts';
import type { Store } from '../store/store.ts';
import { resolveInWorkspace } from '../tools/paths.ts';
import type { ApprovalBroker, EmployeeTracker, EventSink, OrgAccess } from '../engine/types.ts';

export type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string) => void;

/** Nothing installed: the shape before the plugin host has been attached. */
function emptyPluginState(): PluginPersistedState {
  return { enabled: {}, settings: {}, sources: [] };
}

/**
 * The narrow slice of the plugin host the runtime needs: its public state, and
 * what to persist. Keeping it to this is what stops the runtime and the host
 * from becoming one object.
 */
export interface PluginHostAccess {
  state(): PluginSystemState;
  persisted(): PluginPersistedState;
  /** Skills contributed by enabled plugins, merged into the office's catalog. */
  pluginSkills(): Skill[];
  /** Everything enabled plugins contribute, for the parts the runtime offers. */
  contributions(): ActiveContributions;
}

export interface WorkspaceInput {
  name: string;
  description?: string;
  color?: string;
  folder?: string;
  path?: string;
  /** Skills the new organisation starts with. Defaults to every skill on disk. */
  skillIds?: string[];
  /** Overrides for the budget it starts with. */
  budget?: Partial<WorkspaceBudget>;
}

export interface Runtime {
  readonly store: Store;
  readonly startedAt: number;

  /** Wire the engine in after construction (the engine needs this runtime first). */
  attachEngine(accessor: { runs(): Run[]; activeRunIds(): string[] }): void;

  /** Wire the plugin host in once it exists; the runtime only reads it. */
  attachPlugins(host: PluginHostAccess): void;

  /**
   * Called by the plugin host after any change - a plugin enabled, configured,
   * installed or removed. Persists the decision and tells every client.
   */
  announcePlugins(): void;

  /** The config the engine reads, with saved settings folded in. */
  engineConfig(): ServerConfig;
  settings(): OfficeSettings;
  updateSettings(patch: Partial<OfficeSettings>): { ok: boolean; error?: string };

  office(): Office;
  workspaces(): Workspace[];
  workspace(workspaceId: string): Workspace | undefined;
  activeWorkspaceId(): string;
  setActiveWorkspace(workspaceId: string): { ok: boolean; error?: string };
  summaries(): WorkspaceSummary[];

  createWorkspace(input: WorkspaceInput): { ok: true; workspace: Workspace } | { ok: false; error: string };
  removeWorkspace(workspaceId: string): { ok: boolean; error?: string };
  setWorkspaceSkills(workspaceId: string, skillIds: string[]): { ok: boolean; error?: string };
  setWorkspaceBudget(workspaceId: string, patch: Partial<WorkspaceBudget>): { ok: boolean; error?: string };
  setWorkspaceDetails(
    workspaceId: string,
    patch: { name?: string; description?: string; color?: string },
  ): { ok: boolean; error?: string };
  /**
   * Restyle a floor. `null` returns it to the default preset.
   *
   * The style is validated the same way a stored one is, so a malformed value
   * from a client is refused rather than persisted into a renderer.
   */
  setWorkspaceStyle(workspaceId: string, style: OfficeStyle | null): { ok: boolean; error?: string };

  state(): OfficeState;
  subscribe(fn: (event: ServerEvent) => void): () => void;
  emit(event: ServerEvent): void;

  org: OrgAccess;
  employees: EmployeeTracker;
  sink: EventSink;
  approvals: ApprovalBroker;

  /** Pipelines enabled for an organisation (defaults to the active one). */
  pipelines(workspaceId?: string): Pipeline[];
  skills(): Skill[];

  pendingApprovals(): Approval[];
  approvalsForRun(runId: string): Approval[];
  decideApproval(approvalId: string, approved: boolean): boolean;

  hire(role: Role, workspaceId?: string): { ok: boolean; error?: string };
  fire(roleId: string, workspaceId?: string): { ok: boolean; error?: string };
  setSeat(
    employeeId: string,
    seatId: string | null,
    roomId?: string | null,
    workspaceId?: string,
  ): { ok: boolean; error?: string };
  setModelPolicy(roleId: string, policy: ModelPolicy, workspaceId?: string): { ok: boolean; error?: string };
  /** Change one role's tool and skill grants, filtered against what exists. */
  setRoleGrants(
    roleId: string,
    patch: { allowedTools?: string[]; skillIds?: string[] },
    workspaceId?: string,
  ): { ok: boolean; error?: string };
  /** Pipelines contributed by enabled plugins, offered to every floor. */
  pluginPipelines(): Array<{ pluginId: string; pipeline: Pipeline }>;
  /** Role templates contributed by enabled plugins, for the hire form. */
  roleTemplates(): Array<{ pluginId: string; role: Role }>;

  /** A floor's generated space: modules, capacity and every seat id. */
  floor(workspaceId?: string): OfficeState['floor'] | null;
  /** Build one more room by hand, whatever the headcount. */
  addRoom(workspaceId?: string): { ok: boolean; error?: string };
  /** Take the newest room back out, never below what the roster needs. */
  removeRoom(workspaceId?: string): { ok: boolean; error?: string };
  setRoutingPosture(posture: OrgChart['routingPosture'], workspaceId?: string): { ok: boolean; error?: string };
  employee(employeeId: string, workspaceId?: string): EmployeeState | undefined;
  approvalsOf(kind: ApprovalKind): Approval[];
  close(): void;
}

// ---------------------------------------------------------------------------
// migration
// ---------------------------------------------------------------------------

interface LegacyOrgChart {
  company?: Partial<Company> & { workspace?: unknown; defaultBudgetUsd?: unknown };
  departments?: OrgChart['departments'];
  roles?: Role[];
  pipelineIds?: string[];
  routingPosture?: OrgChart['routingPosture'];
  updatedAt?: number;
  workspaces?: Array<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Fill in anything a stored workspace is missing, without inventing identity. */
function normalizeWorkspace(raw: unknown, index: number): Workspace | null {
  if (!isRecord(raw)) return null;
  const org = raw['org'];
  if (!isRecord(org) || !Array.isArray(org['roles'])) return null;

  const budget = isRecord(raw['budget']) ? raw['budget'] : {};
  const floor = typeof raw['floor'] === 'number' && raw['floor'] > 0 ? raw['floor'] : index + 1;

  const workspace: Workspace = {
    id: typeof raw['id'] === 'string' ? raw['id'] : `workspace-${index + 1}`,
    name: typeof raw['name'] === 'string' ? raw['name'] : `Workspace ${index + 1}`,
    path: typeof raw['path'] === 'string' ? raw['path'] : '',
    floor,
    skillIds: Array.isArray(raw['skillIds']) ? (raw['skillIds'] as string[]) : allSkillIds(),
    budget: {
      defaultRunUsd: typeof budget['defaultRunUsd'] === 'number' ? budget['defaultRunUsd'] : 5,
      spentUsd: typeof budget['spentUsd'] === 'number' ? budget['spentUsd'] : 0,
      ...(typeof budget['totalUsd'] === 'number' ? { totalUsd: budget['totalUsd'] } : {}),
    },
    org: org as unknown as OrgChart,
    createdAt: typeof raw['createdAt'] === 'number' ? raw['createdAt'] : Date.now(),
  };
  if (typeof raw['description'] === 'string') workspace.description = raw['description'];
  if (typeof raw['color'] === 'string') workspace.color = raw['color'];
  // A style is read as untrusted input for the same reason a layout is: a
  // workspace written by an older build, or hand-edited, must degrade to its
  // preset rather than putting a `NaN` into a shader.
  const style = parseOfficeStyle(raw['style']);
  if (style !== undefined) workspace.style = style;
  if (raw['isDefault'] === true) workspace.isDefault = true;
  // Growth is read back, but not trusted: `reconcileFloors` re-derives it against
  // the current kit at boot, so a layout written by an older kit is corrected
  // rather than carried forward into geometry that no longer exists.
  const layout = raw['layout'];
  if (isRecord(layout) && Array.isArray(layout['blocks'])) {
    workspace.layout = { blocks: layout['blocks'] as PlacedBlock[] };
  }
  if (isRecord(layout) && typeof layout['updatedAt'] === 'number' && workspace.layout) {
    workspace.layout.updatedAt = layout['updatedAt'];
  }
  return workspace;
}

/**
 * Turn whatever is in the database into a current-shape Office.
 *
 * Three cases, in order: an Office as we write it now; a bare OrgChart from
 * before workspaces were organisations, which becomes a single default
 * organisation carrying its old company, roles and budget; and a fresh install.
 */
export function migrateOffice(raw: unknown, config: ServerConfig): Office {
  const settings = defaultOfficeSettings(config);

  if (isRecord(raw)) {
    const candidate = raw as Record<string, unknown>;

    if (Array.isArray(candidate['workspaces']) && candidate['workspaces'].length > 0) {
      const workspaces = candidate['workspaces']
        .map((entry, index) => normalizeWorkspace(entry, index))
        .filter((entry): entry is Workspace => entry !== null);
      if (workspaces.length > 0) {
        const stored = isRecord(candidate['settings']) ? candidate['settings'] : {};
        return {
          settings: { ...settings, ...(stored as Partial<OfficeSettings>), updatedAt: Date.now() },
          workspaces,
          plugins: emptyPluginState(),
        updatedAt: Date.now(),
        };
      }
    }

    // Legacy: a single org chart with no organisations in it.
    if (Array.isArray(candidate['roles'])) {
      const legacy = candidate as unknown as LegacyOrgChart;
      const legacyWorkspaces = Array.isArray(legacy.workspaces) ? legacy.workspaces : [];
      const first = legacyWorkspaces[0] ?? {};
      const legacyBudget =
        typeof legacy.company?.defaultBudgetUsd === 'number' ? legacy.company.defaultBudgetUsd : 5;

      const workspace = defaultWorkspace({
        id: 'default',
        name: typeof first['name'] === 'string' ? first['name'] : 'Default project',
        path: typeof first['path'] === 'string' ? first['path'] : config.workspace,
        floor: 1,
        isDefault: true,
        color: typeof first['color'] === 'string' ? first['color'] : '#38bdf8',
        description:
          typeof first['description'] === 'string'
            ? first['description']
            : 'The organisation the orchestrator was configured with.',
        companyName: typeof legacy.company?.name === 'string' ? legacy.company.name : 'dev3d Labs',
        budget: { defaultRunUsd: legacyBudget, spentUsd: 0 },
      });

      const migratedCompany = legacy.company;
      if (migratedCompany !== undefined) {
        workspace.org.company = {
          ...workspace.org.company,
          ...(typeof migratedCompany.id === 'string' ? { id: migratedCompany.id } : {}),
          ...(typeof migratedCompany.name === 'string' ? { name: migratedCompany.name } : {}),
          ...(typeof migratedCompany.mission === 'string' ? { mission: migratedCompany.mission } : {}),
        };
      }
      if (Array.isArray(legacy.departments)) workspace.org.departments = legacy.departments;
      if (Array.isArray(legacy.roles)) workspace.org.roles = legacy.roles;
      if (Array.isArray(legacy.pipelineIds)) workspace.org.pipelineIds = legacy.pipelineIds;
      if (legacy.routingPosture !== undefined) workspace.org.routingPosture = legacy.routingPosture;

      return { settings, workspaces: [workspace], plugins: emptyPluginState(), updatedAt: Date.now() };
    }
  }

  // A fresh install: one organisation on the ground floor.
  return {
    settings,
    workspaces: [
      defaultWorkspace({
        id: 'default',
        name: 'Default project',
        path: config.workspace,
        floor: 1,
        isDefault: true,
        color: '#38bdf8',
        description: 'The organisation the orchestrator was configured with.',
        companyName: 'dev3d Labs',
      }),
    ],
    plugins: emptyPluginState(),
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// runtime
// ---------------------------------------------------------------------------

export function createRuntime(opts: {
  config: ServerConfig;
  store: Store;
  registry: ProviderRegistry;
  skills: Skill[];
  log: LogFn;
  /**
   * Every tool that exists, so a role grant can be checked against reality.
   * Optional because the runtime does not own the tool registry: with no
   * supplier, a grant is taken as given, which is only right for a caller that
   * has no registry at all.
   */
  toolNames?: () => string[];
}): Runtime {
  const { config, store, registry, log } = opts;

  const office: Office = migrateOffice(store.loadOffice(), config);
  const pipelines: Pipeline[] = defaultPipelines();

  /**
   * The block kit and the core's own seat anchors, read once at boot.
   *
   * Reading the asset rather than trusting a number is what keeps capacity
   * honest: if `office.glb` gains or loses a seat, the office can no longer seat
   * the wrong number of people. A missing kit is not fatal - the office runs with
   * the core room only and says so.
   */
  const assets: OfficeAssetKit = loadOfficeKit(resolve(config.repoRoot, 'apps/web/public/office'));
  const EMPTY_LAYOUT: FloorLayout = { blocks: [] };
  if (assets.kit === null) {
    log('warn', 'office', `no block kit: ${assets.problem ?? 'unknown reason'}. Floors will not grow.`);
  } else {
    log('info', 'office', `block kit v${assets.kit.version}: ${assets.kit.blocks.length} modules, ${assets.coreSeatIds.length} core seats, ${assets.kit.core.ports.length} growth ports`);
  }

  /**
   * Reconcile every floor with its roster at boot.
   *
   * A floor's plan is deterministic, so this is idempotent: it re-derives the same
   * building when nothing has changed, and catches up when something has - a
   * roster that outgrew its desks while the office was down, or a kit that gained
   * a module. Persisting is left to the next commit, because a layout that can be
   * recomputed does not need to be written down to be safe.
   */
  function reconcileFloors(): void {
    const pruned = pruneUnknownModules();
    if (pruned > 0) {
      log('info', 'office', `dropped ${pruned} room(s) whose kind is no longer in the block kit`);
    }
    for (const workspace of office.workspaces) {
      const growth = ensureCapacity(workspace, workspace.org.roles.length);
      if (growth.grew > 0) {
        log(
          'info',
          'office',
          `"${workspace.name}" was under-built; added ${growth.grew} room(s) to seat ${workspace.org.roles.length}`,
        );
      }
    }
  }

  /** The config the engine reads; settings overrides are folded into it. */
  const engineConfig: ServerConfig = { ...config };

  function applySettings(): void {
    engineConfig.maxConcurrency = office.settings.maxConcurrency;
    engineConfig.softSpendApprovalUsd = office.settings.softSpendApprovalUsd;
    engineConfig.autoApproveShell = office.settings.autoApproveShell;
    engineConfig.approvalTimeoutMs = office.settings.approvalTimeoutMs;
    engineConfig.workspacesRoot = office.settings.workspacesRoot;
    engineConfig.allowExternalWorkspaces = office.settings.allowExternalWorkspaces;
    engineConfig.routingPosture = office.settings.defaultRoutingPosture;
    engineConfig.logLevel = office.settings.logLevel;
  }
  applySettings();
  reconcileFloors();

  let activeWorkspaceId = office.workspaces.find((w) => w.isDefault === true)?.id ?? office.workspaces[0]?.id ?? '';

  const rosters = new Map<string, Map<string, EmployeeState>>();
  const subscribers = new Set<(event: ServerEvent) => void>();
  const pending = new Map<
    string,
    { approval: Approval; resolve: (approved: boolean) => void; timer: NodeJS.Timeout }
  >();
  const approvalHistory = new Map<string, Approval>();

  /** Which organisation each run belongs to, and how much it had spent. */
  const runWorkspace = new Map<string, string>();
  const runSpent = new Map<string, number>();

  /** The plugin host, attached once it exists. */

  let pluginHost: PluginHostAccess | null = null;

  let engineAccessor: { runs(): Run[]; activeRunIds(): string[] } = {
    runs: () => [],
    activeRunIds: () => [],
  };

  const startedAt = Date.now();

  // ------------------------------------------------------------- workspaces

  function workspaceById(workspaceId: string | undefined): Workspace | undefined {
    if (workspaceId === undefined) return office.workspaces.find((w) => w.id === activeWorkspaceId);
    return office.workspaces.find((w) => w.id === workspaceId);
  }

  function activeWorkspace(): Workspace | undefined {
    return workspaceById(activeWorkspaceId);
  }

  function rosterFor(workspaceId: string): Map<string, EmployeeState> {
    let map = rosters.get(workspaceId);
    if (!map) {
      map = new Map();
      rosters.set(workspaceId, map);
    }
    return map;
  }

  /** Keep an organisation's roster exactly in step with its chart. */
  function syncRoster(workspace: Workspace): void {
    const map = rosterFor(workspace.id);
    const live = new Set(workspace.org.roles.map((role) => role.id));
    for (const id of [...map.keys()]) {
      if (!live.has(id)) map.delete(id);
    }
    for (const role of workspace.org.roles) {
      const existing = map.get(role.id);
      if (!existing) {
        map.set(role.id, toEmployeeState(role, workspace.id));
        continue;
      }
      existing.workspaceId = workspace.id;
      existing.displayName = role.displayName;
      existing.title = role.title;
      existing.departmentId = role.departmentId;
      existing.seatId = role.seatId;
      existing.roomId = role.roomId;
    }
  }

  /** The next free floor above the highest one in use. */
  function nextFloor(): number {
    return office.workspaces.reduce((highest, entry) => Math.max(highest, entry.floor), 0) + 1;
  }

  function slugify(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return slug === '' ? 'office' : slug;
  }

  function uniqueWorkspaceId(base: string): string {
    let id = base;
    let suffix = 2;
    while (office.workspaces.some((entry) => entry.id === id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    return id;
  }

  /**
   * True when `candidate` resolves to `root` or to something inside it. This
   * reuses the tool layer's own containment check rather than re-implementing it,
   * so "inside the workspace" means exactly one thing in this codebase.
   */
  function isInside(root: string, candidate: string): boolean {
    try {
      resolveInWorkspace(root, candidate);
      return true;
    } catch {
      return false;
    }
  }

  function summaries(): WorkspaceSummary[] {
    const runs = engineAccessor.runs();
    const active = new Set(engineAccessor.activeRunIds());
    return [...office.workspaces]
      .sort((a, b) => a.floor - b.floor)
      .map((workspace) => {
        const own = runs.filter((run) => run.workspaceId === workspace.id);
        const live = own.filter((run) => active.has(run.id)).length;
        const summary = toWorkspaceSummary(workspace, live, capacityOf(workspace));
        // Recorded spend plus whatever is in flight right now, so the floor
        // selector never under-reports a run that is still working.
        const inFlight = own.reduce((total, run) => total + run.budget.spentUsd, 0);
        summary.spentUsd = workspace.budget.spentUsd + inFlight;
        return summary;
      });
  }

  // ------------------------------------------------------------- floor space

  /** How many employees a floor can seat, given the modules it has grown. */
  function capacityOf(workspace: Workspace): number {
    if (assets.kit === null) return assets.coreSeatIds.length;
    return capacityFrom(assets.kit, workspace.layout ?? EMPTY_LAYOUT, assets.coreSeatIds.length);
  }

  /** The core's own seats plus everything the grown modules add. */
  function seatIdsOf(workspace: Workspace): string[] {
    if (assets.kit === null) return [...assets.coreSeatIds];
    return seatIdsFor(assets.kit, workspace.layout ?? EMPTY_LAYOUT, assets.coreSeatIds);
  }

  /**
   * Validate an operator's per-model corrections.
   *
   * Checked against the *live* catalog rather than trusted, so a settings document
   * cannot accumulate entries for models that have gone away, and a tier that is
   * not a tier is refused instead of quietly making a model unroutable.
   */
  function cleanModelOverrides(
    raw: Record<string, ModelOverride>,
  ): { ok: true; overrides: Record<string, ModelOverride> } | { ok: false; error: string } {
    const known = new Set(registry.models().map((model) => model.id));
    const overrides: Record<string, ModelOverride> = {};
    const unknown: string[] = [];
    for (const [id, patch] of Object.entries(raw)) {
      if (!known.has(id)) {
        unknown.push(id);
        continue;
      }
      if (typeof patch !== 'object' || patch === null) {
        return { ok: false, error: `The override for "${id}" is not an object.` };
      }
      const entry: ModelOverride = {};
      if (patch.tier !== undefined) {
        if (!MODEL_TIER_ORDER.includes(patch.tier)) {
          return { ok: false, error: `"${String(patch.tier)}" is not a model tier.` };
        }
        entry.tier = patch.tier;
      }
      for (const key of ['costPerMTokIn', 'costPerMTokOut'] as const) {
        const value = patch[key];
        if (value === undefined) continue;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          return {
            ok: false,
            error: `The ${key === 'costPerMTokIn' ? 'input' : 'output'} price for "${id}" must be a number of dollars per million tokens, zero or more.`,
          };
        }
        entry[key] = value;
      }
      overrides[id] = entry;
    }
    // Dropped rather than refused: the catalog can change between a page rendering
    // and its form being saved, so a stale id must not fail the whole write. But
    // it is said out loud, because a typo'd id is otherwise a silent no-op.
    if (unknown.length > 0) {
      log('warn', 'settings', `ignoring a model correction for ${unknown.join(', ')}: no such model in the catalog.`);
    }
    return { ok: true, overrides };
  }

  /** The block kinds the loaded kit actually has, for pruning and reporting. */
  const kitKinds = new Set((assets.kit?.blocks ?? []).map((block) => block.id));

  /**
   * Drop modules whose kind no longer exists in the kit.
   *
   * A kit is regenerated, not versioned: `blocks.json` is rewritten in place by
   * the Blender script, so a room type that is renamed or retired leaves every
   * persisted layout pointing at a module nothing can draw. A floor that keeps
   * them pays for them in capacity it cannot seat anybody in and renders a hole
   * where a room should be, so they are dropped here and the floor is left to
   * re-grow what its roster actually needs.
   */
  function pruneUnknownModules(): number {
    if (assets.kit === null) return 0;
    let dropped = 0;
    for (const workspace of office.workspaces) {
      const layout = workspace.layout;
      if (layout === undefined) continue;
      const kept = layout.blocks.filter((block) => kitKinds.has(block.kind));
      if (kept.length === layout.blocks.length) continue;
      dropped += layout.blocks.length - kept.length;
      workspace.layout = { blocks: kept };
    }
    return dropped;
  }

  function floorState(workspace: Workspace): OfficeState['floor'] {
    const layout = workspace.layout ?? EMPTY_LAYOUT;
    return {
      layout,
      coreSeats: assets.coreSeatIds.length,
      capacity: capacityOf(workspace),
      seatIds: seatIdsOf(workspace),
      modules: structuredClone(assets.kit?.blocks ?? []),
      // The floor's look travels with everything else about it, so the 3D view
      // needs no second request and no second source of truth.
      style: workspace.style ?? { preset: DEFAULT_STYLE_PRESET },
      describe: assets.kit === null ? 'the core office only' : describeLayout(assets.kit, layout),
      problem: assets.problem,
    };
  }

  /**
   * Grow a floor until it can seat `target` employees.
   *
   * Called after a hire, and at boot: a floor whose roster grew while the office
   * was down, or whose kit changed, has to catch up. It is deliberately silent
   * when nothing is needed, because it runs on every hire.
   */
  function ensureCapacity(workspace: Workspace, target: number): { grew: number; exhausted: boolean } {
    if (assets.kit === null) return { grew: 0, exhausted: assets.coreSeatIds.length < target };
    const result = grow(assets.kit, workspace.layout ?? EMPTY_LAYOUT, assets.coreSeatIds.length, target);
    if (result.added.length === 0) return { grew: 0, exhausted: result.exhausted };
    workspace.layout = result.layout;
    return { grew: result.added.length, exhausted: result.exhausted };
  }

  /** Trim a floor back to `target` seats, newest module first. */
  function trimCapacity(workspace: Workspace, target: number): number {
    if (assets.kit === null) return 0;
    let layout = workspace.layout ?? EMPTY_LAYOUT;
    let removed = 0;
    while (layout.blocks.length > 0 && capacityFrom(assets.kit, layout, assets.coreSeatIds.length) > target) {
      layout = shrink(assets.kit, layout, assets.coreSeatIds.length).layout;
      removed += 1;
    }
    if (removed > 0) workspace.layout = layout;
    return removed;
  }

  /**
   * Seat a newcomer at the first desk nobody is using, including one in a module
   * the floor just built for them.
   *
   * A hire with no seat is not an error - hot-desking is a real choice - but a
   * floor that grew four desks and left them empty would be building for nobody.
   * So this only fills a *free* desk, and never moves anyone who already has one.
   */
  function seatNewcomer(workspace: Workspace, role: Role): { seatId: string; roomId: string | null } | null {
    if (role.seatId !== null) return null;
    const taken = new Set<string>();
    for (const other of workspace.org.roles) {
      if (other.id === role.id || other.seatId === null) continue;
      taken.add(other.seatId);
    }
    const free = seatIdsOf(workspace).find((seat) => !taken.has(seat));
    if (free === undefined) return null;

    const seatId = free;
    const instance = seatId.includes('::') ? seatId.slice(0, seatId.indexOf('::')) : null;
    const placed = instance === null ? undefined : (workspace.layout?.blocks ?? []).find((block) => block.id === instance);
    const module = placed === undefined ? undefined : assets.kit?.blocks.find((block) => block.id === placed.kind);
    // A generated seat reports the room it is in, so the console calls it the pod
    // rather than the bench. Both parts are namespaced by the module instance.
    const roomId = instance !== null && module?.room !== undefined ? `${instance}::${module.room}` : null;

    workspace.org.roles = workspace.org.roles.map((entry) =>
      entry.id === role.id ? { ...entry, seatId, roomId } : entry,
    );
    syncRoster(workspace);
    return { seatId, roomId };
  }

  // ------------------------------------------------------------------ events

  function runIdOf(event: ServerEvent): string | null {
    if ('runId' in event && typeof event.runId === 'string') return event.runId;
    if (event.type === 'run.created' || event.type === 'run.updated') return event.run.id;
    if (event.type === 'turn.started' || event.type === 'turn.finished') return event.turn.runId;
    if (event.type === 'stage.started' || event.type === 'stage.finished') return event.runId;
    if (event.type === 'artifact.created') return event.artifact.runId;
    if (event.type === 'approval.requested' || event.type === 'approval.decided') return event.approval.runId;
    return null;
  }

  function emit(event: ServerEvent): void {
    // 1. persist first, so the log is never behind the broadcast
    store.appendEvent({
      runId: runIdOf(event),
      type: event.type,
      payloadJson: JSON.stringify(event),
      at: event.at,
    });

    // 2. keep the durable projections current
    switch (event.type) {
      case 'run.created':
        runWorkspace.set(event.run.id, event.run.workspaceId);
        store.saveRun(event.run);
        break;
      case 'run.updated': {
        store.saveRun(event.run);
        runWorkspace.set(event.run.id, event.run.workspaceId);
        // Settled runs are folded into their organisation's recorded spend, so a
        // floor's lifetime cost survives the run falling out of memory.
        if (['done', 'failed', 'cancelled'].includes(event.run.status)) {
          const workspace = workspaceById(event.run.workspaceId);
          if (workspace) {
            workspace.budget.spentUsd += event.run.budget.spentUsd;
            office.updatedAt = Date.now();
            persistOffice();
          }
          runSpent.delete(event.run.id);
        }
        break;
      }
      case 'turn.finished':
        store.saveTurn(event.turn);
        break;
      case 'artifact.created':
        store.saveArtifact(event.artifact);
        break;
      case 'approval.requested':
      case 'approval.decided':
        store.saveApproval(event.approval);
        approvalHistory.set(event.approval.id, event.approval);
        break;
      case 'org.updated': {
        const workspace = workspaceById(event.workspaceId);
        if (workspace) {
          workspace.org = event.org;
          syncRoster(workspace);
          office.updatedAt = Date.now();
          persistOffice();
        }
        break;
      }
      case 'settings.updated':
        office.settings = event.settings;
        office.updatedAt = Date.now();
        persistOffice();
        break;
      default:
        break;
    }

    // 3. broadcast
    for (const fn of subscribers) {
      try {
        fn(event);
      } catch (e) {
        log('warn', 'runtime', `subscriber threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * Stamp the operator's plugin decisions onto the document before it is
   * written, so enabling a plugin and recording a run's spend are one write path
   * rather than two that can disagree.
   */
  function persistOffice(): void {
    if (pluginHost) office.plugins = pluginHost.persisted();
    store.saveOffice(office);
  }

  function commitWorkspace(workspace: Workspace, note: string): void {
    workspace.org.updatedAt = Date.now();
    office.updatedAt = Date.now();
    persistOffice();
    emit({ type: 'org.updated', workspaceId: workspace.id, org: structuredClone(workspace.org), at: Date.now() });
    log('info', 'org', note);
  }

  /**
   * Resolve one pending approval. There is exactly one path to a decision - the
   * operator pressing a button, and the timeout expiring - so the store, the
   * event stream and the waiting tool can never disagree about what happened.
   */
  function resolveApproval(approvalId: string, approved: boolean, reason: string): boolean {
    const live = pending.get(approvalId);
    if (!live) return false;
    pending.delete(approvalId);
    clearTimeout(live.timer);
    const decided: Approval = {
      ...live.approval,
      status: approved ? 'approved' : 'rejected',
      decidedAt: Date.now(),
    };
    approvalHistory.set(decided.id, decided);
    store.saveApproval(decided);
    emit({ type: 'approval.decided', approval: decided, at: Date.now() });
    log('info', 'approvals', `${approved ? 'approved' : 'refused'} ${approvalId} (${reason})`);
    live.resolve(approved);
    return true;
  }

  // ------------------------------------------------------------- trackers

  const employeeTracker: EmployeeTracker = {
    get: (workspaceId, employeeId) => rosters.get(workspaceId)?.get(employeeId),

    update(workspaceId, employeeId, patch) {
      const workspace = workspaceById(workspaceId);
      const role = workspace?.org.roles.find((candidate) => candidate.id === employeeId);
      const base = rosters.get(workspaceId)?.get(employeeId) ?? toEmployeeState(role ?? syntheticRole(employeeId), workspaceId);
      const next: EmployeeState = {
        ...base,
        ...patch,
        id: base.id,
        roleId: base.roleId,
        workspaceId: base.workspaceId,
      };
      rosterFor(workspaceId).set(employeeId, next);
      emit({ type: 'employee.updated', employee: structuredClone(next), at: Date.now() });
      return next;
    },

    addUsage(workspaceId, employeeId, usage: UsageRecord) {
      const workspace = workspaceById(workspaceId);
      const role = workspace?.org.roles.find((candidate) => candidate.id === employeeId);
      const base = rosters.get(workspaceId)?.get(employeeId) ?? toEmployeeState(role ?? syntheticRole(employeeId), workspaceId);
      const lifetime: EmployeeUsage = {
        turns: base.lifetime.turns + 1,
        tokensIn: base.lifetime.tokensIn + usage.tokensIn,
        tokensOut: base.lifetime.tokensOut + usage.tokensOut,
        costUsd: base.lifetime.costUsd + usage.costUsd,
      };
      const next: EmployeeState = { ...base, lifetime };
      rosterFor(workspaceId).set(employeeId, next);
      emit({ type: 'usage', employeeId, lifetime: { ...lifetime }, at: Date.now() });
      return next;
    },
  };

  /** A state for an id that is not in a chart (should not happen; never crash). */
  function syntheticRole(employeeId: string): Role {
    return {
      id: employeeId,
      displayName: employeeId,
      title: 'Contractor',
      departmentId: 'platform',
      seniority: 'mid',
      rank: 99,
      reportsTo: null,
      mission: 'Not part of any current org chart.',
      responsibilities: [],
      skillIds: [],
      allowedTools: [],
      modelPolicy: { defaultTier: 'small', minTier: 'nano', maxTier: 'standard' },
      seatId: null,
      roomId: null,
      canDelegate: false,
      maxDirectReports: 0,
      persona: { voice: 'neutral', values: [] },
      appearance: { bodyColor: '#94a3b8', accentColor: '#334155', height: 1 },
      maxTurnsPerStage: 1,
    };
  }

  const orgAccess: OrgAccess = {
    chart: (workspaceId) => {
      const workspace = workspaceById(workspaceId) ?? office.workspaces[0];
      if (!workspace) return { company: defaultCompany(), departments: [], roles: [], pipelineIds: [], updatedAt: Date.now() };
      return workspace.org;
    },
    role: (roleId, workspaceId) => workspaceById(workspaceId)?.org.roles.find((role) => role.id === roleId),
    workspace: (workspaceId) => workspaceById(workspaceId),
    workspaces: () => office.workspaces,
  };

  const broker: ApprovalBroker = {
    request(input) {
      const approval: Approval = {
        id: `appr_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
        runId: input.runId,
        turnId: input.turnId,
        employeeId: input.employeeId,
        kind: input.kind,
        summary: input.summary,
        detail: input.detail,
        status: 'pending',
        requestedAt: Date.now(),
        decidedAt: null,
      };
      approvalHistory.set(approval.id, approval);

      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          log(
            'warn',
            'approvals',
            `approval ${approval.id} timed out after ${office.settings.approvalTimeoutMs} ms; treating it as refused`,
          );
          resolveApproval(approval.id, false, 'timed out');
        }, office.settings.approvalTimeoutMs);

        pending.set(approval.id, { approval, resolve, timer });
        store.saveApproval(approval);
        emit({ type: 'approval.requested', approval: structuredClone(approval), at: Date.now() });
      });
    },
  };

  // ------------------------------------------------------------------ state

  function state(): OfficeState {
    const workspace = activeWorkspace() ?? office.workspaces[0];
    const workspaceId = workspace?.id ?? '';
    if (workspace) syncRoster(workspace);

    const providers: ProviderStatus[] = registry.status().map((status) => ({
      id: status.id,
      label: status.label,
      configured: status.configured,
      ok: status.ok,
      detail: status.detail,
      modelCount: status.modelCount,
      pluginId: status.pluginId,
      // Where the model list came from. Without it a console sees a count and
      // cannot tell a provider that was asked from one that never was.
      modelSource: status.modelSource,
      modelSourceDetail: status.modelSourceDetail,
      discoveredAt: status.discoveredAt,
    }));
    const runs = engineAccessor.runs().filter((run) => run.workspaceId === workspaceId);
    const activeRunIds = engineAccessor.activeRunIds().filter((id) => runs.some((run) => run.id === id));

    return {
      settings: structuredClone(office.settings),
      activeWorkspaceId: workspaceId,
      plugins: pluginHost?.state() ?? {
        apiVersion: PLUGIN_API_VERSION,
        pluginsRoot: config.pluginsDir,
        allowInstall: config.allowPluginInstall,
        records: [],
        sources: [],
      },
      workspaces: summaries(),
      company: structuredClone(workspace?.org.company ?? defaultCompany()),
      departments: structuredClone(workspace?.org.departments ?? []),
      roles: structuredClone(workspace?.org.roles ?? []),
      employees: [...(rosters.get(workspaceId)?.values() ?? [])].map((entry) => structuredClone(entry)),
      skillIds: [...(workspace?.skillIds ?? [])],
      budget: structuredClone(workspace?.budget ?? { defaultRunUsd: 5, spentUsd: 0 }),
      style: structuredClone(workspace?.style ?? { preset: DEFAULT_STYLE_PRESET }),
      floor: workspace === undefined
        ? {
            layout: EMPTY_LAYOUT,
            coreSeats: assets.coreSeatIds.length,
            capacity: assets.coreSeatIds.length,
            seatIds: [...assets.coreSeatIds],
            modules: [],
            style: { preset: DEFAULT_STYLE_PRESET },
            describe: 'no floor',
            problem: assets.problem,
          }
        : floorState(workspace),
      pipelines: structuredClone(enabledPipelines(workspace)),
      runs,
      activeRunIds,
      models: structuredClone(registry.models()),
      providers,
      // Coverage of the quality signals, so the console can say "31 of 445
      // benchmarked" rather than implying a thin signal is a complete one.
      modelSignals: registry.signals(),
      llmMode: registry.mock ? 'mock' : 'live',
      // The reason travels with the mode so the badge can explain itself rather
      // than leaving "mock" to be interpreted.
      llmModeReason: config.llmModeReason,
      configStale: detectConfigDrift(config).detail,
      routingPosture: workspace?.org.routingPosture ?? office.settings.defaultRoutingPosture,
      version: config.version,
      startedAt,
    };
  }

  function enabledPipelines(workspace: Workspace | undefined): Pipeline[] {
    // A floor tunes which of the *shipped* pipelines it runs. A plugin's
    // pipelines are installation-level, like the providers and models it
    // contributes, so they are offered to every floor: a plugin cannot know
    // which organisations exist, and "enable this per floor" would mean an
    // operator editing thirteen floors to turn one on.
    const fromPlugins = (pluginHost?.contributions().pipelines ?? []).map((entry) => entry.pipeline);
    if (!workspace) return [...pipelines, ...fromPlugins];
    const ids = workspace.org.pipelineIds;
    const shipped =
      !Array.isArray(ids) || ids.length === 0
        ? pipelines
        : (() => {
            const enabled = pipelines.filter((pipeline) => ids.includes(pipeline.id));
            return enabled.length > 0 ? enabled : pipelines;
          })();
    // A plugin pipeline id must not shadow a shipped one; the shipped pipeline
    // already owns that id and the floor's own configuration stays authoritative.
    const taken = new Set(shipped.map((pipeline) => pipeline.id));
    return [...shipped, ...fromPlugins.filter((pipeline) => !taken.has(pipeline.id))];
  }

  // --------------------------------------------------------------- returned

  return {
    store,
    startedAt,

    attachEngine(accessor) {
      engineAccessor = accessor;
    },

    attachPlugins(host) {
      pluginHost = host;
    },

    announcePlugins() {
      if (!pluginHost) return;
      office.plugins = pluginHost.persisted();
      office.updatedAt = Date.now();
      store.saveOffice(office);
      emit({ type: 'plugins.updated', state: pluginHost.state(), at: Date.now() });
    },

    engineConfig: () => engineConfig,
    settings: () => structuredClone(office.settings),

    updateSettings(patch) {
      const next: OfficeSettings = { ...office.settings, ...patch, updatedAt: Date.now() };
      if (next.maxConcurrency < 1 || next.maxConcurrency > 16) {
        return { ok: false, error: 'Concurrency must be between 1 and 16.' };
      }
      if (next.softSpendApprovalUsd < 0) {
        return { ok: false, error: 'The soft spend threshold cannot be negative.' };
      }
      if (next.approvalTimeoutMs < 1_000) {
        return { ok: false, error: 'An approval must be allowed at least a second to answer.' };
      }
      if (patch.modelOverrides !== undefined) {
        const cleaned = cleanModelOverrides(patch.modelOverrides);
        if (!cleaned.ok) return { ok: false, error: cleaned.error };
        next.modelOverrides = cleaned.overrides;
      }
      office.settings = next;
      applySettings();
      emit({ type: 'settings.updated', settings: structuredClone(next), at: Date.now() });
      return { ok: true };
    },

    office: () => structuredClone(office),
    workspaces: () => office.workspaces.map((entry) => structuredClone(entry)),
    workspace: (workspaceId) => {
      const found = workspaceById(workspaceId);
      return found ? structuredClone(found) : undefined;
    },
    activeWorkspaceId: () => activeWorkspaceId,
    summaries,

    setActiveWorkspace(workspaceId) {
      const found = workspaceById(workspaceId);
      if (!found) return { ok: false, error: `There is no workspace "${workspaceId}".` };
      activeWorkspaceId = workspaceId;
      syncRoster(found);
      return { ok: true };
    },

    createWorkspace(input) {
      const name = input.name.trim();
      if (name.length === 0) return { ok: false, error: 'A workspace needs a name.' };
      if (name.length > 60) return { ok: false, error: 'Workspace names are limited to 60 characters.' };

      const root = office.settings.workspacesRoot;
      const explicit = input.path?.trim();
      let target: string;

      if (explicit !== undefined && explicit !== '') {
        if (!isAbsolute(explicit)) {
          return {
            ok: false,
            error:
              `"${explicit}" is not an absolute path. Give a full path (like E:\\code\\project), ` +
              'or leave the path empty and give a folder name to create one under the workspaces root.',
          };
        }
        target = resolve(explicit);
        if (!office.settings.allowExternalWorkspaces && !isInside(root, target)) {
          return {
            ok: false,
            error:
              `External workspaces are disabled, so "${target}" is outside the permitted root ${root}. ` +
              'Turn them on in Settings, or create the organisation under the root.',
          };
        }
      } else {
        const raw = input.folder?.trim() ?? '';
        const folder = (raw !== '' ? raw : slugify(name)).replace(/[\\/]+$/, '');
        if (folder === '' || folder.includes('..') || /[\\/]/.test(folder)) {
          return { ok: false, error: 'A folder name cannot be empty or contain a path separator.' };
        }
        target = resolve(root, folder);
        if (!isInside(root, target)) {
          return { ok: false, error: `"${folder}" escapes the workspaces root ${root}.` };
        }
      }

      if (office.workspaces.some((entry) => resolve(entry.path) === target)) {
        return { ok: false, error: `An office already works in ${target}.` };
      }

      try {
        mkdirSync(target, { recursive: true });
      } catch (e) {
        return {
          ok: false,
          error: `Could not create ${target}: ${e instanceof Error ? e.message : String(e)}`,
        };
      }

      const workspace = defaultWorkspace({
        id: uniqueWorkspaceId(slugify(name)),
        name,
        path: target,
        floor: nextFloor(),
        ...(input.description !== undefined && input.description.trim() !== ''
          ? { description: input.description.trim() }
          : {}),
        color: input.color?.trim() || '#a78bfa',
        ...(input.skillIds !== undefined ? { skillIds: input.skillIds } : {}),
        budget: {
          defaultRunUsd: input.budget?.defaultRunUsd ?? 5,
          ...(input.budget?.totalUsd !== undefined ? { totalUsd: input.budget.totalUsd } : {}),
        },
      });

      office.workspaces = [...office.workspaces, workspace];
      office.updatedAt = Date.now();
      syncRoster(workspace);
      persistOffice();
      emit({ type: 'org.updated', workspaceId: workspace.id, org: structuredClone(workspace.org), at: Date.now() });
      log('info', 'office', `opened "${workspace.name}" on floor ${workspace.floor} at ${workspace.path}`);
      return { ok: true, workspace: structuredClone(workspace) };
    },

    removeWorkspace(workspaceId) {
      const found = workspaceById(workspaceId);
      if (!found) return { ok: false, error: `No workspace "${workspaceId}".` };
      if (found.isDefault === true) {
        return {
          ok: false,
          error: 'The first organisation cannot be closed: it is the fallback when nothing else is selected.',
        };
      }
      office.workspaces = office.workspaces.filter((entry) => entry.id !== workspaceId);
      rosters.delete(workspaceId);
      if (activeWorkspaceId === workspaceId) {
        activeWorkspaceId = office.workspaces.find((entry) => entry.isDefault === true)?.id ?? office.workspaces[0]?.id ?? '';
      }
      office.updatedAt = Date.now();
      persistOffice();
      // Only the registration is forgotten. Deleting a directory full of someone
      // else's work is never something a UI button should do.
      log('info', 'office', `closed "${found.name}"; its directory and runs are untouched`);
      return { ok: true };
    },

    setWorkspaceSkills(workspaceId, skillIds) {
      const workspace = workspaceById(workspaceId);
      if (!workspace) return { ok: false, error: `No workspace "${workspaceId}".` };
      // Validate against the same merged catalog the engine offers employees.
      // Checking only the markdown on disk would make a plugin's skill
      // impossible to enable, and so impossible to ever use.
      const known = new Set(
        [...opts.skills, ...(pluginHost?.pluginSkills() ?? [])].map((skill) => skill.id),
      );
      const clean = [...new Set(skillIds)].filter((id) => known.has(id));
      if (clean.length === 0) {
        return { ok: false, error: 'An organisation needs at least one skill available to its employees.' };
      }
      workspace.skillIds = clean;
      // A role may only hold skills its organisation has enabled.
      for (const role of workspace.org.roles) {
        const kept = role.skillIds.filter((id) => clean.includes(id));
        role.skillIds = kept.length > 0 ? kept : [clean[0] as string];
      }
      commitWorkspace(workspace, `"${workspace.name}" now has ${clean.length} skills enabled`);
      return { ok: true };
    },

    setWorkspaceBudget(workspaceId, patch) {
      const workspace = workspaceById(workspaceId);
      if (!workspace) return { ok: false, error: `No workspace "${workspaceId}".` };
      if (patch.defaultRunUsd !== undefined) {
        if (!Number.isFinite(patch.defaultRunUsd) || patch.defaultRunUsd < 0) {
          return { ok: false, error: 'A default run budget must be zero or more.' };
        }
        workspace.budget.defaultRunUsd = patch.defaultRunUsd;
      }
      if (patch.totalUsd !== undefined) {
        if (!Number.isFinite(patch.totalUsd) || patch.totalUsd < 0) {
          return { ok: false, error: 'A total budget must be zero or more.' };
        }
        workspace.budget.totalUsd = patch.totalUsd;
      }
      if (patch.spentUsd !== undefined && Number.isFinite(patch.spentUsd)) {
        workspace.budget.spentUsd = Math.max(0, patch.spentUsd);
      }
      commitWorkspace(workspace, `"${workspace.name}" budget updated`);
      return { ok: true };
    },

    setWorkspaceDetails(workspaceId, patch) {
      const workspace = workspaceById(workspaceId);
      if (!workspace) return { ok: false, error: `No workspace "${workspaceId}".` };
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (name === '') return { ok: false, error: 'A workspace needs a name.' };
        if (name.length > 60) return { ok: false, error: 'Workspace names are limited to 60 characters.' };
        workspace.name = name;
        workspace.org.company.name = name;
      }
      if (patch.description !== undefined) {
        if (patch.description.trim() === '') delete workspace.description;
        else workspace.description = patch.description.trim();
      }
      if (patch.color !== undefined && patch.color.trim() !== '') workspace.color = patch.color.trim();
      commitWorkspace(workspace, `"${workspace.name}" details updated`);
      return { ok: true };
    },

    setWorkspaceStyle(workspaceId, style) {
      const workspace = workspaceById(workspaceId);
      if (!workspace) return { ok: false, error: `No workspace "${workspaceId}".` };
      if (style === null) {
        delete workspace.style;
        commitWorkspace(workspace, `"${workspace.name}" returned to the default look`);
        return { ok: true };
      }
      const parsed = parseOfficeStyle(style);
      if (parsed === undefined) return { ok: false, error: 'That is not a style this build can apply.' };
      if (style.preset !== undefined && stylePreset(style.preset).id !== style.preset) {
        return { ok: false, error: `There is no style preset called "${style.preset}".` };
      }
      workspace.style = parsed;
      const resolved = resolveStyle(parsed);
      commitWorkspace(workspace, `"${workspace.name}" restyled to ${resolved.preset.name}`);
      return { ok: true };
    },

    state,
    emit,
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    org: orgAccess,
    employees: employeeTracker,
    sink: { emit },
    approvals: broker,

    pipelines: (workspaceId) => enabledPipelines(workspaceById(workspaceId)),
    /**
     * Every skill an employee could be offered: the markdown on disk plus
     * whatever enabled plugins contribute.
     */
    skills: () => {
      const contributed = pluginHost?.pluginSkills() ?? [];
      return contributed.length === 0 ? opts.skills : [...opts.skills, ...contributed];
    },

    pendingApprovals: () => [...pending.values()].map((entry) => structuredClone(entry.approval)),
    approvalsForRun: (runId) =>
      [...approvalHistory.values()].filter((approval) => approval.runId === runId).map((a) => structuredClone(a)),
    approvalsOf: (kind) =>
      [...approvalHistory.values()].filter((approval) => approval.kind === kind).map((a) => structuredClone(a)),

    decideApproval(approvalId, approved) {
      return resolveApproval(approvalId, approved, 'operator decision');
    },

    hire(role, workspaceId) {
      const workspace = workspaceById(workspaceId);
      if (!workspace) return { ok: false, error: `No workspace "${workspaceId ?? activeWorkspaceId}".` };
      if (workspace.org.roles.some((entry) => entry.id === role.id)) {
        return { ok: false, error: `A role with id "${role.id}" already exists here.` };
      }
      if (role.reportsTo !== null && !workspace.org.roles.some((entry) => entry.id === role.reportsTo)) {
        return { ok: false, error: `Reports-to role "${role.reportsTo}" does not exist.` };
      }
      // An employee may only hold skills the organisation has enabled.
      const allowed = new Set(workspace.skillIds);
      const scoped: Role = { ...role, skillIds: role.skillIds.filter((id) => allowed.has(id)) };
      if (scoped.skillIds.length === 0 && workspace.skillIds[0] !== undefined) {
        scoped.skillIds = [workspace.skillIds[0]];
      }

      workspace.org.roles = [...workspace.org.roles, scoped];
      syncRoster(workspace);
      // A floor grows itself rather than hot-desking a new hire indefinitely.
      // Growing first, then seating, is what makes the new desks usable in the
      // same breath as the hire that needed them.
      const growth = ensureCapacity(workspace, workspace.org.roles.length);
      const seated = seatNewcomer(workspace, scoped);
      commitWorkspace(
        workspace,
        growth.grew > 0
          ? `hired ${scoped.displayName} (${scoped.title}); the floor grew ${growth.grew} room(s) to seat them`
          : `hired ${scoped.displayName} (${scoped.title})`,
      );
      if (seated !== null) {
        emit({
          type: 'employee.moved',
          employeeId: scoped.id,
          fromSeatId: null,
          toSeatId: seated.seatId,
          toRoomId: seated.roomId,
          at: Date.now(),
        });
      }
      if (growth.grew > 0) {
        emit({
          type: 'log',
          level: 'info',
          scope: 'office',
          message: `"${workspace.name}" grew ${growth.grew} room(s) on floor ${workspace.floor}.`,
          at: Date.now(),
        });
      }
      if (growth.exhausted) {
        emit({
          type: 'log',
          level: 'warn',
          scope: 'office',
          message: `"${workspace.name}" has run out of room to build: some employees have no desk.`,
          at: Date.now(),
        });
      }
      emit({
        type: 'employee.updated',
        employee: structuredClone(rosterFor(workspace.id).get(scoped.id) ?? toEmployeeState(scoped, workspace.id)),
        at: Date.now(),
      });
      return { ok: true };
    },

    fire(roleId, workspaceId) {
      const workspace = workspaceById(workspaceId);
      if (!workspace) return { ok: false, error: `No workspace "${workspaceId ?? activeWorkspaceId}".` };
      const role = workspace.org.roles.find((entry) => entry.id === roleId);
      if (!role) return { ok: false, error: `No role "${roleId}".` };

      const reports = workspace.org.roles.filter((entry) => entry.reportsTo === roleId);
      if (reports.length > 0) {
        // Keep the tree connected: orphaned reports move up to their old boss's
        // manager rather than silently becoming roots.
        workspace.org.roles = workspace.org.roles.map((entry) =>
          entry.reportsTo === roleId ? { ...entry, reportsTo: role.reportsTo } : entry,
        );
      }
      workspace.org.roles = workspace.org.roles.filter((entry) => entry.id !== roleId);
      syncRoster(workspace);
      commitWorkspace(workspace, `let ${role.displayName} go; ${reports.length} report(s) re-parented`);

      // 'offline' is exactly what the type means: not part of the current org.
      const gone: EmployeeState = {
        ...(rosterFor(workspace.id).get(roleId) ?? toEmployeeState(role, workspace.id)),
        status: 'offline',
        activity: null,
        seatId: null,
        roomId: null,
        currentRunId: null,
        currentTurnId: null,
      };
      rosterFor(workspace.id).delete(roleId);
      emit({ type: 'employee.updated', employee: structuredClone(gone), at: Date.now() });
      return { ok: true };
    },

    setSeat(employeeId, seatId, roomId, workspaceId) {
      const workspace = workspaceById(workspaceId);
      if (!workspace) return { ok: false, error: `No workspace "${workspaceId ?? activeWorkspaceId}".` };
      const role = workspace.org.roles.find((entry) => entry.id === employeeId);
      if (!role) return { ok: false, error: `No role "${employeeId}".` };
      const from = role.seatId;
      const nextRoom = roomId === undefined ? role.roomId : roomId;
      workspace.org.roles = workspace.org.roles.map((entry) =>
        entry.id === employeeId ? { ...entry, seatId, roomId: nextRoom ?? null } : entry,
      );
      syncRoster(workspace);
      commitWorkspace(workspace, `moved ${role.displayName} to ${seatId ?? 'hot-desking'}`);
      emit({
        type: 'employee.moved',
        employeeId,
        fromSeatId: from,
        toSeatId: seatId,
        toRoomId: nextRoom ?? null,
        at: Date.now(),
      });
      const current = rosterFor(workspace.id).get(employeeId);
      if (current) emit({ type: 'employee.updated', employee: structuredClone(current), at: Date.now() });
      return { ok: true };
    },

    setModelPolicy(roleId, policy, workspaceId) {
      const workspace = workspaceById(workspaceId);
      if (!workspace) return { ok: false, error: `No workspace "${workspaceId ?? activeWorkspaceId}".` };
      const role = workspace.org.roles.find((entry) => entry.id === roleId);
      if (!role) return { ok: false, error: `No role "${roleId}".` };
      workspace.org.roles = workspace.org.roles.map((entry) =>
        entry.id === roleId ? { ...entry, modelPolicy: policy } : entry,
      );
      commitWorkspace(workspace, `${role.displayName}'s model policy updated`);
      return { ok: true };
    },

    setRoutingPosture(posture, workspaceId) {
      const workspace = workspaceById(workspaceId);
      if (!workspace) return { ok: false, error: `No workspace "${workspaceId ?? activeWorkspaceId}".` };
      workspace.org.routingPosture = posture;
      commitWorkspace(workspace, `"${workspace.name}" routing posture set to ${posture ?? 'balanced'}`);
      return { ok: true };
    },

    /**
     * Change what one employee may hold: their tools and their skills.
     *
     * Both are filtered rather than trusted. A skill must be enabled on the
     * floor, exactly as at hire time, or a role could reference something its
     * organisation turned off. A tool must exist in the registry, which is what
     * makes a plugin-contributed tool grantable at all - and also what stops a
     * typo becoming a grant that silently never resolves.
     */
    setRoleGrants(roleId, patch, workspaceId) {
      const workspace = workspaceById(workspaceId);
      if (!workspace) return { ok: false, error: `No workspace "${workspaceId ?? activeWorkspaceId}".` };
      const role = workspace.org.roles.find((entry) => entry.id === roleId);
      if (!role) return { ok: false, error: `No role "${roleId}".` };

      const changes: string[] = [];
      let next: Role = role;

      if (patch.allowedTools !== undefined) {
        const known = new Set(opts.toolNames?.() ?? []);
        // With no registry to check against, the list is taken as given: the
        // caller that owns the tools is the only thing that can validate them.
        const clean = [...new Set(patch.allowedTools)].filter((name) => known.size === 0 || known.has(name));
        const dropped = [...new Set(patch.allowedTools)].filter((name) => known.size > 0 && !known.has(name));
        if (clean.length === 0) {
          return { ok: false, error: 'An employee must keep at least one tool; the whole list was unknown.' };
        }
        next = { ...next, allowedTools: clean };
        changes.push(
          dropped.length > 0
            ? `${role.displayName} may now use ${clean.length} tool(s); ${dropped.join(', ')} is not a tool here`
            : `${role.displayName} may now use ${clean.length} tool(s)`,
        );
      }

      if (patch.skillIds !== undefined) {
        const enabled = new Set(workspace.skillIds);
        const clean = [...new Set(patch.skillIds)].filter((id) => enabled.has(id));
        if (clean.length === 0) {
          return { ok: false, error: `"${workspace.name}" has none of those skills enabled.` };
        }
        next = { ...next, skillIds: clean };
        changes.push(`${role.displayName} now holds ${clean.length} skill(s)`);
      }

      if (changes.length === 0) return { ok: false, error: 'Nothing to change: send allowedTools or skillIds.' };

      workspace.org.roles = workspace.org.roles.map((entry) => (entry.id === roleId ? next : entry));
      syncRoster(workspace);
      commitWorkspace(workspace, changes.join('; '));
      return { ok: true };
    },

    employee: (employeeId, workspaceId) => {
      const workspace = workspaceById(workspaceId);
      const found = workspace ? rosterFor(workspace.id).get(employeeId) : undefined;
      return found ? structuredClone(found) : undefined;
    },

    pluginPipelines: () => (pluginHost?.contributions().pipelines ?? []).map((entry) => ({ ...entry })),
    roleTemplates: () => (pluginHost?.contributions().roleTemplates ?? []).map((entry) => ({ ...entry })),

    /** The floor's space, for the console's floor panel. */
    floor: (workspaceId) => {
      const workspace = workspaceById(workspaceId);
      return workspace ? floorState(workspace) : null;
    },

    /**
     * Build one more room by hand, whatever the headcount.
     *
     * An operator may want a meeting room or a lounge that nobody is hired into,
     * so this is not "grow until everyone has a desk" - it is one module, chosen
     * by the same deterministic planner, appended to whatever is there.
     */
    addRoom(workspaceId) {
      const workspace = workspaceById(workspaceId);
      if (!workspace) return { ok: false, error: `No workspace "${workspaceId ?? activeWorkspaceId}".` };
      if (assets.kit === null) {
        return { ok: false, error: assets.problem ?? 'this installation has no block kit, so there is nothing to build with.' };
      }
      const wanted = (workspace.layout?.blocks.length ?? 0) + 1;
      const result = planFloor(assets.kit, assets.coreSeatIds.length, wanted);
      if (result.layout.blocks.length <= (workspace.layout?.blocks.length ?? 0)) {
        return { ok: false, error: 'there is no room left to build on: every port is either used or blocked.' };
      }
      workspace.layout = result.layout;
      const added = result.added[result.added.length - 1];
      const kind = assets.kit.blocks.find((block) => block.id === added?.kind);
      commitWorkspace(workspace, `added a ${kind?.name ?? 'room'} to "${workspace.name}"`);
      return { ok: true };
    },

    /** Take the newest room back out. Refuses to go below what the roster needs. */
    removeRoom(workspaceId) {
      const workspace = workspaceById(workspaceId);
      if (!workspace) return { ok: false, error: `No workspace "${workspaceId ?? activeWorkspaceId}".` };
      if (assets.kit === null) return { ok: false, error: assets.problem ?? 'this installation has no block kit.' };
      const layout = workspace.layout;
      if (layout === undefined || layout.blocks.length === 0) {
        return { ok: false, error: `"${workspace.name}" is the core office only; there is nothing to remove.` };
      }
      // Removing a room someone is sitting in would leave them standing in a
      // doorway, so the test is not "is the roster bigger than the core" but
      // "can the floor still seat everyone without this room". A spare lounge
      // nobody is hired into comes out; a room with desks in use does not.
      const remaining = assets.kit.blocks.length > 0
        ? capacityFrom(assets.kit, shrink(assets.kit, layout, assets.coreSeatIds.length).layout, assets.coreSeatIds.length)
        : 0;
      if (remaining < workspace.org.roles.length) {
        return {
          ok: false,
          error: `"${workspace.name}" has ${workspace.org.roles.length} employee(s) and would only have ${remaining} seat(s) left; no room can be spared.`,
        };
      }
      const removed = shrink(assets.kit, layout, assets.coreSeatIds.length);
      if (removed.removed === null) return { ok: false, error: 'there is nothing to remove.' };
      workspace.layout = removed.layout;
      const kind = assets.kit.blocks.find((block) => block.id === removed.removed?.kind);
      commitWorkspace(workspace, `removed a ${kind?.name ?? 'room'} from "${workspace.name}"`);
      return { ok: true };
    },

    close() {
      for (const [, live] of pending) clearTimeout(live.timer);
      pending.clear();
    },
  };
}
