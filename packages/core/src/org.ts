/**
 * The office: the building, the organisations inside it, and who works there.
 *
 * The shape is deliberately two-layered.
 *
 * An **Office** is the installation: one set of settings (providers, model
 * catalog, concurrency, approval policy, where projects live) and a list of
 * workspaces. An installation has exactly one Office.
 *
 * A **Workspace** is an independent organisation occupying one floor of the
 * building. It owns its own company, departments, roles, enabled skills,
 * pipelines and budget, and its own directory on disk, which is the confinement
 * boundary for every tool its employees hold. Two workspaces share nothing but
 * the building they sit in: the portal team and the admin-console team can have
 * different people, different skills, and different money.
 *
 * A `Role` is a *job description* - static, editable configuration. An
 * `EmployeeState` is that job description instantiated at runtime, with a status
 * and a desk. Keeping them separate means an organisation can be saved, diffed
 * and hand-edited while the runtime mutates freely.
 */

import type { ModelPolicy, ModelTier, RoutingPosture } from './model.ts';
import type { PluginPersistedState } from './plugin.ts';
import type { FloorLayout } from './block.ts';

/** Identity and mission of one organisation. */
export interface Company {
  id: string;
  name: string;
  /** One line every employee in this organisation keeps in mind. */
  mission: string;
  createdAt: number;
}

/** An organisation's money. */
export interface WorkspaceBudget {
  /** Ceiling applied to a run in this organisation that does not set its own. */
  defaultRunUsd: number;
  /** Optional ceiling on total recorded spend. Absent means no ceiling. */
  totalUsd?: number;
  /** Spend recorded against this organisation across all of its runs. */
  spentUsd: number;
}

/**
 * One organisation: its people, its skills, its money, and the floor it sits on.
 */
export interface Workspace {
  /** Stable id, e.g. 'customer-portal'. */
  id: string;
  /** Human name shown in the floor selector, e.g. 'Customer portal'. */
  name: string;
  /** Absolute path. The confinement boundary for tools in this organisation. */
  path: string;
  /** One line about what this team is for. */
  description?: string;
  /** UI accent colour (hex), used to tag runs, floors and artifacts. */
  color?: string;
  /** The organisation the office was configured with; cannot be removed. */
  isDefault?: boolean;
  /** Floor of the building this organisation occupies. 1 is the ground floor. */
  floor: number;
  /** Skill ids employees here may draw on. A role may only use what is listed. */
  skillIds: string[];
  budget: WorkspaceBudget;
  /** The organisation itself: who exists, and how they are staffed. */
  org: OrgChart;
  /**
   * The room modules this floor has grown. Absent means the core office only,
   * which is what a floor that has never outgrown its desks looks like.
   */
  layout?: FloorLayout;
  createdAt: number;
}

/**
 * A correction to a catalog model, for the whole installation.
 *
 * A model's tier decides where it sits in the routing walk and its prices decide
 * what a turn costs and which model wins a tie. Both used to live only in
 * `llm/catalog.ts`, which meant an operator could not fix a stale price or
 * re-tier a model without editing source and redeploying.
 *
 * A patch, not a whole model: an override that leaves a field alone cannot
 * accidentally blank it out.
 */
export interface ModelOverride {
  tier?: ModelTier;
  costPerMTokIn?: number;
  costPerMTokOut?: number;
}

/**
 * Installation-wide configuration. Everything here is about the office rather
 * than about one organisation inside it.
 */
export interface OfficeSettings {
  /** Where the Projects form creates new organisation directories. */
  workspacesRoot: string;
  /** Whether an organisation may point at a path outside `workspacesRoot`. */
  allowExternalWorkspaces: boolean;
  /** Posture new organisations start with. */
  defaultRoutingPosture: RoutingPosture;
  /** Max concurrently executing employees inside one organisation. */
  maxConcurrency: number;
  /** Ask a human before a run's spend crosses this, in USD. 0 disables. */
  softSpendApprovalUsd: number;
  /** When true, employees may run shell commands without asking. */
  autoApproveShell: boolean;
  /** How long an approval waits for a human before it counts as refused. */
  approvalTimeoutMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Models switched off for the whole installation, by id. */
  disabledModelIds: string[];
  /** Per-model corrections, keyed by model id. Absent means the catalog's word. */
  modelOverrides: Record<string, ModelOverride>;
  updatedAt: number;
}

/** The installation: settings plus every organisation inside it. */
export interface Office {
  settings: OfficeSettings;
  workspaces: Workspace[];
  /** What the operator decided about plugins; the manifests live on disk. */
  plugins: PluginPersistedState;
  updatedAt: number;
}

/**
 * The lightweight view of a workspace the console needs for its floor selector.
 * The full organisation only travels for the workspace being looked at.
 */
export interface WorkspaceSummary {
  id: string;
  name: string;
  path: string;
  description?: string;
  color?: string;
  isDefault?: boolean;
  floor: number;
  /** Employees in this organisation. */
  roleCount: number;
  /** Skills enabled for this organisation. */
  skillCount: number;
  activeRuns: number;
  spentUsd: number;
  budgetTotalUsd?: number;
  /**
   * The modules this floor has grown. On the summary rather than only on the
   * full workspace because the 3D view builds *every* floor from the summaries -
   * a floor that is not being looked at still has to be drawn as a plate of the
   * right shape, and it grows whether or not anyone is watching it.
   */
  layout: FloorLayout;
  /** How many employees this floor can seat right now. */
  capacity: number;
  createdAt: number;
}

export interface Department {
  id: string;
  name: string;
  mission: string;
  /** `Anchor_Room_*` node names this department occupies in the 3D office. */
  roomIds: string[];
  /** UI accent colour (hex). */
  color: string;
}

export type Seniority = 'executive' | 'lead' | 'senior' | 'mid' | 'junior';

export interface RoleAppearance {
  /** Hex colour of the avatar's torso. */
  bodyColor: string;
  /** Hex colour of the avatar's trim/headset. */
  accentColor: string;
  /** Visual height multiplier, roughly 0.9..1.15. */
  height: number;
}

export interface Role {
  /** Stable id, e.g. 'ceo', 'design-lead', 'frontend-dev-1'. */
  id: string;
  /** Human name shown in the office, e.g. 'Ada'. */
  displayName: string;
  title: string;
  departmentId: string;
  seniority: Seniority;
  /** 0 = top of the company. Used to order the org chart and escalation. */
  rank: number;
  /** Role id this role reports to; null for the CEO. */
  reportsTo: string | null;
  mission: string;
  /** What this employee is accountable for. Injected into the system prompt. */
  responsibilities: string[];
  /**
   * Skill ids. The first few are always offered; the rest are candidates the
   * employee may pull in per turn when the task looks relevant. Every id here
   * must also be enabled on the workspace.
   */
  skillIds: string[];
  /** Tool names this employee may call. Anything else is refused. */
  allowedTools: string[];
  modelPolicy: ModelPolicy;
  /** `Seat_*` anchor in the 3D office; null means hot-desking. */
  seatId: string | null;
  /** `Anchor_Room_*` the employee primarily works in. */
  roomId: string | null;
  canDelegate: boolean;
  maxDirectReports: number;
  persona: {
    voice: string;
    values: string[];
    /** How this employee behaves when arguing with a colleague. */
    debateStyle?: string;
  };
  appearance: RoleAppearance;
  /** Hard cap on turns this employee may take within a single stage. */
  maxTurnsPerStage: number;
}

/** One organisation's chart: who exists and how the work is routed. */
export interface OrgChart {
  company: Company;
  departments: Department[];
  roles: Role[];
  /** Pipeline ids this organisation can run. */
  pipelineIds: string[];
  /** Routing posture for this organisation; its roles may still pin policies. */
  routingPosture?: RoutingPosture;
  updatedAt: number;
}

export type EmployeeStatus =
  | 'offline' // on the bench / not part of the current org
  | 'idle' // at their desk with nothing to do
  | 'thinking' // a model call is in flight
  | 'working' // executing tools (editing files, running commands)
  | 'talking' // in a debate, review or meeting
  | 'blocked' // waiting on a human approval
  | 'error';

export interface EmployeeUsage {
  turns: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface EmployeeState {
  /** Runtime id. Currently 1:1 with roleId, but kept distinct on purpose. */
  id: string;
  roleId: string;
  /** The organisation this employee belongs to. */
  workspaceId: string;
  displayName: string;
  title: string;
  departmentId: string;
  status: EmployeeStatus;
  seatId: string | null;
  roomId: string | null;
  /** Short human-readable activity, e.g. 'editing src/auth/session.ts'. */
  activity: string | null;
  currentRunId: string | null;
  currentTurnId: string | null;
  /** Cumulative lifetime usage, independent of any single run. */
  lifetime: EmployeeUsage;
  /** Skills currently pulled into context for the in-flight turn. */
  activeSkillIds: string[];
  /** Most recent routing decision for this employee. */
  lastRoute: {
    modelId: string;
    providerId: string;
    tier: string;
    reason: string;
    at: number;
  } | null;
  /** Set while status === 'error'; cleared on the next successful turn. */
  lastError: string | null;
}

export function toEmployeeState(role: Role, workspaceId: string): EmployeeState {
  return {
    id: role.id,
    roleId: role.id,
    workspaceId,
    displayName: role.displayName,
    title: role.title,
    departmentId: role.departmentId,
    status: 'idle',
    seatId: role.seatId,
    roomId: role.roomId,
    activity: null,
    currentRunId: null,
    currentTurnId: null,
    lifetime: { turns: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
    activeSkillIds: [],
    lastRoute: null,
    lastError: null,
  };
}

/** Direct reports of a role, resolved against a role list. */
export function directReports(roles: Role[], roleId: string): Role[] {
  return roles.filter((r) => r.reportsTo === roleId).sort((a, b) => a.rank - b.rank);
}

/** Walks up the reporting chain from a role to the top of the company. */
export function chainOfCommand(roles: Role[], roleId: string): Role[] {
  const byId = new Map(roles.map((r) => [r.id, r]));
  const chain: Role[] = [];
  let cursor = byId.get(roleId);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.reportsTo ? byId.get(cursor.reportsTo) : undefined;
  }
  return chain;
}

/**
 * The compact view of a workspace used by the floor selector.
 *
 * `capacity` is passed in rather than derived here: it depends on the block kit
 * and on how many seats the core office actually carries, and neither is this
 * module's business.
 */
export function toWorkspaceSummary(
  workspace: Workspace,
  activeRuns: number,
  capacity = 0,
): WorkspaceSummary {
  const summary: WorkspaceSummary = {
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    floor: workspace.floor,
    roleCount: workspace.org.roles.length,
    skillCount: workspace.skillIds.length,
    activeRuns,
    spentUsd: workspace.budget.spentUsd,
    layout: workspace.layout ?? { blocks: [] },
    capacity,
    createdAt: workspace.createdAt,
  };
  if (workspace.description !== undefined) summary.description = workspace.description;
  if (workspace.color !== undefined) summary.color = workspace.color;
  if (workspace.isDefault === true) summary.isDefault = true;
  if (workspace.budget.totalUsd !== undefined) summary.budgetTotalUsd = workspace.budget.totalUsd;
  return summary;
}
