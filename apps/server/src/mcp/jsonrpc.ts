/**
 * JSON-RPC 2.0, the wire format MCP is built on.
 *
 * Implemented here rather than taken from the MCP SDK because the surface this
 * project needs is small — request, response, notification, error — and the
 * server already runs on Node built-ins plus `ws`. A dependency would have to
 * bring a transport stack with it, and the transports are the part this codebase
 * wants to own so they can be bounded the way the tools are.
 *
 * Spec: https://www.jsonrpc.org/specification
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: JsonRpcError;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** Standard JSON-RPC error codes, plus the one MCP adds. */
export const RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** MCP: the server understood the request but refuses it (e.g. no consent). */
  mcpDenied: -32000,
} as const;

/** Is this value a JSON-RPC failure response rather than a success? */
export function isFailure(msg: JsonRpcResponse): msg is JsonRpcFailure {
  return 'error' in msg;
}

/** Build a request. Ids are supplied by the caller so they can be correlated. */
export function request(id: JsonRpcId, method: string, params?: unknown): JsonRpcRequest {
  const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method };
  if (params !== undefined) msg.params = params;
  return msg;
}

/** Build a notification (a request with no id, which expects no reply). */
export function notification(method: string, params?: unknown): JsonRpcNotification {
  const msg: JsonRpcNotification = { jsonrpc: '2.0', method };
  if (params !== undefined) msg.params = params;
  return msg;
}

/**
 * Read one inbound message.
 *
 * Returns `null` for anything that is not a well-formed JSON-RPC message. The
 * caller decides what to do about that: for a response it means the peer is
 * speaking something else, which is worth reporting rather than crashing on.
 */
export function parseMessage(raw: unknown): JsonRpcRequest | JsonRpcNotification | JsonRpcResponse | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const msg = raw as Record<string, unknown>;
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // A response carries no method; make sure it at least has an id and one of
    // result/error before accepting it.
    if (msg.jsonrpc !== '2.0') return null;
    if (msg.id === undefined) return null;
    if (!('result' in msg) && !('error' in msg)) return null;
    return msg as unknown as JsonRpcResponse;
  }
  if ('id' in msg && msg.id !== null && msg.id !== undefined) {
    return msg as unknown as JsonRpcRequest;
  }
  return msg as unknown as JsonRpcNotification;
}
