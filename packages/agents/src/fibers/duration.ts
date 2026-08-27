/**
 * Duration parsing for the Fibers capability. Durations appear in step
 * retry delays, per-attempt timeouts, and durable sleeps.
 */

/** Units accepted in a {@link FiberDurationString}. */
export type FiberDurationUnit = "second" | "minute" | "hour" | "day" | "week";

/**
 * A human-readable duration such as `"10 seconds"` or `"1 day"`.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type FiberDurationString = `${number} ${FiberDurationUnit}${"" | "s"}`;

const UNIT_MILLISECONDS: Record<FiberDurationUnit, number> = {
  second: 1000,
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000
};

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s+(second|minute|hour|day|week)s?$/;

/**
 * Parse a duration into whole milliseconds.
 *
 * @param duration - Milliseconds, or a duration string such as `"10 seconds"`.
 * @param context - Name of the option being parsed, used in error messages.
 * @returns The duration in milliseconds, floored to an integer.
 * @throws Error when the duration is negative, not finite, or unparseable.
 */
export function parseFiberDuration(
  duration: number | FiberDurationString,
  context: string
): number {
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0) {
      throw new Error(
        `Invalid ${context}: expected a non-negative number of milliseconds, got ${duration}`
      );
    }
    return Math.floor(duration);
  }
  const match = DURATION_PATTERN.exec(duration.trim());
  if (!match) {
    throw new Error(
      `Invalid ${context}: expected milliseconds or a duration like "10 seconds", got ${JSON.stringify(duration)}`
    );
  }
  const amount = Number(match[1]);
  const unit = match[2] as FiberDurationUnit;
  return Math.floor(amount * UNIT_MILLISECONDS[unit]);
}
