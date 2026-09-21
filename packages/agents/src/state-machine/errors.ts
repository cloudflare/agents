/**
 * Error classes for the StateMachine capability. Each carries a stable `name` so
 * hosts and tests can classify failures without depending on message text.
 */

/**
 * Thrown by a step callback to fail its run immediately, skipping any
 * remaining retry attempts.
 *
 * Errors named `"NonRetryableError"` from other sources (for example
 * `cloudflare:workflows`) are honored the same way.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class NonRetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NonRetryableError";
  }
}

/** True when an error should skip remaining step retry attempts. */
export function isNonRetryableError(error: unknown): boolean {
  return (
    error instanceof NonRetryableError ||
    (error instanceof Error && error.name === "NonRetryableError")
  );
}

/**
 * Thrown before executing user code when one replay uses the same step name
 * twice. Step names are durable journal keys and must be unique within a run.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StateMachineDuplicateStepError extends Error {
  /** The step name used more than once. */
  readonly stepName: string;

  constructor(stepName: string) {
    super(
      `Step name "${stepName}" was already used in this run. Step names are ` +
        `durable journal keys; suffix loop steps with a stable index, e.g. ` +
        `"${stepName}:0".`
    );
    this.name = "StateMachineDuplicateStepError";
    this.stepName = stepName;
  }
}

/**
 * Thrown when a replay observes a journal that this handler code cannot have
 * written — a known step under a different kind, for example. The run fails
 * rather than guessing; changing a definition's step layout for in-flight
 * runs requires versioning the definition name.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StateMachineReplayDivergedError extends Error {
  /** The step name where replay diverged from the journal. */
  readonly stepName: string;

  constructor(stepName: string, detail: string) {
    super(
      `Replay diverged from the journal at step "${stepName}": ${detail}. ` +
        `Version the definition name (e.g. "name@v2") instead of changing ` +
        `the step layout of in-flight runs.`
    );
    this.name = "StateMachineReplayDivergedError";
    this.stepName = stepName;
  }
}

/**
 * Recorded against a run whose persisted definition name is no longer
 * registered after a deployment. The run fails visibly; it is never silently
 * deleted and never replayed against a different handler.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StateMachineMissingDefinitionError extends Error {
  /** The persisted definition name that no longer resolves. */
  readonly definition: string;

  constructor(definition: string) {
    super(
      `No Task definition named "${definition}" is registered. A deployment ` +
        `removed or renamed it while this run was active. Re-register the ` +
        `definition (or a versioned successor with the same name) to let the ` +
        `run finish.`
    );
    this.name = "StateMachineMissingDefinitionError";
    this.definition = definition;
  }
}

/**
 * Recorded against a run whose interruption retry budget is spent: as many
 * consecutive attempts died mid-execution as the run's `retries.limit`
 * allows in total, so the run fails instead of being replayed again.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StateMachineInterruptionsExhaustedError extends Error {
  readonly runId: string;
  /** Consecutive attempts of this run lost to an unclean interruption. */
  readonly interruptions: number;

  constructor(runId: string, interruptions: number) {
    super(
      `Task run "${runId}" was interrupted ${interruptions} time${interruptions === 1 ? "" : "s"} and its retry budget is spent.`
    );
    this.name = "StateMachineInterruptionsExhaustedError";
    this.runId = runId;
    this.interruptions = interruptions;
  }
}

/**
 * Recorded against a run whose wall-clock `deadline` passed before it
 * settled. A live attempt observes it as the reason on `step.signal`; a
 * parked run fails at its next wake.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StateMachineDeadlineExceededError extends Error {
  readonly runId: string;
  /** The deadline, epoch milliseconds. */
  readonly deadline: number;

  constructor(runId: string, deadline: number) {
    super(
      `Task run "${runId}" exceeded its deadline of ${new Date(deadline).toISOString()}.`
    );
    this.name = "StateMachineDeadlineExceededError";
    this.runId = runId;
    this.deadline = deadline;
  }
}

/**
 * Thrown when a Task input, step result, metadata value, or final result is
 * not JSON-serializable or exceeds the serialized size limit.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StateMachineSerializationError extends Error {
  constructor(context: string, detail: string) {
    super(`Cannot serialize ${context}: ${detail}`);
    this.name = "StateMachineSerializationError";
  }
}

/**
 * Recorded against a run whose transition changed no checkpoint, parked on
 * nothing, and credited no durable progress — progress rule A, the crash
 * detector. A legitimate re-park is never faulted: parks are decided above
 * this rule, so it needs no exemption list.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StateMachineNoProgressError extends Error {
  readonly runId: string;
  /** The phase whose handler made no progress. */
  readonly phase: string;
  /** Consecutive no-progress transitions tolerated before this failure. */
  readonly stallLimit: number;

  constructor(runId: string, phase: string, stallLimit: number) {
    super(
      `Task run "${runId}" made no progress in phase "${phase}" ` +
        `${stallLimit} time${stallLimit === 1 ? "" : "s"} in a row: the ` +
        `transition changed no checkpoint, parked on nothing, and wrote ` +
        `nothing durable. Return a different checkpoint, park on a wait, or ` +
        `settle the run.`
    );
    this.name = "StateMachineNoProgressError";
    this.runId = runId;
    this.phase = phase;
    this.stallLimit = stallLimit;
  }
}

/**
 * Recorded against a run that took more transitions since its last park
 * than `transitionBudget` allows — progress rule B, the liveness bound.
 * Rule A cannot catch a loop whose checkpoint differs every time; this is
 * that bound, and every iteration of such a loop bills one row write.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StateMachineTransitionBudgetError extends Error {
  readonly runId: string;
  /** Transitions taken since the last park. */
  readonly transitions: number;
  /** The last phases the run cycled through, oldest first. */
  readonly phases: readonly string[];

  constructor(runId: string, transitions: number, phases: readonly string[]) {
    super(
      `Task run "${runId}" took ${transitions} transitions without parking` +
        (phases.length > 0 ? `, cycling ${phases.join(" -> ")}` : "") +
        `. Park on a wait, or raise transitionBudget if the loop is intended.`
    );
    this.name = "StateMachineTransitionBudgetError";
    this.runId = runId;
    this.transitions = transitions;
    this.phases = phases;
  }
}

/**
 * Recorded against a run whose per-transition watchdog fired: one
 * transition produced nothing durable for a full `turnTimeout`. Distinct
 * from the run's wall-clock `deadline`, which bounds the whole run.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StateMachineTurnDeadlineExceededError extends Error {
  readonly runId: string;
  /** The transition deadline, epoch milliseconds. */
  readonly deadline: number;

  constructor(runId: string, deadline: number) {
    super(
      `Task run "${runId}" exceeded its transition deadline of ` +
        `${new Date(deadline).toISOString()}.`
    );
    this.name = "StateMachineTurnDeadlineExceededError";
    this.runId = runId;
    this.deadline = deadline;
  }
}

/**
 * Thrown when an `onCancel` transition calls a parking member. The cancel
 * transition owns the run's outcome and must reach it in one invocation;
 * anything it needs to wait for belongs in the checkpoint it returns.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StateMachineCancelCannotParkError extends Error {
  /** The parking member that was called. */
  readonly member: string;

  constructor(member: string) {
    super(
      `onCancel cannot park: "${member}" suspends the run, and a cancel ` +
        `transition must settle or return a checkpoint in one invocation.`
    );
    this.name = "StateMachineCancelCannotParkError";
    this.member = member;
  }
}

/**
 * Thrown when a second parking member is awaited while one park is already
 * pending. A park unwinds the whole invocation, so the engine cannot honour
 * two — and failing loudly beats silently discarding one.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StateMachineConcurrentParkError extends Error {
  /** The member already parking. */
  readonly pending: string;
  /** The member that tried to park beside it. */
  readonly member: string;

  constructor(pending: string, member: string) {
    super(
      `"${member}" cannot park while "${pending}" is already parking: a ` +
        `transition parks on one wait at a time.`
    );
    this.name = "StateMachineConcurrentParkError";
    this.pending = pending;
    this.member = member;
  }
}

/**
 * Thrown from `step.waitForEvent()` when its `timeout` elapses, matching
 * `cloudflare:workflows`. The machine layer's `within` waits return
 * `ctx.timedOut` instead, because a thrown timeout composes badly with
 * return-the-next-checkpoint.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StateMachineEventTimeoutError extends Error {
  /** The step name the wait was journaled under. */
  readonly stepName: string;
  /** The event type the wait was matching. */
  readonly eventType: string;

  constructor(stepName: string, eventType: string) {
    super(`Timed out waiting for event "${eventType}" at step "${stepName}".`);
    this.name = "StateMachineEventTimeoutError";
    this.stepName = stepName;
    this.eventType = eventType;
  }
}

/**
 * Thrown by `send()` when a run's mailbox already holds `mailboxLimit`
 * unconsumed items. The mailbox is bounded rather than growing without
 * bound behind a handler that stopped reading it.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StateMachineMailboxFullError extends Error {
  readonly runId: string;
  /** Unconsumed items allowed per run. */
  readonly limit: number;

  constructor(runId: string, limit: number) {
    super(
      `Task run "${runId}" already holds ${limit} unconsumed mailbox items.`
    );
    this.name = "StateMachineMailboxFullError";
    this.runId = runId;
    this.limit = limit;
  }
}

/**
 * Thrown from the commit when a returned checkpoint exceeds the checkpoint
 * ceiling. A subclass of {@link StateMachineSerializationError} so existing catches
 * still match. Serialization runs before the fenced UPDATE, so the previous
 * checkpoint survives intact.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StateMachineCheckpointTooLargeError extends StateMachineSerializationError {
  /** The serialized size that was refused, in bytes. */
  readonly bytes: number;
  /** The ceiling, in bytes. */
  readonly limit: number;

  constructor(context: string, bytes: number, limit: number) {
    super(
      context,
      `serialized checkpoint size ${bytes} bytes exceeds the ${limit}-byte ` +
        `limit. A checkpoint is rewritten every transition: keep the phase ` +
        `and its identifiers here and put bulk state in a stream, a Sessions ` +
        `row, or your own table.`
    );
    this.name = "StateMachineCheckpointTooLargeError";
    this.bytes = bytes;
    this.limit = limit;
  }
}

/**
 * Recorded against a live run whose persisted `@vN` definition is unknown
 * and unmigratable. The run settles `failed` with `outcome: "orphaned"` and
 * its checkpoint, journal, mailbox and asks are preserved — `retain: false`
 * is overridden — so `tasks.reopen(runId)` can bring it back once the
 * definition is registered again.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StateMachineOrphanedDefinitionError extends Error {
  /** The persisted definition name. */
  readonly definition: string;
  /** The persisted definition's version, or 0 when unversioned. */
  readonly version: number;

  constructor(definition: string, version: number, detail: string) {
    super(
      `Task definition "${definition}" cannot carry this run forward: ` +
        `${detail}. The run is orphaned; its checkpoint is preserved. ` +
        `Register a higher version of "${definition}" with a migrate() and ` +
        `call tasks.reopen() to resume it.`
    );
    this.name = "StateMachineOrphanedDefinitionError";
    this.definition = definition;
    this.version = version;
  }
}
