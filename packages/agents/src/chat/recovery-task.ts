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

/** Host operations used by the shared recovery Task definition. */
export type ChatRecoveryTaskHooks = {
  /** Dispatch the named continuation through its existing host entry point. */
  dispatch(
    callback: ChatRecoveryScheduleCallback,
    data: Record<string, unknown>
  ): Promise<void>;
};

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
 * and callback. Chained retries are intentionally unkeyed because they are
 * enqueued while the preceding run still exists. Non-retention releases the
 * initial key when the run settles.
 */
export function chatRecoveryTaskRunOptions(
  input: ChatRecoveryTaskInput,
  reason: ChatRecoveryTaskReason
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
      () => hooks.dispatch(input.callback, input.data)
    );
  };
}
