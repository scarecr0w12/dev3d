/**
 * Anthropic Messages API adapter.
 *
 * Translates the shared `ChatMessage[]` shape into Anthropic's `system` +
 * content-block form, and back again. Tool calls become `tool_use` blocks on
 * the assistant side and `tool_result` blocks (wrapped in a user message) on
 * the tool-result side. Streaming is Anthropic's SSE event stream.
 */

import type { ChatMessage, DiscoveredModel, ToolCallRequest, UsageRecord } from '@dev3d/core';
import type { ProviderConfig } from '../config.ts';
import { isProviderConfigured } from '../config.ts';
import type { ChatRequest, ChatResult, LlmProvider, LlmToolSchema } from './types.ts';
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

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

interface AnthropicResponse {
  content?: Array<{
    type?: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
  stop_reason?: string;
  usage?: AnthropicUsage;
}

/**
 * A reported usage block.
 *
 * `thinking_tokens` is Anthropic's split of the output bill: extended thinking is
 * billed at the output rate and routinely dominates it, so a total with no split
 * is a number an operator cannot account for.
 */
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  content_block?: { type?: string; id?: string; name?: string; input?: unknown };
  message?: { usage?: { input_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
}

function mapStopReason(r: string | undefined): ChatResult['finishReason'] {
  if (r === 'tool_use') return 'tool_calls';
  if (r === 'max_tokens') return 'length';
  if (r === 'end_turn' || r === 'stop_sequence') return 'stop';
  return 'error';
}

function translateMessages(messages: ChatMessage[]): {
  system: string;
  messages: AnthropicMessage[];
} {
  const system: string[] = [];
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }],
      });
      continue;
    }
    const blocks: Block[] = [];
    if (m.content) blocks.push({ type: 'text', text: m.content });
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      for (const tc of m.toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.argumentsJson);
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
      }
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: blocks });
  }
  return { system: system.join('\n\n'), messages: out };
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
  usage: AnthropicResponse['usage'],
  req: ChatRequest,
  text: string,
  reasoning: string | null,
  toolCalls: ToolCallRequest[],
): UsageRecord {
  const tokensIn = usage?.input_tokens ?? estimateTokensIn(req.messages);
  let outChars = text.length + (reasoning?.length ?? 0);
  for (const tc of toolCalls) outChars += tc.name.length + tc.argumentsJson.length;
  const tokensOut = usage?.output_tokens ?? Math.max(1, Math.round(outChars / 4));
  const out: UsageRecord = {
    tokensIn,
    tokensOut,
    costUsd: computeCost(req.model, tokensIn, tokensOut),
    // An estimate and a bill used to be drawn identically. They still may be
    // numerically wrong, but they are no longer indistinguishable.
    ...(usage?.input_tokens === undefined || usage.output_tokens === undefined ? { estimated: true } : {}),
  };
  // Extended thinking is billed as output and is often most of it. Anthropic
  // reports the split; folding it in and saying nothing is how a bill stops being
  // explicable.
  const thinking = usage?.thinking_tokens;
  if (typeof thinking === 'number' && Number.isFinite(thinking) && thinking > 0) {
    out.reasoningTokens = Math.min(Math.round(thinking), tokensOut);
  }
  return out;
}

function parseResponse(json: AnthropicResponse, req: ChatRequest): ChatResult {
  let text = '';
  let reasoning: string | null = null;
  const toolCalls: ToolCallRequest[] = [];
  for (const block of json.content ?? []) {
    if (!block) continue;
    if (block.type === 'text') {
      text += typeof block.text === 'string' ? block.text : '';
    } else if (block.type === 'thinking') {
      reasoning = (reasoning ?? '') + (typeof block.thinking === 'string' ? block.thinking : '');
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: typeof block.id === 'string' ? block.id : `toolu_${toolCalls.length}`,
        name: typeof block.name === 'string' ? block.name : '',
        argumentsJson: JSON.stringify(block.input ?? {}),
      });
    }
  }
  return {
    text,
    reasoning,
    toolCalls,
    usage: buildUsage(json.usage, req, text, reasoning, toolCalls),
    finishReason: mapStopReason(json.stop_reason),
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
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  /** Reset on every chunk: a slow stream is fine, a silent one is not. */
  let idleTimer: NodeJS.Timeout | undefined;
  let stalled = false;

  const armIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stalled = true;
      void reader.cancel().catch(() => {});
    }, STREAM_IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  };

  const processLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '') return;
    let ev: AnthropicStreamEvent;
    try {
      ev = JSON.parse(data) as AnthropicStreamEvent;
    } catch {
      return;
    }

    if (ev.type === 'message_start') {
      inputTokens = ev.message?.usage?.input_tokens;
      return;
    }
    if (ev.type === 'content_block_start') {
      const block = ev.content_block;
      if (block?.type === 'tool_use') {
        const index = typeof ev.index === 'number' ? ev.index : toolCalls.length;
        const slot = (toolCalls[index] ??= {
          id: typeof block.id === 'string' ? block.id : `toolu_${index}`,
          name: typeof block.name === 'string' ? block.name : '',
          argumentsJson: '',
        });
        if (typeof block.id === 'string') slot.id = block.id;
        if (typeof block.name === 'string') slot.name = block.name;
      }
      return;
    }
    if (ev.type === 'content_block_delta') {
      const delta = ev.delta;
      if (!delta) return;
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        text += delta.text;
        req.onDelta?.(delta.text);
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        reasoning = (reasoning ?? '') + delta.thinking;
        req.onReasoning?.(delta.thinking);
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const index = typeof ev.index === 'number' ? ev.index : 0;
        const slot = (toolCalls[index] ??= { id: `toolu_${index}`, name: '', argumentsJson: '' });
        slot.argumentsJson += delta.partial_json;
      }
      return;
    }
    if (ev.type === 'message_delta') {
      outputTokens = ev.usage?.output_tokens;
      const sr = ev.delta?.stop_reason;
      if (sr !== undefined) finishReason = mapStopReason(sr);
      return;
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
    usage: buildUsage(
      { input_tokens: inputTokens, output_tokens: outputTokens },
      req,
      text,
      reasoning,
      toolCalls,
    ),
    finishReason,
  };
}

export function createAnthropicProvider(cfg: ProviderConfig): LlmProvider {
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');

  function authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey ?? '',
      'anthropic-version': '2023-06-01',
    };
  }

  const provider: LlmProvider = {
    id: cfg.id,
    label: cfg.label,
    models: [],
    isConfigured: () => isProviderConfigured(cfg),

    /**
     * `GET /models` on the Messages API. Anthropic spells the human label
     * `display_name`, which the shared parser understands; everything else it
     * returns (a creation date, a type) is either mapped or ignored.
     */
    async listModels(): Promise<DiscoveredModel[]> {
      const resp = await fetch(`${baseUrl}/models?limit=1000`, {
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

    async chat(req: ChatRequest): Promise<ChatResult> {
      const { system, messages } = translateMessages(req.messages);

      const body: Record<string, unknown> = {
        model: req.model.id,
        max_tokens: req.maxOutputTokens ?? req.model.maxOutputTokens,
        messages,
      };
      if (system) body.system = system;
      if (req.tools && req.tools.length > 0) {
        body.tools = req.tools.map((t: LlmToolSchema) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }));
      }
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.onDelta) body.stream = true;

      const headers: Record<string, string> = authHeaders();

      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
        const signal = deadlineSignal(
          req.onDelta ? REQUEST_CEILING_MS : FIRST_BYTE_TIMEOUT_MS,
          req.signal,
        );
        try {
          const resp = await fetch(`${baseUrl}/messages`, {
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
          const json = (await resp.json()) as AnthropicResponse;
          return parseResponse(json, req);
        } catch (err) {
          if (req.signal?.aborted === true) throw err;
          if (attempt <= MAX_RETRIES && isRetryableError(err)) {
            lastError = err;
            await delay(retryDelayMs(attempt), req.signal);
            continue;
          }
          throw err;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(`${cfg.id}: all attempts failed`);
    },
  };

  return provider;
}
