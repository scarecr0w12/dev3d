/**
 * Persistence.
 *
 * `node:sqlite` is built into Node 22+, so dev3d gets a real database with zero
 * dependencies. Everything the office must remember across a restart lives here:
 * the org chart the operator edited, every run and turn, the artifact bodies,
 * the approval history, and the append-only event log that lets a fresh browser
 * replay a run it never watched.
 *
 * The store is deliberately forgiving. If the database cannot be opened - a
 * read-only volume, an unexpected Node build without `node:sqlite`, a locked
 * file - the office still boots and runs; it just forgets everything when it
 * exits, and says so at boot. Losing history is bad. Refusing to start is worse.
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { Approval, Artifact, EventLogEntry, Office, Run, TurnRecord } from '@dev3d/core';

/** This file is ESM, so `require` has to be rebuilt to load a builtin lazily. */
const require = createRequire(import.meta.url);

export interface Store {
  readonly persistent: boolean;
  /** Human-readable backend description for the boot log and `/api/health`. */
  readonly backend: string;

  appendEvent(entry: Omit<EventLogEntry, 'id'>): void;
  eventsForRun(runId: string, limit?: number): EventLogEntry[];
  recentEvents(limit: number): EventLogEntry[];

  saveRun(run: Run): void;
  loadRun(id: string): Run | undefined;
  recentRuns(limit: number): Run[];

  saveTurn(turn: TurnRecord): void;
  turnsForRun(runId: string): TurnRecord[];
  turnsForStage(stageId: string): TurnRecord[];
  /**
   * The most recent turns across every run, newest first.
   *
   * Bounded rather than "all" because its only consumer is outcome-based
   * learning, which is about recent behaviour on the current catalog and would
   * be actively misled by turns from a model version that no longer exists.
   */
  recentTurns(limit: number): TurnRecord[];

  saveArtifact(artifact: Artifact): void;
  artifactsForRun(runId: string): Artifact[];

  /**
   * The installation: settings plus every organisation. Returned as `unknown`
   * because a stored document may predate the current shape - the runtime owns
   * migration, not the store.
   */
  saveOffice(office: Office): void;
  loadOffice(): unknown | null;
  saveApproval(approval: Approval): void;
  approvalsForRun(runId: string): Approval[];
  pendingApprovals(): Approval[];

  close(): void;
}

interface Log {
  (level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string): void;
}

// ---------------------------------------------------------------------------
// in-memory fallback
// ---------------------------------------------------------------------------

function createMemoryStore(reason: string, log: Log): Store {
  const events: EventLogEntry[] = [];
  const runs = new Map<string, Run>();
  const turns = new Map<string, TurnRecord>();
  const artifacts = new Map<string, Artifact>();
  const approvals = new Map<string, Approval>();
  let office: Office | null = null;
  let nextEventId = 1;

  log('warn', 'store', `running without persistence (${reason}); history will be lost on exit`);

  return {
    persistent: false,
    backend: `memory (${reason})`,
    appendEvent(entry) {
      events.push({ ...entry, id: nextEventId });
      nextEventId += 1;
    },
    eventsForRun: (runId, limit = 2_000) =>
      events.filter((e) => e.runId === runId).slice(-limit),
    recentEvents: (limit) => events.slice(-limit),
    saveRun: (run) => {
      runs.set(run.id, structuredClone(run));
    },
    loadRun: (id) => {
      const run = runs.get(id);
      return run ? structuredClone(run) : undefined;
    },
    recentRuns: (limit) =>
      [...runs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit),
    saveTurn: (turn) => {
      turns.set(turn.id, structuredClone(turn));
    },
    turnsForRun: (runId) => [...turns.values()].filter((t) => t.runId === runId),
    turnsForStage: (stageId) => [...turns.values()].filter((t) => t.stageId === stageId),
    recentTurns: (limit) =>
      [...turns.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit),
    saveArtifact: (artifact) => {
      artifacts.set(artifact.id, structuredClone(artifact));
    },
    artifactsForRun: (runId) => [...artifacts.values()].filter((a) => a.runId === runId),
    saveOffice: (next) => {
      office = structuredClone(next);
    },
    loadOffice: () => (office ? structuredClone(office) : null),
    saveApproval: (approval) => {
      approvals.set(approval.id, structuredClone(approval));
    },
    approvalsForRun: (runId) => [...approvals.values()].filter((a) => a.runId === runId),
    pendingApprovals: () => [...approvals.values()].filter((a) => a.status === 'pending'),
    close: () => {},
  };
}

// ---------------------------------------------------------------------------
// sqlite
// ---------------------------------------------------------------------------

/**
 * Bring a run read out of the database up to the current shape.
 *
 * Persisted runs were written by whatever version produced them, so a field
 * added since - `plan` is the first - is simply absent from the JSON. The type
 * says the field is there, and only this function makes that true. Defaulting is
 * right rather than migrating: an absent working plan is exactly an empty one.
 */
function normalizeRun(run: Run): Run {
  if (!Array.isArray(run.plan)) run.plan = [];
  return run;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   TEXT,
  type     TEXT NOT NULL,
  payload  TEXT NOT NULL,
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events (run_id, id);

CREATE TABLE IF NOT EXISTS runs (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_created ON runs (created_at DESC);

CREATE TABLE IF NOT EXISTS turns (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  stage_id    TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  status      TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS turns_run ON turns (run_id, started_at);
CREATE INDEX IF NOT EXISTS turns_stage ON turns (stage_id, started_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  stage_id   TEXT,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  path       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_run ON artifacts (run_id, created_at);

CREATE TABLE IF NOT EXISTS office (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  status       TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  decided_at   INTEGER,
  json         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_run ON approvals (run_id, requested_at);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status, requested_at);
`;

/** Minimal shape of the bits of `node:sqlite` this file uses. */
interface SqliteStatement {
  run(...params: Array<string | number | null>): unknown;
  get(...params: Array<string | number | null>): unknown;
  all(...params: Array<string | number | null>): unknown[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type JsonRow = { json: string };
type EventRow = { id: number; run_id: string | null; type: string; payload: string; at: number };

export function openStore(dbPath: string, log: Log): Store {
  let db: SqliteDatabase;
  try {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    // Required lazily so a Node build without node:sqlite degrades instead of
    // failing at module load.
    const sqlite = require('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDatabase };
    db = new sqlite.DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
    } catch {
      /* pragmas are an optimisation, not a requirement */
    }
    db.exec(SCHEMA);
  } catch (e) {
    return createMemoryStore(e instanceof Error ? e.message : String(e), log);
  }

  const parse = <T>(json: string, fallback: T | null): T | null => {
    try {
      return JSON.parse(json) as T;
    } catch {
      return fallback;
    }
  };

  log('info', 'store', `sqlite ready at ${dbPath}`);

  return {
    persistent: true,
    backend: `sqlite (${dbPath})`,

    appendEvent(entry) {
      try {
        db.prepare('INSERT INTO events (run_id, type, payload, at) VALUES (?, ?, ?, ?)').run(
          entry.runId,
          entry.type,
          entry.payloadJson,
          entry.at,
        );
      } catch (e) {
        log('warn', 'store', `failed to append event: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    eventsForRun(runId, limit = 2_000) {
      const rows = db
        .prepare('SELECT id, run_id, type, payload, at FROM events WHERE run_id = ? ORDER BY id ASC LIMIT ?')
        .all(runId, limit) as EventRow[];
      return rows.map((r) => ({ id: r.id, runId: r.run_id, type: r.type, payloadJson: r.payload, at: r.at }));
    },

    recentEvents(limit) {
      const rows = db
        .prepare('SELECT id, run_id, type, payload, at FROM events ORDER BY id DESC LIMIT ?')
        .all(limit) as EventRow[];
      return rows
        .map((r) => ({ id: r.id, runId: r.run_id, type: r.type, payloadJson: r.payload, at: r.at }))
        .reverse();
    },

    saveRun(run) {
      db.prepare(
        `INSERT INTO runs (id, status, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, json = excluded.json`,
      ).run(run.id, run.status, run.createdAt, run.updatedAt, JSON.stringify(run));
    },

    loadRun(id) {
      const row = db.prepare('SELECT json FROM runs WHERE id = ?').get(id) as JsonRow | undefined;
      if (!row) return undefined;
      const run = parse<Run>(row.json, null);
      return run === null ? undefined : normalizeRun(run);
    },

    recentRuns(limit) {
      const rows = db
        .prepare('SELECT json FROM runs ORDER BY created_at DESC LIMIT ?')
        .all(limit) as JsonRow[];
      return rows
        .map((r) => parse<Run>(r.json, null))
        .filter((r): r is Run => r !== null)
        .map(normalizeRun);
    },

    saveTurn(turn) {
      db.prepare(
        `INSERT INTO turns (id, run_id, stage_id, employee_id, status, started_at, ended_at, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, ended_at = excluded.ended_at, json = excluded.json`,
      ).run(
        turn.id,
        turn.runId,
        turn.stageId,
        turn.employeeId,
        turn.status,
        turn.startedAt,
        turn.endedAt,
        JSON.stringify(turn),
      );
    },

    turnsForRun(runId) {
      const rows = db
        .prepare('SELECT json FROM turns WHERE run_id = ? ORDER BY started_at ASC')
        .all(runId) as JsonRow[];
      return rows.map((r) => parse<TurnRecord>(r.json, null)).filter((t): t is TurnRecord => t !== null);
    },

    turnsForStage(stageId) {
      const rows = db
        .prepare('SELECT json FROM turns WHERE stage_id = ? ORDER BY started_at ASC')
        .all(stageId) as JsonRow[];
      return rows.map((r) => parse<TurnRecord>(r.json, null)).filter((t): t is TurnRecord => t !== null);
    },

    recentTurns(limit) {
      // Served by the `turns_started` index, so a bounded read stays cheap on a
      // table that grows with every turn the office has ever taken.
      const rows = db
        .prepare('SELECT json FROM turns ORDER BY started_at DESC LIMIT ?')
        .all(Math.max(0, Math.floor(limit))) as JsonRow[];
      return rows.map((r) => parse<TurnRecord>(r.json, null)).filter((t): t is TurnRecord => t !== null);
    },

    saveArtifact(artifact) {
      db.prepare(
        `INSERT INTO artifacts (id, run_id, stage_id, kind, title, body, path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET body = excluded.body, title = excluded.title`,
      ).run(
        artifact.id,
        artifact.runId,
        artifact.stageId,
        artifact.kind,
        artifact.title,
        artifact.body,
        artifact.path ?? null,
        artifact.createdAt,
      );
    },

    artifactsForRun(runId) {
      const rows = db
        .prepare(
          'SELECT id, run_id, stage_id, kind, title, body, path, created_at FROM artifacts WHERE run_id = ? ORDER BY created_at ASC',
        )
        .all(runId) as Array<{
        id: string;
        run_id: string;
        stage_id: string | null;
        kind: string;
        title: string;
        body: string;
        path: string | null;
        created_at: number;
      }>;
      return rows.map((r) => {
        const artifact: Artifact = {
          id: r.id,
          runId: r.run_id,
          stageId: r.stage_id,
          employeeId: null,
          kind: r.kind as Artifact['kind'],
          title: r.title,
          body: r.body,
          createdAt: r.created_at,
        };
        if (r.path !== null) artifact.path = r.path;
        return artifact;
      });
    },

    saveOffice(next) {
      db.prepare(
        `INSERT INTO office (id, json, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      ).run(JSON.stringify(next), Date.now());
    },

    loadOffice() {
      const row = db.prepare('SELECT json FROM office WHERE id = 1').get() as JsonRow | undefined;
      if (!row) return null;
      return parse<unknown>(row.json, null);
    },

    saveApproval(approval) {
      db.prepare(
        `INSERT INTO approvals (id, run_id, status, requested_at, decided_at, json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, decided_at = excluded.decided_at, json = excluded.json`,
      ).run(
        approval.id,
        approval.runId,
        approval.status,
        approval.requestedAt,
        approval.decidedAt,
        JSON.stringify(approval),
      );
    },

    approvalsForRun(runId) {
      const rows = db
        .prepare('SELECT json FROM approvals WHERE run_id = ? ORDER BY requested_at ASC')
        .all(runId) as JsonRow[];
      return rows
        .map((r) => parse<Approval>(r.json, null))
        .filter((a): a is Approval => a !== null);
    },

    pendingApprovals() {
      const rows = db
        .prepare("SELECT json FROM approvals WHERE status = 'pending' ORDER BY requested_at ASC")
        .all() as JsonRow[];
      return rows
        .map((r) => parse<Approval>(r.json, null))
        .filter((a): a is Approval => a !== null);
    },

    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}
