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
 * Default callback surface for a Scheduler constructed without a host: any
 * named callback, with untyped payloads. Constructing with the host object
 * instead types `set()`/`every()` against its methods and lets installation
 * verify the host's identity.
 */
export type SchedulerCallbacks = Record<
  string,
  (payload: unknown, schedule: Schedule<unknown>) => unknown
>;

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
  retry?: RetryOptions;
  running?: number;
  execution_started_at?: number | null;
  retry_options?: string | null;
  owner_path?: string | null;
  owner_path_key?: string | null;
};
