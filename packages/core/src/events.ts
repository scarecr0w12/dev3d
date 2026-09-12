/**
 * The wire protocol between the orchestrator and the office UI.
 *
 * One WebSocket. The server pushes ServerEvents; the client sends
 * ClientCommands. Everything is lossless JSON and every payload is a plain
 * owned object - never a live handle - so the same types work over the wire,
 * in the SQLite store, and in the browser store.
 */

import type { ModelCapabilities, ModelPolicy, ModelSpec, RouteDecision, RoutingPosture } from './model.ts';
import type { Company, Department, EmployeeState, EmployeeUsage, Role, OrgChart, OfficeSettings, WorkspaceBudget, WorkspaceSummary } from './org.ts';
import type { McpState, PluginSystemState } from './plugin.ts';
import type { Approval, Artifact, DirectMessage, Pipeline, Run, StageRun, TurnRecord } from './run.ts';
import type { FloorLayout, OfficeBlockKind } from './block.ts';
import type { OfficeStyle } from './style.ts';
import type { MemoryFact, MemoryFactInput, MemoryState } from './memory.ts';
import type { VendorBay } from './vendor.ts';

export interface ProviderStatus {
  id: string;
  label: string;
  /** True when the adapter has credentials/base URL and could be used. */
  configured: boolean;
  /** null = not probed yet. */
  ok: boolean | null;
  detail: string | null;
  modelCount: number;
  /**
   * The plugin that contributed this provider, or null for a built-in one. The
   * console shows it, because "where do my prompts go" should never need a
   * guess.
   */
  pluginId: string | null;
  /**
   * How this provider's model list was obtained.
   *
   * The distinction matters to anyone reading the catalog: `discovered` means
   * the vendor told us which models it serves, `seed` means nobody asked, and
   * `degraded` means we asked and could not get an answer, so the curated
   * catalog is standing in. A count with no provenance is a number nobody can
   * act on.
   */
  modelSource: 'discovered' | 'degraded' | 'seed';
  /** Why discovery failed, when it did. */
  modelSourceDetail: string | null;
  /** When the model list was last obtained, in epoch milliseconds. */
  discoveredAt: number | null;
}

/**
 * One turn of an ongoing conversation, as replayed by the browser.
 *
 * It is deliberately narrower than the model-facing `ChatMessage`: a client
 * sends the two roles a person can see, so a compromised or confused console
 * cannot inject a `system` prompt or a forged `tool` result into a turn.
 */
export interface ChatTurnInput {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * What the office knows about its models, beyond the catalog itself.
 *
 * Every one of these is optional information the router uses when it has it and
 * ignores when it does not, so the console reports coverage rather than implying
 * that a thin signal is a complete one.
 */
export interface ModelSignals {
  /** Public benchmark scores, from OpenRouter's aggregation of three sources. */
  benchmarks: {
    enabled: boolean;
    /** Rows returned, across every source. */
    entries: number;
    /** Distinct models those rows describe. */
    models: number;
    /** Rows carrying an Artificial Analysis index, which is the usable subset. */
    measured: number;
    fetchedAt: number | null;
    /** Required attribution, shown wherever a score is. */
    attribution: string;
    /** Why it is empty, when it is. */
    detail: string | null;
  };
  /** Upstream endpoint uptime. Needs no key. */
  health: {
    enabled: boolean;
    /** Models an uptime reading has been obtained for. */
    known: number;
    fetchedAt: number | null;
  };
  /** What the office has observed from its own finished turns. */
  learned: {
    /** Models with at least one observed outcome. */
    models: number;
    /** Turns the estimate is built from. */
    samples: number;
  };
}

/** Everything the office needs to render itself from cold. */
export interface OfficeState {
  /** Installation-wide settings: providers, catalog, policy, where projects live. */
  settings: OfficeSettings;
  /** The organisation the console is currently looking at. */
  activeWorkspaceId: string;
  /** Every organisation in the building, for the floor selector. */
  workspaces: WorkspaceSummary[];
  /**
   * The active organisation, flattened. Panels read `roles`, `employees` and
   * `company` directly rather than reaching through the workspace, so switching
   * floors swaps the whole context in one event.
   */
  company: Company;
  departments: Department[];
  roles: Role[];
  employees: EmployeeState[];
  /** Skills enabled for the active organisation. */
  skillIds: string[];
  /** The active organisation's money. */
  budget: WorkspaceBudget;
  /**
   * How the active floor looks, at the top level as well as on its floor state.
   *
   * The style editor is a top-level panel, and reaching into `floor.style` for
   * the value it edits - while every other panel on the same page reads a
   * top-level field - is the kind of inconsistency that gets copied.
   */
  style: OfficeStyle;
  /** Everything about the floor the console is looking at, in one place. */
  floor: {
    /** The modules this floor has grown beyond the core office. */
    layout: FloorLayout;
    /** How many seats the core office itself carries. */
    coreSeats: number;
    /** Seats available now: the core plus every module. */
    capacity: number;
    /** Every seat id, core and generated, for the seat picker. */
    seatIds: string[];
    /** The module kinds a floor can be grown with. */
    modules: OfficeBlockKind[];
    /**
     * How this floor looks: the preset it starts from plus whatever was changed.
     * Sparse, so a floor that has never been styled is one field rather than a
     * full palette the client has to diff against the default.
     */
    style: OfficeStyle;
    /** A short human line: `core + 3 rooms · Open pod, Lounge`. */
    describe: string;
    /** Why there is no kit, when there is none. */
    problem: string | null;
  };
  pipelines: Pipeline[];
  /** Runs belonging to the active organisation. */
  runs: Run[];
  activeRunIds: string[];
  /** Full model catalog the router chooses from. */
  models: ModelSpec[];
  providers: ProviderStatus[];
  /** Coverage of the quality signals the router weighs. */
  modelSignals: ModelSignals;
  /** 'mock' runs the whole engine against scripted employees, no keys needed. */
  llmMode: 'mock' | 'live';
  /**
   * Why `llmMode` is what it is, in words.
   *
   * The console badges the mode, and a badge that says "mock" without a reason
   * is a riddle: it looks identical whether no key was found, or an operator
   * forced it, or the process simply predates the key being added.
   */
  llmModeReason: string;
  /**
   * Set when the environment has changed since this process read it, so a
   * restart would resolve something differently.
   *
   * `.env` is read once at startup, which is correct and completely invisible.
   * Without this, editing it and seeing no change looks like a bug in the
   * configuration rather than a process that has not been restarted.
   */
  configStale: string | null;
  routingPosture: RoutingPosture;
  /** Installed plugins, marketplaces, and what they contribute. */
  plugins: PluginSystemState;
  /**
   * MCP servers, and the tools each of them published.
   *
   * Carried in the state rather than fetched on demand because a tool an
   * employee can call is a capability, and the console should be able to say
   * which capabilities exist without asking a second question.
   */
  mcp: McpState;
  /**
   * What the office remembers between runs.
   *
   * Carried in the state rather than fetched on demand for the same reason the
   * MCP tool list is: a fact an employee can recall is a capability, and the
   * console should be able to show what the office believes without asking a
   * second question. It is bounded by the store, not by the protocol.
   */
  memory: MemoryState;
  /**
   * The third-party vendors this office has engaged.
   *
   * Carried here rather than fetched on demand for the same reason the MCP
   * server list and the memory index are: a vendor an employee can hand work to
   * is a *capability*, and the console should be able to say who is on site
   * without asking a second question. The 3D office reads it too - this is what
   * puts a terminal in the vendor bay rather than leaving the floor looking as
   * though the work came from nowhere.
   *
   * Deliberately a separate list from `employees`. See `vendor.ts` for why a
   * vendor is not given an `EmployeeState`.
   */
  vendorBay: VendorBay;
  /** Server build info, shown in the office footer. */
  version: string;
  startedAt: number;
}

export type ServerEvent =
  | { type: 'hello'; state: OfficeState; at: number }
  | { type: 'office.updated'; state: OfficeState; at: number }
  /** The active organisation's chart changed. Carries which one. */
  | { type: 'org.updated'; workspaceId: string; org: OrgChart; at: number }
  /** Installation-wide settings changed. */
  | { type: 'settings.updated'; settings: OfficeSettings; at: number }
  /** A plugin was enabled, disabled, configured, installed or removed. */
  | { type: 'plugins.updated'; state: PluginSystemState; at: number }
  | { type: 'run.created'; run: Run; at: number }
  | { type: 'run.updated'; run: Run; at: number }
  | { type: 'stage.started'; runId: string; stage: StageRun; at: number }
  | { type: 'stage.finished'; runId: string; stage: StageRun; at: number }
  | { type: 'turn.started'; turn: TurnRecord; at: number }
  | { type: 'turn.delta'; runId: string; turnId: string; text: string; at: number }
  | { type: 'turn.reasoning'; runId: string; turnId: string; text: string; at: number }
  | { type: 'turn.finished'; turn: TurnRecord; at: number }
  | { type: 'employee.updated'; employee: EmployeeState; at: number }
  | {
      type: 'employee.moved';
      employeeId: string;
      fromSeatId: string | null;
      toSeatId: string | null;
      toRoomId: string | null;
      at: number;
    }
  | {
      type: 'speech';
      runId: string;
      stageId: string;
      fromEmployeeId: string;
      toEmployeeIds: string[];
      text: string;
      kind: 'debate' | 'report' | 'question' | 'answer' | 'handoff';
      at: number;
    }
  | { type: 'tool.result'; runId: string; turnId: string; call: TurnRecord['toolCalls'][number]; at: number }
  | { type: 'artifact.created'; artifact: Artifact; at: number }
  | { type: 'approval.requested'; approval: Approval; at: number }
  | { type: 'approval.decided'; approval: Approval; at: number }
  | {
      /**
       * The reply to a `chat` command. A direct conversation happens outside
       * every pipeline, so it has no run, no stage and no turn to hang off -
       * this event carries the exchange itself.
       */
      type: 'direct.message';
      employeeId: string;
      messages: DirectMessage[];
      at: number;
    }
  | {
      /**
       * The answer to one `plan` turn.
       *
       * Addressed to the console that asked rather than broadcast: a plan is a
       * private draft, and a half-finished idea appearing in every other
       * console's feed would be noise at best.
       */
      type: 'plan.reply';
      employeeId: string;
      /** Echoes the command's `requestId`, when it sent one. */
      requestId: string | null;
      text: string;
      route: RouteDecision | undefined;
      at: number;
    }
  | { type: 'budget.updated'; runId: string; limitUsd: number; spentUsd: number; at: number }
  | { type: 'routing.decision'; runId: string; turnId: string; route: RouteDecision; at: number }
  /**
   * A fact was written down.
   *
   * `superseded` is present when the write was a correction rather than an
   * addition, and carries the fact it replaced. Both halves of a supersession
   * travel in this one event because they are one operation: a console that saw
   * only the new fact would show two active facts contradicting each other until
   * its next full sync.
   */
  | { type: 'memory.created'; fact: MemoryFact; superseded: MemoryFact | null; at: number }
  /**
   * A fact stopped being true, without a replacement.
   *
   * Retraction rather than deletion: the row remains and stays retrievable by
   * asking what was believed before, which is the whole reason the office keeps
   * validity intervals instead of overwriting rows.
   */
  | { type: 'memory.retracted'; fact: MemoryFact; at: number }
  /** The memory state, resent whole when it changes shape rather than by delta. */
  | { type: 'memory.updated'; state: MemoryState; at: number }
  | { type: 'usage'; employeeId: string; lifetime: EmployeeUsage; at: number }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; scope: string; message: string; at: number }
  | { type: 'error'; message: string; runId?: string; at: number };

export type ServerEventType = ServerEvent['type'];

export type ClientCommand =
  /** Submit a new brief to the office. The CEO of that organisation owns it. */
  | { type: 'submit'; brief: string; pipelineId?: string; budgetUsd?: number; workspaceId?: string }
  /** Stop a run; in-flight turns are cancelled. */
  | { type: 'cancel'; runId: string }
  /** Talk directly to one employee, outside any pipeline. */
  | { type: 'chat'; employeeId: string; text: string; workspaceId?: string }
  /**
   * Shape a brief before any work is commissioned.
   *
   * `history` is the conversation so far, replayed by the client. A plan is
   * stateless on the server by design: nothing is commissioned until it is
   * submitted, so there is nothing to persist and nothing to leave behind.
   *
   * `requestId` is echoed back on the reply, so a console can match an answer to
   * the turn that asked for it.
   */
  | {
      type: 'plan';
      employeeId: string;
      text: string;
      history?: ChatTurnInput[];
      workspaceId?: string;
      requestId?: string;
    }
  /** Answer a pending approval. */
  | { type: 'approve'; approvalId: string; approved: boolean }

  /**
   * Switch which organisation the console is looking at. The server answers
   * with a fresh `office.updated`, so the whole context - people, skills, money,
   * runs, floor - changes together.
   */
  | { type: 'selectWorkspace'; workspaceId: string }

  // ------------------------------------------------- organisation (per floor)
  // Each of these acts on the active organisation unless it names one, which is
  // what lets the console operate on what is on screen while a script or a test
  // can address a specific floor.
  /** Re-tune one role's model policy. */
  | { type: 'setModelPolicy'; roleId: string; policy: ModelPolicy; workspaceId?: string }
  /**
   * Change what one employee may hold. Both lists are replaced, not merged, and
   * both are filtered by the server against what actually exists: a skill must
   * be enabled on the floor and a tool must be in the registry. This is the only
   * way to grant a tool a plugin registered.
   */
  | { type: 'setRoleGrants'; roleId: string; allowedTools?: string[]; skillIds?: string[]; workspaceId?: string }
  /** Move an employee to a different desk. */
  | { type: 'setSeat'; employeeId: string; seatId: string | null; roomId?: string | null; workspaceId?: string }
  /** Add a role to an organisation. */
  | { type: 'hire'; role: Role; workspaceId?: string }
  /** Remove a role from an organisation. */
  | { type: 'fire'; roleId: string; workspaceId?: string }
  /** Change the routing posture of an organisation. */
  | { type: 'setRoutingPosture'; posture: RoutingPosture; workspaceId?: string }
  /**
   * Build one more room on a floor, or take the newest one back out.
   *
   * A floor also grows by itself when its roster outgrows its desks; this is the
   * operator's hand on the same machinery, for a meeting room or a lounge that
   * nobody is hired into. Removal never goes below what the roster needs.
   */
  | { type: 'addRoom'; workspaceId?: string }
  | { type: 'removeRoom'; workspaceId?: string }
  /** Set which skills an organisation's employees may draw on. */
  | { type: 'setWorkspaceSkills'; skillIds: string[]; workspaceId?: string }
  /** Set an organisation's money. */
  | { type: 'setWorkspaceBudget'; budget: Partial<WorkspaceBudget>; workspaceId?: string }
  /** Rename, recolour or describe an organisation without touching its files. */
  | {
      type: 'setWorkspaceDetails';
      name?: string;
      description?: string;
      color?: string;
      workspaceId?: string;
    }
  /**
   * Restyle a floor: its preset, and whatever it changes about it.
   *
   * A whole style rather than a patch, because that is what the editor holds -
   * it renders the resolved palette, so it always sends back a complete answer,
   * and a merge would make "reset this surface to the preset" impossible to
   * express. `null` returns the floor to the default preset.
   */
  | { type: 'setWorkspaceStyle'; style: OfficeStyle | null; workspaceId?: string }

  // ------------------------------------------------------ building and system
  /**
   * Open a new organisation in the building.
   *
   * `folder` is a directory name under the configured workspaces root, which is
   * the safe path and what the UI offers first. `path` is an absolute override
   * for pointing the office at a project that already exists elsewhere on disk;
   * the server refuses it unless external workspaces are enabled, and the whole
   * directory becomes readable and writable to that organisation's employees.
   *
   * A new organisation starts staffed with a copy of the shipped company, on its
   * own floor, with the installation's default budget and every skill enabled.
   */
  | {
      type: 'createWorkspace';
      name: string;
      description?: string;
      color?: string;
      folder?: string;
      path?: string;
    }
  /** Close an organisation. Its directory and its runs are left alone. */
  | { type: 'removeWorkspace'; workspaceId: string }
  /** Change installation-wide settings. */
  | { type: 'updateSettings'; patch: Partial<OfficeSettings> }

  // ------------------------------------------------------------------ plugins
  /** Turn an installed plugin on or off. Disabling unloads what it contributed. */
  | { type: 'setPluginEnabled'; pluginId: string; enabled: boolean }
  /** Change a plugin's settings, merging over the manifest defaults. */
  | { type: 'configurePlugin'; pluginId: string; settings: Record<string, unknown> }
  /** Re-scan the plugins directory, picking up directories added by hand. */
  | { type: 'refreshPlugins' }
  /** Install a plugin from a marketplace catalog entry. */
  | { type: 'installPlugin'; catalogUrl: string; pluginId: string }
  /** Remove an installed plugin's directory. */
  | { type: 'removePlugin'; pluginId: string }
  /** Register a marketplace to browse. */
  | { type: 'addPluginSource'; label: string; url: string }
  | { type: 'removePluginSource'; sourceId: string }

  // ------------------------------------------------------------------- memory
  /**
   * Write a fact down, or correct one.
   *
   * `supersedes` on the input is what makes this a correction: the server creates
   * the new fact and invalidates the named one in a single operation, so a
   * correction can never be applied as half a change.
   */
  | { type: 'rememberFact'; fact: MemoryFactInput }
  /** Retract a fact. It stays on record; it stops being retrieved. */
  | { type: 'retractFact'; factId: string }

  /** Open a run's full transcript. */
  | { type: 'loadRun'; runId: string }
  /** Re-request the whole office state. */
  | { type: 'resync' }
  | { type: 'ping' };

export type ClientCommandType = ClientCommand['type'];

/** Persisted, replayable log line. */
export interface EventLogEntry {
  id: number;
  runId: string | null;
  type: string;
  payloadJson: string;
  at: number;
}

/** What the frontend keeps, so panels can render without re-deriving. */
export interface ClientOfficeStore {
  connected: boolean;
  state: OfficeState | null;
  /** Streaming text for the turn currently in flight, keyed by turnId. */
  streaming: Record<string, string>;
  /** Rolling event feed for the activity panel. */
  feed: Array<{ id: string; kind: string; text: string; at: number; employeeId?: string; runId?: string }>;
  approvals: Approval[];
  selectedEmployeeId: string | null;
  selectedRunId: string | null;
  /** Direct conversations, keyed by employeeId. Fed by `direct.message`. */
  directMessages?: Record<string, DirectMessage[]>;
}

export type { ModelCapabilities };
