/**
 * Provider-adapter vocabulary.
 *
 * These are the *adapter* types: the shape the LLM layer speaks internally.
 * The shared domain contracts (`@dev3d/core`) stay upstream; adapters translate
 * between the two. Keeping a small `LlmToolSchema` here (rather than reusing
 * core `ToolSchema`) lets each adapter map to its vendor wire format without
 * dragging domain concerns into the transport.
 */

import type { ChatMessage, DiscoveredModel, ModelSpec, ToolCallRequest, UsageRecord } from '@dev3d/core';

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
  /**
   * Ask the provider which models it actually serves, from its own list
   * endpoint.
   *
   * Optional on purpose. A provider without a list endpoint, and the mock
   * adapter, simply do not implement it - and the office falls back to the
   * curated seed rather than treating "I cannot ask" as "there are none". An
   * implementation must **throw** on a failed attempt rather than resolving to
   * an empty list, because "the vendor is down" and "the vendor serves nothing"
   * have opposite consequences for routing.
   */
  listModels?(): Promise<DiscoveredModel[]>;
}
