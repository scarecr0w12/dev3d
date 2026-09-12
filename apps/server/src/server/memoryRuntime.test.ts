/**
 * Memory through the runtime.
 *
 * `memory.test.ts` covers the rules of the fact store in isolation. This covers
 * the wiring around it, which is where three things can go wrong that a store
 * test cannot see:
 *
 *  - **the event contract.** A correction must reach the console as one frame
 *    carrying both halves, or every open console briefly holds two facts that
 *    contradict each other;
 *  - **scope resolution.** The runtime derives the readable scopes from a
 *    workspace and a role, and it has to be the only place that does - an engine
 *    that named its own scope could read another floor's memory;
 *  - **the embedding path.** Semantic recall is assembled here from a config
 *    setting and a provider, and either half being missing must leave lexical
 *    recall fully working rather than failing the boot.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@dev3d/core';
import { loadConfig } from '../config.ts';
import { MOCK_EMBEDDING_DIMENSIONS, mockEmbedding } from '../llm/mock.ts';
import { createProviderRegistry } from '../llm/registry.ts';
import { openStore } from '../store/store.ts';
import { createRuntime, type Runtime } from './runtime.ts';

interface Harness {
  runtime: Runtime;
  events: ServerEvent[];
  cleanup(): void;
}

function makeRuntime(
  overrides: Record<string, unknown> = {},
  storeOptions: { vectors?: boolean } = {},
): Harness {
  const base = mkdtempSync(join(tmpdir(), 'dev3d-mem-runtime-'));
  const config = {
    ...loadConfig(),
    workspace: join(base, 'default-workspace'),
    workspacesRoot: join(base, 'projects'),
    dbPath: join(base, 'test.sqlite'),
    llmMode: 'mock' as const,
    logLevel: 'error' as const,
    ...overrides,
  };
  const quiet = (): void => {};
  const store = openStore(config.dbPath, quiet, storeOptions);
  const runtime = createRuntime({
    config,
    store,
    registry: createProviderRegistry(config),
    skills: [],
    log: quiet,
  });
  const events: ServerEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  return {
    runtime,
    events,
    cleanup: () => {
      runtime.close();
      store.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

const fact = (text: string, extra: Record<string, unknown> = {}) => ({
  scope: 'workspace' as const,
  scopeId: 'default',
  kind: 'convention' as const,
  text,
  ...extra,
});

test('a fact written through the runtime is broadcast with both halves of a correction', () => {
  const h = makeRuntime();
  try {
    const created = h.runtime.rememberFact(fact('Deploys go through the release branch.'));
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const first = h.events.find((e) => e.type === 'memory.created');
    assert.ok(first);
    if (first.type !== 'memory.created') return;
    assert.equal(first.superseded, null, 'an addition replaces nothing');

    const corrected = h.runtime.rememberFact(
      fact('Deploys go through the release branch, tagged with the version.', { supersedes: created.fact.id }),
    );
    assert.equal(corrected.ok, true);
    if (!corrected.ok) return;

    const framed = h.events.filter((e) => e.type === 'memory.created');
    assert.equal(framed.length, 2);
    const second = framed[1];
    if (second?.type !== 'memory.created') return;
    // One frame, both facts. A console that received only the addition would show
    // two current conventions that contradict each other.
    assert.equal(second.fact.supersedes, created.fact.id);
    assert.equal(second.superseded?.id, created.fact.id);
    assert.equal(typeof second.superseded?.invalidFrom, 'number');

    // And the refusal path returns an error rather than emitting anything.
    const before = h.events.length;
    const bad = h.runtime.rememberFact(fact('no scope id', { scope: 'role', scopeId: undefined }));
    assert.equal(bad.ok, false);
    assert.equal(h.events.length, before, 'a refused write must not be broadcast');
  } finally {
    h.cleanup();
  }
});

test('retraction is broadcast and the fact stays in the ledger', () => {
  const h = makeRuntime();
  try {
    const created = h.runtime.rememberFact(fact('A convention we will drop.'));
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const retracted = h.runtime.retractFact(created.fact.id);
    assert.equal(retracted.ok, true);

    const event = h.events.find((e) => e.type === 'memory.retracted');
    assert.ok(event);
    if (event.type !== 'memory.retracted') return;
    assert.equal(event.fact.id, created.fact.id);
    assert.equal(event.fact.supersededBy, null, 'a retraction carries no replacement');

    // The ledger is the whole record even though the live state is empty.
    const ledger = h.runtime.memoryLedger();
    assert.equal(ledger.total, 1);
    assert.equal(ledger.inactive, 1);
    assert.equal(h.runtime.state().memory.facts.length, 0);
  } finally {
    h.cleanup();
  }
});

test('recall sees installation facts plus its own floor, and nothing else', () => {
  const h = makeRuntime();
  try {
    h.runtime.rememberFact({ scope: 'installation', kind: 'note', text: 'routing note for everyone' });
    h.runtime.rememberFact({ scope: 'workspace', scopeId: 'default', kind: 'note', text: 'routing note for this floor' });
    h.runtime.rememberFact({ scope: 'workspace', scopeId: 'another-floor', kind: 'note', text: 'routing note for elsewhere' });
    h.runtime.rememberFact({ scope: 'role', scopeId: 'ceo', kind: 'note', text: 'routing note for the ceo' });
    h.runtime.rememberFact({ scope: 'role', scopeId: 'cto', kind: 'note', text: 'routing note for the cto' });

    const asCeo = h.runtime
      .recall({ workspaceId: 'default', roleId: 'ceo', query: 'routing note', limit: 20 })
      .map((f) => f.text)
      .sort();
    assert.deepEqual(asCeo, [
      'routing note for everyone',
      'routing note for the ceo',
      'routing note for this floor',
    ]);

    // The engine asks without a role when there is no employee, and must not see
    // any role's private notes.
    const asNobody = h.runtime
      .recall({ workspaceId: 'default', roleId: null, query: 'routing note', limit: 20 })
      .map((f) => f.text)
      .sort();
    assert.deepEqual(asNobody, ['routing note for everyone', 'routing note for this floor']);
  } finally {
    h.cleanup();
  }
});

test('recall counts a read so ranking has something to learn from', () => {
  const h = makeRuntime();
  try {
    const created = h.runtime.rememberFact(fact('A fact worth counting.'));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(h.runtime.memoryFacts().find((f) => f.id === created.fact.id)?.readCount, 0);

    h.runtime.recall({ workspaceId: 'default', roleId: null, query: 'counting', limit: 5 });
    assert.equal(h.runtime.memoryFacts().find((f) => f.id === created.fact.id)?.readCount, 1);

    // A search that matches nothing must not count as a read of anything.
    h.runtime.recall({ workspaceId: 'default', roleId: null, query: 'nothing-matches-this', limit: 5 });
    assert.equal(h.runtime.memoryFacts().find((f) => f.id === created.fact.id)?.readCount, 1);
  } finally {
    h.cleanup();
  }
});

test('semantic recall stays off when the flag is off, and says so', async () => {
  const h = makeRuntime();
  try {
    assert.equal(h.runtime.memory().semantic(), false);
    const state = h.runtime.state().memory;
    assert.equal(state.semantic, false);
    assert.equal(state.vectorCount, 0);
    // And lexical recall is a complete answer, not a degraded one.
    assert.equal(state.searchable, true);

    h.runtime.rememberFact(fact('A lexical fact about caching.'));
    const hits = await h.runtime.recallAsync({ workspaceId: 'default', roleId: null, query: 'caching', limit: 5 });
    assert.equal(hits.length, 1);
    assert.equal(await h.runtime.embedMemory(10), 0, 'nothing to embed when semantic is off');
  } finally {
    h.cleanup();
  }
});

test('the flag without an embedding endpoint does not claim semantic recall', () => {
  // The index loads, but there is nothing to turn a query into a vector with.
  const h = makeRuntime({ memoryVectors: true }, { vectors: true });
  try {
    assert.equal(h.runtime.memory().semantic(), false);
    assert.equal(h.runtime.state().memory.semantic, false);
    // Lexical recall still works, which is what makes this a configuration
    // rather than a failure.
    assert.equal(h.runtime.state().memory.searchable, true);
  } finally {
    h.cleanup();
  }
});

test('a fact whose embedding is the wrong width is not stored, and recall still answers', async () => {
  // The mock embedder produces 64 dimensions; the index is 768 wide. That is the
  // wrong-model case, and it must fail closed: a vector truncated into these
  // columns would produce distances that are numbers and mean nothing.
  const h = makeRuntime({
    memoryVectors: true,
    memoryEmbedding: { providerId: 'mock', model: 'mock-embed' },
  }, { vectors: true });
  try {
    assert.equal(MOCK_EMBEDDING_DIMENSIONS, 64);

    h.runtime.rememberFact(fact('A fact whose embedding is the wrong width.'));
    assert.equal(await h.runtime.embedMemory(10), 0, 'a wrong-width vector must not be stored');
    assert.equal(h.runtime.state().memory.vectorCount, 0);

    // Refusing the vector must not cost the fact: full text still finds it.
    const hits = await h.runtime.recallAsync({ workspaceId: 'default', roleId: null, query: 'wrong width', limit: 5 });
    assert.equal(hits.length, 1);
  } finally {
    h.cleanup();
  }
});

test('a correctly sized embedding is stored, and semantic recall re-ranks with it', async () => {
  // The model name carries the width, so this exercises the path a real
  // 768-dimension model would take - including that the vector is stored, counted
  // and then used to order results.
  const h = makeRuntime({
    memoryVectors: true,
    memoryEmbedding: { providerId: 'mock', model: 'mock-embed-768' },
  }, { vectors: true });
  try {
    assert.equal(h.runtime.memory().semantic(), true, 'both halves are present');
    assert.equal(h.runtime.state().memory.semantic, true);

    h.runtime.rememberFact(fact('Caching happens in process and never on disk.'));
    h.runtime.rememberFact(fact('The release branch is protected and needs a review.'));
    assert.equal(h.runtime.state().memory.vectorCount, 0, 'nothing is embedded until asked');

    assert.equal(await h.runtime.embedMemory(10), 2, 'both facts must be embedded');
    assert.equal(h.runtime.state().memory.vectorCount, 2);
    assert.equal(await h.runtime.embedMemory(10), 0, 'a second pass has nothing left to do');

    // And a search still answers, now with vectors in play. Full text selected the
    // candidate; the vector only ordered it.
    const hits = await h.runtime.recallAsync({ workspaceId: 'default', roleId: null, query: 'caching', limit: 5 });
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.text, /Caching/);
  } finally {
    h.cleanup();
  }
});

test('a search embeds unembedded facts as it passes, bounded per call', async () => {
  const h = makeRuntime({
    memoryVectors: true,
    memoryEmbedding: { providerId: 'mock', model: 'mock-embed-768' },
  }, { vectors: true });
  try {
    for (let i = 0; i < 3; i += 1) h.runtime.rememberFact(fact(`routing convention number ${i}`));
    assert.equal(h.runtime.state().memory.vectorCount, 0);

    // The lazy path: a search embeds what it needs rather than the operator having
    // to remember to run a backfill first.
    const hits = await h.runtime.recallAsync({ workspaceId: 'default', roleId: null, query: 'routing', limit: 5 });
    assert.equal(hits.length, 3);
    assert.ok(h.runtime.state().memory.vectorCount > 0, 'the search must have embedded something');

    // And an explicit drain finishes the job.
    await h.runtime.embedMemory(64);
    assert.equal(h.runtime.state().memory.vectorCount, 3);
  } finally {
    h.cleanup();
  }
});
test('embedMissing reports how much it drained rather than claiming success', async () => {
  const h = makeRuntime({
    memoryVectors: true,
    memoryEmbedding: { providerId: 'mock', model: 'mock-embed' },
  }, { vectors: true });
  try {
    for (let i = 0; i < 3; i += 1) h.runtime.rememberFact(fact(`fact number ${i}`));
    // Zero embedded is a real answer here (wrong width), not a failure - and the
    // count is what lets a caller say so honestly.
    const drained = await h.runtime.embedMemory(2);
    assert.equal(drained, 0);
    assert.equal(h.runtime.state().memory.facts.length, 3);
  } finally {
    h.cleanup();
  }
});
