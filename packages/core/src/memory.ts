/**
 * Memory.
 *
 * dev3d already remembers a great deal about *work in flight*: `RunKnowledge`
 * threads the brief, the objective, every stage summary and every artifact from
 * one stage to the next. What it has never had is anything that outlives the run
 * it was produced in. A run ends and the knowledge it accumulated ends with it,
 * so the office cannot answer the questions that make a second attempt cheaper
 * than the first: what did we try here before, did it work, and what did we
 * decide the last time this came up.
 *
 * This module is the vocabulary for that. It is deliberately small and
 * deliberately conservative, and both of those are informed by how memory
 * systems fail in practice rather than by how they are usually described:
 *
 *  - **A fact is stated, not extracted.** The overwhelming majority of memory
 *    errors are made on the write path: a model asked to summarise a transcript
 *    into "memories" omits what mattered and invents what did not, and every
 *    later turn inherits the mistake. So nothing here derives a fact from a
 *    transcript. A fact exists because an operator wrote it down.
 *
 *  - **A fact is never overwritten.** Correcting a fact supersedes it: the old
 *    row keeps its text and gains the moment it stopped being true and a pointer
 *    to what replaced it. "What do we believe now" and "what did we believe
 *    then" are both answerable, and no correction can silently destroy the
 *    record of what was believed before. Last-write-wins is the default in most
 *    memory systems and it is the reason a contradiction there is unrecoverable.
 *
 *  - **Nothing is deleted for being old.** A fact that has not been read in
 *    months is not thereby wrong; it may be the one thing that matters the
 *    moment it comes up again. Age affects ranking, never existence. Only an
 *    explicit operator action removes a fact, and even that is recorded.
 */

/**
 * How far a fact reaches.
 *
 * The three levels are the ones the office already partitions by - the building,
 * the floor, and the person - so memory inherits the same containment story as
 * the filesystem rather than inventing a second one.
 */
export type MemoryScope = 'installation' | 'workspace' | 'role';

/**
 * What kind of thing a fact is, which is mostly about how it should be read.
 */
export type MemoryKind =
  /** A rule the work must follow: a convention, a boundary, a requirement. */
  | 'convention'
  /** A choice that was made, and is expensive to revisit. */
  | 'decision'
  /** A trap worth not falling into twice: a failure mode, a sharp edge. */
  | 'pitfall'
  /** Anything else worth remembering that is not one of the above. */
  | 'note';

export const MEMORY_SCOPES: readonly MemoryScope[] = ['installation', 'workspace', 'role'];
export const MEMORY_KINDS: readonly MemoryKind[] = ['convention', 'decision', 'pitfall', 'note'];

/**
 * How a fact came to exist, and who is answerable for it.
 *
 * There is no `extracted-by-model` member, and that is the point: if a future
 * version does derive facts automatically, adding the member is a deliberate,
 * visible change to this type rather than a quiet widening of what already
 * exists.
 */
export type MemoryOrigin =
  /** Written by a person through the console or the API. */
  | 'operator'
  /** Written by a person, then confirmed against the workspace by the model. */
  | 'operator-verified';

/**
 * One remembered fact.
 *
 * The three timestamp pairs are the substance of the type and are worth reading
 * carefully, because collapsing any of them loses a distinction the office needs:
 *
 *  - `createdAt` / `updatedAt` describe the row.
 *  - `validFrom` / `invalidFrom` describe **the world**: the interval during
 *    which the fact was true. A fact is active while `invalidFrom` is null.
 *  - `supersededBy` / `supersedes` are the edit chain, so a correction is a link
 *    between two facts rather than a mutation of one.
 */
export interface MemoryFact {
  id: string;
  scope: MemoryScope;
  /**
   * Which installation, floor or role the fact belongs to.
   *
   * `null` exactly when the scope is `installation`, which is the only scope that
   * does not name anything: the installation is the thing every other scope lives
   * inside. A record with a null id and a narrower scope is meaningless, and
   * `validateMemoryFact` refuses it.
   */
  scopeId: string | null;
  kind: MemoryKind;
  /** The fact itself, as one statement a person can agree or disagree with. */
  text: string;
  origin: MemoryOrigin;
  /** Free-text tags for grouping and filtering. Lowercased and deduplicated. */
  tags: string[];
  /** Where this came from - a file, a run, an issue, a conversation. */
  source: string | null;
  /**
   * How much this should be believed, 0..1.
   *
   * Not a measure of confidence in the wording but of how load-bearing the fact
   * has proven: an operator can set it when writing, and it is a ranking input.
   * It deliberately does not decay with age - see the note on `validFrom`.
   */
  confidence: number;
  createdAt: number;
  updatedAt: number;
  /** The moment the fact became true. */
  validFrom: number;
  /** The moment it stopped being true, or null while it still is. */
  invalidFrom: number | null;
  /** The fact that replaced this one, when it has been superseded. */
  supersededBy: string | null;
  /** The fact this one replaced, when it was written as a correction. */
  supersedes: string | null;
  /**
   * How many times this fact has been returned by a search.
   *
   * The raw material for outcome-weighted ranking: use is the only honest signal
   * of whether a fact is worth keeping, and it is the one signal a system with
   * real success and failure outcomes - which this office has - can actually
   * measure. Counting reads is the first half of that loop.
   */
  readCount: number;
  /** The last time a search returned it, or null if it never has. */
  lastReadAt: number | null;
}

/**
 * Just enough of a fact to show in a list or inject into a prompt.
 *
 * Separate from `MemoryFact` because the two have different jobs: a search result
 * is shown to a model under a token budget, while `MemoryFact` is the operator's
 * record. Trimming the injection form here means no caller has to remember to.
 */
export interface MemoryFactSummary {
  id: string;
  scope: MemoryScope;
  scopeId: string | null;
  kind: MemoryKind;
  text: string;
  tags: string[];
  confidence: number;
  validFrom: number;
}

/**
 * What the console needs to render the Memory page from the live socket.
 *
 * Deliberately **active facts only**, and deliberately without a total. The
 * building's record of what it used to believe is unbounded, and a live state
 * frame is the wrong place for an unbounded payload; the full record including
 * superseded and retracted facts is served on request at `/api/memory`. Keeping
 * a total here and only active facts here would also mean shipping a number that
 * does not agree with the list beside it, which is worse than shipping no number.
 */
export interface MemoryState {
  /** Active facts only - superseded and retracted ones are not listed here. */
  facts: MemoryFact[];
  /**
   * Active facts per scope.
   *
   * Derived from `facts`, so the summary line on the page always adds up against
   * the list underneath it.
   */
  counts: {
    installation: number;
    workspace: number;
    role: number;
  };
  /** True when the store has a ranked index, false when it degraded to a scan. */
  searchable: boolean;
  /**
   * True when semantic re-ranking is actually in force.
   *
   * Not "the flag is on". It is true only when the vector index loaded *and* an
   * embedding endpoint is configured and reachable enough to have been set up -
   * because a page that claims semantic ranking while every search falls back to
   * lexical is claiming a capability that does nothing.
   */
  semantic: boolean;
  /**
   * How many facts **in the index** have a vector - active or not.
   *
   * A measure of how much embedding work exists in the index in total. It is not a
   * fraction of `facts`, which holds active facts only: superseded facts keep
   * their vectors, because a fact that stopped being true does not mean its vector
   * should be discarded, and one that is corrected back would otherwise pay to be
   * embedded twice.
   *
   * So this is **at most** `ledger.total`, reaching it only once every fact has
   * been embedded, and it is not a number to compare against `total` for
   * correctness. Use `vectorCoverage` for anything expressed as a proportion.
   */
  vectorCount: number;
  /**
   * How many of the **active** facts have a vector.
   *
   * The number the page shows against `facts.length`, because that pair is
   * actually a fraction: it answers "if I search now, how much of what I believe
   * is ranked by meaning rather than only by words".
   *
   * Separate from `vectorCount` rather than derived from it. Subtracting the
   * inactive count would be wrong - `total` includes inactive facts that were
   * never embedded - and a UI left to infer it would eventually show a fraction
   * with a numerator larger than its denominator. The server sets `vectorCount`
   * to exactly `ledger.total`, so it is not the number to do arithmetic on.
   */
  vectorCoverage: number;
}

/** One fact with the full record behind it, for the Memory page's history view. */
export interface MemoryRecord {
  facts: MemoryFact[];
  /** Every fact ever recorded, active or not. */
  total: number;
  /** How many have been superseded or retracted. */
  inactive: number;
  searchable: boolean;
  semantic: boolean;
  /** How many facts in the index have a vector - at most `total`, less until all are embedded. */
  vectorCount: number;
  /** How many *active* facts have a vector, which is what the page shows against `facts`. */
  vectorCoverage: number;
}

/**
 * A write to the fact store, as the API and the console express it.
 *
 * Supersession is expressed by naming the fact being replaced rather than by
 * mutating it: `supersedes` turns a create into a correction, and the server
 * performs both halves of that as one operation so a correction can never be
 * half-applied.
 */
export interface MemoryFactInput {
  scope: MemoryScope;
  scopeId?: string | null;
  kind: MemoryKind;
  text: string;
  tags?: string[];
  source?: string | null;
  confidence?: number;
  /** When set, the named fact is superseded by the one being created. */
  supersedes?: string | null;
}

export const MEMORY_TEXT_LIMIT = 500;
export const MEMORY_TAG_LIMIT = 12;
export const MEMORY_SOURCE_LIMIT = 200;

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === 'string' && (MEMORY_SCOPES as readonly string[]).includes(value);
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

/** A fact is active, and so retrievable, exactly while it has not been invalidated. */
export function isActive(fact: MemoryFact): boolean {
  return fact.invalidFrom === null && fact.supersededBy === null;
}

/**
 * Normalise tags: trimmed, lowercased, empty ones dropped, duplicates removed,
 * order preserved, and the list capped.
 *
 * Lowercasing rather than keeping case because tags are a grouping key, and
 * `Testing` and `testing` being separate groups is a bug the operator would have
 * to work around rather than a feature.
 */
export function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().toLowerCase();
    if (tag === '' || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MEMORY_TAG_LIMIT) break;
  }
  return out;
}

export interface MemoryValidation {
  ok: boolean;
  error: string | null;
  /** The normalised input, present only when `ok`. */
  value: {
    scope: MemoryScope;
    scopeId: string | null;
    kind: MemoryKind;
    text: string;
    tags: string[];
    source: string | null;
    confidence: number;
    supersedes: string | null;
  } | null;
}

/**
 * Validate and normalise a fact as it arrives from a client.
 *
 * Exported and pure so the HTTP route, the socket command and the tests all
 * enforce exactly the same rules instead of three approximations of them. Returns
 * a message rather than throwing because every caller's job is to turn bad input
 * into a 400 or a refusal the model can read, not to crash.
 */
export function validateMemoryFact(input: unknown): MemoryValidation {
  const fail = (error: string): MemoryValidation => ({ ok: false, error, value: null });
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail('A memory fact must be an object.');
  }
  const raw = input as Record<string, unknown>;

  if (!isMemoryScope(raw.scope)) {
    return fail(`"scope" must be one of ${MEMORY_SCOPES.join(', ')}.`);
  }
  if (!isMemoryKind(raw.kind)) {
    return fail(`"kind" must be one of ${MEMORY_KINDS.join(', ')}.`);
  }

  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (text === '') return fail('"text" must be a non-empty string.');
  if (text.length > MEMORY_TEXT_LIMIT) {
    return fail(`"text" is ${text.length} characters; the limit is ${MEMORY_TEXT_LIMIT}.`);
  }

  // The installation scope is the one scope that names nothing, and a narrower
  // scope that names nothing would match no floor and no role - a fact that can
  // never be retrieved is worse than a rejected one, because it looks stored.
  let scopeId: string | null = null;
  if (raw.scope !== 'installation') {
    scopeId = typeof raw.scopeId === 'string' ? raw.scopeId.trim() : '';
    if (scopeId === '') {
      return fail(`"scopeId" is required when "scope" is "${raw.scope}".`);
    }
  } else if (raw.scopeId !== undefined && raw.scopeId !== null && raw.scopeId !== '') {
    return fail('"scopeId" must be omitted when "scope" is "installation".');
  }

  const source =
    typeof raw.source === 'string' && raw.source.trim() !== ''
      ? raw.source.trim().slice(0, MEMORY_SOURCE_LIMIT)
      : null;

  // Default confidence is deliberately middling rather than maximal: a fact
  // nobody has vouched for beyond writing it down should not outrank one an
  // operator deliberately rated, and it should not be treated as worthless.
  let confidence = 0.6;
  if (raw.confidence !== undefined && raw.confidence !== null) {
    const n = Number(raw.confidence);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return fail('"confidence" must be a number between 0 and 1.');
    }
    confidence = n;
  }

  const supersedes =
    typeof raw.supersedes === 'string' && raw.supersedes.trim() !== '' ? raw.supersedes.trim() : null;

  return {
    ok: true,
    error: null,
    value: {
      scope: raw.scope,
      scopeId,
      kind: raw.kind,
      text,
      tags: normalizeTags(raw.tags),
      source,
      confidence,
      supersedes,
    },
  };
}
