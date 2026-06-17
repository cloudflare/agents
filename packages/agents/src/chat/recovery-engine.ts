/**
 * Shared chat-recovery engine policy (sibling-package support for
 * `@cloudflare/ai-chat` and `@cloudflare/think`). This is the first slice of the
 * recovery engine: orchestration *decisions* that both packages must make
 * identically, kept pure and unit-testable. See
 * `design/rfc-chat-recovery-foundation.md`.
 *
 * @internal Not a public API.
 */

/** The scheduled-callback entrypoints a recovery schedule can target. */
export type ChatRecoveryScheduleCallback =
  | "_chatRecoveryContinue"
  | "_chatRecoveryRetry";

/**
 * Why a recovery callback is being scheduled. The idempotency of the underlying
 * `schedule()` call depends ONLY on this:
 *
 * - `"initial"` — the first schedule of a continuation/retry when an interrupted
 *   turn is detected on wake. A deploy rollout drops/reconnects the socket
 *   several times, re-triggering detection; idempotent scheduling (dedup on
 *   callback + payload) collapses that storm into a single enqueued continuation
 *   instead of N duplicates.
 *
 * - `"stable_timeout_retry"` — a reschedule issued from INSIDE the currently-
 *   executing one-shot schedule row (a continuation that timed out waiting for
 *   stable state). `alarm()` deletes that row only AFTER the callback returns,
 *   so an idempotent reschedule would dedup onto the doomed row and be deleted
 *   with it — the retry would never fire. A fresh (non-idempotent) delayed row
 *   survives the deletion.
 */
export type ChatRecoveryScheduleReason = "initial" | "stable_timeout_retry";

/**
 * Resolve the `schedule()` idempotency option for a recovery schedule. Single
 * source of truth for both packages; see {@link ChatRecoveryScheduleReason} for
 * the rationale behind each case.
 *
 * This is a cutover invariant: flipping either case silently breaks deploy-storm
 * dedup (initial) or stalls stable-timeout retries (reschedule), and neither is
 * caught by a type error — only by the recovery suites.
 */
export function chatRecoverySchedulePolicy(
  reason: ChatRecoveryScheduleReason
): { idempotent: boolean } {
  return { idempotent: reason === "initial" };
}
