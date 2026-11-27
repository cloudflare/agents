/**
 * Running one chat recovery attempt as steps of a Task run: the run waits
 * for any requested backoff, then dispatches the bounded host callback
 * through model handoff. The durable recovery incident remains the source
 * of truth for attempt and work budgets. The run is a chat-turn run: the
 * one of the turn being recovered, or one started only for the attempt.
 * The recovery Task's own definition only finishes runs an earlier version
 * enqueued.
 *
 * @internal Sibling-package support for AI Chat and Think.
 */

import {
  holdLaneForReplacement,
  holdLaneForReply,
  inLaneRecoveryAttempt
} from "./turn-task";
import { AsyncLocalStorage } from "node:async_hooks";
import { isPlatformFailure, tryN } from "../retries";
import type { TaskJson } from "../tasks";
import { MAX_SERIALIZED_BYTES } from "../tasks/serialization";
import type { TaskStep } from "../tasks/types";
import type {
  ChatRecoveryAttemptInput,
  ChatRecoveryScheduleCallback
} from "./recovery-engine";

/** Reserved Task definition shared by the chat hosts. */
export const CHAT_RECOVERY_TASK_NAME = "__cf_internal_chat_recovery";

/** Input persisted for one recovery continuation attempt. */
export type ChatRecoveryTaskInput = ChatRecoveryAttemptInput;

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
  // In a lane run's recovery attempt, a replacement attempt keeps the lane
  // the recovered reply held, until it ends as well.
  const holding = inLaneRecoveryAttempt();
  let releaseReplacement = () => {};
  const replaced = new Promise<void>((resolve) => {
    releaseReplacement = resolve;
  });
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
      // The replacement's run id is the key: the hold is found by it.
      const dropHold = holding
        ? holdLaneForReplacement(dedupeKey, releaseReplacement)
        : undefined;
      void tryN(3, () => handoff.redefer(dedupeKey), {
        baseDelayMs: 50,
        maxDelayMs: 500
      }).catch((redeferError) => {
        dropHold?.();
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
 * Build the recovery Task's handler. Nothing enqueues this Task any more:
 * an attempt no turn's run keeps runs in a chat-turn run of its own
 * (`ChatTurns.startAttemptRun`). The definition stays registered to finish
 * the runs an earlier version enqueued, each of which is one attempt, and
 * is removed once no version that enqueued it is supported.
 */
export function createChatRecoveryTaskDefinition(
  hooks: ChatRecoveryTaskHooks
): (input: unknown, step: TaskStep) => Promise<void> {
  return async (unknownInput, step) => {
    await runChatRecoveryAttempt(
      step,
      hooks,
      parseChatRecoveryTaskInput(unknownInput)
    );
  };
}

/**
 * Run one recovery attempt as steps of `step`'s run: wait out its backoff,
 * then dispatch the host callback. `step`'s run is the chat-turn run that
 * recovers its own turn, one started only for the attempt, or a recovery
 * Task run an earlier version enqueued.
 */
export async function runChatRecoveryAttempt(
  step: TaskStep,
  hooks: ChatRecoveryTaskHooks,
  first: ChatRecoveryAttemptInput,
  /**
   * Told `true` as the run starts to wait out a backoff and `false` once
   * that wait is over. A wait that suspends the run is still going.
   */
  backingOff?: (waiting: boolean) => void
): Promise<void> {
  // An attempt that times out waiting for a stable chat plans the next one
  // (`rescheduleAfterStableTimeout`) into this run, bounded by the
  // incident's attempt budget: the run waits and dispatches it again.
  let input = first;
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    if (input.delaySeconds > 0) {
      backingOff?.(true);
      await step.sleep(`backoff${suffix}`, input.delaySeconds * 1000);
      backingOff?.(false);
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
 * carrying a larger request body gets a run of its own, whose input is
 * parted (`ChatTurns.startAttemptRun`).
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
