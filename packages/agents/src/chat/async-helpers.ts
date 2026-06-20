/**
 * @internal Small async control-flow helpers shared by the chat hosts
 * (`@cloudflare/ai-chat` and `@cloudflare/think`) — not a public API. Extracted
 * so the host idle/stable waits and the interaction-apply completeness drain
 * stay byte-identical across both. See `design/chat-shared-layer.md`.
 */

/**
 * Sentinel returned by {@link awaitWithDeadline} when the deadline elapses
 * before the awaited promise settles. A single shared symbol so both hosts
 * compare against the same identity.
 */
export const TIMED_OUT = Symbol("timed-out");

/**
 * Await `promise`, but give up and resolve to {@link TIMED_OUT} once `deadline`
 * (an absolute `Date.now()` ms timestamp) passes. A `null` deadline waits
 * indefinitely (the promise is returned unchanged). The timeout timer is always
 * cleared so it can't pin the isolate awake past resolution.
 */
export async function awaitWithDeadline<T>(
  promise: Promise<T>,
  deadline: number | null
): Promise<T | typeof TIMED_OUT> {
  if (deadline == null) {
    return promise;
  }
  const remainingMs = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout>;
  const result = await Promise.race([
    promise,
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), remainingMs);
    })
  ]);
  clearTimeout(timer!);
  return result;
}

/**
 * Drain the host's interaction-apply chain so a subsequent completeness check
 * (e.g. `hasIncompleteToolBatch`) sees every tool result that has ALREADY
 * arrived.
 *
 * Bounded by real apply activity (a storage write each), never a fixed timer:
 * `getTail` is re-read after every await because a sibling can extend the tail
 * mid-drain, and the loop stops once the tail stops advancing. Bails early when
 * `hasPending()` goes false (the pending continuation was cleared by a chat
 * clear / turn reset) so a stale drain can't hold the isolate awake.
 */
export async function drainInteractionApplies(
  hasPending: () => boolean,
  getTail: () => Promise<unknown>
): Promise<void> {
  let tail = getTail();
  for (;;) {
    if (!hasPending()) return;
    try {
      await tail;
    } catch {
      // A rejected apply is irrelevant to completeness — re-read and re-check.
    }
    if (getTail() === tail) return;
    tail = getTail();
  }
}
