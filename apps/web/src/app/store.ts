/**
 * The client office store.
 *
 * One class owns every piece of state the console renders. It is a pure
 * reducer over `ServerEvent`: the WebSocket hands it frames, it produces the
 * next immutable snapshot, and React subscribes to just the slices a panel
 * needs.
 *
 * Why slices instead of one big object: a run streams dozens of
 * `turn.delta`/`reasoning` frames per second. With slice-scoped
 * `useSyncExternalStore` subscriptions those frames only re-render the panels
 * that read streamed text - the org chart, the approvals queue and the run list
 * are untouched, so the console stays smooth while text pours in.
 *
 * Every one of the wire protocol's event variants is handled here. Anything
 * unrecognised is ignored without throwing, and every event is counted so the
 * header can prove the socket is alive.
 */

import type {
  Approval,
  Artifact,
  ClientCommand,
  ClientOfficeStore,
  DirectMessage,
  EmployeeState,
  OfficeState,
  OrgChart,
  Run,
  RunStatus,
  RouteDecision,
  ServerEvent,
  SkillSummary,
  StageRun,
  ToolCallRecord,
  TurnRecord,
} from '@dev3d/core';
import { toEmployeeState } from '@dev3d/core';

import { formatDuration, formatPercent, formatUsd, truncate } from './format.ts';

// --------------------------------------------------------------------- shapes

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ConnectionState {
  status: ConnectionStatus;
  attempt: number;
  error: string | null;
  since: number;
  /** True once a `hello` has been applied, i.e. the office state is server truth. */
  hello: boolean;
  /** Server events applied since mount. */
  events: number;
  lastEventAt: number | null;
}

export type NoticeLevel = 'info' | 'warn' | 'error';

export interface Notice {
  id: string;
  level: NoticeLevel;
  text: string;
  at: number;
}

export interface FeedItem {
  id: string;
  kind: string;
  text: string;
  at: number;
  employeeId?: string;
  runId?: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
}

export interface SelectionState {
  employeeId: string | null;
  runId: string | null;
}

export interface SkillsState {
  skills: SkillSummary[] | null;
  loading: boolean;
  error: string | null;
}

/** turnId -> TurnRecord, per run. Runs carry turn *ids*; the turns arrive live. */
export type TurnIndex = Record<string, Record<string, TurnRecord>>;

/**
 * One planning turn that has come back from the orchestrator.
 *
 * `requestId` is what the console sent, so it can match the answer to the turn
 * that asked for it rather than to whatever arrived most recently.
 */
export interface PlanReply {
  requestId: string | null;
  employeeId: string;
  text: string;
  route: DirectMessage['route'];
  at: number;
}

export interface RunDetailPayload {
  run: Run;
  turns?: TurnRecord[];
  artifacts?: Artifact[];
}

export type Slice =
  | 'connection'
  | 'office'
  | 'streaming'
  | 'reasoning'
  | 'feed'
  | 'approvals'
  | 'selection'
  | 'artifacts'
  | 'turns'
  | 'skills'
  | 'messages'
  | 'plans'
  | 'notices';

// --------------------------------------------------------------------- limits

const MAX_FEED = 500;
const MAX_NOTICES = 6;
const FEED_TEXT_LIMIT = 420;
const MAX_MESSAGES_PER_EMPLOYEE = 200;
/** Plan turns kept for consumption. A reply is taken once and then dropped. */
const MAX_PLAN_REPLIES = 24;

const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['queued', 'running', 'awaiting-approval', 'paused']);

// ------------------------------------------------------------------- helpers

function upsertById<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

function findById<T extends { id: string }>(list: readonly T[], id: string): T | undefined {
  return list.find((entry) => entry.id === id);
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next: Record<string, T> = {};
  for (const existing of Object.keys(record)) {
    if (existing === key) continue;
    const value = record[existing];
    if (value !== undefined) next[existing] = value;
  }
  return next;
}

function withActiveRun(activeRunIds: readonly string[], run: Run): string[] {
  const isActive = ACTIVE_RUN_STATUSES.has(run.status);
  const present = activeRunIds.includes(run.id);
  if (isActive && !present) return [...activeRunIds, run.id];
  if (!isActive && present) return activeRunIds.filter((id) => id !== run.id);
  return activeRunIds.slice();
}

function sortApprovals(list: readonly Approval[]): Approval[] {
  return list.slice().sort((a, b) => {
    const aPending = a.status === 'pending' ? 0 : 1;
    const bPending = b.status === 'pending' ? 0 : 1;
    if (aPending !== bPending) return aPending - bPending;
    const aAt = a.status === 'pending' ? a.requestedAt : a.decidedAt ?? a.requestedAt;
    const bAt = b.status === 'pending' ? b.requestedAt : b.decidedAt ?? b.requestedAt;
    return bAt - aAt;
  });
}

function defaultAppearance(): { bodyColor: string; accentColor: string; height: number } {
  return { bodyColor: '#94a3b8', accentColor: '#334155', height: 1 };
}

function mergeToolCalls(existing: readonly ToolCallRecord[], incoming: readonly ToolCallRecord[]): ToolCallRecord[] {
  if (existing.length === 0) return [...incoming];
  if (incoming.length === 0) return [...existing];
  let merged = existing.slice();
  for (const call of incoming) merged = upsertById(merged, call);
  return merged;
}

/**
 * Merges an exchange into a thread.
 *
 * Threading by message id is what keeps a re-delivered frame from doubling up,
 * but it is *not* enough on its own, because an optimistic echo and the server's
 * copy of that same message carry different ids by construction - the echo is
 * `local-<at>` and the server mints its own. Ids alone therefore leave the
 * operator's own message sitting in the thread twice, which reads as the console
 * having sent it twice. So a server copy of a user message reconciles against a
 * pending local echo by content and time, and the echo is replaced.
 *
 * The window is small on purpose: it is matched against the *pending* echo, not
 * against every message ever sent, so two deliberately identical messages an
 * hour apart are still two messages.
 */
const ECHO_WINDOW_MS = 120_000;

function reconcileEchoes(
  thread: readonly DirectMessage[],
  incoming: readonly DirectMessage[],
): { thread: DirectMessage[]; incoming: DirectMessage[] } {
  if (thread.length === 0 || incoming.length === 0) return { thread: [...thread], incoming: [...incoming] };
  const superseded = new Set<string>();

  for (const message of incoming) {
    if (message.role !== 'user') continue;
    const echo = thread.find(
      (candidate) =>
        candidate.id.startsWith('local-') &&
        candidate.role === 'user' &&
        candidate.text === message.text &&
        Math.abs(candidate.at - message.at) <= ECHO_WINDOW_MS,
    );
    // Keep the echo and drop the server's copy of it. The thread is returned
    // untouched on purpose: removing the echo here and re-adding it from the map
    // would move it to the server's timestamp, and the whole point of an
    // optimistic echo is that it stays exactly where the operator saw it appear.
    if (echo) superseded.add(message.id);
  }

  return {
    thread: [...thread],
    incoming: superseded.size === 0 ? [...incoming] : incoming.filter((message) => !superseded.has(message.id)),
  };
}

function mergeMessages(thread: readonly DirectMessage[], incoming: readonly DirectMessage[]): DirectMessage[] {
  const merged = reconcileEchoes(thread, incoming);
  const byId = new Map<string, DirectMessage>();
  for (const message of merged.thread) byId.set(message.id, message);
  for (const message of merged.incoming) {
    if (typeof message.id !== 'string' || message.id.length === 0) continue;
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.at - b.at).slice(-MAX_MESSAGES_PER_EMPLOYEE);
}

// --------------------------------------------------------------------- store

export class OfficeStore implements ClientOfficeStore {
  private connection: ConnectionState = {
    status: 'idle',
    attempt: 0,
    error: null,
    since: Date.now(),
    hello: false,
    events: 0,
    lastEventAt: null,
  };
  private officeState: OfficeState | null = null;
  private streamingByTurn: Record<string, string> = {};
  private reasoningByTurn: Record<string, string> = {};
  private feedItems: FeedItem[] = [];
  private approvalList: Approval[] = [];
  private sel: SelectionState = { employeeId: null, runId: null };
  private artifactsByRun: Record<string, Artifact[]> = {};
  private turnsByRun: TurnIndex = {};
  private skillsState: SkillsState = { skills: null, loading: false, error: null };
  private messagesByEmployee: Record<string, DirectMessage[]> = {};
  private planReplyQueue: PlanReply[] = [];
  private noticeList: Notice[] = [];

  private readonly listeners: Record<Slice, Set<() => void>> = {
    connection: new Set(),
    office: new Set(),
    streaming: new Set(),
    reasoning: new Set(),
    feed: new Set(),
    approvals: new Set(),
    selection: new Set(),
    artifacts: new Set(),
    turns: new Set(),
    skills: new Set(),
    messages: new Set(),
    plans: new Set(),
    notices: new Set(),
  };

  private transport: ((command: ClientCommand) => void) | null = null;
  private detailLoader: ((runId: string) => Promise<RunDetailPayload | null>) | null = null;
  private readonly detailRequests = new Set<string>();
  private feedSeq = 0;
  private noticeSeq = 0;

  // -------------------------------------------------- ClientOfficeStore surface

  get connected(): boolean {
    return this.connection.status === 'open';
  }

  get state(): OfficeState | null {
    return this.officeState;
  }

  get streaming(): Record<string, string> {
    return this.streamingByTurn;
  }

  get feed(): FeedItem[] {
    return this.feedItems;
  }

  get approvals(): Approval[] {
    return this.approvalList;
  }

  get selectedEmployeeId(): string | null {
    return this.sel.employeeId;
  }

  get selectedRunId(): string | null {
    return this.sel.runId;
  }

  /** Direct conversations, keyed by employeeId. Fed by `direct.message`. */
  get directMessages(): Record<string, DirectMessage[]> {
    return this.messagesByEmployee;
  }

  /**
   * Planning turns that have come back and not yet been taken.
   *
   * The plan itself belongs to the console that is holding the conversation, so
   * the store is only a mailbox between the socket and that surface - it does
   * not keep the transcript.
   */
  get planReplies(): PlanReply[] {
    return this.planReplyQueue;
  }

  // -------------------------------------------------------- bound subscription

  subscribeConnection = (listener: () => void): (() => void) => this.subscribe('connection', listener);
  subscribeOffice = (listener: () => void): (() => void) => this.subscribe('office', listener);
  subscribeStreaming = (listener: () => void): (() => void) => this.subscribe('streaming', listener);
  subscribeReasoning = (listener: () => void): (() => void) => this.subscribe('reasoning', listener);
  subscribeFeed = (listener: () => void): (() => void) => this.subscribe('feed', listener);
  subscribeApprovals = (listener: () => void): (() => void) => this.subscribe('approvals', listener);
  subscribeSelection = (listener: () => void): (() => void) => this.subscribe('selection', listener);
  subscribeArtifacts = (listener: () => void): (() => void) => this.subscribe('artifacts', listener);
  subscribeTurns = (listener: () => void): (() => void) => this.subscribe('turns', listener);
  subscribeSkills = (listener: () => void): (() => void) => this.subscribe('skills', listener);
  subscribeMessages = (listener: () => void): (() => void) => this.subscribe('messages', listener);
  subscribePlans = (listener: () => void): (() => void) => this.subscribe('plans', listener);
  subscribeNotices = (listener: () => void): (() => void) => this.subscribe('notices', listener);

  getConnection = (): ConnectionState => this.connection;
  getOffice = (): OfficeState | null => this.officeState;
  getStreaming = (): Record<string, string> => this.streamingByTurn;
  getReasoning = (): Record<string, string> => this.reasoningByTurn;
  getFeed = (): FeedItem[] => this.feedItems;
  getApprovals = (): Approval[] => this.approvalList;
  getSelection = (): SelectionState => this.sel;
  getArtifacts = (): Record<string, Artifact[]> => this.artifactsByRun;
  getTurns = (): TurnIndex => this.turnsByRun;
  getSkills = (): SkillsState => this.skillsState;
  getMessages = (): Record<string, DirectMessage[]> => this.messagesByEmployee;
  getPlans = (): PlanReply[] => this.planReplyQueue;
  getNotices = (): Notice[] => this.noticeList;

  // ------------------------------------------------------------------ plumbing

  private subscribe(slice: Slice, listener: () => void): () => void {
    const set = this.listeners[slice];
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  private emit(...slices: Slice[]): void {
    for (const slice of slices) {
      for (const listener of this.listeners[slice]) listener();
    }
  }

  /** Wires the socket (or anything else) as the outbound command channel. */
  attachTransport(transport: ((command: ClientCommand) => void) | null): void {
    this.transport = transport;
  }

  /** Wires the HTTP run-detail fetcher used to backfill historical turns. */
  attachDetailLoader(loader: ((runId: string) => Promise<RunDetailPayload | null>) | null): void {
    this.detailLoader = loader;
  }

  send(command: ClientCommand): boolean {
    if (!this.transport) {
      this.notify('warn', `not connected - "${command.type}" was not sent`);
      return false;
    }
    this.transport(command);
    return true;
  }

  hasHello(): boolean {
    return this.connection.hello;
  }

  setConnectionStatus(status: ConnectionStatus, attempt: number, error: string | null, at = Date.now()): void {
    const next: ConnectionState = {
      ...this.connection,
      status,
      attempt,
      error,
      since: this.connection.status === status ? this.connection.since : at,
    };
    if (
      next.status === this.connection.status &&
      next.attempt === this.connection.attempt &&
      next.error === this.connection.error
    ) {
      return;
    }
    this.connection = next;
    this.emit('connection');
  }

  // ------------------------------------------------------------- selections

  /** Bound so panels can pass it straight to `onClick`/`onSelect` props. */
  selectEmployee = (employeeId: string | null): void => {
    if (this.sel.employeeId === employeeId) return;
    this.sel = { ...this.sel, employeeId };
    this.emit('selection');
  };

  /** Selecting a run also opens its transcript: `loadRun` plus an HTTP backfill. */
  selectRun = (runId: string | null): void => {
    if (this.sel.runId !== runId) {
      this.sel = { ...this.sel, runId };
      this.emit('selection');
    }
    if (runId) {
      this.send({ type: 'loadRun', runId });
      this.ensureRunDetail(runId);
    }
  };

  // -------------------------------------------------------------- skills/misc

  setSkillsLoading(): void {
    this.skillsState = { ...this.skillsState, loading: true, error: null };
    this.emit('skills');
  }

  setSkills(skills: SkillSummary[]): void {
    this.skillsState = { skills, loading: false, error: null };
    this.emit('skills');
  }

  setSkillsError(error: string): void {
    this.skillsState = { skills: null, loading: false, error };
    this.emit('skills');
  }

  notify(level: NoticeLevel, text: string): void {
    if (text.length === 0) return;
    const existing = this.noticeList.find((notice) => notice.text === text);
    if (existing) return;
    this.noticeSeq += 1;
    const notice: Notice = { id: `n${this.noticeSeq}`, level, text, at: Date.now() };
    this.noticeList = [notice, ...this.noticeList].slice(0, MAX_NOTICES);
    this.emit('notices');
  }

  dismissNotice(id: string): void {
    const next = this.noticeList.filter((notice) => notice.id !== id);
    if (next.length === this.noticeList.length) return;
    this.noticeList = next;
    this.emit('notices');
  }

  /**
   * Adds one message locally (the optimistic echo of a chat the user sent).
   *
   * This is an *append*, not a merge, and it has to stay one. `mergeMessages`
   * assumes the incoming copy is the server's and drops an echo it recognises,
   * which is exactly right when a delivered batch arrives and exactly wrong
   * here - feeding the echo through it drops the echo itself, and the operator's
   * message disappears from the thread until the server confirms it.
   */
  appendDirectMessage(message: DirectMessage): void {
    const thread = this.messagesByEmployee[message.employeeId] ?? [];
    const existing = thread.findIndex((candidate) => candidate.id === message.id);
    const next = existing === -1 ? [...thread, message] : thread.map((c, i) => (i === existing ? message : c));
    this.messagesByEmployee = {
      ...this.messagesByEmployee,
      [message.employeeId]: next.sort((a, b) => a.at - b.at).slice(-MAX_MESSAGES_PER_EMPLOYEE),
    };
    this.emit('messages');
  }

  // ----------------------------------------------------- cold-start backfills

  /** Used by the `/api/state` fallback before the socket delivers `hello`. */
  applyColdState(state: OfficeState, note: string | null): void {
    if (this.officeState !== null || this.connection.hello) return;
    this.adoptState(state);
    if (note) this.notify('info', note);
  }

  /** Used by the `/api/runs/:id` backfill: historical turns plus artifacts. */
  ingestRunDetail(payload: RunDetailPayload): void {
    this.mergeRun(payload.run);
    if (payload.turns && payload.turns.length > 0) {
      const existing = this.turnsByRun[payload.run.id] ?? {};
      const merged: Record<string, TurnRecord> = { ...existing };
      for (const turn of payload.turns) merged[turn.id] = turn;
      this.turnsByRun = { ...this.turnsByRun, [payload.run.id]: merged };
      this.emit('turns');
    }
    if (payload.artifacts && payload.artifacts.length > 0) {
      let list = this.artifactsByRun[payload.run.id] ?? [];
      for (const artifact of payload.artifacts) list = upsertById(list, artifact);
      this.artifactsByRun = { ...this.artifactsByRun, [payload.run.id]: list };
      this.emit('artifacts');
    }
  }

  private ensureRunDetail(runId: string): void {
    const known = this.turnsByRun[runId];
    if (known && Object.keys(known).length > 0) return;
    if (this.detailRequests.has(runId)) return;
    const loader = this.detailLoader;
    if (!loader) return;
    this.detailRequests.add(runId);
    void loader(runId)
      .then((payload) => {
        if (payload) this.ingestRunDetail(payload);
      })
      .catch(() => {
        /* backfill is best-effort; the live socket remains authoritative */
      })
      .finally(() => {
        this.detailRequests.delete(runId);
      });
  }

  // ---------------------------------------------------------------- dispatch

  /** Applies one server event. Never throws; unknown variants are ignored. */
  apply(event: ServerEvent): void {
    this.connection = {
      ...this.connection,
      events: this.connection.events + 1,
      lastEventAt: event.at,
    };
    this.emit('connection');

    switch (event.type) {
      case 'hello':
        this.handleHello(event.state, event.at);
        break;
      case 'office.updated':
        this.adoptState(event.state);
        this.pushFeed({ kind: 'lifecycle', text: 'office state replaced by a full server snapshot', at: event.at });
        break;
      case 'org.updated':
        this.handleOrgUpdated(event.workspaceId, event.org, event.at);
        break;
      case 'settings.updated':
        this.handleSettingsUpdated(event.settings, event.at);
        break;
      case 'plugins.updated':
        this.handlePluginsUpdated(event.state, event.at);
        break;
      case 'run.created':
        this.handleRunCreated(event.run, event.at);
        break;
      case 'run.updated':
        this.handleRunUpdated(event.run, event.at);
        break;
      case 'stage.started':
      case 'stage.finished':
        this.handleStage(event.runId, event.stage, event.at);
        break;
      case 'turn.started':
        this.handleTurnStarted(event.turn, event.at);
        break;
      case 'turn.delta':
        this.streamingByTurn = {
          ...this.streamingByTurn,
          [event.turnId]: (this.streamingByTurn[event.turnId] ?? '') + event.text,
        };
        this.emit('streaming');
        break;
      case 'turn.reasoning':
        this.reasoningByTurn = {
          ...this.reasoningByTurn,
          [event.turnId]: (this.reasoningByTurn[event.turnId] ?? '') + event.text,
        };
        this.emit('reasoning');
        break;
      case 'turn.finished':
        this.handleTurnFinished(event.turn, event.at);
        break;
      case 'employee.updated':
        this.handleEmployeeUpdated(event.employee);
        break;
      case 'employee.moved':
        this.handleEmployeeMoved(event.employeeId, event.fromSeatId, event.toSeatId, event.toRoomId, event.at);
        break;
      case 'speech':
        this.handleSpeech(event);
        break;
      case 'tool.result':
        this.handleToolResult(event.runId, event.turnId, event.call, event.at);
        break;
      case 'artifact.created':
        this.handleArtifact(event.artifact, event.at);
        break;
      case 'approval.requested':
        this.handleApproval(event.approval, false, event.at);
        break;
      case 'approval.decided':
        this.handleApproval(event.approval, true, event.at);
        break;
      case 'direct.message':
        this.handleDirectMessage(event.employeeId, event.messages, event.at);
        break;
      case 'plan.reply':
        this.handlePlanReply(event.requestId, event.employeeId, event.text, event.at);
        break;
      case 'budget.updated':
        this.handleBudget(event.runId, event.limitUsd, event.spentUsd, event.at);
        break;
      case 'routing.decision':
        this.handleRouting(event.runId, event.turnId, event.route, event.at);
        break;
      case 'usage':
        this.handleUsage(event.employeeId, event.lifetime);
        break;
      case 'log':
        this.pushFeed({
          kind: 'log',
          level: event.level,
          text: `[${event.scope}] ${truncate(event.message, FEED_TEXT_LIMIT)}`,
          at: event.at,
        });
        break;
      case 'error':
        this.pushFeed({ kind: 'error', level: 'error', text: truncate(event.message, FEED_TEXT_LIMIT), at: event.at, ...(event.runId ? { runId: event.runId } : {}) });
        this.notify('error', truncate(event.message, 240));
        break;
      default: {
        // Compile-time exhaustiveness: if a future `ServerEvent` variant is not
        // handled above, `event` is no longer `never` here and this line fails
        // the typecheck. At runtime an unknown frame is simply ignored.
        const exhaustive: never = event;
        void exhaustive;
        const unknown = event as { type?: unknown };
        this.pushFeed({
          kind: 'unknown',
          level: 'debug',
          text: `ignored unknown event "${String(unknown.type ?? '?')}"`,
          at: Date.now(),
        });
        break;
      }
    }
  }

  // ----------------------------------------------------------- event handlers

  private handleHello(state: OfficeState, at: number): void {
    this.adoptState(state);
    // A fresh hello is a new session's truth: drop streamed text and any turn
    // or artifact history for runs the server no longer knows about.
    this.streamingByTurn = {};
    this.reasoningByTurn = {};
    const runIds = new Set(state.runs.map((run) => run.id));
    this.turnsByRun = pruneRecord(this.turnsByRun, runIds);
    this.artifactsByRun = pruneRecord(this.artifactsByRun, runIds);
    this.emit('streaming', 'reasoning', 'turns', 'artifacts');

    this.connection = { ...this.connection, hello: true, status: 'open', attempt: 0, error: null };
    this.emit('connection');
    this.pushFeed({
      kind: 'lifecycle',
      text: `connected · ${state.company.name} · ${state.roles.length} roles · llmMode=${state.llmMode} · posture=${state.routingPosture}`,
      at,
    });
  }

  private handleOrgUpdated(workspaceId: string, org: OrgChart, at: number): void {
    const state = this.officeState;
    if (!state) return;
    // An organisation on another floor is not what this console is showing; the
    // `office.updated` that follows carries the building-wide list.
    if (workspaceId !== state.activeWorkspaceId) return;

    const roleIds = new Set(org.roles.map((role) => role.id));
    const employees: EmployeeState[] = org.roles.map((role) => {
      const existing = state.employees.find((employee) => employee.roleId === role.id);
      if (!existing) return toEmployeeState(role, workspaceId);
      return {
        ...existing,
        roleId: role.id,
        displayName: role.displayName,
        title: role.title,
        departmentId: role.departmentId,
        seatId: existing.seatId ?? role.seatId,
        roomId: existing.roomId ?? role.roomId,
      };
    });

    // Anyone whose role is gone goes to the bench rather than vanishing: their
    // avatar stays in the office, greyed out and unseated.
    for (const employee of state.employees) {
      if (roleIds.has(employee.roleId)) continue;
      employees.push({
        ...employee,
        status: 'offline',
        seatId: null,
        roomId: null,
        activity: 'not in the current org',
        currentRunId: null,
        currentTurnId: null,
        activeSkillIds: [],
      });
    }

    this.setOffice({
      ...state,
      company: org.company,
      departments: org.departments,
      roles: org.roles,
      employees,
      routingPosture: org.routingPosture ?? state.routingPosture,
    });
    this.pushFeed({
      kind: 'org',
      text: `org chart updated · ${org.roles.length} roles · ${org.departments.length} departments`,
      at,
    });
  }

  private handleSettingsUpdated(settings: OfficeState['settings'], at: number): void {
    const state = this.officeState;
    if (!state) return;
    this.setOffice({ ...state, settings });
    this.pushFeed({ kind: 'org', text: 'office settings updated', at });
  }

  /**
   * The plugin system's whole state, replaced wholesale. Enabling, disabling,
   * configuring, installing and removing all land here, so a panel never has to
   * guess what an action did - it reads the server's answer.
   */
  private handlePluginsUpdated(plugins: OfficeState['plugins'], at: number): void {
    const state = this.officeState;
    if (!state) return;
    this.setOffice({ ...state, plugins });
    const errored = plugins.records.filter((record) => record.status === 'error').length;
    const loaded = plugins.records.filter((record) => record.status === 'loaded').length;
    this.pushFeed({
      kind: 'lifecycle',
      level: errored > 0 ? 'warn' : 'info',
      text: `plugins updated · ${loaded} loaded · ${plugins.records.length} installed${
        errored > 0 ? ` · ${errored} errored` : ''
      }`,
      at,
    });
  }

  private handleRunCreated(run: Run, at: number): void {
    const state = this.officeState;
    if (!state) return;
    this.setOffice({
      ...state,
      runs: upsertById(state.runs, run),
      activeRunIds: withActiveRun(state.activeRunIds, run),
    });
    this.pushFeed({ kind: 'run', text: `run created · ${truncate(run.brief, 160)}`, at, runId: run.id });
    if (this.sel.runId === null) this.selectRun(run.id);
  }

  private handleRunUpdated(run: Run, at: number): void {
    const state = this.officeState;
    if (!state) return;
    const previous = findById(state.runs, run.id);
    this.setOffice({
      ...state,
      runs: upsertById(state.runs, run),
      activeRunIds: withActiveRun(state.activeRunIds, run),
    });
    if (previous && previous.status !== run.status) {
      this.pushFeed({
        kind: 'run',
        level: run.status === 'failed' ? 'error' : 'info',
        text: `run ${run.status}${run.error ? ` · ${truncate(run.error, 160)}` : ''}`,
        at,
        runId: run.id,
      });
    }
  }

  private handleStage(runId: string, stage: StageRun, at: number): void {
    const state = this.officeState;
    if (!state) return;
    const run = findById(state.runs, runId);
    if (!run) return;
    const updated: Run = { ...run, stages: upsertById(run.stages, stage), updatedAt: Math.max(run.updatedAt, at) };
    this.setOffice({ ...state, runs: upsertById(state.runs, updated), activeRunIds: withActiveRun(state.activeRunIds, updated) });
    this.pushFeed({
      kind: 'stage',
      text: `${stage.spec.name} ${stage.status}${stage.error ? ` · ${truncate(stage.error, 140)}` : ''}`,
      at,
      runId,
    });
  }

  private handleTurnStarted(turn: TurnRecord, at: number): void {
    const forRun = this.turnsByRun[turn.runId] ?? {};
    this.turnsByRun = { ...this.turnsByRun, [turn.runId]: { ...forRun, [turn.id]: turn } };
    this.emit('turns');

    this.updateRun(turn.runId, (run) => ({
      ...run,
      stages: run.stages.map((stage) =>
        stage.id === turn.stageId && !stage.turnIds.includes(turn.id)
          ? { ...stage, turnIds: [...stage.turnIds, turn.id] }
          : stage,
      ),
    }));

    this.pushFeed({
      kind: 'turn',
      text: `${this.employeeName(turn.employeeId)} · ${turn.purpose} · ${turn.route.modelId} (${turn.route.tier})`,
      at,
      employeeId: turn.employeeId,
      runId: turn.runId,
    });
  }

  private handleTurnFinished(turn: TurnRecord, at: number): void {
    const forRun = this.turnsByRun[turn.runId] ?? {};
    const previous = forRun[turn.id];
    const streamedText = this.streamingByTurn[turn.id] ?? '';
    const streamedReasoning = this.reasoningByTurn[turn.id] ?? '';
    // The closing record is authoritative, but a terse server may omit fields we
    // already streamed. Keep whatever arrived, preferring the final values.
    const merged: TurnRecord = {
      ...turn,
      text: turn.text && turn.text.length > 0 ? turn.text : streamedText.length > 0 ? streamedText : previous?.text ?? '',
      reasoning:
        turn.reasoning && turn.reasoning.length > 0
          ? turn.reasoning
          : streamedReasoning.length > 0
            ? streamedReasoning
            : previous?.reasoning ?? null,
      toolCalls: mergeToolCalls(previous?.toolCalls ?? [], turn.toolCalls),
      wroteFiles: turn.wroteFiles.length > 0 ? turn.wroteFiles : previous?.wroteFiles ?? [],
      skills: turn.skills.length > 0 ? turn.skills : previous?.skills ?? [],
    };

    this.turnsByRun = { ...this.turnsByRun, [turn.runId]: { ...forRun, [turn.id]: merged } };
    this.streamingByTurn = omitKey(this.streamingByTurn, turn.id);
    this.reasoningByTurn = omitKey(this.reasoningByTurn, turn.id);
    this.emit('turns', 'streaming', 'reasoning');

    this.pushFeed({
      kind: 'turn',
      level: turn.status === 'failed' ? 'error' : 'info',
      text: `${this.employeeName(turn.employeeId)} finished · ${formatDuration(
        (turn.endedAt ?? at) - turn.startedAt,
      )} · ${turn.usage.tokensIn + turn.usage.tokensOut} tok · ${formatUsd(turn.usage.costUsd)}${
        turn.error ? ` · ${truncate(turn.error, 140)}` : ''
      }`,
      at,
      employeeId: turn.employeeId,
      runId: turn.runId,
    });
  }

  private handleEmployeeUpdated(employee: EmployeeState): void {
    const state = this.officeState;
    if (!state) return;
    this.setOffice({ ...state, employees: upsertById(state.employees, employee) });
  }

  private handleEmployeeMoved(
    employeeId: string,
    fromSeatId: string | null,
    toSeatId: string | null,
    toRoomId: string | null,
    at: number,
  ): void {
    const state = this.officeState;
    if (!state) return;
    const employee = findById(state.employees, employeeId);
    if (!employee) return;
    const next: EmployeeState = {
      ...employee,
      seatId: toSeatId,
      roomId: toRoomId ?? employee.roomId,
    };
    this.setOffice({ ...state, employees: upsertById(state.employees, next) });
    this.pushFeed({
      kind: 'move',
      text: `${employee.displayName} moved ${fromSeatId ?? 'bench'} → ${toSeatId ?? 'bench'}${
        toRoomId ? ` (${toRoomId.replace('Anchor_Room_', '')})` : ''
      }`,
      at,
      employeeId,
    });
  }

  private handleSpeech(event: Extract<ServerEvent, { type: 'speech' }>): void {
    const from = this.employeeName(event.fromEmployeeId);
    const to = event.toEmployeeIds.map((id) => this.employeeName(id)).join(', ') || 'the room';
    this.pushFeed({
      kind: `speech.${event.kind}`,
      text: `${from} → ${to}: ${truncate(event.text.replace(/\s+/g, ' ').trim(), FEED_TEXT_LIMIT)}`,
      at: event.at,
      employeeId: event.fromEmployeeId,
      runId: event.runId,
    });
  }

  /**
   * The reply to a `chat` command: a direct conversation has no run, stage or
   * turn, so the exchange arrives whole and lands in a per-employee thread.
   */
  private handleDirectMessage(employeeId: string, messages: DirectMessage[], at: number): void {
    if (messages.length === 0) return;
    const reply = [...messages].reverse().find((message) => message.role === 'employee');
    this.ingestDirectMessages(employeeId, messages);
    if (reply) {
      this.pushFeed({
        kind: 'direct',
        text: `${this.employeeName(employeeId)} → you: ${truncate(reply.text.replace(/\s+/g, ' ').trim(), FEED_TEXT_LIMIT)}${
          reply.route ? ` · ${reply.route.modelId} (${reply.route.tier})` : ''
        }`,
        at,
        employeeId,
      });
    }
  }

  /** Merges an exchange into a thread. Used by `direct.message` and the HTTP fallback. */
  ingestDirectMessages(employeeId: string, messages: readonly DirectMessage[]): void {
    if (messages.length === 0) return;
    const thread = this.messagesByEmployee[employeeId] ?? [];
    this.messagesByEmployee = { ...this.messagesByEmployee, [employeeId]: mergeMessages(thread, messages) };
    this.emit('messages');
  }

  /**
   * One planning turn arrived. It is queued rather than applied, because only
   * the surface holding that conversation knows which session and which turn it
   * belongs to - the store is a mailbox here, not the owner.
   */
  private handlePlanReply(requestId: string | null, employeeId: string, text: string, at: number): void {
    this.planReplyQueue = [...this.planReplyQueue, { requestId, employeeId, text, route: undefined, at }].slice(
      -MAX_PLAN_REPLIES,
    );
    this.emit('plans');
  }

  /** Takes a queued reply, removing it. A reply is consumed exactly once. */
  takePlanReply(requestId: string): PlanReply | null {
    const found = this.planReplyQueue.find((reply) => reply.requestId === requestId);
    if (!found) return null;
    this.planReplyQueue = this.planReplyQueue.filter((reply) => reply !== found);
    this.emit('plans');
    return found;
  }

  private handleToolResult(runId: string, turnId: string, call: ToolCallRecord, at: number): void {
    const forRun = this.turnsByRun[runId];
    const turn = forRun?.[turnId];
    if (forRun && turn) {
      const updated: TurnRecord = { ...turn, toolCalls: upsertById(turn.toolCalls, call) };
      this.turnsByRun = { ...this.turnsByRun, [runId]: { ...forRun, [turnId]: updated } };
      this.emit('turns');
    }
    const paths = call.affectsPaths.length > 0 ? ` · ${call.affectsPaths.length} file${call.affectsPaths.length === 1 ? '' : 's'}` : '';
    this.pushFeed({
      kind: 'tool',
      level: call.status === 'error' || call.status === 'denied' ? 'warn' : 'info',
      text: `${call.name} ${call.status} · ${formatDuration(call.durationMs)}${paths}${call.resultPreview ? ` · ${truncate(call.resultPreview.replace(/\s+/g, ' '), 200)}` : ''}`,
      at,
      runId,
    });
  }

  private handleArtifact(artifact: Artifact, at: number): void {
    const list = this.artifactsByRun[artifact.runId] ?? [];
    this.artifactsByRun = { ...this.artifactsByRun, [artifact.runId]: upsertById(list, artifact) };
    this.emit('artifacts');

    if (artifact.stageId) {
      this.updateRun(artifact.runId, (run) => ({
        ...run,
        stages: run.stages.map((stage) =>
          stage.id === artifact.stageId && !stage.artifactIds.includes(artifact.id)
            ? { ...stage, artifactIds: [...stage.artifactIds, artifact.id] }
            : stage,
        ),
      }));
    }

    this.pushFeed({
      kind: 'artifact',
      text: `${artifact.kind} · ${artifact.title}${artifact.path ? ` · ${artifact.path}` : ''}`,
      at,
      runId: artifact.runId,
      ...(artifact.employeeId ? { employeeId: artifact.employeeId } : {}),
    });
  }

  private handleApproval(approval: Approval, decided: boolean, at: number): void {
    this.approvalList = sortApprovals(upsertById(this.approvalList, approval));
    this.emit('approvals');
    this.pushFeed({
      kind: 'approval',
      level: decided ? 'info' : 'warn',
      text: decided
        ? `approval ${approval.status} · ${approval.summary}`
        : `${approval.kind} approval needed · ${approval.summary}`,
      at,
      runId: approval.runId,
      employeeId: approval.employeeId,
    });
  }

  private handleBudget(runId: string, limitUsd: number, spentUsd: number, at: number): void {
    const state = this.officeState;
    if (!state) return;
    const run = findById(state.runs, runId);
    if (!run) return;
    const before = run.budget.limitUsd > 0 ? run.budget.spentUsd / run.budget.limitUsd : 0;
    const after = limitUsd > 0 ? spentUsd / limitUsd : 0;
    const updated: Run = { ...run, budget: { limitUsd, spentUsd }, updatedAt: Math.max(run.updatedAt, at) };
    this.setOffice({ ...state, runs: upsertById(state.runs, updated) });
    if (after >= 0.9 && before < 0.9) {
      this.notify('warn', `run budget ${formatPercent(spentUsd, limitUsd)} used (${formatUsd(spentUsd)} of ${formatUsd(limitUsd)})`);
      this.pushFeed({
        kind: 'budget',
        level: 'warn',
        text: `budget at ${formatPercent(spentUsd, limitUsd)} · ${formatUsd(spentUsd)} / ${formatUsd(limitUsd)}`,
        at,
        runId,
      });
    }
  }

  private handleRouting(runId: string, turnId: string, route: RouteDecision, at: number): void {
    const forRun = this.turnsByRun[runId];
    const turn = forRun?.[turnId];
    if (forRun && turn) {
      const updated: TurnRecord = { ...turn, route };
      this.turnsByRun = { ...this.turnsByRun, [runId]: { ...forRun, [turnId]: updated } };
      this.emit('turns');
    }

    const employeeId = turn?.employeeId ?? this.officeState?.employees.find((employee) => employee.currentTurnId === turnId)?.id;
    if (employeeId) this.patchEmployee(employeeId, { lastRoute: { modelId: route.modelId, providerId: route.providerId, tier: route.tier, reason: route.reason, at } });

    this.pushFeed({
      kind: 'route',
      text: `${route.modelId} · ${route.tier} · ${route.taskClass} — ${truncate(route.reason, 180)}`,
      at,
      runId,
      ...(employeeId ? { employeeId } : {}),
    });
  }

  private handleUsage(employeeId: string, lifetime: EmployeeState['lifetime']): void {
    this.patchEmployee(employeeId, { lifetime });
  }

  // -------------------------------------------------------------- state utils

  private adoptState(state: OfficeState): void {
    const previousEmployee = this.sel.employeeId;
    const keepEmployee = previousEmployee && state.employees.some((employee) => employee.id === previousEmployee) ? previousEmployee : null;
    const previousRun = this.sel.runId;
    const keepRun =
      previousRun && state.runs.some((run) => run.id === previousRun)
        ? previousRun
        : state.activeRunIds.find((id) => state.runs.some((run) => run.id === id)) ?? newestRunId(state.runs);
    this.officeState = state;
    this.sel = { employeeId: keepEmployee, runId: keepRun };
    this.emit('office', 'selection');
  }

  private setOffice(state: OfficeState): void {
    this.officeState = state;
    this.emit('office');
  }

  /** Upserts one run into the office state without a full snapshot replace. */
  private mergeRun(run: Run): void {
    const state = this.officeState;
    if (!state) return;
    this.setOffice({
      ...state,
      runs: upsertById(state.runs, run),
      activeRunIds: withActiveRun(state.activeRunIds, run),
    });
  }

  private updateRun(runId: string, mutate: (run: Run) => Run): void {
    const state = this.officeState;
    if (!state) return;
    const run = findById(state.runs, runId);
    if (!run) return;
    const next = mutate(run);
    this.setOffice({ ...state, runs: upsertById(state.runs, next), activeRunIds: withActiveRun(state.activeRunIds, next) });
  }

  /** Applies a shallow patch to one employee, keeping the snapshot immutable. */
  private patchEmployee(employeeId: string, patch: Partial<EmployeeState>): void {
    const state = this.officeState;
    if (!state) return;
    const employee = findById(state.employees, employeeId);
    if (!employee) return;
    this.setOffice({ ...state, employees: upsertById(state.employees, { ...employee, ...patch }) });
  }

  private employeeById(employeeId: string): EmployeeState | undefined {
    return this.officeState?.employees.find((employee) => employee.id === employeeId);
  }

  private employeeName(employeeId: string): string {
    const employee = this.employeeById(employeeId);
    if (employee) return employee.displayName;
    const role = this.officeState?.roles.find((candidate) => candidate.id === employeeId);
    return role ? role.displayName : employeeId;
  }

  private pushFeed(item: Omit<FeedItem, 'id'>): void {
    this.feedSeq += 1;
    const entry: FeedItem = { id: `f${this.feedSeq}`, ...item };
    this.feedItems = [entry, ...this.feedItems].slice(0, MAX_FEED);
    this.emit('feed');
  }
}

// ------------------------------------------------------------------ utilities

function newestRunId(runs: readonly Run[]): string | null {
  let best: Run | null = null;
  for (const run of runs) {
    if (!best || run.createdAt > best.createdAt) best = run;
  }
  return best ? best.id : null;
}

function pruneRecord<T>(record: Record<string, T>, keep: ReadonlySet<string>): Record<string, T> {
  let changed = false;
  const next: Record<string, T> = {};
  for (const key of Object.keys(record)) {
    if (keep.has(key)) {
      const value = record[key];
      if (value !== undefined) next[key] = value;
    } else {
      changed = true;
    }
  }
  return changed ? next : record;
}

/** The appearance an avatar falls back to when a role has vanished. */
export const FALLBACK_APPEARANCE = defaultAppearance();
