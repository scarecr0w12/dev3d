/**
 * Deadlines for outbound model calls.
 *
 * The gap this closes: every adapter passed only the *caller's* signal to
 * `fetch` (`llm/openaiCompat.ts`, `llm/anthropic.ts`), and the caller's signal is
 * the run's cancellation token — aborted only when an operator presses Cancel.
 * There was no `AbortSignal.timeout`, no per-request deadline, and no retry
 * anywhere in `llm/`. A provider that accepted the TCP connection and then never
 * answered, or stalled mid-stream after sending headers, therefore never
 * settled: the turn never finished, the employee stayed `thinking`/`working`
 * forever, the run never reached a terminal state, and the only remedy was a
 * restart. On a parallel stage every branch could be stuck at once.
 *
 * Every other outbound call in this codebase was already bounded — MCP HTTP
 * (`mcp/http.ts`), `web_fetch`/`web_search` (`tools/web.ts`), plugin panel
 * fetches (`plugins/panels.ts`), the marketplace (`plugins/host.ts`) — so the
 * model path was an oversight rather than a policy.
 *
 * ## Two deadlines, not one
 *
 * A single total timeout is wrong for streaming. A long answer legitimately
 * takes minutes, and killing it at 60s would break working behaviour. What
 * distinguishes "slow but alive" from "dead" is *progress*: so there is a
 * generous total ceiling, and a much tighter **idle** deadline that is reset
 * every time a byte arrives. A stream that has produced nothing for
 * `IDLE_TIMEOUT_MS` is dead no matter how long its total budget is.
 */

/** No bytes at all for this long means the endpoint is not going to answer. */
export const FIRST_BYTE_TIMEOUT_MS = 90_000;

/**
 * No bytes for this long *between* chunks means the stream has stalled.
 *
 * Longer than a first-byte wait because a reasoning model can legitimately think
 * for a while before the first token of a long answer, and shorter than the
 * total ceiling so a reader that has gone quiet is caught well before the run's
 * own patience is.
 */
export const STREAM_IDLE_TIMEOUT_MS = 180_000;

/**
 * The absolute ceiling on one model call, however busy it looks.
 *
 * Deliberately generous — this is the backstop for "it keeps dribbling bytes
 * forever", not the primary control.
 */
export const REQUEST_CEILING_MS = 1_800_000;

/** How many times one route is retried before the failover chain moves on. */
export const MAX_RETRIES = 2;

/** Base delay for the bounded retry backoff, in milliseconds. */
export const RETRY_BASE_DELAY_MS = 400;

/**
 * Whether a failure is worth retrying on the *same* route.
 *
 * Retrying is only useful for a transient condition. A 400 from a malformed
 * request will fail identically forever, and a 401 needs a human, so both go
 * straight down the fallback chain. A rate limit, a server error, and a
 * connection-level failure do not.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/** Whether an error from `fetch` or a timeout is worth another attempt. */
export function isRetryableError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && RETRYABLE_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : '';
  // `fetch failed` is undici's wrapper around a connection-level problem.
  return /fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(message);
}

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * Backoff before attempt `n` (1-based), with jitter.
 *
 * Jitter matters here because a parallel stage fires several branches at the
 * same provider at the same moment: without it they retry in lockstep and
 * re-create the burst that caused the failure.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(random() * RETRY_BASE_DELAY_MS);
  return Math.min(exponential + jitter, 10_000);
}

/**
 * Compose the caller's cancellation signal with a timeout.
 *
 * `AbortSignal.any` keeps the caller in charge: an operator pressing Cancel
 * still aborts immediately, and the adapter's own `reason` says which of the two
 * fired so the error can be reported honestly rather than as "the operator
 * cancelled" when nobody did.
 */
export function deadlineSignal(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller === undefined ? timeout : AbortSignal.any([caller, timeout]);
}

/**
 * Distinguish "the operator cancelled" from "the endpoint went quiet".
 *
 * Both surface as an `AbortError`, and telling them apart is the difference
 * between a truthful turn error and a misleading one.
 */
export function describeAbort(caller: AbortSignal | undefined, what: string): string {
  if (caller?.aborted === true) return 'The operator cancelled this run.';
  return `${what} stopped responding and the request timed out.`;
}

/** Sleep that respects a caller's cancellation. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((settle, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      settle();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
