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
  MemoryFact,
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

/**
 * What a run was authorised to do without asking, fixed at the moment it started.
 *
 * The office has one live `autoApproveShell` setting, and `deps.config` is the
 * same object for the life of the process — `applySettings()` mutates it in
 * place, which is deliberate, because an operator changing a setting should see
 * it take effect. But "takes effect" must mean *on the next run*, not "on the
 * next tool call of a run that is already running". Live mutation made a
 * contradiction reachable: a settings write that arrives mid-run changes whether
 * the employees in that run are asked for approval, so the run is governed by a
 * policy that was never true when it was submitted, and its transcript cannot
 * say afterwards which policy it actually ran under.
 *
 * Pinning it fixes both halves. It is also the bound on the one actor that can
 * reach `POST /api/settings` at all: whatever a local client manages to write,
 * the run already in flight keeps the answer it started with.
 */
export interface RunPolicy {
  /** Whether tools that would otherwise ask may act unattended. */
  autoApproveShell: boolean;
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
  /**
   * What the office remembers, as this employee is allowed to see it.
   *
   * A function rather than the memory service itself, so the engine depends on
   * "ask a question, get facts" instead of on the store - which is what lets the
   * whole engine be driven in a test with a list of facts and no database. The
   * scope is resolved inside the runtime from the workspace and role, so the
   * engine cannot widen it by passing something else.
   *
   * It may return a promise, because semantic recall has to embed the query
   * first. The turn awaits it once, up front, and hands the resolved facts to the
   * `recall` tool through the context - so the tool stays synchronous and a model
   * calling it never pays for a second embedding round trip mid-turn.
   *
   * Optional because an engine without memory is still a working engine: the
   * prompt section and the `recall` tool both disappear cleanly when it is absent.
   */
  recall?: (input: {
    workspaceId: string;
    roleId: string | null;
    query: string;
    limit?: number;
  }) => MemoryFact[] | Promise<MemoryFact[]>;
  /**
   * The same lookup, lexical only, synchronously.
   *
   * All three of the `recall` variants exist for one reason each, and the reason
   * is that embedding costs a network round trip:
   *
   *  - `recall` may be async, so the prompt index can be semantically ranked - it
   *    runs once per turn, and the turn is already awaiting other work.
   *  - this one is synchronous, so the `recall` **tool** needs no async signature
   *    and a model that calls it mid-turn pays nothing extra.
   *  - the turn seeds a cache from the async call, so the overwhelmingly common
   *    case - the model asking the question the prompt already asked - is answered
   *    from memory instead of from a second search.
   *
   * Optional, and absent means the tool falls back to whatever `recall` gave it.
   */
  recallSync?: (input: {
    workspaceId: string;
    roleId: string | null;
    query: string;
    limit?: number;
  }) => MemoryFact[];
  employees: EmployeeTracker;
  sink: EventSink;
  approvals: ApprovalBroker;
  /**
   * The policy the run being executed started under, or `undefined` for a run
   * this engine did not start. The engine supplies this; a caller that omits it
   * gets the live config, which is what every turn did before runs were pinned.
   */
  policyFor?: (runId: string) => RunPolicy | undefined;
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
