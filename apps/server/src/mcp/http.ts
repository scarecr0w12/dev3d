/**
 * Streamable HTTP transport: an MCP server reached over http(s).
 *
 * The shape, per the MCP specification:
 *
 *  - Every message is `POST`ed to one endpoint.
 *  - The reply is either `application/json` (one response) or
 *    `text/event-stream` (a stream that carries the response, and possibly
 *    server-initiated messages before it).
 *  - A session, once the server issues one, is carried in `Mcp-Session-Id`.
 *  - `DELETE` with that header ends the session.
 *
 * Requests are sent with `fetch`, which Node 24 provides, so this adds no
 * dependency. Streaming is read through the response body reader rather than
 * `EventSource`, because `EventSource` only does GET and cannot carry a POST
 * body or custom headers.
 */

import type { McpTransport } from './client.ts';

export interface HttpTransportOptions {
  url: string;
  /** Extra headers, e.g. an `Authorization` bearer token. */
  headers?: Record<string, string>;
  /** How long to wait for the response headers of one POST. */
  requestTimeoutMs?: number;
  /**
   * How long an event stream may stay open with no data before it is abandoned.
   * Without this a silent server would hold the connection for ever.
   */
  streamIdleTimeoutMs?: number;
  onNoise?: (line: string) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;

export class HttpTransport implements McpTransport {
  readonly label: string;
  private readonly options: HttpTransportOptions;
  private handler: ((raw: unknown) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private sessionId: string | null = null;
  private closed = false;
  private readonly inFlight = new Set<AbortController>();

  constructor(options: HttpTransportOptions) {
    this.options = options;
    this.label = `http:${options.url}`;
  }

  /** The session the server issued, if any. */
  get session(): string | null {
    return this.sessionId;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error(`${this.label} is closed.`);
    // Nothing to open: the endpoint is contacted per request. Existence is
    // established by the `initialize` call that follows.
  }

  send(message: unknown): void {
    if (this.closed) throw new Error(`${this.label} is closed.`);
    const controller = new AbortController();
    this.inFlight.add(controller);
    void this.post(message, controller)
      .catch((err: unknown) => {
        this.errorHandler?.(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        this.inFlight.delete(controller);
      });
  }

  onMessage(handler: (raw: unknown) => void): void {
    this.handler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();

    // Best-effort session teardown. A server that does not support it answers
    // 405, which is not an error worth reporting.
    if (this.sessionId !== null) {
      const session = this.sessionId;
      this.sessionId = null;
      try {
        await fetch(this.options.url, {
          method: 'DELETE',
          headers: this.headers(),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // ignore: the session will expire on its own
      }
      void session;
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      // Both types are acceptable on the way in; the server picks.
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(this.options.headers ?? {}),
    };
    if (this.sessionId !== null) headers['mcp-session-id'] = this.sessionId;
    return headers;
  }

  private async post(message: unknown, controller: AbortController): Promise<void> {
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    timeout.unref?.();

    let response: Response;
    try {
      response = await fetch(this.options.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } catch (e) {
      if (this.closed) return;
      throw new Error(`${this.label} request failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timeout);
    }

    // The server may issue a session on any response; remember the first one.
    const issued = response.headers.get('mcp-session-id');
    if (issued !== null && issued !== '' && this.sessionId === null) this.sessionId = issued;

    if (response.status === 202 || response.status === 204) return; // notification accepted

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `${this.label} answered ${response.status} ${response.statusText}${body === '' ? '' : `: ${truncate(body)}`}`,
      );
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('text/event-stream')) {
      await this.readEventStream(response, controller);
      return;
    }

    const text = await response.text();
    if (text.trim() === '') return;
    this.deliverJson(text);
  }

  /** Read an SSE response, dispatching every `data:` payload as a message. */
  private async readEventStream(response: Response, controller: AbortController): Promise<void> {
    const body = response.body;
    if (body === null) return;

    const idleLimit = this.options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), idleLimit);
      idleTimer.unref?.();
    };

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      resetIdle();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdle();
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line.
        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const event = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          this.handleEvent(event);
          split = buffer.indexOf('\n\n');
        }
      }
      if (buffer.trim() !== '') this.handleEvent(buffer);
    } catch (e) {
      if (!this.closed) {
        throw new Error(`${this.label} stream failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      if (idleTimer !== null) clearTimeout(idleTimer);
      reader.releaseLock?.();
    }
  }

  /** One SSE event block: concatenate its `data:` lines and dispatch. */
  private handleEvent(block: string): void {
    const dataLines: string[] = [];
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trimEnd();
      if (line === '' || line.startsWith(':')) continue;
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    this.deliverJson(dataLines.join('\n'));
  }

  private deliverJson(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.options.onNoise?.(truncate(text));
      return;
    }
    // A batch response is an array; each entry is a message of its own.
    if (Array.isArray(parsed)) {
      for (const entry of parsed) this.handler?.(entry);
      return;
    }
    this.handler?.(parsed);
  }
}

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed;
}
