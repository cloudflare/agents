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
 * 5. A stop that landed meanwhile ends the attempt. This comes before the
 *    timeout branch: a stopped attempt must not reschedule, park or give up.
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
import type { RecoveryAttemptHandle } from "./chat-turns";
import type { SaveMessagesResult } from "./lifecycle";
import type { ChatRecoveryIncident } from "./recovery-incident";
import type {
  ChatRecoveryEngine,
  ChatRecoveryScheduleCallback
} from "./recovery-engine";

/** The part of a recovery schedule payload the attempt reads. */
export type RecoveryAttemptData = {
  incidentId?: string;
  originalRequestId?: string;
  recoveredRequestId?: string;
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
 * What a host supplies for one attempt. The required members are the steps
 * both hosts have. The optional ones are `Think`'s submission and messenger
 * steps, and the continue-only settle.
 */
export interface RecoveredTurnHost<
  TData extends RecoveryAttemptData,
  TResult extends RecoveredTurnResult
> {
  /** The callback this attempt runs under. */
  callback: ChatRecoveryScheduleCallback;
  /** The schedule payload. */
  data: TData | undefined;
  /** Prefix for log lines, such as `[Think]`. */
  logPrefix: string;

  /** `ChatTurns.beginRecoveryAttempt`. */
  beginAttempt(rootRequestId: string | undefined): RecoveryAttemptHandle;
  /** The root request id recovery work runs under. */
  getActiveRootRequestId(): string | undefined;
  setActiveRootRequestId(rootRequestId: string | undefined): void;
  /** The host's `waitUntilStable`. Resolves `false` on timeout. */
  waitUntilStable(timeoutMs: number): Promise<boolean>;
  /** Whether a client still has a tool call or approval to answer. */
  hasPendingInteraction(): boolean;
  /**
   * Write a status to the incident. The host's binding of
   * `ChatRecoveryEngine.updateIncident`.
   */
  updateIncident(
    incidentId: string | undefined,
    status: ChatRecoveryIncident["status"],
    reason?: string
  ): Promise<void>;
  /** Whether the message this attempt recovers is still the latest. */
  checkLeaf(): Promise<RecoveryLeafCheck>;
  /** Restore the tools and body the interrupted request ran with. */
  applyRequestContext(): void;
  /** Run the turn. `signal` aborts when a client stops the attempt. */
  runTurn(signal: AbortSignal): Promise<TResult>;
  /** Close agent-tool child runs the recovered turn settled. */
  reconcile(): Promise<void>;

  /**
   * Runs after the cancelled check and before the attempt is registered.
   * Return `false` to skip the attempt. The host records why.
   */
  admit?(): Promise<boolean>;
  /** Continue only: settle the dead tool calls of the cut-off reply. */
  settleCutOffReply?(): Promise<void>;
  /** The user stopped the attempt, or cancelled it while it was scheduled. */
  onStopped?(): Promise<void>;
  /** The attempt parked on a pending client interaction. */
  onParked?(): Promise<void>;
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
  /** Runs in the `finally`, after the attempt ends. */
  release?(): void;
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
  const { callback, data } = host;
  const incidentId = data?.incidentId;

  if (await engine.isRecoveryCancelled(incidentId)) {
    await host.onStopped?.();
    return;
  }
  if (host.admit && !(await host.admit())) return;

  const previousRootRequestId = host.getActiveRootRequestId();
  host.setActiveRootRequestId(data?.originalRequestId ?? previousRootRequestId);
  // A client stops this attempt by the original request id: the only id it
  // knows until the recovered turn streams.
  const stop = host.beginAttempt(data?.originalRequestId);
  const recordStop = async (): Promise<void> => {
    await engine.recordRecoveryStop(incidentId, host.updateIncident);
    await host.onStopped?.();
  };

  try {
    await host.settleCutOffReply?.();
    const config = engine.resolveConfig();
    // The reply was settled above, so anything still pending is a call a
    // client can answer, and the timeout branch parks on it.
    const ready = await host.waitUntilStable(config.stableTimeoutMs);

    // Before the timeout branch: a stopped attempt must not reschedule,
    // park or give up.
    if (stop.signal.aborted) {
      await recordStop();
      return;
    }

    if (!ready) {
      // A turn waiting on a client is not stuck. The client's answer starts
      // its own continuation, so spending the attempt budget on the wait
      // would give up on a healthy turn.
      if (host.hasPendingInteraction()) {
        await host.updateIncident(
          incidentId,
          "skipped",
          "awaiting_client_interaction"
        );
        await host.onParked?.();
        return;
      }
      console.warn(
        `${host.logPrefix} ${callback} timed out waiting for stable state`
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
      await host.updateIncident(incidentId, "skipped", leaf.reason);
      await host.onSkipped?.(leaf);
      return;
    }

    host.applyRequestContext();
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
      await host.updateIncident(
        incidentId,
        result.status === "completed"
          ? "completed"
          : result.status === "skipped"
            ? "skipped"
            : "failed",
        result.error
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
      logPrefix: host.logPrefix,
      updateIncident: host.updateIncident,
      whileDeferring: host.whileDeferring
    });
  } finally {
    stop.end();
    host.setActiveRootRequestId(previousRootRequestId);
    host.release?.();
    // If this facet is an agent-tool child, its recovered turn settled
    // outside `startAgentToolRun`'s finalizer. Close the run now so a
    // re-attached parent collects the terminal at once.
    await host.reconcile();
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
    logPrefix: string;
    /** The host's incident write. Defaults to the engine's. */
    updateIncident?: RecoveredTurnHost<
      RecoveryAttemptData,
      RecoveredTurnResult
    >["updateIncident"];
    whileDeferring?: (
      incidentId: string,
      write: () => Promise<void>
    ) => Promise<void>;
  }
): Promise<void> {
  const { callback, data, error, logPrefix } = input;
  // Classified before the transient check: a memory-limit reset is not a
  // transient, and the give-up below would write through storage that is
  // already gone.
  if (isDurableObjectMemoryLimitReset(error)) throw error;
  if (isPlatformTransientError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    const incidentId = data?.incidentId;
    const update =
      input.updateIncident ?? ((...args) => engine.updateIncident(...args));
    const write = () => update(incidentId, "failed", message);
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
