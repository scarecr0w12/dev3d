/**
 * Provider-adapter vocabulary.
 *
 * These are the *adapter* types: the shape the LLM layer speaks internally.
 * The shared domain contracts (`@dev3d/core`) stay upstream; adapters translate
 * between the two. Keeping a small `LlmToolSchema` here (rather than reusing
 * core `ToolSchema`) lets each adapter map to its vendor wire format without
 * dragging domain concerns into the transport.
 */

import type { ChatMessage, ModelSpec, ToolCallRequest, UsageRecord } from '@dev3d/core';

/** A tool as passed to a model: a JSON-Schema argument shape. */
export interface LlmToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: ModelSpec;
  messages: ChatMessage[];
  tools?: LlmToolSchema[];
  temperature?: number;
  maxOutputTokens?: number;
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  reasoning: string | null;
  toolCalls: ToolCallRequest[];
  usage: UsageRecord;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

export interface LlmProvider {
  id: string;
  label: string;
  models: ModelSpec[];
  isConfigured(): boolean;
  chat(req: ChatRequest): Promise<ChatResult>;
}
