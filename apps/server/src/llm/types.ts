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
  /**
   * Turn text into vectors, for the memory layer's optional semantic search.
   *
   * Optional for the same reason `listModels` is, and the omission is
   * meaningful rather than a gap to be filled in later: **not every provider
   * serves embeddings at all.** Anthropic does not; a local runtime usually does
   * not until a model is pulled. So an adapter that cannot embed must leave this
   * unimplemented rather than answering with a substitute, because a fabricated
   * vector would make every semantic search silently meaningless - results that
   * look ranked and are not.
   *
   * The office treats an absent method, and a thrown error, identically: the
   * memory layer runs without semantic search and says so. This must **throw**
   * on failure rather than resolving to an empty array, so that "the request
   * failed" cannot be mistaken for "these texts have no embedding".
   */
  embed?(req: EmbedRequest): Promise<number[][]>;
}

export interface EmbedRequest {
  /** The embedding model to call, as the provider names it. */
  model: string;
  /** The texts to embed, in order. The result must align with this array. */
  texts: string[];
  signal?: AbortSignal;
}

