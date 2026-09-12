/**
 * The office's single WebSocket connection.
 *
 * One socket carries everything: the server pushes `ServerEvent`s, the client
 * sends `ClientCommand`s. This class owns the transport concerns so the store
 * can stay a pure reducer:
 *
 *  - connect / auto-reconnect with exponential backoff plus jitter,
 *  - a bounded outbound queue so a brief typed during a blip is not lost,
 *  - a keepalive `ping` so proxies do not silently drop an idle socket,
 *  - a status stream the UI renders as the connection chip.
 *
 * It never throws at its callers: malformed frames are reported and dropped.
 */

import type { ClientCommand, ServerEvent } from '@dev3d/core';

export type SocketStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SocketStatusUpdate {
  status: SocketStatus;
  /** How many consecutive failed attempts; 0 once connected. */
  attempt: number;
  /** Last transport-level problem, for the UI. */
  error: string | null;
  /** When the status last changed. */
  at: number;
}

export interface OfficeSocketOptions {
  url: string;
  onEvent: (event: ServerEvent) => void;
  onStatus: (update: SocketStatusUpdate) => void;
  /** `resumed` is true for any open after the first, so the app can resync. */
  onOpen?: (resumed: boolean) => void;
  /** Frames that could not be understood; surfaced as a console warning. */
  onProtocolError?: (message: string) => void;
}

const MAX_QUEUE = 64;
const BASE_DELAY_MS = 400;
const MAX_DELAY_MS = 20_000;
const PING_INTERVAL_MS = 25_000;

function backoffDelay(attempt: number): number {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(attempt, 8));
  // Full-ish jitter: without it every tab in the office reconnects in lockstep.
  return Math.round(exponential * (0.7 + Math.random() * 0.6));
}

function isServerEvent(value: unknown): value is ServerEvent {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && type.length > 0;
}

export class OfficeSocket {
  private readonly options: OfficeSocketOptions;
  private socket: WebSocket | null = null;
  private queue: ClientCommand[] = [];
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private disposed = false;
  private opened = false;
  private currentStatus: SocketStatus = 'idle';
  private attempt = 0;
  private lastError: string | null = null;

  constructor(options: OfficeSocketOptions) {
    this.options = options;
  }

  get status(): SocketStatus {
    return this.currentStatus;
  }

  /** Opens the socket. Safe to call once; call `dispose()` before re-using. */
  connect(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.setStatus('connecting', this.attempt, null);

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url);
    } catch (error) {
      this.setStatus('reconnecting', this.attempt, error instanceof Error ? error.message : String(error));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.disposed) return;
      const resumed = this.opened;
      this.opened = true;
      this.attempt = 0;
      this.setStatus('open', 0, null);
      this.flushQueue();
      this.startPing();
      this.options.onOpen?.(resumed);
    };

    socket.onmessage = (message: MessageEvent<unknown>) => {
      if (this.disposed) return;
      if (typeof message.data !== 'string') {
        this.options.onProtocolError?.('ignored a non-text websocket frame');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data) as unknown;
      } catch {
        this.options.onProtocolError?.('ignored a websocket frame that was not JSON');
        return;
      }
      if (!isServerEvent(parsed)) {
        this.options.onProtocolError?.('ignored a websocket frame with no event type');
        return;
      }
      this.options.onEvent(parsed);
    };

    socket.onerror = () => {
      if (this.disposed) return;
      // Browsers give no detail here on purpose; the close handler follows.
      this.setStatus(this.currentStatus === 'open' ? 'open' : 'reconnecting', this.attempt, 'socket error');
    };

    socket.onclose = (event: CloseEvent) => {
      if (this.disposed) return;
      this.stopPing();
      this.socket = null;
      this.attempt += 1;
      const reason = event.reason && event.reason.length > 0 ? event.reason : `closed (code ${event.code})`;
      this.setStatus('reconnecting', this.attempt, reason);
      this.scheduleReconnect();
    };
  }

  /** Sends a command, or queues it until the socket is open. */
  send(command: ClientCommand): void {
    if (this.disposed) return;
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(command));
      } catch (error) {
        this.options.onProtocolError?.(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push(command);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.stopPing();
    this.queue = [];
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, 'client disposed');
      }
    }
    this.setStatus('closed', this.attempt, null);
  }

  private flushQueue(): void {
    const pending = this.queue;
    this.queue = [];
    for (const command of pending) this.send(command);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.send({ type: 'ping' });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    const delay = backoffDelay(this.attempt);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setStatus(status: SocketStatus, attempt: number, error: string | null): void {
    const changed = this.currentStatus !== status || this.attempt !== attempt || this.lastError !== error;
    this.currentStatus = status;
    this.attempt = attempt;
    this.lastError = error;
    if (!changed) return;
    this.options.onStatus({ status, attempt, error, at: Date.now() });
  }
}

/** Builds the same-origin websocket URL, allowing an explicit override. */
export function resolveSocketUrl(): string {
  const override = import.meta.env.VITE_WS_URL;
  if (typeof override === 'string' && override.length > 0) return override;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}
