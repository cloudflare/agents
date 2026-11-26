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

import {
  holdLaneForReply,
  inLaneRecoveryAttempt,
  runHoldingLane
} from "./turn-task";
import { isTaskSuspension } from "../tasks/replay";
import { AsyncLocalStorage } from "node:async_hooks";
import { isPlatformFailure, tryN } from "../retries";
import type { TaskJson } from "../tasks";
import { MAX_SERIALIZED_BYTES } from "../tasks/serialization";
import type { TaskRunOptions, TaskStep } from "../tasks/types";
import type {
  ChatRecoveryAttemptInput,
  ChatRecoveryScheduleCallback
} from "./recovery-engine";

/** Reserved Task definition shared by the chat hosts. */
export const CHAT_RECOVERY_TASK_NAME = "__cf_internal_chat_recovery";

/** Input persisted for one recovery continuation attempt. */
export type ChatRecoveryTaskInput = ChatRecoveryAttemptInput;

/** Why a recovery attempt is being enqueued. */
export type ChatRecoveryTaskReason =
  | "initial"
  | "stable_timeout_retry"
  | "chained_retry"
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
  /** The incident the attempt recovers: a replacement holds its lane. */
  readonly incidentId?: string;
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
  // In a lane run's recovery attempt, a replacement attempt keeps the lane
  // the recovered reply held, until it ends as well.
  const incidentId = handoff.incidentId;
  const holding = inLaneRecoveryAttempt() && incidentId !== undefined;
  let releaseReplacement = () => {};
  const replaced = new Promise<void>((resolve) => {
    releaseReplacement = resolve;
  });
  turn.catch((error) => {
    if (!handedOff) return;
    if (isPlatformFailure(error)) {
      if (holding) replacementHolds.set(incidentId, releaseReplacement);
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
      }).catch((redeferError) => {
        if (holding) {
          replacementHolds.delete(incidentId);
          releaseReplacement();
        }
        handoff.onDetachedError(redeferError);
      });
      return;
    }
    handoff.onDetachedError(error);
  });
  // A lane run's recovery keeps the lane until the recovered reply ends: a
  // question queued behind it must not stream beside it.
  holdLaneForReply(
    turn.catch(async (error) => {
      if (holding && handedOff && isPlatformFailure(error)) await replaced;
    })
  );
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
 * Initial detection joins an existing in-flight attempt for the same incident,
 * callback and schedule number, so a retried enqueue of one schedule creates
 * one run. A later schedule of the same incident carries a newer number and
 * gets its own run: the older run is stale by then and returns without a
 * turn. Chained retries are otherwise unkeyed because each one is
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
  // The schedule's number is part of the key. A second schedule of the same
  // incident has a newer number, which makes the run it would join stale
  // (`recoveryDelivery`), so it must get its own run.
  const delivery =
    typeof input.data.delivery === "number" ? input.data.delivery : undefined;

  return {
    retain: false,
    ...(dedupeKey !== undefined ? { runId: dedupeKey } : {}),
    ...(reason === "initial" && incidentId
      ? {
          idempotencyKey: `chat-recovery:${input.callback}:${incidentId}${
            delivery === undefined ? "" : `:${delivery}`
          }`
        }
      : {}),
    metadata: {
      callback: input.callback,
      ...(incidentId ? { incidentId } : {}),
      ...(recoveredRequestId ? { recoveredRequestId } : {})
    }
  };
}

/**
 * Enqueue one recovery attempt on the Tasks transport. Tasks mirrors a routed
 * dynamic agent's wake to the root's alarm. The run itself, and the
 * continuation's replay, still execute on the host.
 *
 * @param tasks - The host's Tasks capability.
 * @param dedupeKey - Keys a retried enqueue so it joins its own earlier try.
 *   See {@link chatRecoveryTaskRunOptions}.
 */
export async function enqueueChatRecoveryTask(
  tasks: {
    run(
      name: string,
      input: ChatRecoveryTaskInput,
      options: TaskRunOptions
    ): Promise<unknown>;
  },
  input: ChatRecoveryTaskInput,
  reason: ChatRecoveryTaskReason,
  dedupeKey?: string
): Promise<void> {
  // From the alarm, where `trackAlarmWork` keeps the continuation's model
  // turn inside the memory-limit breaker.
  await tasks.run(CHAT_RECOVERY_TASK_NAME, input, {
    ...chatRecoveryTaskRunOptions(input, reason, dedupeKey),
    start: "alarm"
  });
}

/**
 * The release of a lane held for a recovered reply that failed on the
 * platform after its handoff, by incident id: its replacement attempt
 * ({@link dispatchChatRecoveryToHandoff}'s `redefer`) runs holding that
 * lane and releases it when its own recovered reply ends. A reset loses it
 * with the park it holds, which the turn's run then recovers.
 */
const replacementHolds = new Map<string, () => void>();

/** Build the shared recovery Task handler for one chat host. */
export function createChatRecoveryTaskDefinition(
  hooks: ChatRecoveryTaskHooks
): (input: unknown, step: TaskStep) => Promise<void> {
  return async (unknownInput, step) => {
    const input = parseChatRecoveryTaskInput(unknownInput);
    const incidentId = input.data?.incidentId;
    const release =
      typeof incidentId === "string"
        ? replacementHolds.get(incidentId)
        : undefined;
    if (!release || typeof incidentId !== "string") {
      await runChatRecoveryAttempt(step, hooks, input);
      return;
    }
    let reply: Promise<void> | undefined;
    try {
      ({ reply } = await runHoldingLane(() =>
        runChatRecoveryAttempt(step, hooks, input)
      ));
    } catch (error) {
      // Tasks keeps the run for a later wake (a suspension, or a platform
      // failure past the step's retries): so does the hold.
      if (isTaskSuspension(error) || isPlatformFailure(error)) throw error;
      replacementHolds.delete(incidentId);
      release();
      throw error;
    }
    replacementHolds.delete(incidentId);
    if (reply) void reply.finally(release);
    else release();
  };
}

/**
 * Run one recovery attempt as steps of `step`'s run: wait out its backoff,
 * then dispatch the host callback. Shared by the recovery Task and the
 * chat-turn run that recovers its own interrupted turn.
 */
export async function runChatRecoveryAttempt(
  step: TaskStep,
  hooks: ChatRecoveryTaskHooks,
  first: ChatRecoveryAttemptInput
): Promise<void> {
  // An attempt that times out waiting for a stable chat plans the next one
  // (`rescheduleAfterStableTimeout`) into this run, bounded by the
  // incident's attempt budget: the run waits and dispatches it again.
  let input = first;
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    if (input.delaySeconds > 0) {
      await step.sleep(`backoff${suffix}`, input.delaySeconds * 1000);
    }
    const next = await step.do(
      `continuation${suffix}`,
      {
        retries: { limit: 3, delay: 100, backoff: "exponential" },
        timeout: "15 minutes"
      },
      async () => {
        let planned: ChatRecoveryAttemptInput | undefined;
        let open = true;
        try {
          await runAttempt.run(
            (attempt) => {
              if (!open || planned || !journalableAttempt(attempt)) {
                return false;
              }
              planned = attempt;
              return true;
            },
            () => hooks[input.callback](input.data)
          );
        } finally {
          open = false;
        }
        // SAFETY: the attempt is the recovery engine's JSON payload.
        return (planned ?? null) as unknown as TaskJson;
      }
    );
    if (!next) return;
    input = next as unknown as ChatRecoveryAttemptInput;
  }
}

const utf8 = new TextEncoder();

/**
 * Whether a recovery attempt fits in a step result (at most 1 MiB). One
 * carrying a larger request body goes to the recovery Task, whose input is
 * parted.
 */
export function journalableAttempt(attempt: ChatRecoveryAttemptInput): boolean {
  return (
    utf8.encode(JSON.stringify(attempt)).byteLength <=
    MAX_SERIALIZED_BYTES - 1024
  );
}

/** Where a running recovery attempt plans the next one. */
const runAttempt = new AsyncLocalStorage<
  (attempt: ChatRecoveryAttemptInput) => boolean
>();

/**
 * The run of the recovery attempt running now, as a place for the next
 * attempt it plans, or `undefined` outside one. It declines once the
 * attempt's step ended, a second attempt, and one too large to journal.
 */
export function currentRunAttempt():
  | ((attempt: ChatRecoveryAttemptInput) => boolean)
  | undefined {
  return runAttempt.getStore();
}
