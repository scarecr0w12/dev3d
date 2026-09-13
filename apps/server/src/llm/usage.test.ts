/**
 * Where a turn's token numbers came from.
 *
 * The review's INFO: reasoning tokens are billed at the output rate, and the
 * `chars/4` fallback folded them into the estimate with no way to tell afterwards
 * that the figure *was* an estimate. Two things follow, and both are tested here:
 * a reported bill and an estimate are now distinguishable, and the reasoning share
 * of a bill is carried through when the provider reports it — because reasoning is
 * routinely most of a completion and a total with no split is a number nobody can
 * account for.
 *
 * The network is stubbed at `globalThis.fetch`, so nothing here leaves the process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { ChatMessage, ModelSpec } from '@dev3d/core';
import type { ProviderConfig } from '../config.ts';
import { createOpenAICompatProvider } from './openaiCompat.ts';
import { createAnthropicProvider } from './anthropic.ts';

const MODEL: ModelSpec = {
  id: 'test-model',
  providerId: 'test',
  label: 'Test',
  tier: 'standard',
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
  costPerMTokIn: 1,
  costPerMTokOut: 2,
  capabilities: { tools: false, vision: false, reasoning: true, streaming: true },
  strengths: [],
};

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hello there' }];

function config(id: string): ProviderConfig {
  return {
    id,
    label: 'Test',
    kind: 'openai-compat',
    baseUrl: 'https://api.test/v1',
    apiKey: 'k',
    keyless: false,
  } as ProviderConfig;
}

/** Run `body` with `fetch` replaced, restoring it however that goes. */
async function withFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  body: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init ?? {})) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** An SSE body, so the streaming path can be driven without a socket. */
function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('a reported bill is marked as reported, and carries its reasoning split', async () => {
  await withFetch(
    () =>
      jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: 'hi' } }],
        usage: { prompt_tokens: 1_200, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 700 } },
      }),
    async () => {
      const provider = createOpenAICompatProvider(config('test'));
      const result = await provider.chat({ model: MODEL, messages: MESSAGES });

      assert.equal(result.usage.tokensIn, 1_200);
      assert.equal(result.usage.tokensOut, 900);
      assert.equal(result.usage.estimated, undefined, 'a reported figure is not an estimate');
      assert.equal(result.usage.reasoningTokens, 700, 'most of the output was reasoning, and that is visible');
      // The cost is the bill's, not the estimate's: 1200 in @ $1/M + 900 out @ $2/M.
      assert.ok(Math.abs(result.usage.costUsd - (1_200 * 1 + 900 * 2) / 1_000_000) < 1e-12);
    },
  );
});

test('an unreported bill is marked as an estimate', async () => {
  await withFetch(
    () => jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'a short answer' } }] }),
    async () => {
      const provider = createOpenAICompatProvider(config('test'));
      const result = await provider.chat({ model: MODEL, messages: MESSAGES });

      assert.equal(result.usage.estimated, true, 'the office guessed, and now says so');
      assert.ok(result.usage.tokensIn >= 1);
      assert.ok(result.usage.tokensOut >= 1);
      assert.equal(result.usage.reasoningTokens, undefined, 'an estimate is never split into reasoning');
    },
  );
});

test('a usage block with no numbers in it counts as unreported', async () => {
  // `usage: {}` is not a report. Treating it as one would mark a guess as a bill —
  // exactly the confusion the flag exists to remove.
  await withFetch(
    () => jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'hi' } }], usage: {} }),
    async () => {
      const provider = createOpenAICompatProvider(config('test'));
      const result = await provider.chat({ model: MODEL, messages: MESSAGES });
      assert.equal(result.usage.estimated, true);
    },
  );
});

test('a reasoning split is never claimed to exceed the output it came from', async () => {
  // Providers do send inconsistent numbers. A share above 100% would be printed as
  // such, so it is clamped rather than trusted.
  await withFetch(
    () =>
      jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: 'hi' } }],
        usage: { prompt_tokens: 10, completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 5_000 } },
      }),
    async () => {
      const provider = createOpenAICompatProvider(config('test'));
      const result = await provider.chat({ model: MODEL, messages: MESSAGES });
      assert.equal(result.usage.reasoningTokens, 100);
    },
  );
});

test('a streamed turn reports usage, and the request asked for it', async () => {
  // `include_usage` is why a streamed turn is a bill rather than an estimate: an
  // OpenAI-compatible endpoint sends no usage block on a stream unless asked.
  let sawIncludeUsage = false;
  await withFetch(
    (_url, init) => {
      const body = JSON.parse(String(init.body ?? '{}')) as { stream_options?: { include_usage?: boolean } };
      sawIncludeUsage = body.stream_options?.include_usage === true;
      return sseResponse([
        { choices: [{ delta: { content: 'he' } }] },
        { choices: [{ delta: { content: 'llo' } }] },
        {
          choices: [{ finish_reason: 'stop', delta: {} }],
          usage: { prompt_tokens: 40, completion_tokens: 55, completion_tokens_details: { reasoning_tokens: 30 } },
        },
      ]);
    },
    async () => {
      const provider = createOpenAICompatProvider(config('test'));
      const deltas: string[] = [];
      const result = await provider.chat({
        model: MODEL,
        messages: MESSAGES,
        onDelta: (text: string) => deltas.push(text),
      });

      assert.equal(sawIncludeUsage, true, 'the request must ask for usage, or there is none to report');
      assert.equal(result.text, 'hello');
      assert.equal(deltas.join(''), 'hello');
      assert.equal(result.usage.estimated, undefined, 'the streamed figure is the provider\'s');
      assert.equal(result.usage.tokensIn, 40);
      assert.equal(result.usage.tokensOut, 55);
      assert.equal(result.usage.reasoningTokens, 30);
    },
  );
});

test('a streamed turn with no usage block is marked as an estimate', async () => {
  await withFetch(
    () =>
      sseResponse([
        { choices: [{ delta: { content: 'hi' } }] },
        { choices: [{ finish_reason: 'stop', delta: {} }] },
      ]),
    async () => {
      const provider = createOpenAICompatProvider(config('test'));
      const result = await provider.chat({ model: MODEL, messages: MESSAGES, onDelta: () => {} });
      assert.equal(result.usage.estimated, true);
    },
  );
});

test('the Anthropic adapter marks an estimate and passes on its thinking split', async () => {
  await withFetch(
    () =>
      jsonResponse({
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 300, output_tokens: 200, thinking_tokens: 150 },
      }),
    async () => {
      const provider = createAnthropicProvider(config('anthropic'));
      const result = await provider.chat({ model: { ...MODEL, providerId: 'anthropic' }, messages: MESSAGES });
      assert.equal(result.usage.estimated, undefined);
      assert.equal(result.usage.reasoningTokens, 150);
      assert.equal(result.usage.tokensOut, 200);
    },
  );

  await withFetch(
    () => jsonResponse({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }),
    async () => {
      const provider = createAnthropicProvider(config('anthropic'));
      const result = await provider.chat({ model: { ...MODEL, providerId: 'anthropic' }, messages: MESSAGES });
      assert.equal(result.usage.estimated, true);
    },
  );
});
