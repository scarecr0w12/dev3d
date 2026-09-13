/**
 * OpenAI-compatible chat-completions adapter.
 *
 * Serves every gateway that speaks the `/chat/completions` shape (DeepSeek,
 * OpenAI, OpenRouter, and local runtimes like Ollama/vLLM/LM Studio). Streaming
 * is SSE; tool calls are accumulated delta-by-delta by index. When the API
 * omits `usage` (common on small local runtimes) we fall back to a `chars/4`
 * estimate so cost accounting still works offline.
 */

import type { ChatMessage, DiscoveredModel, ToolCallRequest, UsageRecord } from '@dev3d/core';
import type { ProviderConfig } from '../config.ts';
import { isProviderConfigured } from '../config.ts';
import type { ChatRequest, ChatResult, EmbedRequest, LlmProvider, LlmToolSchema } from './types.ts';
import { computeCost } from './pricing.ts';
import { parseModelList } from './modelList.ts';
import {
  FIRST_BYTE_TIMEOUT_MS,
  MAX_RETRIES,
  REQUEST_CEILING_MS,
  STREAM_IDLE_TIMEOUT_MS,
  deadlineSignal,
  delay,
  isRetryableError,
  isRetryableStatus,
  retryDelayMs,
} from './deadline.ts';

/**
 * A reported usage block, in the two shapes providers actually send.
 *
 * `completion_tokens_details.reasoning_tokens` is the split that explains a bill:
 * reasoning is billed as output and is often most of it, so a number that folds
 * the two together is one nobody can check.
 */
interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface OpenAICompletionResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: OpenAIUsage;
}

interface OpenAIStreamChunk {
  choices?: Array<{
    finish_reason?: string;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  /**
   * Present on the final chunk when the request asked for it.
   *
   * OpenAI-compatible endpoints do not report usage on a streamed response
   * unless the request sets `stream_options: { include_usage: true }`, and this
   * code never did — so every streamed turn silently fell back to the `chars/4`
   * estimate below, and `costUsd` was an estimate rather than a bill. The
   * estimate still exists as the documented fallback for local runtimes that
   * never report usage, but it is no longer the normal path.
   */
  usage?: OpenAIUsage;
}

function mapFinishReason(r: string | undefined): ChatResult['finishReason'] {
  if (r === 'tool_calls') return 'tool_calls';
  if (r === 'length') return 'length';
  if (r === 'stop') return 'stop';
  return 'error';
}

function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.name !== undefined) out.name = m.name;
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    out.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.argumentsJson },
    }));
  }
  if (m.role === 'tool' && m.toolCallId !== undefined) {
    out.tool_call_id = m.toolCallId;
  }
  return out;
}

function toOpenAITools(tools: LlmToolSchema[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function estimateTokensIn(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length;
    if (m.name !== undefined) chars += m.name.length;
    if (m.toolCalls) {
      for (const tc of m.toolCalls) chars += tc.name.length + tc.argumentsJson.length;
    }
  }
  return Math.max(1, Math.round(chars / 4));
}

function buildUsage(
  usage: OpenAIUsage | undefined,
  req: ChatRequest,
  text: string,
  reasoning: string | null,
  toolCalls: ToolCallRequest[],
): UsageRecord {
  const tokensIn = usage?.prompt_tokens ?? estimateTokensIn(req.messages);
  let outChars = text.length + (reasoning?.length ?? 0);
  for (const tc of toolCalls) outChars += tc.name.length + tc.argumentsJson.length;
  const tokensOut = usage?.completion_tokens ?? Math.max(1, Math.round(outChars / 4));
  const out: UsageRecord = {
    tokensIn,
    tokensOut,
    costUsd: computeCost(req.model, tokensIn, tokensOut),
    // Only a block with at least one number in it counts as reported: an endpoint
    // that sends `usage: {}` is not telling us anything, and the estimate stands.
    ...(usage?.prompt_tokens === undefined || usage.completion_tokens === undefined
      ? { estimated: true }
      : {}),
  };
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoningTokens === 'number' && Number.isFinite(reasoningTokens) && reasoningTokens > 0) {
    out.reasoningTokens = Math.min(Math.round(reasoningTokens), tokensOut);
  }
  return out;
}

function parseCompletion(json: OpenAICompletionResponse, req: ChatRequest): ChatResult {
  const message = json.choices?.[0]?.message ?? {};
  const text = typeof message.content === 'string' ? message.content : '';
  const reasoning =
    typeof message.reasoning_content === 'string'
      ? message.reasoning_content
      : typeof message.reasoning === 'string'
        ? message.reasoning
        : null;
  const toolCalls: ToolCallRequest[] = (message.tool_calls ?? []).map((tc, i) => ({
    id: tc.id ?? `call_${i}`,
    name: tc.function?.name ?? '',
    argumentsJson: tc.function?.arguments ?? '{}',
  }));
  return {
    text,
    reasoning,
    toolCalls,
    usage: buildUsage(json.usage, req, text, reasoning, toolCalls),
    finishReason: mapFinishReason(json.choices?.[0]?.finish_reason),
  };
}

async function parseStream(resp: Response, req: ChatRequest): Promise<ChatResult> {
  const body = resp.body;
  if (!body) throw new Error(`${req.model.providerId}: streaming response had no body`);

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning: string | null = null;
  let finishReason: ChatResult['finishReason'] = 'stop';
  const toolCalls: ToolCallRequest[] = [];
  /** The vendor's own count, when it sends one. Preferred over the estimate. */
  let reportedUsage: OpenAIStreamChunk['usage'];
  /**
   * Reset on every chunk, so a stream that is making progress is never killed
   * for being slow — only one that has gone quiet.
   */
  let idleTimer: NodeJS.Timeout | undefined;
  let stalled = false;

  const armIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stalled = true;
      // Cancelling the reader rejects the pending `read()`, which is the only
      // way out of a stream that will never send another byte.
      void reader.cancel().catch(() => {});
    }, STREAM_IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  };

  const processLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]' || data === '') return;
    let chunk: OpenAIStreamChunk;
    try {
      chunk = JSON.parse(data) as OpenAIStreamChunk;
    } catch {
      return;
    }
    if (chunk.usage !== undefined) reportedUsage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta ?? {};
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      text += delta.content;
      req.onDelta?.(delta.content);
    }
    const rc = delta.reasoning_content ?? delta.reasoning;
    if (typeof rc === 'string' && rc.length > 0) {
      reasoning = (reasoning ?? '') + rc;
      req.onReasoning?.(rc);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = typeof tc.index === 'number' ? tc.index : 0;
        const slot = (toolCalls[index] ??= { id: `call_${index}`, name: '', argumentsJson: '' });
        if (typeof tc.id === 'string' && tc.id.length > 0) slot.id = tc.id;
        if (typeof tc.function?.name === 'string') slot.name = tc.function.name;
        if (typeof tc.function?.arguments === 'string') slot.argumentsJson += tc.function.arguments;
      }
    }
    if (chunk.choices?.[0]?.finish_reason !== undefined) {
      finishReason = mapFinishReason(chunk.choices[0]!.finish_reason);
    }
  };

  try {
    armIdleTimer();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdleTimer();
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        processLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') processLine(buffer);
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
  }

  if (stalled && text === '' && toolCalls.length === 0) {
    throw new Error(
      `${req.model.providerId}: the stream sent nothing for ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s and was abandoned.`,
    );
  }

  return {
    text,
    reasoning,
    toolCalls,
    usage: buildUsage(reportedUsage, req, text, reasoning, toolCalls),
    finishReason,
  };
}

export function createOpenAICompatProvider(cfg: ProviderConfig): LlmProvider {
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');

  function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    if (cfg.extraHeaders) {
      for (const [k, v] of Object.entries(cfg.extraHeaders)) headers[k] = v;
    }
    return headers;
  }

  const provider: LlmProvider = {
    id: cfg.id,
    label: cfg.label,
    models: [],
    isConfigured: () => isProviderConfigured(cfg),

    /**
     * `GET /models`: the vendor's own list, which is the only thing that knows
     * which models exist today. Optional fields it omits stay omitted, so a
     * bare `{id}` answer (DeepSeek's) does not overwrite curated metadata with
     * zeroes.
     */
    async listModels(): Promise<DiscoveredModel[]> {
      const resp = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: { ...authHeaders(), accept: 'application/json' },
        // Bounded, because discovery runs sequentially across providers and a
        // vendor that accepts the connection and never answers would otherwise
        // hold up every provider after it.
        signal: AbortSignal.timeout(FIRST_BYTE_TIMEOUT_MS),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} from ${cfg.id}/models: ${detail.slice(0, 200)}`);
      }
      return parseModelList(await resp.json());
    },

    /**
     * `POST /embeddings`.
     *
     * OpenAI's shape, which OpenRouter and every local runtime's compatibility
     * layer also speak. The result is sorted by `index` before being returned,
     * because the wire format does not promise the order it was asked in and an
     * embedding attached to the wrong fact is a corruption that would never
     * surface as an error.
     */
    async embed(req: EmbedRequest): Promise<number[][]> {
      const resp = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ model: req.model, input: req.texts }),
        ...(req.signal ? { signal: req.signal } : {}),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} from ${cfg.id}/embeddings: ${detail.slice(0, 200)}`);
      }
      const body = (await resp.json()) as {
        data?: Array<{ index?: number; embedding?: number[] }>;
      };
      const rows = body.data ?? [];
      if (rows.length !== req.texts.length) {
        throw new Error(
          `${cfg.id} returned ${rows.length} embedding(s) for ${req.texts.length} input(s).`,
        );
      }
      const ordered: number[][] = new Array(req.texts.length);
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const vector = row?.embedding;
        if (!Array.isArray(vector) || vector.length === 0) {
          throw new Error(`${cfg.id} returned an unusable embedding at position ${i}.`);
        }
        ordered[row?.index ?? i] = vector;
      }
      if (ordered.some((v) => !Array.isArray(v))) {
        throw new Error(`${cfg.id} returned embeddings with inconsistent indexes.`);
      }
      return ordered;
    },

    async chat(req: ChatRequest): Promise<ChatResult> {
      const headers = authHeaders();

      const body: Record<string, unknown> = {
        model: req.model.id,
        messages: req.messages.map(toOpenAIMessage),
      };
      if (req.tools && req.tools.length > 0) {
        body.tools = toOpenAITools(req.tools);
        body.tool_choice = 'auto';
      }
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.maxOutputTokens !== undefined) body.max_tokens = req.maxOutputTokens;
      if (req.onDelta) {
        body.stream = true;
        // Without this the vendor sends no `usage` on a streamed response, and
        // every turn's token count - and therefore its cost - is a `chars/4`
        // estimate. Harmless to a gateway that ignores it.
        body.stream_options = { include_usage: true };
      }

      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
        // The caller's cancellation is composed with a deadline so a provider
        // that accepts the connection and stalls cannot wedge the turn forever.
        const signal = deadlineSignal(
          req.onDelta ? REQUEST_CEILING_MS : FIRST_BYTE_TIMEOUT_MS,
          req.signal,
        );
        try {
          const resp = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
          });

          if (!resp.ok) {
            const detail = await resp.text().catch(() => '');
            const error = new Error(`HTTP ${resp.status} from ${cfg.id}: ${detail.slice(0, 300)}`);
            if (attempt <= MAX_RETRIES && isRetryableStatus(resp.status)) {
              lastError = error;
              await delay(retryDelayMs(attempt), req.signal);
              continue;
            }
            throw error;
          }

          if (req.onDelta) return await parseStream(resp, req);
          const json = (await resp.json()) as OpenAICompletionResponse;
          return parseCompletion(json, req);
        } catch (err) {
          // An operator's Cancel is final: never retry it, and never report it
          // as a transport failure.
          if (req.signal?.aborted === true) throw err;
          if (attempt <= MAX_RETRIES && isRetryableError(err)) {
            lastError = err;
            await delay(retryDelayMs(attempt), req.signal);
            continue;
          }
          if (err instanceof Error && /timed out|stopped responding/.test(err.message)) throw err;
          throw err;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(`${cfg.id}: all attempts failed`);
    },
  };

  return provider;
}
