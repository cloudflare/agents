import type { FiberDurationString } from "./duration";

/**
 * JSON-serializable data accepted as Fiber input, step results, metadata,
 * and final results.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type FiberJson =
  | string
  | number
  | boolean
  | null
  | FiberJson[]
  | { [key: string]: FiberJson };

/**
 * A value a Fiber handler or step callback may produce. `undefined` and
 * `void` persist as SQL `NULL` and restore as `undefined`.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type FiberValue = FiberJson | undefined | void;

/**
 * The main callback of a Fiber definition. Invoked with the owning host as
 * `this`, from the beginning, on every execution attempt; completed steps
 * return journaled results instead of running again.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type FiberRunHandler<Host, Input, Output extends FiberValue> = (
  this: Host,
  input: Readonly<Input>,
  step: FiberStep
) => Output | Promise<Output>;

/**
 * Per-attempt context passed to a `step.do()` callback.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface FiberStepAttempt {
  /** One-based attempt number for this named step. */
  readonly attempt: number;

  /**
   * Stable external deduplication key for this step: identical across
   * attempts and replays of the same run.
   */
  readonly idempotencyKey: string;

  /** Aborted on cancellation or when this attempt's timeout elapses. */
  readonly signal: AbortSignal;
}

/**
 * Retry and timeout policy for one `step.do()` call.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface FiberStepConfig {
  retries?: {
    /** Total attempts, including the first. */
    limit?: number;
    /** Delay before the first retry. */
    delay?: number | FiberDurationString;
    /** Delay growth across retries. Defaults to exponential. */
    backoff?: "constant" | "linear" | "exponential";
  };

  /** Timeout of one callback attempt. */
  timeout?: number | FiberDurationString;
}

/**
 * The step API a Fiber handler receives. Named steps are the run's durable
 * journal: `do` memoizes completed results, sleeps persist their first
 * deadline, and both suspend the execution attempt rather than holding the
 * invocation open.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface FiberStep {
  /** Run a named step once, replaying its journaled result thereafter. */
  do<T extends FiberValue>(
    name: string,
    callback: (attempt: FiberStepAttempt) => T | Promise<T>
  ): Promise<T>;
  do<T extends FiberValue>(
    name: string,
    config: FiberStepConfig,
    callback: (attempt: FiberStepAttempt) => T | Promise<T>
  ): Promise<T>;

  /**
   * Sleep durably. The first recorded deadline is authoritative; replays
   * before it suspend again, replays after it continue.
   */
  sleep(name: string, duration: number | FiberDurationString): Promise<void>;

  /** Sleep durably until a wall-clock time. */
  sleepUntil(name: string, when: number | Date): Promise<void>;

  /**
   * Update observable progress. Replays stay silent until execution reaches
   * new ground, so old progress is not re-published as new.
   */
  status(message: string): Promise<void>;

  /** The stable external deduplication key `step.do(name, ...)` would get. */
  idempotencyKey(name: string): string;
}

/**
 * States a Fiber run moves through.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type FiberRunState =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

/** Why a waiting run is waiting. */
export type FiberWaitReason = "sleep" | "retry";

/** Safe projection of an error retained with a failed run. */
export interface FiberError {
  name: string;
  message: string;
}

/**
 * Options accepted when starting one Fiber run.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface FiberRunOptions {
  /** Stable key deduplicating repeated acceptance attempts onto one run. */
  idempotencyKey?: string;

  /** Caller-selected run ID. Generated when omitted. */
  runId?: string;

  /** JSON metadata retained with the run. */
  metadata?: Record<string, FiberJson>;

  /** Keep terminal state for inspection. Defaults to `true`. */
  retain?: boolean;
}

/**
 * Durable acceptance receipt returned by `Fiber.run()`. `accepted: false`
 * means an existing run matched `runId` or `idempotencyKey`; it is not an
 * error.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface FiberReceipt {
  runId: string;
  definition: string;
  accepted: boolean;
  state: FiberRunState;
  createdAt: number;
}

/**
 * Read-only snapshot of one Fiber run, discriminated by state.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type FiberRunSnapshot<Output extends FiberValue> =
  | {
      runId: string;
      definition: string;
      state: "pending";
      createdAt: number;
      metadata?: Record<string, FiberJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "running";
      attempt: number;
      startedAt: number;
      createdAt: number;
      statusMessage?: string;
      metadata?: Record<string, FiberJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "waiting";
      reason: FiberWaitReason;
      wakeAt: number;
      createdAt: number;
      statusMessage?: string;
      metadata?: Record<string, FiberJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "completed";
      result: Output;
      createdAt: number;
      settledAt: number;
      metadata?: Record<string, FiberJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "failed";
      error: FiberError;
      createdAt: number;
      settledAt: number;
      metadata?: Record<string, FiberJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "cancelled";
      reason?: string;
      createdAt: number;
      settledAt: number;
      metadata?: Record<string, FiberJson>;
    };

/**
 * Typed handle for one named Fiber definition, returned by
 * `fibers.create()`. The handle holds no state of its own; it addresses runs
 * of its definition through the owning capability.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface Fiber<Input, Output extends FiberValue> {
  readonly name: string;

  /** Durably accept a run and return without waiting for terminal state. */
  run(input: Input, options?: FiberRunOptions): Promise<FiberReceipt>;

  /** Read one run of this definition. */
  get(runId: string): Promise<FiberRunSnapshot<Output> | null>;

  /** Read one run of this definition by its idempotency key. */
  getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<FiberRunSnapshot<Output> | null>;

  /** Request cooperative cancellation. True when a live run was cancelled. */
  cancel(runId: string, reason?: string): Promise<boolean>;
}

/** @internal Raw `cf_fiber_runs` SQLite row. */
export type FiberRunRow = {
  run_id: string;
  definition: string;
  input: string | null;
  state: FiberRunState;
  result: string | null;
  error_name: string | null;
  error_message: string | null;
  status_message: string | null;
  metadata: string | null;
  idempotency_key: string | null;
  retain: number;
  attempt: number;
  generation: string | null;
  next_at: number | null;
  wait_reason: FiberWaitReason | null;
  cancel_requested: number;
  cancel_reason: string | null;
  created_at: number;
  started_at: number | null;
  updated_at: number;
  settled_at: number | null;
};

/** @internal Raw `cf_fiber_steps` SQLite row. */
export type FiberStepRow = {
  run_id: string;
  step_name: string;
  kind: "do" | "sleep";
  state: "running" | "waiting" | "completed" | "failed";
  result: string | null;
  error_name: string | null;
  error_message: string | null;
  attempt: number;
  next_at: number | null;
  created_at: number;
  started_at: number | null;
  updated_at: number;
  completed_at: number | null;
};
