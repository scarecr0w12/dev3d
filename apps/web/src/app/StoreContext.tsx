/**
 * React bindings for the office store.
 *
 * `useSyncExternalStore` is wired once per slice, so a component only re-renders
 * for the part of the office it actually reads. Streaming text therefore cannot
 * cause the org chart or the approvals queue to re-render.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import type {
  Approval,
  Artifact,
  Department,
  DirectMessage,
  EmployeeState,
  OfficeState,
  PluginSystemState,
  Role,
  Run,
  StageRun,
  TurnRecord,
} from '@dev3d/core';

import { api } from './api';
import type { ConnectionState, FeedItem, Notice, PlanReply, SelectionState, SkillsState, TurnIndex } from './store';
import { OfficeStore } from './store';

const StoreContext = createContext<OfficeStore | null>(null);

export function StoreProvider({ store, children }: { store: OfficeStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): OfficeStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('dev3d office: the office store was used outside <StoreProvider>');
  return store;
}

export function useConnection(): ConnectionState {
  const store = useStore();
  return useSyncExternalStore(store.subscribeConnection, store.getConnection);
}

export function useOffice(): OfficeState | null {
  const store = useStore();
  return useSyncExternalStore(store.subscribeOffice, store.getOffice);
}

export function useStreaming(): Record<string, string> {
  const store = useStore();
  return useSyncExternalStore(store.subscribeStreaming, store.getStreaming);
}

export function useReasoning(): Record<string, string> {
  const store = useStore();
  return useSyncExternalStore(store.subscribeReasoning, store.getReasoning);
}

export function useFeed(): FeedItem[] {
  const store = useStore();
  return useSyncExternalStore(store.subscribeFeed, store.getFeed);
}

export function useApprovals(): Approval[] {
  const store = useStore();
  return useSyncExternalStore(store.subscribeApprovals, store.getApprovals);
}

export function useSelection(): SelectionState {
  const store = useStore();
  return useSyncExternalStore(store.subscribeSelection, store.getSelection);
}

export function useArtifacts(): Record<string, Artifact[]> {
  const store = useStore();
  return useSyncExternalStore(store.subscribeArtifacts, store.getArtifacts);
}

export function useTurns(): TurnIndex {
  const store = useStore();
  return useSyncExternalStore(store.subscribeTurns, store.getTurns);
}

export function useSkills(): SkillsState {
  const store = useStore();
  return useSyncExternalStore(store.subscribeSkills, store.getSkills);
}

// ------------------------------------------------------------------- plugins

export interface PluginsView {
  /** The server's plugin state, or null when it has never been seen. */
  state: PluginSystemState | null;
  loading: boolean;
  error: string | null;
  /** Where the state came from, so the page can say whether it is live. */
  origin: 'socket' | 'http' | null;
  /** Re-reads `GET /api/plugins`. The socket remains the primary source. */
  reload: () => void;
}

/**
 * The plugin system's state.
 *
 * `OfficeState.plugins` is the source of truth and arrives with `hello`,
 * `office.updated` and `plugins.updated`. The HTTP fallback exists for two
 * cases the socket cannot cover: a server build that does not carry the field
 * yet, and a socket that is down while the operator still wants to look. A
 * socket value always wins the moment it appears, so an action served over HTTP
 * is confirmed by the event rather than by optimistic guessing.
 */
export function usePlugins(): PluginsView {
  const office = useOffice();
  const fromSocket = office?.plugins ?? null;

  const [fetched, setFetched] = useState<PluginSystemState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((current) => current + 1), []);

  useEffect(() => {
    if (fromSocket !== null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.plugins().then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result.ok && result.data) {
        setFetched(result.data);
        setError(null);
        return;
      }
      setError(result.error ?? 'the request failed');
    });
    return () => {
      cancelled = true;
    };
  }, [fromSocket, nonce]);

  const state = fromSocket ?? fetched;
  return {
    state,
    loading: loading && state === null,
    // Only report a failure that left the page with nothing to show: when the
    // socket has delivered state, a failed fallback read is not the page's
    // problem, and a banner saying so would be noise.
    error: state === null ? error : null,
    origin: fromSocket !== null ? 'socket' : state !== null ? 'http' : null,
    reload,
  };
}

export function useMessages(): Record<string, DirectMessage[]> {
  const store = useStore();
  return useSyncExternalStore(store.subscribeMessages, store.getMessages);
}

/**
 * Planning turns that have arrived and not yet been consumed.
 *
 * A page holding a planning conversation watches this and takes the reply whose
 * `requestId` matches the turn it sent. The alternative - the store appending
 * straight into the transcript - would need the store to know which session the
 * turn belonged to, which is the page's business and not the office's.
 */
export function usePlanReplies(): PlanReply[] {
  const store = useStore();
  return useSyncExternalStore(store.subscribePlans, store.getPlans);
}

export function useNotices(): Notice[] {
  const store = useStore();
  return useSyncExternalStore(store.subscribeNotices, store.getNotices);
}

// ------------------------------------------------------------- derived slices

export interface EmployeeView {
  employee: EmployeeState | null;
  role: Role | null;
  department: Department | null;
}

export function useEmployeeView(employeeId: string | null): EmployeeView {
  const office = useOffice();
  return useMemo<EmployeeView>(() => {
    if (!office || !employeeId) return { employee: null, role: null, department: null };
    const employee = office.employees.find((candidate) => candidate.id === employeeId) ?? null;
    const roleId = employee ? employee.roleId : employeeId;
    const role = office.roles.find((candidate) => candidate.id === roleId) ?? null;
    const department = role ? office.departments.find((candidate) => candidate.id === role.departmentId) ?? null : null;
    return { employee, role, department };
  }, [office, employeeId]);
}

export function useSelectedEmployeeView(): EmployeeView {
  const selection = useSelection();
  return useEmployeeView(selection.employeeId);
}

export function useRun(runId: string | null): Run | null {
  const office = useOffice();
  return useMemo(() => {
    if (!office || !runId) return null;
    return office.runs.find((run) => run.id === runId) ?? null;
  }, [office, runId]);
}

export function useSelectedRun(): Run | null {
  const selection = useSelection();
  return useRun(selection.runId);
}

export interface RunTurns {
  /** turnId -> TurnRecord for one run. */
  byId: Record<string, TurnRecord>;
  /** Turns in stage order, using each stage's turnIds when it has them. */
  ordered: TurnRecord[];
}

export function useRunTurns(run: Run | null): RunTurns {
  const turns = useTurns();
  return useMemo<RunTurns>(() => {
    if (!run) return { byId: {}, ordered: [] };
    const byId = turns[run.id] ?? {};
    const ordered: TurnRecord[] = [];
    const seen = new Set<string>();
    for (const stage of run.stages) {
      for (const turnId of stage.turnIds) {
        const turn = byId[turnId];
        if (turn && !seen.has(turn.id)) {
          seen.add(turn.id);
          ordered.push(turn);
        }
      }
    }
    // Turns the run's stage index has not caught up with yet still belong on screen.
    for (const turn of Object.values(byId)) {
      if (!seen.has(turn.id)) {
        seen.add(turn.id);
        ordered.push(turn);
      }
    }
    ordered.sort((a, b) => a.startedAt - b.startedAt);
    return { byId, ordered };
  }, [run, turns]);
}

export interface StageTurns {
  stage: StageRun;
  turns: TurnRecord[];
}

export function useStageTurns(run: Run | null, runTurns: RunTurns): StageTurns[] {
  return useMemo(() => {
    if (!run) return [];
    return run.stages.map((stage) => ({
      stage,
      turns: stage.turnIds
        .map((turnId) => runTurns.byId[turnId])
        .filter((turn): turn is TurnRecord => turn !== undefined),
    }));
  }, [run, runTurns]);
}
