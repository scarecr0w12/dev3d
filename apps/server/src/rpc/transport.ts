/**
 * The transport contract, and the subprocess slices a stdio transport uses.
 *
 * Deliberately protocol-agnostic, and shared: **MCP and the Agent Client
 * Protocol both speak JSON-RPC 2.0 over a newline-delimited stdio wire**, so the
 * framing, the stderr ring, the start handshake and the kill sequence are the
 * same problem twice. Two copies of that would drift, and the part most likely
 * to drift is the part that has to be bounded correctly.
 *
 * ## Why the interface is a callback and not a promise
 *
 * `onMessage` registers **once**, and every inbound message goes to that handler.
 * A transport that returned a promise per message would have to match responses
 * to requests itself - which is the client's job, because only the client knows
 * which ids it issued and what it is waiting for.
 *
 * That split is what makes both clients testable without a process: the protocol
 * logic takes a transport, and a fake transport is twenty lines.
 */

import type { EventEmitter } from 'node:events';

export interface JsonRpcTransport {
  /** Human-readable name for logs and error messages, e.g. `stdio:npx foo`. */
  readonly label: string;
  /** Start the transport. Resolves once it can carry messages. */
  start(): Promise<void>;
  /** Send one message. */
  send(message: unknown): void;
  /** Register the handler that receives every inbound message. */
  onMessage(handler: (raw: unknown) => void): void;
  /** Register a handler for transport-level failure. */
  onError(handler: (error: Error) => void): void;
  /** Stop the transport and release whatever it holds. Must be idempotent. */
  close(): Promise<void>;
}

/**
 * The slices of a child process the transports actually use.
 *
 * Narrowed deliberately: `spawn` can then be injected in a test without a real
 * child process being involved, which is the only way to exercise the framing
 * and error paths on a machine where a sandbox forbids piped stdio altogether.
 *
 * **Every stream is nullable**, because a caller may spawn with `stdio: 'ignore'`
 * on any descriptor. The one-shot vendor transport does exactly that for stdin
 * when the prompt travels in `argv` — closing it so a harness that reads stdin
 * cannot block waiting for input that is never coming — while the stdio transport
 * always pipes all three. A shared type has to admit both, and the alternative
 * was two nearly-identical seams that could not be faked with one test double.
 */
export interface ChildLike extends EventEmitter {
  readonly stdin: { write(chunk: string): unknown; end(): unknown; destroyed: boolean } | null;
  readonly stdout: (EventEmitter & { setEncoding(encoding: string): unknown }) | null;
  readonly stderr: (EventEmitter & { setEncoding(encoding: string): unknown }) | null;
  kill(signal?: NodeJS.Signals): boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => ChildLike;
