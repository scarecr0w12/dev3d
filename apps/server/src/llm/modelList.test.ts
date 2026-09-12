/**
 * Model-list parsing, against real captured payloads.
 *
 * Every fixture below is a trimmed copy of a response actually returned by the
 * named provider, not an invented shape. That matters here more than usual: this
 * module reads a document somebody else writes, and the interesting cases are
 * the ones where vendors disagree - DeepSeek answers with two fields, OpenRouter
 * with a price table and a capability list, Anthropic with `display_name`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DISCOVERED_MODELS, parseModelList } from './modelList.ts';

// --------------------------------------------------------------- real payloads

/** `GET https://api.deepseek.com/v1/models` — the whole answer, verbatim. */
const DEEPSEEK = {
  object: 'list',
  data: [
    { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' },
    { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
  ],
};

/** One entry of `GET https://openrouter.ai/api/v1/models`, verbatim. */
const OPENROUTER_GPT4O = {
  id: 'openai/gpt-4o',
  canonical_slug: 'openai/gpt-4o',
  name: 'OpenAI: GPT-4o',
  created: 1715558400,
  description: 'GPT-4o is a multimodal model...',
  context_length: 128000,
  architecture: {
    modality: 'text+image+file->text',
    input_modalities: ['text', 'image', 'file'],
    output_modalities: ['text'],
    tokenizer: 'GPT',
    instruct_type: null,
  },
  pricing: { prompt: '0.0000025', completion: '0.00001', input_cache_read: '0.00000125' },
  top_provider: { context_length: 128000, max_completion_tokens: 16384, is_moderated: true },
  per_request_limits: null,
  supported_parameters: ['temperature', 'tool_choice', 'tools', 'response_format', 'structured_outputs'],
  default_parameters: {},
};

/** A model with a reasoning channel and no vision. */
const OPENROUTER_DEEPSEEK = {
  id: 'deepseek/deepseek-chat-v3.1',
  name: 'DeepSeek: DeepSeek V3.1',
  context_length: 163840,
  architecture: { input_modalities: ['text'], modality: 'text->text' },
  pricing: { prompt: '0.00000025', completion: '0.00000095' },
  top_provider: { context_length: 163840, max_completion_tokens: 32768 },
  supported_parameters: ['max_tokens', 'include_reasoning', 'reasoning', 'tool_choice', 'tools'],
};

/** Anthropic's Messages API list shape. */
const ANTHROPIC = {
  data: [
    { type: 'model', id: 'claude-3-5-sonnet-latest', display_name: 'Claude 3.5 Sonnet', created_at: '2024-10-22T00:00:00Z' },
    { type: 'model', id: 'claude-3-5-haiku-latest', display_name: 'Claude 3.5 Haiku', created_at: '2024-10-22T00:00:00Z' },
  ],
  has_more: false,
  first_id: 'claude-3-5-sonnet-latest',
  last_id: 'claude-3-5-haiku-latest',
};

// ---------------------------------------------------------------------- tests

test('a bare id list parses, with nothing invented', () => {
  const models = parseModelList(DEEPSEEK);
  assert.equal(models.length, 2);
  assert.equal(models[0]?.id, 'deepseek-flash');
  assert.equal(models[0]?.ownedBy, 'deepseek');
  // The vendor said nothing about context, price or tools. Absent must stay
  // absent: a zero price here would make this model win every cost tie, and a
  // `tools: false` would disqualify it from every coding turn.
  assert.equal(models[0]?.contextWindow, undefined);
  assert.equal(models[0]?.costPerMTokIn, undefined);
  assert.equal(models[0]?.capabilities, undefined);
});

test('OpenRouter per-token prices become per-million figures', () => {
  const [model] = parseModelList({ data: [OPENROUTER_GPT4O] });
  assert.ok(model);
  // 0.0000025 per token is $2.50 per million - the real published price.
  assert.equal(model.costPerMTokIn, 2.5);
  assert.equal(model.costPerMTokOut, 10);
  // The description and the cached-input rate are not modelled and must not leak
  // into a field the router reads.
  assert.equal(Object.hasOwn(model, 'description'), false);
});

test('OpenRouter capability lists become tool, vision and reasoning claims', () => {
  const [withVision, withReasoning] = parseModelList({
    data: [OPENROUTER_GPT4O, OPENROUTER_DEEPSEEK],
  });
  assert.equal(withVision?.capabilities?.tools, true);
  assert.equal(withVision?.capabilities?.vision, true);
  assert.equal(withVision?.capabilities?.reasoning, false);

  assert.equal(withReasoning?.capabilities?.tools, true);
  assert.equal(withReasoning?.capabilities?.reasoning, true);
  assert.equal(withReasoning?.capabilities?.vision, false);
});

test('a model list that never mentions tools does not claim it lacks them', () => {
  // A coder model whose listing simply omits `supported_parameters`.
  const [model] = parseModelList({
    data: [{ id: 'qwen/qwen-2.5-coder-32b-instruct', context_length: 32768 }],
  });
  assert.equal(model?.capabilities, undefined);
});

test('OpenRouter context and output limits come from top_provider', () => {
  const [model] = parseModelList({ data: [OPENROUTER_GPT4O] });
  assert.equal(model?.contextWindow, 128000);
  assert.equal(model?.maxOutputTokens, 16384);
  assert.equal(model?.created, 1715558400);
  assert.equal(model?.label, 'OpenAI: GPT-4o');
});

test('Anthropic display_name becomes the label and created_at becomes a timestamp', () => {
  const models = parseModelList(ANTHROPIC);
  assert.equal(models.length, 2);
  assert.equal(models[0]?.id, 'claude-3-5-sonnet-latest');
  assert.equal(models[0]?.label, 'Claude 3.5 Sonnet');
  assert.equal(models[0]?.created, Math.floor(Date.parse('2024-10-22T00:00:00Z') / 1000));
});

test('an unrecognisable body throws rather than reporting an empty catalog', () => {
  // "I do not understand this" and "the vendor serves nothing" must not be the
  // same answer: the first keeps the curated seed, the second would empty it.
  assert.throws(() => parseModelList({ object: 'list' }), /not a model list/);
  assert.throws(() => parseModelList('nonsense'), /not a model list/);
  assert.throws(() => parseModelList(null), /not a model list/);
});

test('an OpenAI-shaped error body surfaces the vendor\u2019s own message', () => {
  assert.throws(
    () => parseModelList({ error: { message: 'Invalid API key provided', code: 401 } }),
    /Invalid API key provided/,
  );
});

test('a recognised list with nothing usable is an empty list, not an error', () => {
  assert.deepEqual(parseModelList({ data: [] }), []);
  // Entries with no id are dropped rather than becoming models called "undefined".
  assert.deepEqual(parseModelList({ data: [{ object: 'model' }, null, 42, { id: '   ' }] }), []);
});

test('duplicate ids collapse, so one model cannot become two fallbacks', () => {
  const models = parseModelList({
    data: [{ id: 'a/one' }, { id: 'a/one' }, { id: 'a/two' }],
  });
  assert.deepEqual(
    models.map((m) => m.id),
    ['a/one', 'a/two'],
  );
});

test('the `models` spelling and a bare array both parse', () => {
  assert.equal(parseModelList({ models: [{ name: 'llama3:8b' }] }).length, 1);
  assert.equal(parseModelList([{ id: 'x' }]).length, 1);
});

test('a per-token price that would scale past any real price is dropped', () => {
  // A gateway reporting an already-per-million number in the per-token slot
  // would become a nonsense figure. Dropping it beats believing it.
  const [model] = parseModelList({ data: [{ id: 'weird', pricing: { prompt: '500', completion: '0.000001' } }] });
  assert.equal(model?.costPerMTokIn, undefined);
  assert.equal(model?.costPerMTokOut, 1);
});

test('an explicit per-million price field is taken at face value', () => {
  const [model] = parseModelList({
    data: [{ id: 'aa/model', cost_per_mtok_in: 1.1, price_1m_output_tokens: 4.4 }],
  });
  assert.equal(model?.costPerMTokIn, 1.1);
  assert.equal(model?.costPerMTokOut, 4.4);
});

test('nonsense numerics are refused rather than floored to zero', () => {
  const [model] = parseModelList({
    data: [
      {
        id: 'bad/numbers',
        context_length: -1,
        max_tokens: Number.NaN,
        pricing: { prompt: '-2', completion: 'Infinity' },
      },
    ],
  });
  assert.equal(model?.contextWindow, undefined);
  assert.equal(model?.maxOutputTokens, undefined);
  assert.equal(model?.costPerMTokIn, undefined);
  assert.equal(model?.costPerMTokOut, undefined);
});

test('the discovered list is bounded', () => {
  const many = { data: Array.from({ length: MAX_DISCOVERED_MODELS + 50 }, (_, i) => ({ id: `m/${i}` })) };
  assert.equal(parseModelList(many).length, MAX_DISCOVERED_MODELS);
});

test('an over-long id is refused instead of entering the catalog', () => {
  assert.deepEqual(parseModelList({ data: [{ id: 'x'.repeat(300) }] }), []);
});
