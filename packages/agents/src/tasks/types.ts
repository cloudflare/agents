import type { TaskDurationString } from "./duration";

/**
 * JSON-serializable data accepted as Task input, step results, metadata,
 * and final results.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskJson =
  | string
  | number
  | boolean
  | null
  | TaskJson[]
  | { [key: string]: TaskJson };

/**
 * A value a Task handler or step callback may produce. `undefined` and
 * `void` persist as SQL `NULL` and restore as `undefined`.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskValue = TaskJson | undefined | void;

/**
 * Constraint for a Tasks definitions map: named handlers invoked from the
 * beginning on every execution attempt, with completed steps returning
 * journaled results instead of running again. An unclean interruption —
 * process loss mid-attempt — replays the handler the same way; durable
 * progress lives in the step journal and in whatever durable state the
 * handler wrote (a stream's cursor, an idempotent external write), so
 * handlers resume from evidence instead of receiving a recovery callback.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskHandlers = Record<
  string,
  // The input parameter is `never` so any concretely-typed definition
  // satisfies the constraint under contravariance; each definition's real
  // input type is recovered with `TaskInput`.
  (input: never, step: TaskStep) => TaskValue | Promise<TaskValue>
>;

/**
 * Default definitions surface for a Tasks constructed without a typed map:
 * any name compiles with an untyped input. At runtime a name must be
 * declared in the constructor map or supplied by a composition-root
 * resolver; a bare Tasks rejects it otherwise.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskCallbacks = Record<
  string,
  (input: unknown, step: TaskStep) => TaskValue | Promise<TaskValue>
>;

/**
 * The input type a registered Task definition accepts.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskInput<Handler> = Handler extends (
  input: infer Input,
  ...rest: never[]
) => unknown
  ? Input
  : never;

/**
 * The settled output type a registered Task definition produces.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskOutput<Handler> = Handler extends (
  ...args: never[]
) => infer Output
  ? Awaited<Output> extends TaskValue
    ? Awaited<Output>
    : never
  : never;

/**
 * Per-attempt context passed to a `step.do()` callback.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskStepAttempt {
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
export interface TaskStepConfig {
  retries?: {
    /** Total attempts, including the first. */
    limit?: number;
    /** Delay before the first retry. */
    delay?: number | TaskDurationString;
    /** Delay growth across retries. Defaults to exponential. */
    backoff?: "constant" | "linear" | "exponential";
  };

  /** Timeout of one callback attempt. */
  timeout?: number | TaskDurationString;
}

/**
 * The step API a Task handler receives. Named steps are the run's durable
 * journal: `do` memoizes completed results, sleeps persist their first
 * deadline, and both suspend the execution attempt rather than holding the
 * invocation open.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskStep {
  /** Run a named step once, replaying its journaled result thereafter. */
  do<T extends TaskValue>(
    name: string,
    callback: (attempt: TaskStepAttempt) => T | Promise<T>
  ): Promise<T>;
  do<T extends TaskValue>(
    name: string,
    config: TaskStepConfig,
    callback: (attempt: TaskStepAttempt) => T | Promise<T>
  ): Promise<T>;

  /**
   * Sleep durably. The first recorded deadline is authoritative; replays
   * before it suspend again, replays after it continue.
   */
  sleep(name: string, duration: number | TaskDurationString): Promise<void>;

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
 * States a Task run moves through.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskRunState =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

/** Why a waiting run is waiting. */
export type TaskWaitReason = "sleep" | "retry";

/** Safe projection of an error retained with a failed run. */
export interface TaskError {
  name: string;
  message: string;
}

/**
 * Options accepted when starting one Task run.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskRunOptions {
  /** Stable key deduplicating repeated acceptance attempts onto one run. */
  idempotencyKey?: string;

  /** Caller-selected run ID. Generated when omitted. */
  runId?: string;

  /** JSON metadata retained with the run. */
  metadata?: Record<string, TaskJson>;

  /** Keep terminal state for inspection. Defaults to `true`. */
  retain?: boolean;
}

/**
 * Durable acceptance receipt returned by `Task.run()`. `accepted: false`
 * means an existing run matched `runId` or `idempotencyKey`; it is not an
 * error.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskReceipt {
  runId: string;
  definition: string;
  accepted: boolean;
  state: TaskRunState;
  createdAt: number;
}

/**
 * Read-only snapshot of one Task run, discriminated by state.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskRunSnapshot<Output extends TaskValue> =
  | {
      runId: string;
      definition: string;
      state: "pending";
      createdAt: number;
      metadata?: Record<string, TaskJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "running";
      attempt: number;
      startedAt: number;
      createdAt: number;
      statusMessage?: string;
      metadata?: Record<string, TaskJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "waiting";
      reason: TaskWaitReason;
      wakeAt: number;
      createdAt: number;
      statusMessage?: string;
      metadata?: Record<string, TaskJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "completed";
      result: Output;
      createdAt: number;
      settledAt: number;
      metadata?: Record<string, TaskJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "failed";
      error: TaskError;
      createdAt: number;
      settledAt: number;
      metadata?: Record<string, TaskJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "cancelled";
      reason?: string;
      createdAt: number;
      settledAt: number;
      metadata?: Record<string, TaskJson>;
    };

/**
 * Typed handle for one named Task definition, returned by
 * `tasks.create()`. The handle holds no state of its own; it addresses runs
 * of its definition through the owning capability.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface Task<Input, Output extends TaskValue> {
  readonly name: string;

  /** Durably accept a run and return without waiting for terminal state. */
  run(input: Input, options?: TaskRunOptions): Promise<TaskReceipt>;

  /** Read one run of this definition. */
  get(runId: string): Promise<TaskRunSnapshot<Output> | null>;

  /** Read one run of this definition by its idempotency key. */
  getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<TaskRunSnapshot<Output> | null>;

  /** Request cooperative cancellation. True when a live run was cancelled. */
  cancel(runId: string, reason?: string): Promise<boolean>;
}

/** @internal Raw `cf_agents_task_runs` SQLite row. */
export type TaskRunRow = {
  run_id: string;
  definition: string;
  input: string | null;
  state: TaskRunState;
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
  wait_reason: TaskWaitReason | null;
  cancel_requested: number;
  cancel_reason: string | null;
  created_at: number;
  started_at: number | null;
  updated_at: number;
  settled_at: number | null;
};

/** @internal Raw `cf_agents_task_steps` SQLite row. */
export type TaskStepRow = {
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
