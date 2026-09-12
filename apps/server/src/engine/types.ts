/**
 * Engine-internal contracts.
 *
 * The engine owns *behaviour*: routing a turn, calling a model, executing its
 * tools, running a stage, walking a pipeline. It deliberately does not own
 * *state* - the live org chart, the employee roster, the event fan-out and the
 * approval queue all live in the server runtime, which hands them to the engine
 * through the narrow interfaces below. That split is what lets the whole engine
 * be driven in a test with a fake sink and an instant approval broker.
 */

import type {
  ApprovalKind,
  Artifact,
  EmployeeState,
  OrgChart,
  Pipeline,
  Role,
  RoutingHint,
  ServerEvent,
  Skill,
  UsageRecord,
  Workspace,
} from '@dev3d/core';
import type { ServerConfig } from '../config.ts';
import type { ProviderRegistry } from '../llm/registry.ts';
import type { ToolRegistry } from '../tools/types.ts';

/** Where engine events go. The server implements this over the WS bus + store. */
export interface EventSink {
  emit(event: ServerEvent): void;
}

/**
 * Human-in-the-loop approval. Resolves `false` when the operator denies it or
 * when nobody can answer, so a tool can never hang a run forever.
 */
export interface ApprovalBroker {
  request(input: {
    runId: string;
    turnId: string | null;
    employeeId: string;
    kind: ApprovalKind;
    summary: string;
    detail: string;
  }): Promise<boolean>;
}

/**
 * Read access to the organisations in the building. Every lookup takes a
 * workspace id, because there is no single company any more: the same role id
 * ('ceo') exists in every organisation and means a different person in each.
 */
export interface OrgAccess {
  /** The organisation for a workspace. Omit the id for the active one. */
  chart(workspaceId?: string): OrgChart;
  role(roleId: string, workspaceId?: string): Role | undefined;
  workspace(workspaceId: string): Workspace | undefined;
  workspaces(): Workspace[];
}

/** The single source of truth for employee runtime state, per organisation. */
export interface EmployeeTracker {
  get(workspaceId: string, employeeId: string): EmployeeState | undefined;
  /** Patch an employee and emit `employee.updated`. Returns the new state. */
  update(
    workspaceId: string,
    employeeId: string,
    patch: Partial<Omit<EmployeeState, 'id' | 'roleId' | 'workspaceId'>>,
  ): EmployeeState;
  /** Add one turn's usage to lifetime totals and emit `usage`. */
  addUsage(workspaceId: string, employeeId: string, usage: UsageRecord): EmployeeState;
}

export interface EngineDeps {
  config: ServerConfig;
  registry: ProviderRegistry;
  tools: ToolRegistry;
  /**
   * The skills available to employees, as a supplier: plugins contribute skills,
   * and enabling one must be visible on the next turn rather than the next boot.
   */
  skills: () => Skill[];
  org: OrgAccess;
  /** Pipelines enabled for an organisation; omit the id for the active one. */
  pipelines: (workspaceId?: string) => Pipeline[];
  /** Preferences contributed by plugins, consulted when routing a turn. */
  routingHints?: () => RoutingHint[];
  employees: EmployeeTracker;
  sink: EventSink;
  approvals: ApprovalBroker;
  /** Injected by tests so generated ids stay predictable. */
  newId?: (prefix: string) => string;
}

/**
 * What later stages and turns are allowed to know about work already done. The
 * engine threads one of these through a run so a reviewer can see the files the
 * builders wrote, and a report can see the decision the workshop reached.
 */
export interface RunKnowledge {
  brief: string;
  objective: string | null;
  tags: string[];
  /** One entry per finished stage, oldest first. */
  stageSummaries: Array<{ stage: string; kind: string; summary: string }>;
  artifacts: Artifact[];
  /** Workspace-relative paths written so far, unique and in write order. */
  filesWritten: string[];
  /** Role ids that have actually written a file, in first-write order. */
  producers: string[];
}

export function emptyKnowledge(brief: string): RunKnowledge {
  return {
    brief,
    objective: null,
    tags: [],
    stageSummaries: [],
    artifacts: [],
    filesWritten: [],
    producers: [],
  };
}

/** A prior turn inside the same stage, used to build a debate transcript. */
export interface StageUtterance {
  speaker: string;
  purpose: string;
  text: string;
}
