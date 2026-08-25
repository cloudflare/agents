/**
 * Pure timing rules for persistent schedules.
 *
 * A `ScheduleTiming` is the parsed "when and how it runs" half of a
 * `Schedule` — everything except identity, callback, and payload. Parsing
 * user-facing inputs here keeps Scheduler's storage code to one insert path.
 */

import { parseCronExpression } from "cron-schedule";

/** Longest allowed gap between interval executions: 30 days. */
export const MAX_INTERVAL_SECONDS = 30 * 24 * 60 * 60;

/** When and how one schedule runs; a `Schedule` minus identity and payload. */
export type ScheduleTiming =
  | {
      /** One-time execution at a specific date. */
      readonly type: "scheduled";
      /** Unix timestamp in seconds. */
      readonly time: number;
    }
  | {
      /** One-time execution after a relative delay. */
      readonly type: "delayed";
      /** Unix timestamp in seconds. */
      readonly time: number;
      /** Delay from creation in seconds. */
      readonly delayInSeconds: number;
    }
  | {
      /** Recurring execution from a cron expression. */
      readonly type: "cron";
      /** Unix timestamp in seconds for the next execution. */
      readonly time: number;
      /** Cron expression defining the recurrence. */
      readonly cron: string;
    }
  | {
      /** Recurring execution at a fixed interval. */
      readonly type: "interval";
      /** Unix timestamp in seconds for the next execution. */
      readonly time: number;
      /** Number of seconds between executions. */
      readonly intervalSeconds: number;
    };

/** True when this timing repeats and therefore deduplicates by default. */
export function isRecurring(timing: ScheduleTiming): boolean {
  return timing.type === "cron" || timing.type === "interval";
}

/**
 * Next wall-clock execution time for a cron expression.
 *
 * @param cron - A standard cron expression.
 * @param nowMs - Current epoch time in milliseconds.
 * @returns The next execution epoch time in milliseconds.
 * @throws For an unparseable cron expression.
 */
export function nextCronTimeMs(cron: string, nowMs: number): number {
  return parseCronExpression(cron).getNextDate(new Date(nowMs)).getTime();
}

/**
 * Parse a user-facing `when` into schedule timing.
 *
 * A `Date` runs once at that date, a number runs once after that many
 * seconds, and a string is a recurring cron expression.
 *
 * @param when - The requested execution time or recurrence.
 * @param nowMs - Current epoch time in milliseconds.
 * @param callback - Callback name, used only in error messages.
 * @returns The parsed timing.
 * @throws For a `when` value that is not a `Date`, number, or string.
 */
export function parseWhen(
  when: Date | string | number,
  nowMs: number,
  callback: string
): ScheduleTiming {
  if (when instanceof Date) {
    return { type: "scheduled", time: Math.floor(when.getTime() / 1000) };
  }
  if (typeof when === "number") {
    return {
      type: "delayed",
      time: Math.floor((nowMs + when * 1000) / 1000),
      delayInSeconds: when
    };
  }
  if (typeof when === "string") {
    return {
      type: "cron",
      time: Math.floor(nextCronTimeMs(when, nowMs) / 1000),
      cron: when
    };
  }
  throw new Error(
    `Invalid schedule type: ${JSON.stringify(when)}(${typeof when}) trying to schedule ${callback}`
  );
}

/**
 * Reject an interval outside the supported range.
 *
 * @param intervalSeconds - The requested gap between executions.
 * @throws For a non-positive interval or one longer than 30 days.
 */
export function validateIntervalSeconds(intervalSeconds: number): void {
  if (typeof intervalSeconds !== "number" || intervalSeconds <= 0) {
    throw new Error("intervalSeconds must be a positive number");
  }
  if (intervalSeconds > MAX_INTERVAL_SECONDS) {
    throw new Error(
      `intervalSeconds cannot exceed ${MAX_INTERVAL_SECONDS} seconds (30 days)`
    );
  }
}

/**
 * Parse a fixed interval into schedule timing.
 *
 * @param intervalSeconds - Seconds between executions.
 * @param nowMs - Current epoch time in milliseconds.
 * @returns The parsed timing with the first execution one interval from now.
 * @throws For an interval outside the supported range.
 */
export function parseInterval(
  intervalSeconds: number,
  nowMs: number
): ScheduleTiming {
  validateIntervalSeconds(intervalSeconds);
  return {
    type: "interval",
    time: Math.floor((nowMs + intervalSeconds * 1000) / 1000),
    intervalSeconds
  };
}
