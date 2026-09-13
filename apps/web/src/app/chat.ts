/**
 * Whether a direct-message thread is still waiting on an answer.
 *
 * Lives outside `ChatThread.tsx` so the verification harness can import it: Node
 * strips types but cannot parse `.tsx`.
 *
 * ## Why this is derived rather than a flag
 *
 * The chat composer used to track "sending" in `useState`. The socket path — the
 * normal one — returned as soon as it had pushed the command, before ever setting
 * the flag, so the operator got no feedback at all between sending a message and
 * the reply. The HTTP fallback did set it, but not in a `finally`, so a rejected
 * request left the Send button disabled with no explanation.
 *
 * The truth is already in the thread. Sending appends an optimistic `local-` echo,
 * and the store keeps that echo until the server's copy of the same message is
 * reconciled against it. So "there is an un-answered echo" is an honest answer to
 * "have we heard back yet", and it holds on the socket path, on the HTTP path, and
 * after a refresh.
 *
 * The patience window stops a dropped socket from showing "…is thinking" forever.
 */

import type { DirectMessage } from '@dev3d/core';

/**
 * How long an unanswered echo counts as "still waiting".
 *
 * Generous, because a frontier model on a hard question genuinely can take this
 * long. Being wrong in this direction costs a missing indicator; being wrong the
 * other way leaves a stuck one.
 */
export const REPLY_PATIENCE_MS = 90_000;

/** Is this thread waiting on a reply from the employee? */
export function pendingEcho(thread: readonly DirectMessage[], now: number): boolean {
  return thread.some(
    (message) =>
      message.id.startsWith('local-') &&
      message.role === 'user' &&
      // Answered when *anything* from the employee has arrived since.
      !thread.some((other) => other.role !== 'user' && other.at >= message.at) &&
      now - message.at < REPLY_PATIENCE_MS,
  );
}
