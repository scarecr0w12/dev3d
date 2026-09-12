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
import type {
  Approval,
  Artifact,
  EventLogEntry,
  MemoryFact,
  Office,
  Run,
  TurnRecord,
} from '@dev3d/core';

/** This file is ESM, so `require` has to be rebuilt to load a builtin lazily. */
const require = createRequire(import.meta.url);

export interface Store {
  readonly persistent: boolean;
  /** Human-readable backend description for the boot log and `/api/health`. */
  readonly backend: string;
  /**
   * Whether the full-text index over memory facts is usable.
   *
   * False when the store fell back to memory, and false on a build whose SQLite
   * lacks FTS5. The memory layer reads this and degrades to a LIKE scan with no
   * ranking rather than pretending recall works: an office that cannot rank
   * facts should say so, in the same way it says which backend it is on.
   */
  readonly searchable: boolean;
  /**
   * Whether a vector index exists for semantic re-ranking.
   *
   * True only when the vector store was both switched on and successfully
   * loaded. It says the *index* is there and nothing more: whether any given
   * fact has a vector is a separate question, answered per fact, because a store
   * that has an index but no embeddings yet must not claim semantic ranking.
   */
  readonly semantic: boolean;

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

  // ------------------------------------------------------------------- memory
  saveMemoryFact(fact: MemoryFact): void;
  /** One fact by id, active or not - a retracted fact is still on record. */
  loadMemoryFact(id: string): MemoryFact | undefined;
  /**
   * Every fact, active and inactive, newest first.
   *
   * Unbounded on purpose, because the console's whole job is to show the
   * operator the record and its arithmetic: the counts it renders have to
   * reconcile against the list it displays, and a silently truncated list would
   * make the two disagree.
   */
  allMemoryFacts(): MemoryFact[];
  /**
   * Ranked search over active facts.
   *
   * `scopes` restricts which facts may be returned, and it is a **required**
   * argument rather than an optional filter: forgetting to scope a search is the
   * one mistake here with a security consequence, and a required parameter makes
   * that a compile error instead of a leak.
   */
  searchMemoryFacts(query: string, scopes: Array<{ scope: string; scopeId: string | null }>, limit: number): MemoryFact[];
  /** Record that these facts were actually handed to someone, for ranking. */
  noteMemoryFactsRead(ids: string[], at: number): void;
  /**
   * Store a fact's embedding, keyed by fact id.
   *
   * Returns whether the vector was **actually stored**. That return value is not
   * decoration: the width check lives here rather than in the caller, so without
   * it a caller could report an embedding as stored while the index held nothing -
   * a silent success on the one path where silence is worst, because the operator
   * would believe semantic search was working.
   *
   * False when the vector index is not available either, so callers do not have
   * to branch - and so a fact written before the flag was switched on does not
   * become unwritable when it is switched off.
   */
  saveMemoryVector(factId: string, vector: number[]): boolean;
  /** Which of these fact ids already have a vector. */
  memoryFactsMissingVectors(factIds: string[]): string[];
  /**
   * Re-rank facts by cosine similarity to a query vector.
   *
   * Returns the same facts in a new order, with any fact that has no vector left
   * where it was. Vectors are compared in SQLite rather than in JavaScript: a
   * fact count in the thousands is not a scale where moving every vector through
   * the JS boundary is worth it, and `vec_distance_cosine` is the same
   * computation the index already understands.
   */
  rankMemoryByVector(facts: MemoryFact[], vector: number[]): MemoryFact[];
  /** How many facts have a vector, for the console's summary. */
  memoryVectorCount(): number;

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
  const facts = new Map<string, MemoryFact>();
  let office: Office | null = null;
  let nextEventId = 1;

  log('warn', 'store', `running without persistence (${reason}); history will be lost on exit`);

  /**
   * Scope matching, shared by both backends' semantics.
   *
   * A search is always a set of permitted scopes; a fact is visible when the
   * caller's set contains its exact scope and scope id. There is no hierarchy
   * here on purpose - widening access is the caller's job, and doing it here
   * would mean the store could resolve a privilege the caller never granted.
   */
  const inScopes = (fact: MemoryFact, scopes: Array<{ scope: string; scopeId: string | null }>): boolean =>
    scopes.some((s) => s.scope === fact.scope && s.scopeId === fact.scopeId);

  const active = (fact: MemoryFact): boolean => fact.invalidFrom === null && fact.supersededBy === null;

  return {
    persistent: false,
    backend: `memory (${reason})`,
    searchable: false,
    semantic: false,
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
    saveMemoryFact: (fact) => {
      facts.set(fact.id, structuredClone(fact));
    },
    loadMemoryFact: (id) => {
      const fact = facts.get(id);
      return fact ? structuredClone(fact) : undefined;
    },
    allMemoryFacts: () =>
      [...facts.values()].sort((a, b) => b.createdAt - a.createdAt).map((f) => structuredClone(f)),
    searchMemoryFacts(query, scopes, limit) {
      // No FTS5 in the fallback, so this is a substring scan with no ranking.
      // Deliberately still correct about scope and activity: degraded recall is
      // acceptable, a fact escaping its floor is not.
      const needle = query.trim().toLowerCase();
      const matches = [...facts.values()].filter(
        (fact) =>
          active(fact) &&
          inScopes(fact, scopes) &&
          (needle === '' ||
            fact.text.toLowerCase().includes(needle) ||
            fact.tags.some((t) => t.includes(needle))),
      );
      matches.sort((a, b) => b.validFrom - a.validFrom);
      return matches.slice(0, Math.max(0, limit)).map((f) => structuredClone(f));
    },
    noteMemoryFactsRead(ids, at) {
      for (const id of ids) {
        const fact = facts.get(id);
        if (!fact) continue;
        fact.readCount += 1;
        fact.lastReadAt = at;
      }
    },
    // No index, no vectors, no semantic ranking. Reported through `semantic`
    // rather than by quietly returning the same order and letting the caller
    // believe it was re-ranked.
    saveMemoryVector: () => false,
    memoryFactsMissingVectors: () => [],
    memoryVectorCount: () => 0,
    rankMemoryByVector: (list) => list,
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

CREATE TABLE IF NOT EXISTS memory_facts (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  scope_id      TEXT,
  kind          TEXT NOT NULL,
  text          TEXT NOT NULL,
  -- Tags as one space-separated lowercase string, which is what the FTS index
  -- wants. The authoritative list is the array inside the json column; this
  -- column exists only so the external-content index can read it back, and it is
  -- written from that array on every save so the two cannot drift.
  tags          TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  valid_from    INTEGER NOT NULL,
  invalid_from  INTEGER,
  superseded_by TEXT,
  json          TEXT NOT NULL
);
-- The read path filters on activity constantly, so the partial index is the one
-- that matters: it covers exactly the rows a search may return and stays small
-- as superseded facts accumulate behind it.
CREATE INDEX IF NOT EXISTS memory_facts_active ON memory_facts (invalid_from, superseded_by, valid_from DESC);
CREATE INDEX IF NOT EXISTS memory_facts_scope ON memory_facts (scope, scope_id, valid_from DESC);
`;

/**
 * The vector index, created only when the operator has switched it on.
 *
 * Two things about this schema are worth stating because both are silent traps:
 *
 *  - `vec0` **requires** integer primary keys, and `node:sqlite` binds those as
 *    `BigInt` or not at all - a plain JS number throws `Only integers are allows
 *    for primary key values`. So keys are passed as `BigInt` everywhere below.
 *  - `allowExtension` must be set **when the database is opened**. Calling
 *    `enableLoadExtension(true)` afterwards throws, and `'loadExtension' in db`
 *    returns true the whole time, so feature detection lies. That is why the
 *    constructor option is threaded through `openStore` rather than being done
 *    lazily here.
 *
 * `float[768]` is the width, chosen to match the common `text-embedding-3-small`
 * and MiniLM families. A model of a different width is refused at write time
 * rather than being truncated into a meaningless vector: a 384-dimension vector
 * silently packed into 768 columns would produce distances that look like numbers
 * and mean nothing.
 */
export const MEMORY_VECTOR_DIMENSIONS = 768;

const VECTOR_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fact_vectors USING vec0(
  embedding float[${MEMORY_VECTOR_DIMENSIONS}]
);
`;

/**
 * Pack a float array the way `vec0` wants it.
 *
 * A `Float32Array` view over the buffer, which is both the accepted wire form and
 * half the bytes of JSON. Exported for the tests, which assert the round trip
 * rather than trusting the cast.
 */
export function toVectorBlob(vector: readonly number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vector).buffer);
}

/**
 * Cosine *distance* between a stored vector and a query vector, or null when
 * there is no stored vector to compare.
 *
 * `vec_distance_cosine` is 0 for identical direction and 2 for opposite, so the
 * caller ranks ascending. Done in SQL rather than in JavaScript because the
 * comparison is the one thing the index already computes, and pulling a few
 * thousand vectors across the driver boundary to do the same arithmetic by hand
 * would be slower and no clearer.
 *
 * Returns null rather than a large number when the fact has no vector: a fact
 * that was never embedded is not *dissimilar*, it is unmeasured, and giving it a
 * worst-case score would let it be pushed behind facts that were measured and
 * found wanting.
 */
export const MEMORY_COSINE_DISTANCE_SQL = `(
  SELECT vec_distance_cosine(v.embedding, ?)
  FROM memory_fact_vectors v
  WHERE v.rowid = memory_facts.rowid
)`;

/**
 * The full-text index over facts, built separately because it can fail on its own.
 *
 * `content='memory_facts'` makes this an external-content index: FTS5 stores the
 * inverted index and reads the text back from the table, so a fact's text is
 * stored once rather than twice. The triggers are what keep the two in step, and
 * they are the reason a write cannot forget to update the index.
 *
 * This is issued on its own and its failure is tolerated, because FTS5 is a
 * compile-time option and a Node build without it must still boot. An office with
 * unranked memory is worse than one with ranked memory and much better than one
 * that will not start.
 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(
  text,
  tags,
  content='memory_facts',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS memory_facts_ai AFTER INSERT ON memory_facts BEGIN
  INSERT INTO memory_facts_fts (rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memory_facts_ad AFTER DELETE ON memory_facts BEGIN
  INSERT INTO memory_facts_fts (memory_facts_fts, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS memory_facts_au AFTER UPDATE ON memory_facts BEGIN
  INSERT INTO memory_facts_fts (memory_facts_fts, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
  INSERT INTO memory_facts_fts (rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;
`;

/**
 * Minimal shape of the bits of `node:sqlite` this file uses.
 *
 * The parameter type covers `bigint` and `Uint8Array` because the vector index
 * needs both: `vec0` primary keys must bind as `BigInt`, and an embedding binds
 * as a float32 byte view. Narrowing this to `string | number | null` would push
 * every caller into a cast, which is exactly how a BigInt ends up being passed as
 * a number and throwing at runtime instead of failing to compile.
 */
type SqlParam = string | number | bigint | null | Uint8Array;

interface SqliteStatement {
  run(...params: SqlParam[]): unknown;
  get(...params: SqlParam[]): unknown;
  all(...params: SqlParam[]): unknown[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  /**
   * Enable extension loading. Only permitted when the database was opened with
   * `allowExtension: true`; otherwise this throws, even though it is present.
   */
  enableLoadExtension(enabled: boolean): void;
  loadExtension(path: string): void;
  close(): void;
}

type JsonRow = { json: string };
type EventRow = { id: number; run_id: string | null; type: string; payload: string; at: number };

/**
 * Turn free text into a MATCH expression FTS5 will accept.
 *
 * FTS5's query language has operators and quoting, so a raw user string is not
 * safe to interpolate: `foo OR` is a syntax error, and an unbalanced quote throws.
 * Rather than escaping the operators - which would surprise a person who typed
 * them and still not make the query mean what they expected - every run of word
 * characters becomes its own quoted term, and the terms are ANDed.
 *
 * Quoting each term is also what makes an identifier searchable. `customer_id`
 * tokenises to `customer` and `id` as a document, but as a *query* the raw form
 * is a syntax error near `_`. Splitting it the same way on both sides is what
 * makes a search for an identifier find the fact that mentions it.
 *
 * Returns null when there is nothing searchable left, which the caller must treat
 * as "list instead of search" rather than as "no matches" - a query of `!!!` has
 * no terms, and answering it with an empty result would be a lie.
 */
export function toFtsQuery(input: string): string | null {
  const terms = input.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (terms === null || terms.length === 0) return null;
  // Bounded so a pathological query cannot build an enormous expression. Twelve
  // terms is far more than a person types at a memory prompt.
  return terms
    .slice(0, 12)
    .map((t) => `"${t}"`)
    .join(' AND ');
}

export function openStore(
  dbPath: string,
  log: Log,
  options: { vectors?: boolean } = {},
): Store {
  let db: SqliteDatabase;
  try {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    // Required lazily so a Node build without node:sqlite degrades instead of
    // failing at module load.
    const sqlite = require('node:sqlite') as {
      DatabaseSync: new (path: string, opts?: { allowExtension?: boolean }) => SqliteDatabase;
    };
    // Extension loading has to be permitted at construction. Doing it later
    // throws, and the method is present either way, so an attempt to detect the
    // capability by looking for `loadExtension` succeeds and then fails at the
    // call - which is the worst kind of feature detection.
    db = new sqlite.DatabaseSync(dbPath, options.vectors === true ? { allowExtension: true } : {});
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

  /**
   * Build the full-text index, tolerating a SQLite without FTS5.
   *
   * A failure here is not a failure to open the store. Every other table is
   * usable, so the office keeps its runs, its artifacts and its facts, and the
   * only thing it loses is ranking - which it then says out loud through
   * `searchable`, rather than letting recall quietly return whatever the scan
   * happened to find first.
   */
  let searchable = true;
  try {
    db.exec(FTS_SCHEMA);
  } catch (e) {
    searchable = false;
    log(
      'warn',
      'store',
      `no full-text index for memory (${e instanceof Error ? e.message : String(e)}); ` +
        'recall will fall back to an unranked substring scan',
    );
  }

  /**
   * Load the vector extension, tolerating every way it can be unavailable.
   *
   * Failing here is not failing to start: the office keeps lexical recall, which
   * is the whole memory system, and simply does not offer the semantic half. The
   * reasons are different enough to be worth naming separately in the log - the
   * package being absent, the binary being built for another platform, the
   * extension being refused - because the operator's next step differs in each
   * case, and "semantic search is off" with no reason is a support request.
   */
  let semantic = false;
  if (options.vectors === true) {
    try {
      const vec = require('sqlite-vec') as { getLoadablePath?: () => string };
      const path = vec.getLoadablePath?.();
      if (typeof path !== 'string' || path === '') throw new Error('no loadable path was reported');
      db.enableLoadExtension(true);
      db.loadExtension(path);
      db.exec(VECTOR_SCHEMA);
      semantic = true;
      log('info', 'store', `semantic memory index ready (vec0, ${MEMORY_VECTOR_DIMENSIONS} dimensions)`);
    } catch (e) {
      log(
        'warn',
        'store',
        `semantic memory is switched on but unavailable (${e instanceof Error ? e.message : String(e)}); ` +
          'recall stays lexical, which is a complete configuration',
      );
    }
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
    searchable,
    semantic,

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

    saveMemoryFact(fact) {
      db.prepare(
        `INSERT INTO memory_facts
           (id, scope, scope_id, kind, text, tags, created_at, valid_from, invalid_from, superseded_by, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           text = excluded.text,
           tags = excluded.tags,
           invalid_from = excluded.invalid_from,
           superseded_by = excluded.superseded_by,
           json = excluded.json`,
      ).run(
        fact.id,
        fact.scope,
        fact.scopeId,
        fact.kind,
        fact.text,
        fact.tags.join(' '),
        fact.createdAt,
        fact.validFrom,
        fact.invalidFrom,
        fact.supersededBy,
        JSON.stringify(fact),
      );
    },

    loadMemoryFact(id) {
      const row = db.prepare('SELECT json FROM memory_facts WHERE id = ?').get(id) as JsonRow | undefined;
      if (!row) return undefined;
      return parse<MemoryFact>(row.json, null) ?? undefined;
    },

    allMemoryFacts() {
      const rows = db
        .prepare('SELECT json FROM memory_facts ORDER BY created_at DESC')
        .all() as JsonRow[];
      return rows.map((r) => parse<MemoryFact>(r.json, null)).filter((f): f is MemoryFact => f !== null);
    },

    searchMemoryFacts(query, scopes, limit) {
      const max = Math.max(0, Math.floor(limit));
      if (max === 0 || scopes.length === 0) return [];

      // The scope filter is built as parameter placeholders rather than
      // interpolated, so a scope id can never be read as SQL. An empty scope list
      // is answered above rather than by an `IN ()` that matches nothing and
      // would be indistinguishable from "no facts".
      const scopeClause = scopes.map(() => '(f.scope = ? AND f.scope_id IS ?)').join(' OR ');
      const scopeParams: Array<string | null> = [];
      for (const s of scopes) scopeParams.push(s.scope, s.scopeId);

      // Activity is a property of the row, never of the query: a superseded fact
      // is not "less relevant", it is no longer true, and no ranking may surface
      // it as current belief.
      const activeClause = 'f.invalid_from IS NULL AND f.superseded_by IS NULL';

      const terms = searchable ? toFtsQuery(query) : null;
      if (terms === null) {
        // No searchable terms, or no index: list rather than search. Ordering is
        // deliberate and honest - most confident first, then newest - because
        // without a query there is no relevance to rank on, and inventing one
        // would bury the newest correction under an old certainty.
        const rows = db
          .prepare(
            `SELECT f.json FROM memory_facts f
             WHERE ${activeClause} AND (${scopeClause})
             ORDER BY json_extract(f.json, '$.confidence') DESC, f.valid_from DESC
             LIMIT ?`,
          )
          .all(...scopeParams, max) as JsonRow[];
        return rows.map((r) => parse<MemoryFact>(r.json, null)).filter((f): f is MemoryFact => f !== null);
      }

      const rows = db
        .prepare(
          `SELECT f.json FROM memory_facts f
           JOIN memory_facts_fts ON memory_facts_fts.rowid = f.rowid
           WHERE ${activeClause} AND (${scopeClause}) AND memory_facts_fts MATCH ?
           ORDER BY bm25(memory_facts_fts, 10.0, 4.0) ASC,
                    json_extract(f.json, '$.confidence') DESC,
                    f.valid_from DESC
           LIMIT ?`,
        )
        .all(...scopeParams, terms, max) as JsonRow[];
      return rows.map((r) => parse<MemoryFact>(r.json, null)).filter((f): f is MemoryFact => f !== null);
    },

    noteMemoryFactsRead(ids, at) {
      // A read is recorded by rewriting the row's JSON. That fires the FTS update
      // trigger, which re-indexes identical text - wasted work, but the index and
      // the row stay consistent by construction, and a rewrite only happens for
      // the handful of facts one recall actually returned.
      const readOne = db.prepare('SELECT json FROM memory_facts WHERE id = ?');
      const writeOne = db.prepare('UPDATE memory_facts SET json = ? WHERE id = ?');
      for (const id of ids) {
        try {
          const row = readOne.get(id) as JsonRow | undefined;
          if (!row) continue;
          const fact = parse<MemoryFact>(row.json, null);
          if (fact === null) continue;
          fact.readCount += 1;
          fact.lastReadAt = at;
          writeOne.run(JSON.stringify(fact), id);
        } catch (e) {
          log('warn', 'store', `failed to record a memory read: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    },

    saveMemoryVector(factId, vector) {
      if (!semantic) return false;
      if (vector.length !== MEMORY_VECTOR_DIMENSIONS) {
        // Refused rather than truncated. A vector of the wrong width packed into
        // these columns would produce distances that are numbers and mean
        // nothing, which is worse than no vector at all.
        log(
          'warn',
          'store',
          `refusing a ${vector.length}-dimension memory vector; the index is ${MEMORY_VECTOR_DIMENSIONS}`,
        );
        return false;
      }
      try {
        const row = db.prepare('SELECT rowid AS rowid FROM memory_facts WHERE id = ?').get(factId) as
          | { rowid: number | bigint }
          | undefined;
        if (row === undefined) return false;
        // `rowid` must be a BigInt: node:sqlite refuses a JS number for a vec0
        // primary key, and the failure is a runtime throw rather than a type
        // error, so it would otherwise only show up in production.
        const key = typeof row.rowid === 'bigint' ? row.rowid : BigInt(row.rowid);
        db.prepare('INSERT OR REPLACE INTO memory_fact_vectors (rowid, embedding) VALUES (?, ?)').run(
          key,
          toVectorBlob(vector),
        );
        return true;
      } catch (e) {
        log('warn', 'store', `failed to store a memory vector: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    },

    memoryFactsMissingVectors(factIds) {
      if (!semantic || factIds.length === 0) return [];
      const missing: string[] = [];
      try {
        const stmt = db.prepare(
          `SELECT f.id AS id FROM memory_facts f
           WHERE f.id = ?
             AND NOT EXISTS (SELECT 1 FROM memory_fact_vectors v WHERE v.rowid = f.rowid)`,
        );
        for (const id of factIds) {
          if (stmt.get(id) !== undefined) missing.push(id);
        }
      } catch (e) {
        log('warn', 'store', `failed to check for missing memory vectors: ${e instanceof Error ? e.message : String(e)}`);
      }
      return missing;
    },

    memoryVectorCount() {
      if (!semantic) return 0;
      try {
        const row = db.prepare('SELECT COUNT(*) AS n FROM memory_fact_vectors').get() as
          | { n: number | bigint }
          | undefined;
        return Number(row?.n ?? 0);
      } catch {
        return 0;
      }
    },

    rankMemoryByVector(facts, vector) {
      if (!semantic || facts.length < 2 || vector.length !== MEMORY_VECTOR_DIMENSIONS) return facts;
      try {
        const placeholders = facts.map(() => '?').join(', ');
        const rows = db
          .prepare(
            `SELECT id, (
               SELECT vec_distance_cosine(v.embedding, ?)
               FROM memory_fact_vectors v
               WHERE v.rowid = memory_facts.rowid
             ) AS distance
             FROM memory_facts
             WHERE id IN (${placeholders})`,
          )
          .all(toVectorBlob(vector), ...facts.map((f) => f.id)) as Array<{
          id: string;
          distance: number | null;
        }>;

        const distance = new Map<string, number | null>();
        for (const row of rows) distance.set(row.id, row.distance);

        const lexicalOrder = new Map(facts.map((fact, index) => [fact.id, index]));
        return [...facts].sort((a, b) => {
          const da = distance.get(a.id) ?? null;
          const db2 = distance.get(b.id) ?? null;
          // An unmeasured fact keeps its lexical position rather than being
          // ranked: it has no opinion to contribute, and a null treated as the
          // worst distance would bury a fact merely for being new.
          if (da === null && db2 === null) return (lexicalOrder.get(a.id) ?? 0) - (lexicalOrder.get(b.id) ?? 0);
          if (da === null) return 0;
          if (db2 === null) return 0;
          if (da === db2) return (lexicalOrder.get(a.id) ?? 0) - (lexicalOrder.get(b.id) ?? 0);
          return da - db2;
        });
      } catch (e) {
        // A failed re-rank must not lose the results. Lexical order is a real
        // answer; an exception here would turn a ranking refinement into a
        // failed recall.
        log('warn', 'store', `semantic re-ranking failed, keeping lexical order: ${e instanceof Error ? e.message : String(e)}`);
        return facts;
      }
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
