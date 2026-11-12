/**
 * One recovery attempt: the body of a `_chatRecoveryContinue` or
 * `_chatRecoveryRetry` callback, shared by `AIChatAgent` and `Think`.
 *
 * The order of the checks is the point of this file. Each one is a rule in
 * the `ChatRecovery` model, with a variant that breaks when the check moves:
 *
 * 1. Return if the user cancelled the incident while it was scheduled.
 * 2. Register the attempt, so a cancel by the original request id stops it.
 * 3. Settle the cut-off reply (continue only).
 * 4. Wait until the chat is stable.
 * 5. A stop that landed meanwhile ends the attempt. So does a client's
 *    answer whose own turn continued the reply. Both come before the timeout
 *    branch: such an attempt must not reschedule, park or give up.
 * 6. On timeout: park if a client still has something to answer, else
 *    reschedule, else give up.
 * 7. Skip if the conversation moved.
 * 8. Apply the recovered request context and run the turn with the stop
 *    signal.
 * 9. A stop ends the attempt. A turn that was cut off again and scheduled the
 *    next attempt leaves the incident to that attempt.
 * 10. Record the turn's result on the incident.
 * 11. Always: end the attempt, restore the root request id, reconcile
 *     agent-tool child runs.
 *
 * A throw anywhere after step 2 is caught: see
 * {@link handleRecoveryAttemptError}.
 *
 * @internal Sibling-package support for AI Chat and Think.
 */

import {
  isDurableObjectMemoryLimitReset,
  isPlatformTransientError
} from "../retries";
import type { ClientToolSchema } from "./client-tools";
import type { SaveMessagesResult } from "./lifecycle";
import { CHAT_RECOVERY_CANCELLED_REASON } from "./recovery-engine";
import type {
  ChatRecoveryEngine,
  ChatRecoveryScheduleCallback
} from "./recovery-engine";

/** The part of a recovery schedule payload the attempt reads. */
export type RecoveryAttemptData = {
  incidentId?: string;
  originalRequestId?: string;
  recoveredRequestId?: string;
  /** The body the interrupted request ran with. `null` when it had none. */
  lastBody?: Record<string, unknown> | null;
  /** The client tools it ran with. `null` when it had none. */
  lastClientTools?: ClientToolSchema[] | null;
};

/** What the recovered turn returned. */
export type RecoveredTurnResult = Pick<SaveMessagesResult, "status" | "error">;

/** Whether the message the attempt recovers is still the latest. */
export type RecoveryLeafCheck =
  | { moved: false }
  | {
      moved: true;
      /** The incident's skip reason. */
      reason: "conversation_changed" | "no_unanswered_user_message";
    };

/**
 * What a host supplies for one attempt: the steps that differ between
 * `AIChatAgent` and `Think`, and between a continue and a retry. Everything
 * both hosts do the same way comes from the engine and its adapter's
 * `turns` bindings. The optional members are `Think`'s submission and
 * messenger steps, and the continue-only settle.
 */
export interface RecoveredTurnHost<
  TData extends RecoveryAttemptData,
  TResult extends RecoveredTurnResult
> {
  /** The callback this attempt runs under. */
  callback: ChatRecoveryScheduleCallback;
  /** The schedule payload. */
  data: TData | undefined;

  /** Whether the message this attempt recovers is still the latest. */
  checkLeaf(): Promise<RecoveryLeafCheck>;
  /** Run the turn. `signal` aborts when a client stops the attempt. */
  runTurn(signal: AbortSignal): Promise<TResult>;

  /**
   * Runs after the cancelled check and before the attempt is registered.
   * Return `false` to skip the attempt. The host records why.
   */
  admit?(): Promise<boolean>;
  /** Continue only: settle the dead tool calls of the cut-off reply. */
  settleCutOffReply?(): Promise<void>;
  /** The user stopped the attempt, or cancelled it while it was scheduled. */
  onStopped?(): Promise<void>;
  /**
   * The reply is the client's to continue: the attempt parked on a pending
   * client interaction, or the client's answer already continued the reply.
   */
  onClientContinued?(): Promise<void>;
  /** The attempt was skipped because the conversation moved. */
  onSkipped?(check: RecoveryLeafCheck & { moved: true }): Promise<void>;
  /** Runs before the turn's result is recorded on the incident. */
  beforeOutcome?(result: TResult): Promise<void>;
  /** Runs after the turn's result is recorded on the incident. */
  afterOutcome?(result: TResult): Promise<void>;
  /**
   * Wraps the "failed" incident write made before a platform transient is
   * rethrown, so the host can tell that write from a real failure.
   */
  whileDeferring?(
    incidentId: string,
    write: () => Promise<void>
  ): Promise<void>;
  /** Always runs last, whether or not the attempt was admitted. */
  release?(): void;
}

/**
 * The cut-off reply a recovery continue should settle before it waits: the
 * reply it targets, only while that reply is the latest message, and only
 * when settling changes it. A reply that finished, or one the conversation
 * moved past, is left alone.
 *
 * @param messages - The transcript.
 * @param replyId - The reply the recovery continues.
 * @param settle - Settles a cut-off reply's dead tool calls. Returns its
 *   argument when there is nothing to settle.
 * @returns The reply as stored and as settled, or `null`.
 */
export function cutOffReplyToSettle<
  TMessage extends { id: string; role: string }
>(
  messages: readonly TMessage[],
  replyId: string,
  settle: (reply: TMessage) => TMessage
): { stored: TMessage; settled: TMessage } | null {
  const stored = messages.at(-1);
  if (stored?.id !== replyId || stored.role !== "assistant") return null;
  const settled = settle(stored);
  return settled === stored ? null : { stored, settled };
}

/**
 * Run one recovery attempt. See the file comment for the order.
 *
 * @param engine - The host's recovery engine.
 * @param host - The steps that differ between hosts.
 */
export async function runRecoveredTurn<
  TData extends RecoveryAttemptData,
  TResult extends RecoveredTurnResult
>(
  engine: ChatRecoveryEngine,
  host: RecoveredTurnHost<TData, TResult>
): Promise<void> {
  if (await engine.isRecoveryCancelled(host.data?.incidentId)) {
    await host.onStopped?.();
    return;
  }
  try {
    if (host.admit && !(await host.admit())) return;
    await runAdmittedAttempt(engine, host);
  } finally {
    // Outside the attempt's own `finally`, so what `admit` registered is
    // released even when the attempt never got as far as its `try`.
    host.release?.();
  }
}

async function runAdmittedAttempt<
  TData extends RecoveryAttemptData,
  TResult extends RecoveredTurnResult
>(
  engine: ChatRecoveryEngine,
  host: RecoveredTurnHost<TData, TResult>
): Promise<void> {
  const { callback, data } = host;
  const incidentId = data?.incidentId;
  const turns = engine.turns;
  const previousRootRequestId = engine.activeRootRequestId;
  engine.activeRootRequestId = data?.originalRequestId ?? previousRootRequestId;
  // A client stops this attempt by the original request id: the only id it
  // knows until the recovered turn streams.
  const stop = turns.beginRecoveryAttempt(data?.originalRequestId);
  const recordStop = async (): Promise<void> => {
    await engine.recordRecoveryStop(incidentId);
    await host.onStopped?.();
  };

  try {
    await host.settleCutOffReply?.();
    const config = engine.resolveConfig();
    // The reply was settled above, so anything still pending is a call a
    // client can answer, and the timeout branch parks on it.
    const ready = await turns.waitUntilStable(config.stableTimeoutMs);

    // Before the timeout branch: a stopped attempt must not reschedule,
    // park or give up.
    if (stop.signal.aborted) {
      await recordStop();
      return;
    }
    // Also before the timeout branch, which would reschedule over the mark:
    // a client answered the reply's tool call while this attempt was queued
    // or waiting, and the answer's own turn continued the reply.
    if (await engine.isRecoverySuperseded(incidentId)) {
      await host.onClientContinued?.();
      return;
    }

    if (!ready) {
      // A turn waiting on a client is not stuck. The client's answer starts
      // its own continuation, so spending the attempt budget on the wait
      // would give up on a healthy turn.
      if (engine.isAwaitingClientInteraction()) {
        await engine.updateIncident(
          incidentId,
          "skipped",
          "awaiting_client_interaction"
        );
        await host.onClientContinued?.();
        return;
      }
      console.warn(
        `${turns.label} ${callback} timed out waiting for stable state`
      );
      // Usually transient under deploy churn, so try again within the
      // attempt budget.
      if (
        await engine.rescheduleAfterStableTimeout({
          incidentId,
          callback,
          data,
          fallbackMaxAttempts: config.maxAttempts
        })
      ) {
        return;
      }
      // Budget spent: the same give-up as deploy recovery (`onExhausted` and
      // the terminal message), so the turn does not end as a spinner.
      await engine.exhaustRecoveryGiveUp({
        callback,
        data,
        reason: "stable_timeout"
      });
      return;
    }

    const leaf = await host.checkLeaf();
    if (leaf.moved) {
      await engine.updateIncident(incidentId, "skipped", leaf.reason);
      await host.onSkipped?.(leaf);
      return;
    }

    // The recovered turn runs with the tools and body of the request that
    // was interrupted. A payload that does not name them leaves the stored
    // ones.
    if (data && ("lastClientTools" in data || "lastBody" in data)) {
      turns.restoreRequestContext({
        ...("lastClientTools" in data && {
          lastClientTools: data.lastClientTools ?? undefined
        }),
        ...("lastBody" in data && { lastBody: data.lastBody ?? undefined })
      });
    }
    // Drop a mark an earlier interruption left, so only this turn's own
    // reschedule counts below.
    engine.takeReschedule(incidentId);
    const result = await host.runTurn(stop.signal);

    if (stop.signal.aborted) {
      await recordStop();
      return;
    }
    if (result.status !== "completed" && engine.takeReschedule(incidentId)) {
      // Interrupted again: the attempt it scheduled owns the outcome.
      return;
    }

    await host.beforeOutcome?.(result);
    // A turn that was cut off with the budget spent already gave up and
    // said so. Marking that incident failed would unseal it.
    if (
      result.status === "completed" ||
      !(await engine.isRecoverySealed(incidentId))
    ) {
      // A turn that returns "aborted" here was stopped: by its own request
      // id, a clear, or the host cancelling every chat. (A turn cut off again
      // returned above.) The stop is the outcome, not a failure.
      const stopped = result.status === "aborted";
      await engine.updateIncident(
        incidentId,
        result.status === "completed"
          ? "completed"
          : result.status === "skipped" || stopped
            ? "skipped"
            : "failed",
        stopped ? CHAT_RECOVERY_CANCELLED_REASON : result.error
      );
    }
    await host.afterOutcome?.(result);
  } catch (error) {
    if (stop.signal.aborted && !isDurableObjectMemoryLimitReset(error)) {
      // The user's stop is the outcome, whatever threw after it. A stop
      // that cannot be recorded rethrows, so the driving Task runs the
      // callback again instead of leaving the incident and a submission open.
      await recordStop();
      return;
    }
    await handleRecoveryAttemptError(engine, {
      callback,
      data,
      error,
      whileDeferring: host.whileDeferring
    });
  } finally {
    stop.end();
    engine.activeRootRequestId = previousRootRequestId;
    // If this facet is an agent-tool child, its recovered turn settled
    // outside `startAgentToolRun`'s finalizer. Close the run now so a
    // re-attached parent collects the terminal at once.
    await turns.reconcileAgentToolChildRuns();
  }
}

/**
 * Handle an error a recovery attempt threw.
 *
 * - A Durable Object memory-limit reset is rethrown with no bookkeeping. The
 *   isolate is condemned and nothing written here would survive (#2613).
 * - A platform transient (a deploy reset, a `retryable` platform error,
 *   "Network connection lost.") is rethrown after a best-effort "failed"
 *   write, so the driving Task run keeps ownership and the platform re-runs
 *   the attempt once it is healthy (#1730). The turn can still recover, so it
 *   is not terminalized.
 * - Any other error gives up through `exhaustRecoveryGiveUp` with
 *   `recovery_error` (`onExhausted` and the terminal message) and is not
 *   rethrown. The driving attempt swallows a non-transient throw, so without
 *   this the turn ends with no terminal event and the tab shows "recovering"
 *   until the incident expires.
 */
export async function handleRecoveryAttemptError(
  engine: ChatRecoveryEngine,
  input: {
    callback: ChatRecoveryScheduleCallback;
    data: RecoveryAttemptData | undefined;
    error: unknown;
    whileDeferring?: (
      incidentId: string,
      write: () => Promise<void>
    ) => Promise<void>;
  }
): Promise<void> {
  const { callback, data, error } = input;
  const logPrefix = engine.turns.label;
  // Classified before the transient check: a memory-limit reset is not a
  // transient, and the give-up below would write through storage that is
  // already gone.
  if (isDurableObjectMemoryLimitReset(error)) throw error;
  if (isPlatformTransientError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    const incidentId = data?.incidentId;
    const write = () => engine.updateIncident(incidentId, "failed", message);
    try {
      if (incidentId && input.whileDeferring) {
        await input.whileDeferring(incidentId, write);
      } else {
        await write();
      }
    } catch (bookkeepingError) {
      // Observability only. In a deploy reset or storage outage this write
      // can reject too, and that must not replace the deferral.
      console.error(
        `${logPrefix} failed to mark recovery incident failed before deferring`,
        bookkeepingError
      );
    }
    throw error;
  }
  // The give-up records only the `recovery_error` category, so log the cause.
  console.error(
    `${logPrefix} ${callback} threw during recovery; terminalizing instead of leaving the turn wedged`,
    error
  );
  await engine.exhaustRecoveryGiveUp({
    callback,
    data,
    reason: "recovery_error"
  });
}
