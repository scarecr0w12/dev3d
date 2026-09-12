/**
 * Tests for `recall` - the read half of memory.
 *
 * The tool itself is thin; what is worth testing is its behaviour at the edges,
 * because those are the cases where a memory feature quietly becomes harmful:
 *
 *  - an engine with **no memory configured** must say so, rather than returning
 *    "nothing matches", which a model would reasonably read as "this project has
 *    no conventions";
 *  - an **empty result** is a real answer and must not be an error, or the model
 *    will retry the search instead of going and reading the code;
 *  - the tool must never be able to widen its own scope, which is why it takes a
 *    callback rather than a store.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { MemoryFact } from '@dev3d/core';
import { createMemoryTools, renderFacts } from './memory.ts';
import type { Tool, ToolContext } from './types.ts';

function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: 'fact_1',
    scope: 'workspace',
    scopeId: 'default',
    kind: 'convention',
    text: 'Tests run with --test-isolation=none.',
    origin: 'operator',
    tags: ['testing'],
    source: null,
    confidence: 0.6,
    createdAt: 1,
    updatedAt: 1,
    validFrom: 1,
    invalidFrom: null,
    supersededBy: null,
    supersedes: null,
    readCount: 0,
    lastReadAt: null,
    ...overrides,
  };
}

function context(recall?: (query: string, limit: number) => MemoryFact[]): ToolContext {
  return {
    workspaceRoot: '/workspace',
    writtenPaths: new Set<string>(),
    plan: [],
    requestApproval: async () => true,
    autoApproveShell: false,
    log: () => {},
    ...(recall === undefined ? {} : { recall }),
  };
}

function recallTool(): Tool {
  const tool = createMemoryTools().find((t) => t.name === 'recall');
  assert.ok(tool, 'the recall tool must exist');
  return tool;
}

test('recall returns matching facts with their scope and kind', async () => {
  const seen: Array<{ query: string; limit: number }> = [];
  const result = await recallTool().run(
    { query: 'tests', limit: 3 },
    context((query, limit) => {
      seen.push({ query, limit });
      return [fact()];
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(seen, [{ query: 'tests', limit: 3 }]);
  // Scope and kind are what make a fact readable: a pitfall is a warning, a
  // convention is a rule, and where it applies decides how much it binds.
  assert.match(result.content, /convention/);
  assert.match(result.content, /workspace default/);
  assert.match(result.content, /test-isolation/);
  assert.match(result.preview, /1 fact\(s\)/);
  assert.deepEqual(result.affectsPaths, []);
});

test('an engine without memory says so instead of claiming nothing matches', async () => {
  const result = await recallTool().run({ query: 'anything' }, context());

  // This is the distinction that matters. "No memory configured" and "nothing
  // matches" lead a model to different places, and conflating them would tell it
  // the project has no conventions when in fact nobody is keeping any.
  assert.equal(result.ok, false);
  assert.match(result.content, /no memory configured/i);
  assert.doesNotMatch(result.content, /nothing on record/i);
});

test('an empty result is a successful answer, not an error', async () => {
  const result = await recallTool().run({ query: 'unheard-of' }, context(() => []));

  assert.equal(result.ok, true);
  assert.match(result.content, /Nothing on record matches/);
  // And it must actively discourage inventing the convention instead.
  assert.match(result.content, /do not assume a convention exists/i);
});

test('an empty query lists rather than searching, and says so', async () => {
  const seen: string[] = [];
  const result = await recallTool().run(
    {},
    context((query) => {
      seen.push(query);
      return [];
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(seen, ['']);
  assert.match(result.content, /Nothing has been written down/);
});

test('recall refuses a malformed query or limit rather than coercing it', async () => {
  const tool = recallTool();
  const ctx = context(() => [fact()]);

  const badQuery = await tool.run({ query: 42 }, ctx);
  assert.equal(badQuery.ok, false);
  assert.match(badQuery.content, /"query" must be a string/);

  const badLimit = await tool.run({ limit: 0 }, ctx);
  assert.equal(badLimit.ok, false);
  assert.match(badLimit.content, /positive integer/);

  const negative = await tool.run({ limit: -5 }, ctx);
  assert.equal(negative.ok, false);
});

test('the limit is capped so one call cannot flood the prompt', async () => {
  const seen: number[] = [];
  await recallTool().run(
    { limit: 10_000 },
    context((_query, limit) => {
      seen.push(limit);
      return [];
    }),
  );
  assert.deepEqual(seen, [25]);
});

test('renderFacts names the scope of every fact and admits an empty store', () => {
  assert.equal(renderFacts([]), '(nothing on record matches that)');
  const rendered = renderFacts([
    fact({ scope: 'installation', scopeId: null, kind: 'pitfall', text: 'never resolve outside the root' }),
    fact({ id: 'fact_2', scope: 'role', scopeId: 'ceo', text: 'report in one page' }),
  ]);
  assert.match(rendered, /\(pitfall, everywhere\)/);
  assert.match(rendered, /\(convention, role ceo\)/);
  assert.match(rendered, /testing/);
});

test('a source is shown when there is one, and omitted when there is not', () => {
  const withSource = renderFacts([fact({ source: 'docs/development.md' })]);
  assert.match(withSource, /source: docs\/development\.md/);
  const without = renderFacts([fact({ source: null })]);
  assert.doesNotMatch(without, /source:/);
});
