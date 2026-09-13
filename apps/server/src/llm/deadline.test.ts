/**
 * Tests for the outbound-call deadlines and retry policy.
 *
 * The bug this exists for: the LLM adapters passed only the caller's cancellation
 * signal to `fetch`, and that signal is the run's Cancel token. A provider that
 * accepted the TCP connection and then never answered never settled the turn —
 * the employee stayed `thinking` forever and the run never reached a terminal
 * state. There was no timeout anywhere in `llm/`, and no retry either.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  MAX_RETRIES,
  REQUEST_CEILING_MS,
  deadlineSignal,
  delay,
  describeAbort,
  isRetryableError,
  isRetryableStatus,
  retryDelayMs,
} from './deadline.ts';

test('a retryable status is retried and a permanent one is not', () => {
  // Transient: worth another attempt on the same route.
  for (const status of [408, 409, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableStatus(status), true, `${status} should be retryable`);
  }
  // Permanent: retrying cannot help, so the failover chain should move on.
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isRetryableStatus(status), false, `${status} should not be retried`);
  }
});

test('connection-level failures are retryable and a Cancel is not', () => {
  assert.equal(isRetryableError(new Error('fetch failed')), true);
  assert.equal(isRetryableError(new Error('read ECONNRESET')), true);
  assert.equal(isRetryableError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), true);
  assert.equal(isRetryableError(Object.assign(new Error('x'), { name: 'TimeoutError' })), true);
  // A malformed request is a programming error, not a transient condition.
  assert.equal(isRetryableError(new Error('HTTP 400 from deepseek: bad model')), false);
  assert.equal(isRetryableError(undefined), false);
});

test('backoff grows and is jittered, so parallel branches do not retry in lockstep', () => {
  const first = retryDelayMs(1, () => 0);
  const second = retryDelayMs(2, () => 0);
  const third = retryDelayMs(3, () => 0);
  assert.ok(second > first && third > second, 'backoff should grow');
  // Two branches given different random draws get different delays.
  assert.notEqual(retryDelayMs(2, () => 0), retryDelayMs(2, () => 0.9));
  // Bounded, so a long outage does not produce an absurd wait.
  assert.ok(retryDelayMs(50, () => 1) <= 10_000);
});

test('the deadline signal aborts on its own, and a caller can still abort first', async () => {
  // Fires without any caller involvement.
  const solo = deadlineSignal(20);
  await assert.rejects(
    () => new Promise((_, reject) => solo.addEventListener('abort', () => reject(solo.reason))),
    undefined,
  );

  // A caller aborting first wins, and is distinguishable in the reason.
  const caller = new AbortController();
  const composed = deadlineSignal(REQUEST_CEILING_MS, caller.signal);
  caller.abort();
  assert.equal(composed.aborted, true);
  assert.equal(describeAbort(caller.signal, 'deepseek'), 'The operator cancelled this run.');

  // With no caller abort, the message says the endpoint went quiet instead of
  // blaming an operator who did nothing.
  const timedOut = new AbortController();
  const quiet = deadlineSignal(REQUEST_CEILING_MS, timedOut.signal);
  assert.equal(describeAbort(timedOut.signal, 'deepseek'), 'deepseek stopped responding and the request timed out.');
  assert.equal(quiet.aborted, false);
});

test('a server that accepts the connection and never answers is abandoned', async () => {
  // The exact shape of the wedge: headers never sent, connection held open.
  const held: Array<() => void> = [];
  const server = createServer((_req, _res) => {
    // Deliberately never responds.
    held.push(() => _res.end());
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  try {
    const started = Date.now();
    // A short deadline stands in for FIRST_BYTE_TIMEOUT_MS so the test is fast;
    // the mechanism is identical.
    await assert.rejects(
      () =>
        fetch(`http://127.0.0.1:${port}/chat/completions`, {
          method: 'POST',
          signal: deadlineSignal(150),
          body: '{}',
        }),
      (err: unknown) => {
        const name = (err as { name?: string }).name;
        assert.ok(name === 'TimeoutError' || name === 'AbortError', `expected an abort, got ${String(err)}`);
        assert.ok(isRetryableError(err), 'this must be classified as retryable');
        return true;
      },
    );
    assert.ok(Date.now() - started < 5_000, 'the deadline must actually bound the wait');
  } finally {
    for (const release of held) release();
    server.closeAllConnections?.();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('delay rejects rather than resolving when the caller cancels', async () => {
  const controller = new AbortController();
  const pending = delay(5_000, controller.signal);
  controller.abort();
  await assert.rejects(() => pending);
  // And an already-aborted signal does not wait at all.
  const already = new AbortController();
  already.abort();
  await assert.rejects(() => delay(5_000, already.signal));
});

test('the retry budget is small and explicit', () => {
  assert.equal(MAX_RETRIES, 2);
});
