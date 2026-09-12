/**
 * OpenAI-compatible chat-completions adapter.
 *
 * Serves every gateway that speaks the `/chat/completions` shape (DeepSeek,
 * OpenAI, OpenRouter, and local runtimes like Ollama/vLLM/LM Studio). Streaming
 * is SSE; tool calls are accumulated delta-by-delta by index. When the API
 * omits `usage` (common on small local runtimes) we fall back to a `chars/4`
 * estimate so cost accounting still works offline.
 */

import type { ChatMessage, ToolCallRequest, UsageRecord } from '@dev3d/core';
import type { ProviderConfig } from '../config.ts';
import { isProviderConfigured } from '../config.ts';
import type { ChatRequest, ChatResult, LlmProvider, LlmToolSchema } from './types.ts';
import { computeCost } from './pricing.ts';

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
  usage?: { prompt_tokens?: number; completion_tokens?: number };
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
  usage: OpenAICompletionResponse['usage'],
  req: ChatRequest,
  text: string,
  reasoning: string | null,
  toolCalls: ToolCallRequest[],
): UsageRecord {
  const tokensIn = usage?.prompt_tokens ?? estimateTokensIn(req.messages);
  let outChars = text.length + (reasoning?.length ?? 0);
  for (const tc of toolCalls) outChars += tc.name.length + tc.argumentsJson.length;
  const tokensOut = usage?.completion_tokens ?? Math.max(1, Math.round(outChars / 4));
  return { tokensIn, tokensOut, costUsd: computeCost(req.model, tokensIn, tokensOut) };
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

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      processLine(line);
    }
    if (done) break;
  }
  if (buffer.trim() !== '') processLine(buffer);

  return {
    text,
    reasoning,
    toolCalls,
    usage: buildUsage(undefined, req, text, reasoning, toolCalls),
    finishReason,
  };
}

export function createOpenAICompatProvider(cfg: ProviderConfig): LlmProvider {
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');

  const provider: LlmProvider = {
    id: cfg.id,
    label: cfg.label,
    models: [],
    isConfigured: () => isProviderConfigured(cfg),

    async chat(req: ChatRequest): Promise<ChatResult> {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      if (cfg.extraHeaders) {
        for (const [k, v] of Object.entries(cfg.extraHeaders)) headers[k] = v;
      }

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
      if (req.onDelta) body.stream = true;

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      });

      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} from ${cfg.id}: ${detail.slice(0, 300)}`);
      }

      if (req.onDelta) return parseStream(resp, req);
      const json = (await resp.json()) as OpenAICompletionResponse;
      return parseCompletion(json, req);
    },
  };

  return provider;
}
