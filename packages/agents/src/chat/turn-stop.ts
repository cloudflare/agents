/**
 * The one rule for a chat turn that fails after it was stopped, for every
 * kind of turn in `@cloudflare/ai-chat` and `@cloudflare/think`.
 *
 * A stop aborts the turn's signal: `abortRequest(id, reason)`, a client's
 * cancel, the `signal` a caller passed to `saveMessages`, `continueLastTurn`
 * or `chat()`, a cancelled agent-tool run. Whatever is waiting on that
 * signal then fails, and it fails with the abort's reason: a provider call
 * rejects with `"my reason"` or with the caller's `Error`, not with an
 * `AbortError`. Deciding "stopped or failed" from the thrown value would
 * report a stop that carries a reason as an error, and only when the
 * failure wins the race against the next chunk.
 *
 * So the signal decides. A turn whose own signal aborted was stopped, and
 * ends `aborted` whatever it threw: no error hook, no error frame, no
 * `onError` to an RPC caller. The reason stays the abort's reason.
 *
 * The stall watchdog also aborts the signal, to free a hung provider call.
 * That is the runtime's abort and not a stop: chat recovery continues the
 * turn. It aborts with a {@link ChatStreamStalledError}, which is how it is
 * told apart.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import { ChatStreamStalledError } from "./stall-watchdog";

/**
 * Whether the turn that owns `signal` was stopped.
 *
 * @param signal - The turn's own abort signal.
 * @returns `true` when the signal aborted for anything but a stall.
 */
export function isTurnStopped(signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true &&
    !(signal.reason instanceof ChatStreamStalledError)
  );
}

/**
 * The reason a recovery attempt's turn is aborted with when another turn
 * took its reply over (`ChatRecoveryEngine.supersedeScheduledRecovery`).
 * The runtime's own abort, like a stall: it is not a user's stop, so the
 * host's stop work (cancelling an agent-tool run, a scheduled recovery)
 * does not run for it.
 */
export class ChatRecoverySupersededError extends Error {
  constructor() {
    super("Another turn continued this recovery's reply.");
    this.name = "ChatRecoverySupersededError";
  }
}
