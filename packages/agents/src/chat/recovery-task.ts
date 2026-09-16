/**
 * Chat recovery transport on the Tasks capability.
 *
 * Each continuation attempt is one short Task run. The Task waits for any
 * requested backoff, dispatches the bounded host callback through model
 * handoff, then disappears after terminal settlement. The durable recovery
 * incident remains the source of truth for attempt and work budgets.
 *
 * @internal Sibling-package support for AI Chat and Think.
 */

import { isPlatformFailure, tryN } from "../retries";
import type { TaskRunOptions, TaskStep } from "../tasks/types";
import type { ChatRecoveryScheduleCallback } from "./recovery-engine";

/** Reserved Task definition shared by the chat hosts. */
export const CHAT_RECOVERY_TASK_NAME = "__cf_internal_chat_recovery";

/** Input persisted for one recovery continuation attempt. */
export type ChatRecoveryTaskInput = {
  /** Host continuation to dispatch. */
  readonly callback: ChatRecoveryScheduleCallback;
  /** Continuation context owned by the chat host. */
  readonly data: Record<string, unknown>;
  /** Durable delay before dispatch, in seconds. */
  readonly delaySeconds: number;
};

/** Why a recovery attempt is being enqueued. */
export type ChatRecoveryTaskReason =
  | "initial"
  | "stable_timeout_retry"
  | "redefer";

/** The host's bounded entry point for each continuation callback. */
export type ChatRecoveryTaskHooks = Record<
  ChatRecoveryScheduleCallback,
  (data: Record<string, unknown>) => Promise<void>
>;

/** How a bounded recovery callback hands its model turn to the alarm domain. */
export type ChatRecoveryHandoff = {
  /**
   * Start the detached continuation. It calls `onTurnStarted` once the model
   * turn begins — the point after which the bounded callback returns.
   */
  readonly detached: (onTurnStarted: () => void) => Promise<void>;
  /** Keep the detached turn inside the current alarm's breaker domain. */
  readonly track: (turn: Promise<void>) => void;
  /**
   * Enqueue exactly one replacement attempt for a detached platform
   * failure. `dedupeKey` is stable across every retried call for the same
   * failure (see {@link dispatchChatRecoveryToHandoff}): acceptance may
   * throw after already durably creating the run — most likely on the
   * wake-mirror push, not the run insert itself — so a naive retry of an
   * unkeyed enqueue risks creating another one. Pass it straight through as
   * the run's `runId` so a retry joins that same row instead.
   */
  readonly redefer: (dedupeKey: string) => Promise<void>;
  /** Report a detached failure the turn's own bookkeeping already handled. */
  readonly onDetachedError: (error: unknown) => void;
};

/**
 * Run a queue-driven recovery callback up to its model handoff, then return.
 *
 * The recovered turn can legitimately run for a long time, and awaiting it
 * would hold the Lifecycle job loop, starving every other job on the object.
 * A failure before the handoff rejects here, so the executing Task run (or
 * compatibility schedule row) keeps ownership and the driver's
 * platform-failure deferral applies (#1730). After the handoff the turn is
 * detached alarm work: a platform failure enqueues one replacement attempt,
 * retried a few times since the completed Task no longer owns this incident
 * and a failure here would otherwise abandon it silently, and any other
 * failure belongs to the turn's own incident bookkeeping.
 */
export async function dispatchChatRecoveryToHandoff(
  handoff: ChatRecoveryHandoff
): Promise<void> {
  let handedOff = false;
  let signalHandoff: () => void = () => {};
  const reachedTurn = new Promise<void>((resolve) => {
    signalHandoff = () => {
      handedOff = true;
      resolve();
    };
  });
  const turn = handoff.detached(signalHandoff);
  const tracked = reachedTurn.then(() => handoff.track(turn));
  turn.catch((error) => {
    if (!handedOff) return;
    if (isPlatformFailure(error)) {
      // A failed attempt may still have durably created the run before
      // throwing — acceptance can fail on the wake-mirror push after the
      // insert already committed — so every retry reuses the SAME key
      // instead of generating a fresh one per attempt: a rejected enqueue
      // does not prove nothing was created. Surface the last failure the
      // same way an unowned detached error already is, rather than
      // swallowing it: no Task run is left to report through.
      const dedupeKey = crypto.randomUUID();
      void tryN(3, () => handoff.redefer(dedupeKey), {
        baseDelayMs: 50,
        maxDelayMs: 500
      }).catch((redeferError) => handoff.onDetachedError(redeferError));
      return;
    }
    handoff.onDetachedError(error);
  });
  await Promise.race([turn, tracked]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseChatRecoveryTaskInput(input: unknown): ChatRecoveryTaskInput {
  if (!isRecord(input)) {
    throw new Error("Chat recovery Task input must be an object");
  }
  const callback = input.callback;
  if (
    callback !== "_chatRecoveryContinue" &&
    callback !== "_chatRecoveryRetry"
  ) {
    throw new Error("Chat recovery Task input has an unknown callback");
  }
  if (!isRecord(input.data)) {
    throw new Error("Chat recovery Task input data must be an object");
  }
  const delaySeconds = input.delaySeconds;
  if (
    typeof delaySeconds !== "number" ||
    !Number.isFinite(delaySeconds) ||
    delaySeconds < 0
  ) {
    throw new Error(
      "Chat recovery Task delaySeconds must be a finite non-negative number"
    );
  }
  return { callback, data: input.data, delaySeconds };
}

/**
 * Build run options for one recovery attempt.
 *
 * Initial detection joins an existing in-flight attempt for the same incident
 * and callback. Chained retries are otherwise unkeyed because each one is
 * enqueued while the preceding run still exists — a genuinely new attempt,
 * not a retry of this same enqueue. `dedupeKey`, when supplied, keys this
 * specific enqueue call by `runId` instead: every retry of one failed
 * `redefer` (see {@link dispatchChatRecoveryToHandoff}) reuses the same key,
 * so a rejected-but-already-inserted attempt is joined rather than
 * duplicated. Non-retention releases the initial key when the run settles.
 */
export function chatRecoveryTaskRunOptions(
  input: ChatRecoveryTaskInput,
  reason: ChatRecoveryTaskReason,
  dedupeKey?: string
): TaskRunOptions {
  const incidentId =
    typeof input.data.incidentId === "string"
      ? input.data.incidentId
      : undefined;
  const recoveredRequestId =
    typeof input.data.recoveredRequestId === "string"
      ? input.data.recoveredRequestId
      : undefined;

  return {
    retain: false,
    ...(dedupeKey !== undefined ? { runId: dedupeKey } : {}),
    ...(reason === "initial" && incidentId
      ? {
          idempotencyKey: `chat-recovery:${input.callback}:${incidentId}`
        }
      : {}),
    metadata: {
      callback: input.callback,
      ...(incidentId ? { incidentId } : {}),
      ...(recoveredRequestId ? { recoveredRequestId } : {})
    }
  };
}

/** Build the shared recovery Task handler for one chat host. */
export function createChatRecoveryTaskDefinition(
  hooks: ChatRecoveryTaskHooks
): (input: unknown, step: TaskStep) => Promise<void> {
  return async (unknownInput, step) => {
    const input = parseChatRecoveryTaskInput(unknownInput);
    if (input.delaySeconds > 0) {
      await step.sleep("backoff", input.delaySeconds * 1000);
    }
    await step.do(
      "continuation",
      {
        retries: { limit: 3, delay: 100, backoff: "exponential" },
        timeout: "15 minutes"
      },
      () => hooks[input.callback](input.data)
    );
  };
}
