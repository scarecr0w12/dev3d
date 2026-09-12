/**
 * Plan sessions: the conversations you have *before* committing to work.
 *
 * A brief is a decision, and a decision made in one shot is usually a bad one.
 * This is the place to develop an idea first — the office's counterpart to a
 * chat window that ends in a Submit button rather than in a shrug.
 *
 * Sessions live in `localStorage` on purpose. They are drafts, not office
 * records: nothing here has been commissioned, so nothing here belongs in the
 * run history, and a refresh should not lose a conversation you are in the
 * middle of. Submitted briefs become runs, and those are the server's.
 */

import { useCallback, useMemo, useState } from 'react';

export interface PlanMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

export interface PlanSession {
  id: string;
  title: string;
  messages: PlanMessage[];
  /** The refined brief, as last drafted or edited. */
  draft: string;
  workspaceId: string;
  pipelineId: string;
  budgetUsd: string;
  createdAt: number;
  updatedAt: number;
}

export interface PlanStore {
  items: PlanSession[];
  activeId: string | null;
}

const STORAGE_KEY = 'dev3d.planSessions';

/** Messages kept per session. A plan is a conversation, not an archive. */
const MAX_MESSAGES = 60;
/** Characters kept per message, so one pasted wall of text cannot fill the quota. */
const MAX_MESSAGE_CHARS = 6000;
const MAX_SESSIONS = 30;

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function emptyStore(): PlanStore {
  return { items: [], activeId: null };
}

/** Trims a session to something that will still serialise in a year. */
function bound(session: PlanSession): PlanSession {
  return {
    ...session,
    draft: session.draft.slice(0, MAX_MESSAGE_CHARS),
    messages: session.messages.slice(-MAX_MESSAGES).map((message) => ({
      ...message,
      text: message.text.slice(0, MAX_MESSAGE_CHARS),
    })),
  };
}

/**
 * A tolerant reader. A stored document is user-writable data that has survived
 * an application upgrade, so anything unrecognisable is dropped rather than
 * allowed to crash the page it is meant to restore.
 */
function parse(raw: string | null): PlanStore {
  if (raw === null) return emptyStore();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return emptyStore();
  }
  if (typeof value !== 'object' || value === null) return emptyStore();
  const candidate = value as { items?: unknown; activeId?: unknown };
  if (!Array.isArray(candidate.items)) return emptyStore();

  const items: PlanSession[] = [];
  for (const entry of candidate.items) {
    if (typeof entry !== 'object' || entry === null) continue;
    const session = entry as Partial<PlanSession>;
    if (typeof session.id !== 'string' || session.id.length === 0) continue;
    const messages: PlanMessage[] = [];
    for (const message of Array.isArray(session.messages) ? session.messages : []) {
      if (typeof message !== 'object' || message === null) continue;
      const m = message as Partial<PlanMessage>;
      if (typeof m.text !== 'string' || (m.role !== 'user' && m.role !== 'assistant')) continue;
      messages.push({
        id: typeof m.id === 'string' ? m.id : newId('pm'),
        role: m.role,
        text: m.text,
        at: typeof m.at === 'number' ? m.at : Date.now(),
      });
    }
    items.push(
      bound({
        id: session.id,
        title: typeof session.title === 'string' && session.title.length > 0 ? session.title : 'New plan',
        messages,
        draft: typeof session.draft === 'string' ? session.draft : '',
        workspaceId: typeof session.workspaceId === 'string' ? session.workspaceId : '',
        pipelineId: typeof session.pipelineId === 'string' ? session.pipelineId : '',
        budgetUsd: typeof session.budgetUsd === 'string' ? session.budgetUsd : '',
        createdAt: typeof session.createdAt === 'number' ? session.createdAt : Date.now(),
        updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : Date.now(),
      }),
    );
    if (items.length >= MAX_SESSIONS) break;
  }

  const activeId =
    typeof candidate.activeId === 'string' && items.some((session) => session.id === candidate.activeId)
      ? candidate.activeId
      : items[0]?.id ?? null;

  return { items, activeId };
}

function read(): PlanStore {
  try {
    return parse(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return emptyStore();
  }
}

function write(store: PlanStore): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* a full or unavailable localStorage costs the draft, not the page */
  }
}

function createPlanSession(): PlanSession {
  const at = Date.now();
  return {
    id: newId('plan'),
    title: 'Untitled plan',
    messages: [],
    draft: '',
    workspaceId: '',
    pipelineId: '',
    budgetUsd: '',
    createdAt: at,
    updatedAt: at,
  };
}

/** The first line of the first thing you said, which is the best title there is. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length === 0) return 'Untitled plan';
  return line.length > 68 ? `${line.slice(0, 67)}…` : line;
}

/**
 * Every hook in the app that touches plan sessions, kept in one place so the
 * page and the dock cannot disagree about what is stored.
 */
export function usePlanSessions() {
  const [store, setStore] = useState<PlanStore>(read);

  const commit = useCallback((next: PlanStore) => {
    setStore(next);
    write(next);
  }, []);

  const active = useMemo(
    () => store.items.find((session) => session.id === store.activeId) ?? null,
    [store.activeId, store.items],
  );

  const createSession = useCallback((): string => {
    const session = createPlanSession();
    setStore((current) => {
      const next: PlanStore = { items: [session, ...current.items].slice(0, MAX_SESSIONS), activeId: session.id };
      write(next);
      return next;
    });
    return session.id;
  }, []);

  const selectSession = useCallback(
    (id: string) => {
      setStore((current) => {
        const next: PlanStore = { ...current, activeId: id };
        write(next);
        return next;
      });
    },
    [],
  );

  const removeSession = useCallback((id: string) => {
    setStore((current) => {
      const items = current.items.filter((session) => session.id !== id);
      const next: PlanStore = {
        items,
        activeId: current.activeId === id ? items[0]?.id ?? null : current.activeId,
      };
      write(next);
      return next;
    });
  }, []);

  /** Patches one session and moves it to the top, because it is now the newest. */
  const updateSession = useCallback((id: string, patch: Partial<PlanSession>) => {
    setStore((current) => {
      const existing = current.items.find((session) => session.id === id);
      if (!existing) return current;
      const updated = bound({ ...existing, ...patch, updatedAt: Date.now() });
      const items = [updated, ...current.items.filter((session) => session.id !== id)];
      const next: PlanStore = { items, activeId: current.activeId ?? id };
      write(next);
      return next;
    });
  }, []);

  return { store, active, createSession, selectSession, removeSession, updateSession };
}
