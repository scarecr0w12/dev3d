/**
 * What the office remembers between runs.
 *
 * Everything above this file is a fact store. This is the part that decides what
 * a write *means*, and it exists as its own module because two of its rules are
 * the whole point of the feature and neither belongs in a route handler:
 *
 *  - **A correction supersedes; it never overwrites.** `record` with a
 *    `supersedes` id performs both halves - create the replacement, invalidate
 *    the original - and returns both, so a caller cannot apply one without the
 *    other. The original keeps its text and gains the instant it stopped being
 *    true, which is what makes "what did we believe in March" answerable after
 *    somebody changes their mind in June.
 *
 *  - **Nothing is ever deleted for being old.** There is no decay, no TTL and no
 *    sweep. A fact that has not been read in six months is not thereby wrong; it
 *    is the thing that matters the moment it comes up again. Retraction is an
 *    explicit act that also keeps the record, and the store has no delete at all,
 *    so age-based forgetting is not merely unimplemented - there is no call that
 *    could do it.
 *
 * Writes are attributed, not inferred. There is no extraction step and no model in
 * this file: a fact exists because a person wrote it down, which is the one write
 * path that cannot hallucinate.
 */

import type {
  MemoryFact,
  MemoryFactInput,
  MemoryOrigin,
  MemoryRecord,
  MemoryScope,
  MemoryState,
} from '@dev3d/core';
import { isActive, validateMemoryFact } from '@dev3d/core';
import type { Store } from '../store/store.ts';

/** A scope a caller is allowed to read. */
export interface MemoryScopeRef {
  scope: MemoryScope;
  scopeId: string | null;
}

/**
 * How text becomes vectors, when the operator has asked for it.
 *
 * Injected rather than constructed here so this module never learns about
 * providers, and so a test can hand it a deterministic function. Absent means
 * "this office has no semantic search", which is a complete configuration and
 * not a broken one.
 */
export type MemoryEmbedder = (texts: string[]) => Promise<number[][]>;

/**
 * How many unembedded facts one search will embed on the way past.
 *
 * Bounded because this runs inside a recall, against an endpoint that may be
 * metered: a store with a thousand historical facts must not turn one search into
 * a thousand embedding calls. A handful per search drains a backlog over normal
 * use without a burst, and an operator who wants it done at once has the explicit
 * backfill.
 */
const BACKFILL_PER_SEARCH = 8;

export interface MemoryService {
  /**
   * Write a fact down, or correct one.
   *
   * `origin` is the writer, not a label the caller invents: the API passes
   * `operator`, and nothing currently passes anything else. It is a parameter
   * rather than a constant so that a future writer has to name itself here.
   */
  record(
    input: unknown,
    origin: MemoryOrigin,
  ): { ok: true; fact: MemoryFact; superseded: MemoryFact | null } | { ok: false; error: string };
  /** Mark a fact no longer true, keeping it on record. */
  retract(id: string): { ok: true; fact: MemoryFact } | { ok: false; error: string };
  /** One fact, active or not. */
  get(id: string): MemoryFact | undefined;
  /**
   * Embed any facts that do not have a vector yet, bounded by `limit`.
   *
   * Reported as a count so a partial backfill can be described honestly rather
   * than as a success or a failure.
   */
  embedMissing(limit: number): Promise<number>;
  /**
   * The whole record, newest first, including facts the office no longer
   * believes.
   *
   * Named `ledger` rather than `record` so it cannot be confused with `record()`,
   * which is the write. Those two being one letter apart in a call site is the
   * kind of mistake that reads correctly and does the wrong thing.
   */
  ledger(): MemoryRecord;
  /** Active facts and the counts over them - what a state frame carries. */
  state(): MemoryState;
  /**
   * Ranked search restricted to the scopes the caller may read.
   *
   * Both arguments are required. `scopes` has no default because an unscoped
   * search would let one floor read another's memory, which is the single mistake
   * here with a containment consequence - and a mandatory parameter turns that
   * into a compile error rather than a leak.
   */
  search(query: string, scopes: MemoryScopeRef[], limit: number): MemoryFact[];
  /**
   * The same search, with semantic re-ranking when it is available.
   *
   * Asynchronous and separate from `search` because embedding the query is a
   * network call, and a caller that cannot wait - or that has no semantic search
   * configured - should not have to pretend otherwise. `search` stays synchronous
   * and stays the whole story when this is unavailable.
   */
  searchAsync(query: string, scopes: MemoryScopeRef[], limit: number): Promise<MemoryFact[]>;
  /** Record that these facts were handed out, which is what ranking learns from. */
  noteRead(ids: string[], at: number): void;
  /** Whether the store has a ranked index, or is degrading to a scan. */
  searchable(): boolean;
  /** Whether semantic ranking is actually in force, index and embedder both. */
  semantic(): boolean;
  /**
   * Embed any of these facts that do not have a vector yet.
   *
   * Exists because the flag can be switched on after facts have already been
   * written, and those facts are the ones an operator most wants to find. Batched
   * through one embedder call and bounded by the caller, so a backfill cannot
   * become an unbounded burst against a paid endpoint.
   */
  embedMissing(limit: number): Promise<number>;
}

/**
 * Scopes are ordered outermost first, and the order is the containment story the
 * rest of the office already tells: a fact pinned to the installation is visible
 * everywhere, a fact pinned to a floor is visible on that floor, and a fact pinned
 * to a role is visible to that role. Nothing sees inward, which is the same rule
 * that stops one floor reading another's files.
 */
export function scopesFor(workspaceId: string, roleId: string | null): MemoryScopeRef[] {
  const scopes: MemoryScopeRef[] = [
    { scope: 'installation', scopeId: null },
    { scope: 'workspace', scopeId: workspaceId },
  ];
  if (roleId !== null && roleId !== '') scopes.push({ scope: 'role', scopeId: roleId });
  return scopes;
}

export function createMemoryService(store: Store, options: { embed?: MemoryEmbedder } = {}): MemoryService {
  const newId = (): string => `fact_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
  const embed = options.embed;
  /**
   * Semantic ranking is in force only when both halves are present.
   *
   * An index with no embedder cannot vectorise a query; an embedder with no index
   * has nowhere to put a vector. Reporting either alone as "semantic" would make
   * the Memory page promise a capability that silently does nothing, which is
   * worse than saying it is off.
   */
  const canRankSemantically = (): boolean => store.semantic && embed !== undefined;

  /**
   * The counts the console shows, derived from the same rows it lists.
   *
   * Derived rather than tracked separately on purpose: a stored counter and a
   * stored list can disagree, and the one time they do the operator is looking at
   * arithmetic that does not add up with no way to tell which half is wrong.
   */
  function state(): MemoryState {
    const all = store.allMemoryFacts();
    const counts = { installation: 0, workspace: 0, role: 0 };
    const active: MemoryFact[] = [];
    for (const fact of all) {
      if (isActive(fact)) {
        counts[fact.scope] += 1;
        active.push(fact);
      }
    }
    return {
      facts: active,
      counts,
      searchable: store.searchable,
      semantic: canRankSemantically(),
      // Two different questions, answered separately: how much embedding work has
      // been done in total (which spans facts the office no longer believes), and
      // how much of what it *does* believe is ranked by meaning. Reporting one
      // number for both is how a page ends up drawing a fraction that does not
      // divide. `vectorCount` is bounded by the whole record rather than by the
      // active set, so it is the wrong number to put over `facts.length`.
      vectorCount: store.memoryVectorCount(),
      vectorCoverage: countEmbedded(active),
    };
  }

  /**
   * How many of these facts already have a vector.
   *
   * Asked of the store per fact rather than inferred from a total, because the
   * store is the only thing that knows, and an inferred number is exactly the
   * kind that drifts into being wrong without anything failing.
   */
  function countEmbedded(facts: readonly MemoryFact[]): number {
    if (!store.semantic || facts.length === 0) return 0;
    const missing = new Set(store.memoryFactsMissingVectors(facts.map((fact) => fact.id)));
    return facts.reduce((count, fact) => (missing.has(fact.id) ? count : count + 1), 0);
  }

  /**
   * The whole record, including what the office no longer believes.
   *
   * Separate from `state()` because the two have different shapes for a reason:
   * this one is unbounded and is therefore fetched on request, while `state()` is
   * what every `hello` carries.
   */
  function recordOf(): MemoryRecord {
    const all = store.allMemoryFacts();
    const active = all.filter(isActive);
    return {
      facts: all,
      total: all.length,
      inactive: all.length - active.length,
      searchable: store.searchable,
      semantic: canRankSemantically(),
      // Against the whole record, because that is the population this describes:
      // `vectorCount` counts embeddings that exist, which is at most `total`.
      vectorCount: store.memoryVectorCount(),
      vectorCoverage: countEmbedded(active),
    };
  }

  /**
   * Embed a batch and store what comes back, swallowing every failure.
   *
   * An embedding is a ranking refinement, so nothing about memory may break when
   * it cannot be obtained: a missing provider, a rate limit, a wrong-width model
   * all leave the fact written and recallable in full text. The count returned is
   * how many were stored, so a caller can report a partial backfill rather than
   * claiming success.
   */
  async function embedFacts(facts: readonly MemoryFact[]): Promise<number> {
    if (!canRankSemantically() || facts.length === 0) return 0;
    try {
      const vectors = await embed!(facts.map((fact) => fact.text));
      let stored = 0;
      for (let i = 0; i < facts.length; i += 1) {
        const vector = vectors[i];
        // A short or ragged answer is dropped per fact rather than aborting the
        // batch: one bad row must not cost the embeddings that were fine.
        if (!Array.isArray(vector) || vector.length === 0) continue;
        // Counted only when the store actually accepted it. The width check lives
        // in the store, so incrementing here regardless would report embeddings as
        // stored while the index held nothing - a success message for a capability
        // that is not working.
        if (store.saveMemoryVector(facts[i]!.id, vector)) stored += 1;
      }
      return stored;
    } catch {
      return 0;
    }
  }

  function writeFact(
    input: unknown,
    origin: MemoryOrigin,
  ): { ok: true; fact: MemoryFact; superseded: MemoryFact | null } | { ok: false; error: string } {
    const validated = validateMemoryFact(input);
    if (!validated.ok || validated.value === null) {
      return { ok: false, error: validated.error ?? 'The fact was not valid.' };
    }
    const v = validated.value;

    // Resolve the fact being corrected before writing anything, so a bad id fails
    // the whole operation rather than leaving a replacement with nothing to
    // replace.
    let superseded: MemoryFact | null = null;
    if (v.supersedes !== null) {
      const existing = store.loadMemoryFact(v.supersedes);
      if (existing === undefined) {
        return { ok: false, error: `There is no fact "${v.supersedes}" to supersede.` };
      }
      if (!isActive(existing)) {
        return {
          ok: false,
          error:
            `The fact "${v.supersedes}" is already replaced or retracted. ` +
            'Correct the fact that is current, so a chain of corrections stays a chain.',
        };
      }
      // A correction must not silently move a fact between floors or roles: the
      // replacement inherits the original's scope rather than the one the caller
      // happened to send, so a correction can never widen where a fact is visible.
      if (existing.scope !== v.scope || existing.scopeId !== v.scopeId) {
        return {
          ok: false,
          error:
            `The fact "${v.supersedes}" is scoped to ${existing.scope}` +
            `${existing.scopeId === null ? '' : ` "${existing.scopeId}"`}, and a correction cannot move it. ` +
            'Replacement facts keep the scope of the fact they replace.',
        };
      }
      superseded = existing;
    }

    const now = Date.now();
    const fact: MemoryFact = {
      id: newId(),
      scope: v.scope,
      scopeId: v.scopeId,
      kind: v.kind,
      text: v.text,
      origin,
      tags: v.tags,
      source: v.source,
      confidence: v.confidence,
      createdAt: now,
      updatedAt: now,
      validFrom: now,
      invalidFrom: null,
      supersededBy: null,
      supersedes: superseded === null ? null : superseded.id,
      readCount: 0,
      lastReadAt: null,
    };

    // Write the replacement first. If the invalidation below were to fail, the
    // failure that matters is the one that leaves a fact current with nothing
    // replacing it - so the new fact must already be on disk before anything is
    // marked invalid, and this order also means the write is never pointing at a
    // row that does not exist.
    store.saveMemoryFact(fact);

    if (superseded !== null) {
      const invalidated: MemoryFact = {
        ...superseded,
        invalidFrom: now,
        supersededBy: fact.id,
        updatedAt: now,
      };
      store.saveMemoryFact(invalidated);
      superseded = invalidated;
    }

    return { ok: true, fact, superseded };
  }

  function retract(id: string): { ok: true; fact: MemoryFact } | { ok: false; error: string } {
    const existing = store.loadMemoryFact(id);
    if (existing === undefined) return { ok: false, error: `There is no fact "${id}".` };
    if (!isActive(existing)) {
      return { ok: false, error: `The fact "${id}" is already replaced or retracted.` };
    }
    const now = Date.now();
    // Retraction carries no replacement, so `supersededBy` stays null and
    // `invalidFrom` alone marks it inactive. The two fields mean different things:
    // one says something replaced this, the other says it stopped being true.
    const retracted: MemoryFact = { ...existing, invalidFrom: now, updatedAt: now };
    store.saveMemoryFact(retracted);
    return { ok: true, fact: retracted };
  }

  return {
    record: writeFact,
    retract,
    get: (id) => store.loadMemoryFact(id),
    state,
    ledger: recordOf,
    search: (query, scopes, limit) => store.searchMemoryFacts(query, scopes, limit),

    /**
     * Lexical recall, then semantic re-ranking when both halves are available.
     *
     * The order is deliberate and is the whole design of this feature: **full
     * text selects the candidates and vectors only order them.** That keeps the
     * scope filter, the activity filter and the containment rule on the one code
     * path that already enforces them, so turning semantic search on cannot widen
     * what a search may return. A vector-only path would have had to reproduce
     * every one of those filters against a table that does not carry them.
     *
     * Every failure here degrades to the lexical answer rather than to an error
     * or an empty list. A semantic ranking that cannot be computed is a ranking
     * refinement that did not happen, not a recall that failed.
     */
    async searchAsync(query, scopes, limit) {
      const lexical = store.searchMemoryFacts(query, scopes, limit);
      if (!canRankSemantically() || lexical.length < 2 || query.trim() === '') return lexical;
      try {
        // Facts written before the flag was switched on have no vector yet.
        // Embedding them here, bounded, is what stops "semantic search is on" from
        // meaning "semantic search works only for facts written since".
        await embedFacts(store.memoryFactsMissingVectors(lexical.map((fact) => fact.id)).slice(0, BACKFILL_PER_SEARCH).map((id) => store.loadMemoryFact(id)).filter((f): f is MemoryFact => f !== undefined));
        const [queryVector] = await embed!([query]);
        if (!Array.isArray(queryVector) || queryVector.length === 0) return lexical;
        return store.rankMemoryByVector(lexical, queryVector);
      } catch {
        return lexical;
      }
    },

    noteRead: (ids, at) => store.noteMemoryFactsRead(ids, at),
    searchable: () => store.searchable,
    semantic: canRankSemantically,

    async embedMissing(limit) {
      if (!canRankSemantically() || limit <= 0) return 0;
      const all = store.allMemoryFacts();
      const missing = store.memoryFactsMissingVectors(all.map((fact) => fact.id));
      const batch = missing
        .slice(0, Math.max(0, Math.floor(limit)))
        .map((id) => store.loadMemoryFact(id))
        .filter((fact): fact is MemoryFact => fact !== undefined);
      return embedFacts(batch);
    },
  };
}
