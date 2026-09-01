import type { RetryOptions } from "../retries";

/**
 * A persisted task scheduled by an Agent.
 *
 * @template T Type of the callback payload.
 */
export type Schedule<T = string> = {
  /** Unique schedule identifier. */
  id: string;
  /** Name of the Agent method invoked by the schedule. */
  callback: string;
  /** Data passed to the callback. */
  payload: T;
  /** Retry policy for callback execution. */
  retry?: RetryOptions;
} & (
  | {
      /** One-time execution at a specific date. */
      type: "scheduled";
      /** Unix timestamp in seconds. */
      time: number;
    }
  | {
      /** One-time execution after a relative delay. */
      type: "delayed";
      /** Unix timestamp in seconds. */
      time: number;
      /** Delay from creation in seconds. */
      delayInSeconds: number;
    }
  | {
      /** Recurring execution from a cron expression. */
      type: "cron";
      /** Unix timestamp in seconds for the next execution. */
      time: number;
      /** Cron expression defining the recurrence. */
      cron: string;
    }
  | {
      /** Recurring execution at a fixed interval. */
      type: "interval";
      /** Unix timestamp in seconds for the next execution. */
      time: number;
      /** Number of seconds between executions. */
      intervalSeconds: number;
    }
);

/**
 * Constraint for a Scheduler's registered callback map: named handlers
 * receiving the parsed payload and the schedule that fired.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type SchedulerHandlers = Record<
  string,
  // Parameters are `never` so any concretely-typed handler satisfies the
  // constraint under contravariance; each handler's real parameter types are
  // recovered with `SchedulerPayload`.
  (payload: never, schedule: never) => unknown
>;

/**
 * Default callback surface for a Scheduler constructed without registered
 * callbacks: any name compiles with an untyped payload. At runtime a name
 * must be registered or supplied by a composition-root resolver (the
 * aperture behind Agent's name-based scheduling API); a bare Scheduler
 * rejects it otherwise.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type SchedulerCallbacks = Record<
  string,
  (payload: unknown, schedule: Schedule<unknown>) => unknown
>;

/**
 * The payload type a registered scheduler callback accepts.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type SchedulerPayload<Handler> = Handler extends (
  payload: infer Payload,
  ...rest: never[]
) => unknown
  ? Payload
  : never;

/** Options accepted when creating one schedule. */
export type ScheduleOptions = {
  /** Retry policy for callback execution, overriding the Scheduler default. */
  retry?: RetryOptions;
  /**
   * Deduplicate onto an existing matching schedule instead of creating a new
   * row. Defaults to `true` for cron and interval schedules, `false` for
   * one-shot schedules.
   */
  idempotent?: boolean;
};

/**
 * @internal Chat-recovery scaffolding, deliberately NOT part of
 * {@link ScheduleOptions}: schedules only shape future work — a row that
 * drives an OOM-prone loop belongs in the Tasks capability, whose runs
 * carry their own memory-limit policy. Until chat recovery migrates onto
 * Tasks, its schedules ride the alarm memory-limit breaker (#1825) through
 * this option; the Scheduler passes it through to the Lifecycle job row
 * untouched (`LifecycleJobPushOptions.recoveryLoop`). Removed with that
 * migration — do not use it for new work.
 */
export type RecoveryLoopScheduleOptions = ScheduleOptions & {
  recoveryLoop: true;
};

/** Filters accepted by `getSchedules()` and `listSchedules()`. */
export type ScheduleCriteria = {
  id?: string;
  type?: "scheduled" | "delayed" | "cron" | "interval";
  timeRange?: { start?: Date; end?: Date };
};

/** @internal Raw `cf_agents_schedules` SQLite row. */
export type ScheduleStorageRow = {
  id: string;
  callback: string;
  payload: string;
  type: "scheduled" | "delayed" | "cron" | "interval";
  time: number;
  delayInSeconds?: number;
  cron?: string;
  intervalSeconds?: number;
  running?: number;
  execution_started_at?: number | null;
  retry_options?: string | null;
  owner_path?: string | null;
  owner_path_key?: string | null;
};
