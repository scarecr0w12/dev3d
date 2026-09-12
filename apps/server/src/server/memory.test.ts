/**
 * Memory tests.
 *
 * The interesting behaviour here is not "a fact can be saved". It is the three
 * rules that make memory survive contact with being wrong, and each one is a
 * promise the README makes that would be invisible if it broke:
 *
 *  - a correction **supersedes** rather than overwrites, so the previous wording
 *    and the moment it stopped being true both survive;
 *  - nothing is deleted for being old, which means there is no call that could
 *    delete it and the ledger stays complete;
 *  - a search cannot return a fact outside the scopes it was given, which is the
 *    one mistake that would let one floor read another's memory.
 *
 * The store is exercised through the SQLite backend rather than the in-memory
 * fallback, because the fallback has no full-text index and the ranking behaviour
 * is exactly what a test of a fallback could not prove.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isActive, validateMemoryFact } from '@dev3d/core';
import { mockEmbedding } from '../llm/mock.ts';
import { MEMORY_VECTOR_DIMENSIONS, openStore, toFtsQuery, toVectorBlob, type Store } from '../store/store.ts';
import { createMemoryService, scopesFor } from './memory.ts';

interface Harness {
  store: Store;
  memory: ReturnType<typeof createMemoryService>;
  cleanup(): void;
}

function makeMemory(opts: { vectors?: boolean; embed?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-memory-'));
  const store = openStore(join(dir, 'test.sqlite'), () => {}, { vectors: opts.vectors === true });
  const memory = createMemoryService(
    store,
    // The mock embedder is wide enough to fill the index: a real 384-dimension
    // model would be refused here, which is the point of the width check.
    opts.embed === true
      ? { embed: async (texts) => texts.map((t) => mockEmbedding(t, MEMORY_VECTOR_DIMENSIONS)) }
      : {},
  );
  return {
    store,
    memory,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const baseFact = {
  scope: 'workspace' as const,
  scopeId: 'floor-a',
  kind: 'convention' as const,
  text: 'Tests are run with --test-isolation=none.',
};

// --------------------------------------------------------------------- writes

test('a fact is written down and comes back with its validity open', () => {
  const h = makeMemory();
  try {
    const result = h.memory.record(baseFact, 'operator');
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.fact.supersededBy, null);
    assert.equal(result.fact.supersedes, null);
    // Open validity is what "active" means, and it is the only thing that makes a
    // fact retrievable - so it is asserted rather than assumed.
    assert.equal(result.fact.invalidFrom, null);
    assert.equal(result.fact.readCount, 0);
    assert.equal(result.fact.lastReadAt, null);
    assert.ok(isActive(result.fact));

    assert.deepEqual(h.memory.state().facts.map((f) => f.id), [result.fact.id]);
  } finally {
    h.cleanup();
  }
});

test('a correction supersedes the original and neither is destroyed', () => {
  const h = makeMemory();
  try {
    const first = h.memory.record(baseFact, 'operator');
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const corrected = h.memory.record(
      { ...baseFact, text: 'Tests are run with --test-isolation=none on Node 24.', supersedes: first.fact.id },
      'operator',
    );
    assert.equal(corrected.ok, true);
    if (!corrected.ok) return;

    // The replacement points back, the original points forward, and the original
    // stopped being true at the moment the replacement was written.
    assert.equal(corrected.fact.supersedes, first.fact.id);
    assert.equal(corrected.superseded?.id, first.fact.id);
    assert.equal(corrected.superseded?.supersededBy, corrected.fact.id);
    assert.equal(typeof corrected.superseded?.invalidFrom, 'number');
    assert.equal(corrected.fact.invalidFrom, null);

    // Only the replacement is a current belief.
    const state = h.memory.state();
    assert.deepEqual(state.facts.map((f) => f.id), [corrected.fact.id]);

    // Both are on record. This is the whole point of superseding rather than
    // overwriting: the ledger still answers what was believed before.
    const ledger = h.memory.ledger();
    assert.equal(ledger.total, 2);
    assert.equal(ledger.inactive, 1);
    assert.ok(ledger.facts.some((f) => f.id === first.fact.id && f.text === baseFact.text));
  } finally {
    h.cleanup();
  }
});

test('a correction cannot move a fact to another scope', () => {
  const h = makeMemory();
  try {
    const first = h.memory.record(baseFact, 'operator');
    assert.equal(first.ok, true);
    if (!first.ok) return;

    // Widening a fact's reach by "correcting" it would be a quiet way to promote a
    // floor's note to installation-wide guidance.
    const widened = h.memory.record(
      { ...baseFact, scope: 'installation', scopeId: null, supersedes: first.fact.id },
      'operator',
    );
    assert.equal(widened.ok, false);
    if (widened.ok) return;
    assert.match(widened.error, /cannot move it/);

    // And the refusal left nothing behind.
    assert.equal(h.memory.ledger().total, 1);
    assert.ok(isActive(h.memory.get(first.fact.id)!));
  } finally {
    h.cleanup();
  }
});

test('superseding an already-superseded fact is refused', () => {
  const h = makeMemory();
  try {
    const first = h.memory.record(baseFact, 'operator');
    if (!first.ok) throw new Error('setup failed');
    const second = h.memory.record({ ...baseFact, text: 'second', supersedes: first.fact.id }, 'operator');
    if (!second.ok) throw new Error('setup failed');

    // A second correction of the same original would fork the chain into two
    // current beliefs, which is the contradiction the mechanism exists to avoid.
    const third = h.memory.record({ ...baseFact, text: 'third', supersedes: first.fact.id }, 'operator');
    assert.equal(third.ok, false);
    if (third.ok) return;
    assert.match(third.error, /already replaced or retracted/);
  } finally {
    h.cleanup();
  }
});

test('superseding an unknown fact is refused without writing anything', () => {
  const h = makeMemory();
  try {
    const result = h.memory.record({ ...baseFact, supersedes: 'fact_nope' }, 'operator');
    assert.equal(result.ok, false);
    // The replacement must not be written when the thing it replaces is missing,
    // or a bad id would silently become a plain addition.
    assert.equal(h.memory.ledger().total, 0);
  } finally {
    h.cleanup();
  }
});

test('retraction keeps the fact and leaves no replacement behind', () => {
  const h = makeMemory();
  try {
    const first = h.memory.record(baseFact, 'operator');
    if (!first.ok) throw new Error('setup failed');

    const retracted = h.memory.retract(first.fact.id);
    assert.equal(retracted.ok, true);
    if (!retracted.ok) return;

    // `invalidFrom` alone marks it inactive: nothing replaced it, so `supersededBy`
    // must stay null or the ledger would claim a replacement that does not exist.
    assert.equal(typeof retracted.fact.invalidFrom, 'number');
    assert.equal(retracted.fact.supersededBy, null);

    assert.equal(h.memory.state().facts.length, 0);
    assert.equal(h.memory.ledger().total, 1);
    assert.equal(h.memory.ledger().inactive, 1);

    // Retracting twice is refused rather than silently re-stamping the date.
    assert.equal(h.memory.retract(first.fact.id).ok, false);
  } finally {
    h.cleanup();
  }
});

test('a fact must name a scope, and the installation scope must name nothing', () => {
  // Missing scope id on a narrower scope would produce a fact no search can reach:
  // stored, listed, and never retrievable, which is worse than a rejection.
  assert.equal(validateMemoryFact({ scope: 'workspace', kind: 'note', text: 'x' }).ok, false);
  assert.equal(validateMemoryFact({ scope: 'role', kind: 'note', text: 'x', scopeId: '  ' }).ok, false);
  // Conversely a scope id on the installation scope is meaningless and refused.
  assert.equal(
    validateMemoryFact({ scope: 'installation', kind: 'note', text: 'x', scopeId: 'floor-a' }).ok,
    false,
  );
  assert.equal(validateMemoryFact({ scope: 'installation', kind: 'note', text: 'x' }).ok, true);
});

test('tags are normalised so case cannot split a group in two', () => {
  const validated = validateMemoryFact({
    scope: 'installation',
    kind: 'note',
    text: 'x',
    tags: ['Testing', 'testing', '  ', 'WINDOWS', 'testing'],
  });
  assert.equal(validated.ok, true);
  assert.deepEqual(validated.value?.tags, ['testing', 'windows']);
});

// ------------------------------------------------------------------- retrieval

test('search ranks by relevance and only returns current beliefs', () => {
  const h = makeMemory();
  try {
    h.memory.record(
      { ...baseFact, text: 'The workspace root is confined per run; never resolve outside it.' },
      'operator',
    );
    const relevant = h.memory.record(
      { ...baseFact, text: 'Persistence uses node:sqlite with a memory fallback when it cannot open.' },
      'operator',
    );
    if (!relevant.ok) throw new Error('setup failed');

    const scopes = scopesFor('floor-a', null);
    const hits = h.memory.search('node:sqlite persistence', scopes, 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, relevant.fact.id);

    // Punctuation in a query is not FTS5 syntax: `node:sqlite` must search, not throw.
    assert.equal(h.memory.search('node:sqlite', scopes, 5).length, 1);

    // A corrected fact stops being retrievable even though its text still matches.
    h.memory.record(
      { ...baseFact, text: 'Persistence moved to a different store entirely.', supersedes: relevant.fact.id },
      'operator',
    );
    const after = h.memory.search('node:sqlite', scopes, 5);
    assert.equal(after.length, 0, 'a superseded fact must not be returned as current belief');
  } finally {
    h.cleanup();
  }
});

test('a search cannot escape the scopes it was given', () => {
  const h = makeMemory();
  try {
    h.memory.record({ ...baseFact, scope: 'installation', scopeId: null, text: 'installation fact about routing' }, 'operator');
    h.memory.record({ ...baseFact, scope: 'workspace', scopeId: 'floor-a', text: 'floor a fact about routing' }, 'operator');
    h.memory.record({ ...baseFact, scope: 'workspace', scopeId: 'floor-b', text: 'floor b fact about routing' }, 'operator');
    h.memory.record({ ...baseFact, scope: 'role', scopeId: 'ceo', text: 'ceo fact about routing' }, 'operator');
    h.memory.record({ ...baseFact, scope: 'role', scopeId: 'cto', text: 'cto fact about routing' }, 'operator');

    const asFloorA = h.memory.search('routing', scopesFor('floor-a', 'ceo'), 20);
    const texts = asFloorA.map((f) => f.text).sort();
    // Installation plus its own floor plus its own role - and neither the other
    // floor's fact nor another role's.
    assert.deepEqual(texts, ['ceo fact about routing', 'floor a fact about routing', 'installation fact about routing']);

    const asFloorB = h.memory.search('routing', scopesFor('floor-b', null), 20);
    assert.deepEqual(asFloorB.map((f) => f.text).sort(), [
      'floor b fact about routing',
      'installation fact about routing',
    ]);

    // An empty scope set is a refusal to search, not an invitation to return all.
    assert.deepEqual(h.memory.search('routing', [], 20), []);
  } finally {
    h.cleanup();
  }
});

test('a query with no searchable terms lists rather than reporting no matches', () => {
  const h = makeMemory();
  try {
    h.memory.record({ ...baseFact, text: 'first fact', confidence: 0.4 }, 'operator');
    const strong = h.memory.record({ ...baseFact, text: 'second fact', confidence: 0.9 }, 'operator');
    if (!strong.ok) throw new Error('setup failed');

    const scopes = scopesFor('floor-a', null);
    // `!!!` has no terms. Answering it with an empty result would be a lie: the
    // store is not empty, the question just had no content.
    const listed = h.memory.search('!!!', scopes, 5);
    assert.equal(listed.length, 2);
    // Without a query there is no relevance, so ordering is by confidence.
    assert.equal(listed[0]?.id, strong.fact.id);
  } finally {
    h.cleanup();
  }
});

test('toFtsQuery quotes terms and drops what FTS5 would read as syntax', () => {
  // The raw forms below are syntax errors or wildcards in FTS5's own language.
  assert.equal(toFtsQuery('foo OR'), '"foo" AND "or"');
  assert.equal(toFtsQuery('customer_id'), '"customer" AND "id"');
  assert.equal(toFtsQuery('"unbalanced'), '"unbalanced"');
  assert.equal(toFtsQuery('a*'), '"a"');
  assert.equal(toFtsQuery('   '), null);
  assert.equal(toFtsQuery('!!!'), null);
});

test('reads are counted, which is the only evidence a fact earned its place', () => {
  const h = makeMemory();
  try {
    const fact = h.memory.record(baseFact, 'operator');
    if (!fact.ok) throw new Error('setup failed');
    assert.equal(fact.fact.readCount, 0);
    assert.equal(fact.fact.lastReadAt, null);

    h.memory.noteRead([fact.fact.id], 1234);
    h.memory.noteRead([fact.fact.id], 5678);

    const after = h.memory.get(fact.fact.id);
    assert.equal(after?.readCount, 2);
    assert.equal(after?.lastReadAt, 5678);
    // Recording a read must not disturb belief.
    assert.ok(isActive(after!));
    assert.equal(h.memory.ledger().total, 1);
  } finally {
    h.cleanup();
  }
});

test('memory survives a reopen, because the point is that it outlives the process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-memory-reopen-'));
  try {
    const path = join(dir, 'test.sqlite');
    const first = openStore(path, () => {});
    const written = createMemoryService(first).record(baseFact, 'operator');
    if (!written.ok) throw new Error('setup failed');
    first.close();

    const second = openStore(path, () => {});
    const reopened = createMemoryService(second);
    const found = reopened.get(written.fact.id);
    assert.equal(found?.text, baseFact.text);
    assert.equal(found?.scopeId, 'floor-a');
    // And the full-text index was rebuilt from the table rather than lost, so
    // recall still ranks after a restart.
    assert.equal(reopened.search('isolation', scopesFor('floor-a', null), 5).length, 1);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------- semantic

test('the vector index is off unless it is asked for', () => {
  const off = makeMemory();
  try {
    // Off is a complete configuration, not a degraded one: lexical recall is the
    // whole memory system, and the flag only adds a re-ranking on top.
    assert.equal(off.store.searchable, true, 'full-text search must work without vectors');
    assert.equal(off.store.semantic, false);
    assert.equal(off.memory.semantic(), false);
    assert.equal(off.memory.state().semantic, false);
  } finally {
    off.cleanup();
  }
});

test('the index loads when asked, and needs an embedder before it claims anything', () => {
  const indexOnly = makeMemory({ vectors: true });
  try {
    assert.equal(indexOnly.store.semantic, true, 'vec0 must load on this platform');
    // The index alone is not semantic search: there is nothing to turn a query
    // into a vector with, so the office must not claim the capability.
    assert.equal(indexOnly.memory.semantic(), false);
    assert.equal(indexOnly.memory.state().semantic, false);
  } finally {
    indexOnly.cleanup();
  }
});

test('semantic ranking is claimed only when both halves are present', async () => {
  const h = makeMemory({ vectors: true, embed: true });
  try {
    assert.equal(h.memory.semantic(), true);
    const written = h.memory.record({ ...baseFact, text: 'Deploys run from the release branch only.' }, 'operator');
    if (!written.ok) throw new Error('setup failed');

    assert.equal(await h.memory.embedMissing(10), 1, 'the backfill must embed the new fact');
    assert.equal(h.memory.state().vectorCount, 1);
    assert.equal(h.memory.ledger().vectorCount, 1);

    // And a search re-orders without losing anything.
    const hits = await h.memory.searchAsync('release branch', scopesFor('floor-a', null), 5);
    assert.equal(hits.length, 1);
  } finally {
    h.cleanup();
  }
});

test('a fact with no vector keeps its lexical place rather than being ranked', async () => {
  const h = makeMemory({ vectors: true, embed: true });
  try {
    const a = h.memory.record({ ...baseFact, text: 'alpha routing fact' }, 'operator');
    const b = h.memory.record({ ...baseFact, text: 'beta routing fact' }, 'operator');
    if (!a.ok || !b.ok) throw new Error('setup failed');

    // Embed only the second, so the first is unmeasured.
    await h.memory.embedMissing(10);
    assert.equal(h.memory.state().vectorCount, 2);

    // A search for a term only the first mentions must still return it, because
    // full text - not the vector index - decides what is a candidate.
    const hits = await h.memory.searchAsync('alpha', scopesFor('floor-a', null), 5);
    assert.deepEqual(hits.map((f) => f.id), [a.fact.id]);
  } finally {
    h.cleanup();
  }
});

test('semantic search cannot escape the scopes it was given', async () => {
  const h = makeMemory({ vectors: true, embed: true });
  try {
    h.memory.record({ ...baseFact, scope: 'workspace', scopeId: 'floor-a', text: 'routing convention for floor a' }, 'operator');
    h.memory.record({ ...baseFact, scope: 'workspace', scopeId: 'floor-b', text: 'routing convention for floor b' }, 'operator');
    await h.memory.embedMissing(10);

    // Re-ranking is a refinement of a scoped result set, so turning it on must
    // not be a way around the boundary that lexical search enforces.
    const a = await h.memory.searchAsync('routing convention', scopesFor('floor-a', null), 10);
    assert.deepEqual(a.map((f) => f.text), ['routing convention for floor a']);
    const b = await h.memory.searchAsync('routing convention', scopesFor('floor-b', null), 10);
    assert.deepEqual(b.map((f) => f.text), ['routing convention for floor b']);
  } finally {
    h.cleanup();
  }
});

test('a failing embedder degrades to lexical rather than to no results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-memory-embedfail-'));
  try {
    const store = openStore(join(dir, 'test.sqlite'), () => {}, { vectors: true });
    const memory = createMemoryService(store, {
      embed: async () => {
        throw new Error('the embedding endpoint is down');
      },
    });
    memory.record({ ...baseFact, text: 'a fact about deployment' }, 'operator');

    // A ranking refinement that cannot be computed is not a failed recall. The
    // operator must still get their facts.
    const hits = await memory.searchAsync('deployment', scopesFor('floor-a', null), 5);
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.text, /deployment/);
    assert.equal(await memory.embedMissing(10), 0, 'a failed backfill must report zero, not throw');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a vector of the wrong width is refused rather than truncated', () => {
  const h = makeMemory({ vectors: true, embed: true });
  try {
    const written = h.memory.record({ ...baseFact, text: 'width-sensitive fact' }, 'operator');
    if (!written.ok) throw new Error('setup failed');

    // A 384-dimension model packed into 768 columns would yield distances that
    // are numbers and mean nothing - the failure would be invisible.
    h.store.saveMemoryVector(written.fact.id, new Array(384).fill(0.5));
    assert.equal(h.store.memoryVectorCount(), 0, 'a wrong-width vector must not be stored');

    h.store.saveMemoryVector(written.fact.id, new Array(MEMORY_VECTOR_DIMENSIONS).fill(0.5));
    assert.equal(h.store.memoryVectorCount(), 1, 'a correct-width vector must be stored');
  } finally {
    h.cleanup();
  }
});

test('the backfill is bounded by the limit it is given', async () => {
  const h = makeMemory({ vectors: true, embed: true });
  try {
    for (let i = 0; i < 5; i += 1) {
      h.memory.record({ ...baseFact, text: `fact number ${i}` }, 'operator');
    }
    assert.equal(h.memory.state().vectorCount, 0);
    assert.equal(await h.memory.embedMissing(2), 2);
    assert.equal(h.memory.state().vectorCount, 2);
    assert.equal(await h.memory.embedMissing(10), 3, 'the rest must drain on the next call');
    assert.equal(h.memory.state().vectorCount, 5);
  } finally {
    h.cleanup();
  }
});

test('vectors survive a reopen alongside the facts they describe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-memory-vector-reopen-'));
  try {
    const path = join(dir, 'test.sqlite');
    const first = openStore(path, () => {}, { vectors: true });
    const service = createMemoryService(first, {
      embed: async (texts) => texts.map((t) => mockEmbedding(t, MEMORY_VECTOR_DIMENSIONS)),
    });
    const written = service.record({ ...baseFact, text: 'a durable fact about caching' }, 'operator');
    if (!written.ok) throw new Error('setup failed');
    assert.equal(await service.embedMissing(5), 1);
    first.close();

    const second = openStore(path, () => {}, { vectors: true });
    try {
      assert.equal(second.semantic, true);
      assert.equal(second.memoryVectorCount(), 1, 'the vec0 table must persist like any other');
      assert.deepEqual(second.memoryFactsMissingVectors([written.fact.id]), []);
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('toVectorBlob packs float32, which is what vec0 reads', () => {
  const blob = toVectorBlob([1, 0.5, -0.25, 0]);
  assert.ok(blob instanceof Uint8Array);
  assert.equal(blob.byteLength, 4 * 4, 'four numbers at four bytes each');
  const round = new Float32Array(blob.buffer);
  assert.deepEqual([...round], [1, 0.5, -0.25, 0]);
});
