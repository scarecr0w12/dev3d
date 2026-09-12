/**
 * Anthropic Messages API adapter.
 *
 * Translates the shared `ChatMessage[]` shape into Anthropic's `system` +
 * content-block form, and back again. Tool calls become `tool_use` blocks on
 * the assistant side and `tool_result` blocks (wrapped in a user message) on
 * the tool-result side. Streaming is Anthropic's SSE event stream.
 */

import type { ChatMessage, ToolCallRequest, UsageRecord } from '@dev3d/core';
import type { ProviderConfig } from '../config.ts';
import { isProviderConfigured } from '../config.ts';
import type { ChatRequest, ChatResult, LlmProvider, LlmToolSchema } from './types.ts';
import { computeCost } from './pricing.ts';

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
  usage?: { input_tokens?: number; output_tokens?: number };
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
  return { tokensIn, tokensOut, costUsd: computeCost(req.model, tokensIn, tokensOut) };
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

  const provider: LlmProvider = {
    id: cfg.id,
    label: cfg.label,
    models: [],
    isConfigured: () => isProviderConfigured(cfg),

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

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      };

      const resp = await fetch(`${baseUrl}/messages`, {
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
      const json = (await resp.json()) as AnthropicResponse;
      return parseResponse(json, req);
    },
  };

  return provider;
}
