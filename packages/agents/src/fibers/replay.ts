/**
 * Replay step engine for the Fibers capability.
 *
 * `ReplayStep` implements the `FiberStep` surface one handler attempt
 * receives. It owns replay semantics — journal hits, journal misses, retry
 * policy, durable sleeps, the status live gate, and duplicate/divergence
 * detection — while all SQL stays behind the narrow {@link FiberStepEngine}
 * port implemented by the `Fibers` capability, the single owner of the
 * schema.
 */

import { parseFiberDuration, type FiberDurationString } from "./duration";
import {
  DuplicateFiberStepError,
  FiberReplayDivergedError,
  FiberSerializationError,
  isNonRetryableError
} from "./errors";
import { deserializeFiberValue } from "./serialization";
import type {
  FiberStep,
  FiberStepAttempt,
  FiberStepConfig,
  FiberStepRow,
  FiberValue,
  FiberWaitReason
} from "./types";

/** Resolved per-step retry and timeout policy. */
export type ResolvedStepPolicy = {
  readonly retryLimit: number;
  readonly retryDelayMs: number;
  readonly backoff: "constant" | "linear" | "exponential";
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
 * it; the capability re-checks with {@link isFiberSuspension}.
 */
export class FiberSuspension {
  readonly wakeAt: number;
  readonly reason: FiberWaitReason;

  constructor(wakeAt: number, reason: FiberWaitReason) {
    this.wakeAt = wakeAt;
    this.reason = reason;
  }
}

/** True when a thrown value is the engine's suspension signal. */
export function isFiberSuspension(value: unknown): value is FiberSuspension {
  return value instanceof FiberSuspension;
}

/**
 * Thrown by the engine when a step boundary observes the run's cancellation
 * request. The capability settles the run as cancelled.
 */
export class FiberCancellation {
  readonly reason: string | undefined;

  constructor(reason: string | undefined) {
    this.reason = reason;
  }
}

/** True when a thrown value is the engine's cancellation signal. */
export function isFiberCancellation(
  value: unknown
): value is FiberCancellation {
  return value instanceof FiberCancellation;
}

/**
 * Thrown by engine writes when another execution attempt has superseded this
 * one. The stale attempt unwinds without settling anything; every durable
 * write it might still try is generation-fenced.
 */
export class AttemptSupersededError extends Error {
  constructor(runId: string) {
    super(
      `Fiber attempt superseded: run "${runId}" is no longer claimed by this ` +
        `execution attempt`
    );
    this.name = "AttemptSupersededError";
  }
}

/**
 * Storage and policy port the `Fibers` capability supplies to one attempt's
 * `ReplayStep`. Every mutation is fenced by the attempt's generation on the
 * capability side.
 */
export interface FiberStepEngine {
  /** Read one step row of this run, or undefined for a journal miss. */
  readStep(name: string): FiberStepRow | undefined;

  /** Number of step rows this run has journaled. */
  countSteps(): number;

  /** Insert a new step row claimed at attempt 1. */
  insertStep(name: string, kind: "do" | "sleep", wakeAt: number | null): void;

  /** Claim the next attempt of an existing step. Returns the new attempt. */
  claimStepAttempt(name: string): number;

  /** Persist a completed step. Serializes and validates the result. */
  completeStep(name: string, result: unknown): void;

  /** Persist a terminally failed step. */
  failStep(name: string, error: { name: string; message: string }): void;

  /** Move a step into its retry wait. */
  waitStep(name: string, wakeAt: number): void;

  /** Replace a running step's recovery checkpoint. Synchronous. */
  writeCheckpoint(name: string, value: unknown): void;

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

  /** Stable external deduplication key for one named step. */
  stepIdempotencyKey(name: string): string;

  /** Default policy applied where a step config leaves fields unset. */
  readonly defaults: ResolvedStepPolicy;
}

/** Compute the delay before the next attempt after `failedAttempt` failed. */
export function computeRetryDelayMs(
  policy: ResolvedStepPolicy,
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

/** Resolve one `step.do()` config against the capability defaults. */
export function resolveStepPolicy(
  defaults: ResolvedStepPolicy,
  config: FiberStepConfig | undefined
): ResolvedStepPolicy {
  const limit = config?.retries?.limit ?? defaults.retryLimit;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `Invalid step retries.limit: expected an integer >= 1, got ${limit}`
    );
  }
  return {
    retryLimit: limit,
    retryDelayMs:
      config?.retries?.delay !== undefined
        ? parseFiberDuration(config.retries.delay, "step retries.delay")
        : defaults.retryDelayMs,
    backoff: config?.retries?.backoff ?? defaults.backoff,
    timeoutMs:
      config?.timeout !== undefined
        ? parseFiberDuration(config.timeout, "step timeout")
        : defaults.timeoutMs
  };
}

/**
 * The `FiberStep` implementation for one execution attempt.
 *
 * Attempt 1 starts live. A later attempt starts silent and becomes live at
 * the frontier of new ground — the first journal miss, or a step still
 * waiting or running — so replayed `status()` calls from completed ground
 * are suppressed instead of re-published as new progress.
 */
export class ReplayStep implements FiberStep {
  readonly #engine: FiberStepEngine;
  readonly #usedNames = new Set<string>();
  #live: boolean;

  constructor(engine: FiberStepEngine, options: { startsLive: boolean }) {
    this.#engine = engine;
    this.#live = options.startsLive;
  }

  do<T extends FiberValue>(
    name: string,
    callback: (attempt: FiberStepAttempt) => T | Promise<T>
  ): Promise<T>;
  do<T extends FiberValue>(
    name: string,
    config: FiberStepConfig,
    callback: (attempt: FiberStepAttempt) => T | Promise<T>
  ): Promise<T>;
  async do<T extends FiberValue>(
    name: string,
    configOrCallback:
      | FiberStepConfig
      | ((attempt: FiberStepAttempt) => T | Promise<T>),
    maybeCallback?: (attempt: FiberStepAttempt) => T | Promise<T>
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

    const row = this.#engine.readStep(name);
    if (row === undefined) {
      this.#live = true;
      if (this.#engine.countSteps() >= MAX_STEPS_PER_RUN) {
        throw new Error(
          `Run exceeded ${MAX_STEPS_PER_RUN} steps; split the work across ` +
            `multiple Fiber runs`
        );
      }
      this.#engine.insertStep(name, "do", null);
      return this.#executeAttempt(name, 1, policy, callback);
    }

    if (row.kind !== "do") {
      throw new FiberReplayDivergedError(
        name,
        `journaled as a ${row.kind} step but replayed as a do step`
      );
    }

    switch (row.state) {
      case "completed":
        return deserializeFiberValue(row.result) as T;
      case "failed":
        // Defensive: a failed step fails its run, so replay should not reach
        // it. Surface the persisted terminal error rather than re-executing.
        throw restoreStepError(row);
      case "waiting": {
        // The frontier: a retry deadline from a previous attempt.
        this.#live = true;
        const wakeAt = row.next_at ?? Date.now();
        if (Date.now() < wakeAt) throw new FiberSuspension(wakeAt, "retry");
        const attempt = this.#engine.claimStepAttempt(name);
        this.#engine.emit("fiber:step:retry", { step: name, attempt });
        return this.#executeAttempt(name, attempt, policy, callback);
      }
      case "running": {
        // A previous attempt was interrupted mid-step. Default replay
        // semantics: run it again under a fresh claim.
        this.#live = true;
        const attempt = this.#engine.claimStepAttempt(name);
        return this.#executeAttempt(name, attempt, policy, callback);
      }
    }
  }

  async sleep(
    name: string,
    duration: number | FiberDurationString
  ): Promise<void> {
    const durationMs = parseFiberDuration(duration, "sleep duration");
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

  idempotencyKey(name: string): string {
    return this.#engine.stepIdempotencyKey(name);
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
      throw new DuplicateFiberStepError(name);
    }
    this.#usedNames.add(name);

    const cancellation = this.#engine.cancellationRequested();
    if (cancellation) throw new FiberCancellation(cancellation.reason);
  }

  /** First persist wins: the recorded wake time is authoritative. */
  async #sleepAt(name: string, wakeTime: () => number): Promise<void> {
    this.#enterStep(name);

    const row = this.#engine.readStep(name);
    if (row === undefined) {
      this.#live = true;
      const wakeAt = wakeTime();
      if (wakeAt <= Date.now()) {
        this.#engine.insertStep(name, "sleep", null);
        this.#engine.completeStep(name, undefined);
        return;
      }
      this.#engine.insertStep(name, "sleep", wakeAt);
      throw new FiberSuspension(wakeAt, "sleep");
    }

    if (row.kind !== "sleep") {
      throw new FiberReplayDivergedError(
        name,
        `journaled as a ${row.kind} step but replayed as a sleep step`
      );
    }
    if (row.state === "completed") return;

    // The frontier: an unfinished sleep is the first unfinished step.
    this.#live = true;
    const wakeAt = row.next_at ?? 0;
    if (Date.now() < wakeAt) throw new FiberSuspension(wakeAt, "sleep");
    this.#engine.completeStep(name, undefined);
  }

  /** Execute one claimed attempt of a `do` step under timeout and retries. */
  async #executeAttempt<T extends FiberValue>(
    name: string,
    attempt: number,
    policy: ResolvedStepPolicy,
    callback: (attempt: FiberStepAttempt) => T | Promise<T>
  ): Promise<T> {
    this.#engine.refreshClaim();
    this.#engine.emit("fiber:step:started", { step: name, attempt });

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
            idempotencyKey: this.#engine.stepIdempotencyKey(name),
            signal: timeout.signal,
            checkpoint: (value) => this.#engine.writeCheckpoint(name, value)
          })
        ),
        timeout.signal
      );
      this.#engine.completeStep(name, result);
      this.#engine.emit("fiber:step:completed", { step: name, attempt });
      return result;
    } catch (error) {
      if (error instanceof AttemptSupersededError) throw error;
      const cancellation = this.#engine.cancellationRequested();
      if (cancellation) throw new FiberCancellation(cancellation.reason);
      if (
        isNonRetryableError(error) ||
        error instanceof FiberSerializationError ||
        attempt >= policy.retryLimit
      ) {
        this.#engine.failStep(name, toErrorSummary(error));
        throw error;
      }
      const wakeAt = Date.now() + computeRetryDelayMs(policy, attempt);
      this.#engine.waitStep(name, wakeAt);
      throw new FiberSuspension(wakeAt, "retry");
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
function restoreStepError(row: FiberStepRow): Error {
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
