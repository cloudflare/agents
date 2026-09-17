/**
 * Replay step engine for the StateMachine capability.
 *
 * `ReplayStep` implements the `StateMachineStep` surface one handler attempt
 * receives. It owns replay semantics — journal hits, journal misses, retry
 * policy, durable sleeps, the status live gate, and duplicate/divergence
 * detection — while all SQL stays behind the narrow {@link TaskStepEngine}
 * port implemented by the `StateMachine` capability, the single owner of the
 * schema.
 */

import {
  isDurableObjectCodeUpdateReset,
  isDurableObjectMemoryLimitReset,
  isPlatformFailure
} from "../retries";
import { parseTaskDuration, type StateMachineDurationString } from "./duration";
import {
  StateMachineDuplicateStepError,
  StateMachineReplayDivergedError,
  StateMachineSerializationError,
  isNonRetryableError
} from "./errors";
import { asTaskTerminal, TaskTerminalSignal } from "./machine";
import { deserializeTaskValue } from "./serialization";
import type {
  TaskAskRow,
  StateMachineChildRef,
  TaskJournalRow,
  StateMachineJson,
  StateMachineMailboxFilter,
  TaskMailboxRow,
  StateMachineRetryConfig,
  StateMachineStep,
  StateMachineStepAttempt,
  StateMachineStepConfig,
  StateMachineStepEvent,
  StateMachineTerminal,
  StateMachineValue,
  StateMachineWaitReason
} from "./types";

/**
 * Resolved retry and backoff policy. Steps resolve one per `step.do()`; a
 * run resolves one for its interrupted attempts, which carries no timeout
 * (a run's claim backstop, not a callback race, bounds an attempt).
 */
export type ResolvedRetryPolicy = {
  readonly retryLimit: number;
  readonly retryDelayMs: number;
  readonly backoff: "constant" | "linear" | "exponential";
};

/** Resolved per-step retry and timeout policy. */
export type ResolvedStepPolicy = ResolvedRetryPolicy & {
  readonly timeoutMs: number;
};

/** Longest computed retry delay: backoff growth never exceeds one day. */
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

/** Steps per run ceiling; crossing it fails the run instead of degrading. */
export const MAX_STEPS_PER_RUN = 10_000;

/** Longest accepted step name. Step names are durable journal keys. */
export const MAX_STEP_NAME_LENGTH = 256;

/**
 * Thrown by the engine to end one execution attempt while its run waits for
 * a durable deadline (sleep or retry). Not an `Error` subclass so a step
 * callback's `catch (error)` around unrelated work is less likely to swallow
 * it; the capability re-checks with {@link isTaskSuspension}.
 */
export class TaskSuspension {
  readonly wakeAt: number;
  // An attempt only ever suspends itself; the 'interrupted' park is written
  // over a lost attempt by the capability, never thrown from inside one.
  readonly reason: Exclude<StateMachineWaitReason, "interrupted">;

  constructor(
    wakeAt: number,
    reason: Exclude<StateMachineWaitReason, "interrupted">
  ) {
    this.wakeAt = wakeAt;
    this.reason = reason;
  }
}

/** True when a thrown value is the engine's suspension signal. */
export function isTaskSuspension(value: unknown): value is TaskSuspension {
  return value instanceof TaskSuspension;
}

/**
 * Thrown by the engine when a step boundary observes the run's cancellation
 * request. The capability settles the run as cancelled.
 */
export class TaskCancellation {
  readonly reason: string | undefined;

  constructor(reason: string | undefined) {
    this.reason = reason;
  }
}

/** True when a thrown value is the engine's cancellation signal. */
export function isTaskCancellation(value: unknown): value is TaskCancellation {
  return value instanceof TaskCancellation;
}

/**
 * Thrown by engine writes when another execution attempt has superseded this
 * one. The stale attempt unwinds without settling anything; every durable
 * write it might still try is generation-fenced.
 */
export class AttemptSupersededError extends Error {
  constructor(runId: string) {
    super(
      `Task attempt superseded: run "${runId}" is no longer claimed by this ` +
        `execution attempt`
    );
    this.name = "AttemptSupersededError";
  }
}

/**
 * Storage and policy port the `StateMachine` capability supplies to one attempt's
 * `ReplayStep`. Every mutation is fenced by the attempt's generation on the
 * capability side.
 */
export interface TaskStepEngine {
  /** Read one journal row of this turn, or undefined for a journal miss. */
  readStep(turn: number, name: string): TaskJournalRow | undefined;

  /** Number of journal rows this turn has written. */
  countSteps(turn: number): number;

  /** Insert a new journal row claimed at attempt 1. */
  insertStep(
    turn: number,
    name: string,
    kind: "do" | "sleep" | "event",
    wakeAt: number | null
  ): void;

  /** Journal an already-elapsed sleep born-completed, in one row write. */
  insertCompletedSleep(turn: number, name: string): void;

  /** Claim the next attempt of an existing step. Returns the new attempt. */
  claimStepAttempt(turn: number, name: string): number;

  /** Persist a completed step. Serializes and validates the result. */
  completeStep(turn: number, name: string, result: unknown): void;

  /** Persist a terminally failed step. */
  failStep(
    turn: number,
    name: string,
    error: { name: string; message: string }
  ): void;

  /** Move a step into its retry wait. */
  waitStep(turn: number, name: string, wakeAt: number): void;

  /** Delete one retiring turn's journal rows. Run-scoped rows are untouched. */
  retireJournal(turn: number): void;

  /** Read one run-scoped memo, or undefined when it was never written. */
  readMemo(name: string): TaskJournalRow | undefined;

  /** Write one run-scoped memo. False when a first writer already won. */
  writeMemo(name: string, value: string | null): boolean;

  /** Visible mailbox rows matching a filter, in FIFO order across kinds. */
  peekMailbox(
    filter: StateMachineMailboxFilter | undefined,
    now: number
  ): TaskMailboxRow[];

  /** Consume mailbox rows by key. Returns how many were still queued. */
  consumeMailbox(keys: readonly string[]): number;

  /** How many mailbox rows this run holds, consumed or not yet visible. */
  countMailbox(): number;

  /** The next FIFO sequence number for this run's mailbox. */
  nextMailboxSeq(): number;

  /** Append one mailbox row. False when its key was already present. */
  appendMailbox(item: {
    key: string;
    seq: number;
    kind: string;
    type: string | null;
    payload: string | null;
    visibleAfter: number | null;
  }): boolean;

  /** Write one ask row. */
  insertAsk(ask: {
    askId: string;
    turn: number;
    name: string;
    question: string | null;
    expiresAt: number | null;
    metadata: string | null;
  }): void;

  /** Read specific asks of this run by id. */
  readAsks(askIds: readonly string[]): TaskAskRow[];

  /** Settle one open ask. False when it was already answered or lapsed. */
  settleAsk(
    askId: string,
    state: "answered" | "expired" | "withdrawn",
    answer: string | null
  ): boolean;

  /** Mark every still-open ask of this run withdrawn. Returns the count. */
  withdrawOpenAsks(): number;

  /** The non-terminal children this run owns. */
  listChildren(): StateMachineChildRef[];

  /** The fenced write that commits one transition. False when fenced out. */
  commitCheckpoint(commit: {
    checkpoint: string | null;
    turn: number;
    retireTurn: number | null;
    transitions: number;
    stall: number;
    progress: number;
  }): boolean;

  /** Credit durable work the chunk log cannot see. Writes nothing itself. */
  creditProgress(units: number): void;

  /** Work credited through {@link creditProgress} during this attempt. */
  progressCredited(): number;

  /** Extend the run's claim deadline while a step attempt executes. */
  refreshClaim(): void;

  /** Persist the run's observable status message. */
  writeStatus(message: string): void;

  /** The cancellation reason when this run was asked to cancel, else null. */
  cancellationRequested(): { reason: string | undefined } | null;

  /** Abort signal for the whole attempt (cancellation or supersession). */
  readonly attemptSignal: AbortSignal;

  /** Emit one capability event. */
  emit(type: string, payload: Record<string, unknown>): void;

  /**
   * Stable external deduplication key for one named step, scoped to the
   * turn the caller is in — `turn` leads, as it does on every journal
   * method, because the same name in two turns is two intended executions.
   */
  stepIdempotencyKey(
    turn: number,
    name: string,
    scope?: "turn" | "run"
  ): string;

  /** Default policy applied where a step config leaves fields unset. */
  readonly defaults: ResolvedStepPolicy;
}

/** Compute the delay before the next attempt after `failedAttempt` failed. */
export function computeRetryDelayMs(
  policy: ResolvedRetryPolicy,
  failedAttempt: number
): number {
  const base = policy.retryDelayMs;
  let delay: number;
  switch (policy.backoff) {
    case "constant":
      delay = base;
      break;
    case "linear":
      delay = base * failedAttempt;
      break;
    case "exponential":
      delay = base * 2 ** (failedAttempt - 1);
      break;
  }
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

/**
 * Resolve one retry policy against defaults, validating as it goes.
 *
 * @param context - The option being resolved (`"step retries"`,
 * `"run interruptions"`), used to name it in validation errors.
 */
export function resolveRetryPolicy(
  defaults: ResolvedRetryPolicy,
  retries: StateMachineRetryConfig | undefined,
  context: string
): ResolvedRetryPolicy {
  const limit = retries?.limit ?? defaults.retryLimit;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `Invalid ${context}.limit: expected an integer >= 1, got ${limit}`
    );
  }
  return {
    retryLimit: limit,
    retryDelayMs:
      retries?.delay !== undefined
        ? parseTaskDuration(retries.delay, `${context}.delay`)
        : defaults.retryDelayMs,
    backoff: retries?.backoff ?? defaults.backoff
  };
}

/** Resolve one `step.do()` config against the capability defaults. */
export function resolveStepPolicy(
  defaults: ResolvedStepPolicy,
  config: StateMachineStepConfig | undefined
): ResolvedStepPolicy {
  return {
    ...resolveRetryPolicy(defaults, config?.retries, "step retries"),
    timeoutMs:
      config?.timeout !== undefined
        ? parseTaskDuration(config.timeout, "step timeout")
        : defaults.timeoutMs
  };
}

/**
 * The `StateMachineStep` implementation for one execution attempt.
 *
 * Attempt 1 starts live. A later attempt starts silent and becomes live at
 * the frontier of new ground — the first journal miss, or a step still
 * waiting or running — so replayed `status()` calls from completed ground
 * are suppressed instead of re-published as new progress.
 */
export class ReplayStep implements StateMachineStep {
  readonly #engine: TaskStepEngine;
  readonly #usedNames = new Set<string>();
  #live: boolean;
  readonly attempt: number;
  readonly interrupted: {
    readonly name: string;
    readonly attempt: number;
  } | null;
  readonly signal: AbortSignal;

  /**
   * The journal scope: the run's committed checkpoint turn. A function
   * definition's checkpoint never changes, so its turn is 0 forever and its
   * journal keys are `(run_id, 0, name)`. A park re-enters the SAME turn,
   * which is what lets a `step.sleep` wake find every completed step intact.
   */
  readonly turn: number;

  /** The run seed: the value a function definition receives as its input. */
  readonly input: unknown;

  constructor(
    engine: TaskStepEngine,
    options: {
      attempt: number;
      startsLive: boolean;
      interrupted?: { name: string; attempt: number } | null;
      turn?: number;
      input?: unknown;
    }
  ) {
    this.#engine = engine;
    this.#live = options.startsLive;
    this.attempt = options.attempt;
    this.interrupted = options.interrupted ?? null;
    this.signal = engine.attemptSignal;
    this.turn = options.turn ?? 0;
    this.input = options.input;
  }

  /** Settle this run with a result. */
  complete(result: StateMachineValue): StateMachineTerminal<StateMachineValue> {
    return asTaskTerminal(TaskTerminalSignal.complete(result));
  }

  /** Settle this run as failed. */
  fail(error: unknown): StateMachineTerminal<StateMachineValue> {
    return asTaskTerminal(TaskTerminalSignal.fail(error));
  }

  /** Settle this run as cancelled, carrying the abort mark's reason. */
  aborted(reason?: string): StateMachineTerminal<StateMachineValue> {
    return asTaskTerminal(TaskTerminalSignal.aborted(reason));
  }

  do<T extends StateMachineValue>(
    name: string,
    callback: (attempt: StateMachineStepAttempt) => T | Promise<T>
  ): Promise<T>;
  do<T extends StateMachineValue>(
    name: string,
    config: StateMachineStepConfig,
    callback: (attempt: StateMachineStepAttempt) => T | Promise<T>
  ): Promise<T>;
  async do<T extends StateMachineValue>(
    name: string,
    configOrCallback:
      | StateMachineStepConfig
      | ((attempt: StateMachineStepAttempt) => T | Promise<T>),
    maybeCallback?: (attempt: StateMachineStepAttempt) => T | Promise<T>
  ): Promise<T> {
    const config =
      typeof configOrCallback === "function" ? undefined : configOrCallback;
    const callback =
      typeof configOrCallback === "function" ? configOrCallback : maybeCallback;
    if (typeof callback !== "function") {
      throw new Error(`step.do("${name}") requires a callback`);
    }
    const policy = resolveStepPolicy(this.#engine.defaults, config);
    this.#enterStep(name);

    const row = this.#engine.readStep(this.turn, name);
    if (row === undefined) {
      this.#live = true;
      if (this.#engine.countSteps(this.turn) >= MAX_STEPS_PER_RUN) {
        throw new Error(
          `Run exceeded ${MAX_STEPS_PER_RUN} steps; split the work across ` +
            `multiple Task runs`
        );
      }
      this.#engine.insertStep(this.turn, name, "do", null);
      return this.#executeAttempt(name, 1, policy, callback);
    }

    if (row.kind !== "do") {
      throw new StateMachineReplayDivergedError(
        name,
        `journaled as a ${row.kind} step but replayed as a do step`
      );
    }

    switch (row.state) {
      case "completed":
        return deserializeTaskValue(row.result) as T;
      case "failed":
        // Defensive: a failed step fails its run, so replay should not reach
        // it. Surface the persisted terminal error rather than re-executing.
        throw restoreStepError(row);
      case "waiting": {
        // The frontier: a retry deadline from a previous attempt.
        this.#live = true;
        const wakeAt = row.next_at ?? Date.now();
        if (Date.now() < wakeAt) throw new TaskSuspension(wakeAt, "retry");
        const attempt = this.#engine.claimStepAttempt(this.turn, name);
        this.#engine.emit("task:step:retry", { step: name, attempt });
        return this.#executeAttempt(name, attempt, policy, callback);
      }
      case "running": {
        // A previous attempt was interrupted mid-step. Default replay
        // semantics: run it again under a fresh claim.
        this.#live = true;
        const attempt = this.#engine.claimStepAttempt(this.turn, name);
        return this.#executeAttempt(name, attempt, policy, callback);
      }
    }
  }

  async sleep(
    name: string,
    duration: number | StateMachineDurationString
  ): Promise<void> {
    const durationMs = parseTaskDuration(duration, "sleep duration");
    return this.#sleepAt(name, () => Date.now() + durationMs);
  }

  async sleepUntil(name: string, when: number | Date): Promise<void> {
    const wakeAt = when instanceof Date ? when.getTime() : when;
    if (!Number.isFinite(wakeAt)) {
      throw new Error(
        `Invalid sleepUntil time for step "${name}": ${String(when)}`
      );
    }
    return this.#sleepAt(name, () => wakeAt);
  }

  async status(message: string): Promise<void> {
    if (!this.#live) return;
    this.#engine.writeStatus(String(message));
  }

  idempotencyKey(name: string, options?: { scope?: "turn" | "run" }): string {
    return this.#engine.stepIdempotencyKey(this.turn, name, options?.scope);
  }

  async waitForEvent<Payload extends StateMachineJson>(
    name: string,
    options: { type: string; timeout?: number | StateMachineDurationString }
  ): Promise<StateMachineStepEvent<Payload>> {
    void name;
    void options;
    throw new Error(
      "step.waitForEvent is declared but its mailbox is not wired up yet"
    );
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /** Validate a step boundary: name rules, duplicates, cancellation. */
  #enterStep(name: string): void {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("Step names must be non-empty strings");
    }
    if (name.length > MAX_STEP_NAME_LENGTH) {
      throw new Error(
        `Step name exceeds ${MAX_STEP_NAME_LENGTH} characters: "${name.slice(0, 40)}…"`
      );
    }
    if (name.startsWith("__cf")) {
      throw new Error(`Step names must not use the reserved "__cf" prefix`);
    }
    if (this.#usedNames.has(name)) {
      throw new StateMachineDuplicateStepError(name);
    }
    this.#usedNames.add(name);

    const cancellation = this.#engine.cancellationRequested();
    if (cancellation) throw new TaskCancellation(cancellation.reason);
  }

  /** First persist wins: the recorded wake time is authoritative. */
  async #sleepAt(name: string, wakeTime: () => number): Promise<void> {
    this.#enterStep(name);

    const row = this.#engine.readStep(this.turn, name);
    if (row === undefined) {
      this.#live = true;
      const wakeAt = wakeTime();
      if (wakeAt <= Date.now()) {
        this.#engine.insertCompletedSleep(this.turn, name);
        return;
      }
      this.#engine.insertStep(this.turn, name, "sleep", wakeAt);
      throw new TaskSuspension(wakeAt, "sleep");
    }

    if (row.kind !== "sleep") {
      throw new StateMachineReplayDivergedError(
        name,
        `journaled as a ${row.kind} step but replayed as a sleep step`
      );
    }
    if (row.state === "completed") return;

    // The frontier: an unfinished sleep is the first unfinished step.
    this.#live = true;
    const wakeAt = row.next_at ?? 0;
    if (Date.now() < wakeAt) throw new TaskSuspension(wakeAt, "sleep");
    this.#engine.completeStep(this.turn, name, undefined);
  }

  /** Execute one claimed attempt of a `do` step under timeout and retries. */
  async #executeAttempt<T extends StateMachineValue>(
    name: string,
    attempt: number,
    policy: ResolvedStepPolicy,
    callback: (attempt: StateMachineStepAttempt) => T | Promise<T>
  ): Promise<T> {
    this.#engine.refreshClaim();
    this.#engine.emit("task:step:started", { step: name, attempt });

    const timeout = new AbortController();
    const onRunAbort = () => timeout.abort(this.#engine.attemptSignal.reason);
    this.#engine.attemptSignal.addEventListener("abort", onRunAbort, {
      once: true
    });
    const timer = setTimeout(() => {
      timeout.abort(
        new Error(
          `Step "${name}" attempt ${attempt} timed out after ${policy.timeoutMs}ms`
        )
      );
    }, policy.timeoutMs);

    try {
      const result = await this.#raceTimeout<T>(
        Promise.resolve(
          callback({
            attempt,
            idempotencyKey: this.#engine.stepIdempotencyKey(this.turn, name),
            signal: timeout.signal
          })
        ),
        timeout.signal
      );
      this.#engine.completeStep(this.turn, name, result);
      this.#engine.emit("task:step:completed", { step: name, attempt });
      return result;
    } catch (error) {
      if (error instanceof AttemptSupersededError) throw error;
      const cancellation = this.#engine.cancellationRequested();
      if (cancellation) throw new TaskCancellation(cancellation.reason);
      // The attempt itself was ended from outside (its deadline passed and
      // the run is already settled): not a step outcome, so neither retry
      // nor fail the step — unwind with the reason.
      if (this.#engine.attemptSignal.aborted) {
        throw this.#engine.attemptSignal.reason;
      }
      // A condemned isolate cannot recover in-process. Leave the journal row
      // running and let the whole Task reach the alarm boundary, where a code
      // update defers to fresh code and a memory reset enters the breaker.
      // Other platform transients (notably "Network connection lost") retain
      // the ordinary short step retry budget before the run defers.
      if (
        isDurableObjectCodeUpdateReset(error) ||
        isDurableObjectMemoryLimitReset(error)
      ) {
        throw error;
      }
      // Transient platform errors use the configured durable retry budget.
      // Once that budget is spent they still are not application failures:
      // keep the step claimed and defer the whole run to a later invocation.
      if (isPlatformFailure(error) && attempt >= policy.retryLimit) throw error;
      if (
        isNonRetryableError(error) ||
        error instanceof StateMachineSerializationError ||
        attempt >= policy.retryLimit
      ) {
        this.#engine.failStep(this.turn, name, toErrorSummary(error));
        throw error;
      }
      const wakeAt = Date.now() + computeRetryDelayMs(policy, attempt);
      this.#engine.waitStep(this.turn, name, wakeAt);
      throw new TaskSuspension(wakeAt, "retry");
    } finally {
      clearTimeout(timer);
      this.#engine.attemptSignal.removeEventListener("abort", onRunAbort);
    }
  }

  /**
   * Settle with the callback or its timeout, whichever finishes first. A
   * callback that ignores its abort signal cannot wedge the attempt; its
   * late settlement is discarded and generation fencing rejects late writes.
   */
  #raceTimeout<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }
}

/** Rebuild a persisted terminal step error for rethrow. */
function restoreStepError(row: TaskJournalRow): Error {
  const error = new Error(row.error_message ?? "Step failed");
  error.name = row.error_name ?? "Error";
  return error;
}

/** Safe name/message projection of an arbitrary thrown value. */
export function toErrorSummary(error: unknown): {
  name: string;
  message: string;
} {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}
