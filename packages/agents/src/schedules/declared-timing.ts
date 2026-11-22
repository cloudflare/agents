/**
 * The declared-schedule DSL: parse an expression such as
 * `"every weekday at 09:00 in Europe/London"` and compute its next
 * occurrence. Pure functions; no storage.
 */

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type Hour = `0${Digit}` | `1${Digit}` | "20" | "21" | "22" | "23";
type Minute = `${"0" | "1" | "2" | "3" | "4" | "5"}${Digit}`;

/** A wall-clock time of day, `HH:mm` on a 24-hour clock. */
export type ScheduleTime = `${Hour}:${Minute}`;

/** A fixed interval: `every 5 minutes`, `every 1 hour`. */
export type IntervalScheduleExpression =
  | `every ${number} minute${"" | "s"}`
  | `every ${number} hour${"" | "s"}`;

/** A time of day on some days, in a timezone supplied separately. */
export type WallClockScheduleExpression =
  | `every day at ${ScheduleTime}`
  | `every weekday at ${ScheduleTime}`
  | `every week on ${string} at ${ScheduleTime}`;

/** Every expression a declared schedule accepts. */
export type DeclaredScheduleExpression =
  | IntervalScheduleExpression
  | WallClockScheduleExpression
  | `${WallClockScheduleExpression} in ${string}`;

/** @internal A parsed declared-schedule expression. JSON-serializable. */
export type ParsedDeclaredSchedule =
  | {
      kind: "interval";
      intervalMs: number;
      normalizedSchedule: string;
    }
  | {
      kind: "wall-clock";
      normalizedSchedule: string;
      timezone: string;
      hour: number;
      minute: number;
      days: "daily" | "weekday" | number[];
    };

type ParseDeclaredScheduleResult =
  | { ok: true; schedule: ParsedDeclaredSchedule }
  | { ok: false; error: string };

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

/** @internal Resolve a timezone to its canonical name, or throw. */
export function validateTimezone(timezone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return formatter.resolvedOptions().timeZone;
  } catch {
    throw new Error(`Invalid timezone "${timezone}"`);
  }
}

function parseTime(value: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid schedule time "${value}"; expected HH:mm`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

const declaredScheduleDayNumbers: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6
};

/** @internal Parse an expression, throwing a readable error when invalid. */
export function parseDeclaredSchedule(
  rawSchedule: string,
  taskTimezone: string | undefined,
  defaultTimezone: string | undefined
): ParsedDeclaredSchedule {
  const result = tryParseDeclaredSchedule(
    rawSchedule,
    taskTimezone,
    defaultTimezone
  );
  if (!result.ok) throw new Error(result.error);
  return result.schedule;
}

/** @internal Parse an expression without throwing. */
export function tryParseDeclaredSchedule(
  rawSchedule: string,
  taskTimezone: string | undefined,
  defaultTimezone: string | undefined
): ParseDeclaredScheduleResult {
  try {
    return {
      ok: true,
      schedule: parseDeclaredScheduleUnchecked(
        rawSchedule,
        taskTimezone,
        defaultTimezone
      )
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseDeclaredScheduleUnchecked(
  rawSchedule: string,
  taskTimezone: string | undefined,
  defaultTimezone: string | undefined
): ParsedDeclaredSchedule {
  const trimmed = rawSchedule.trim().replace(/\s+/g, " ").toLowerCase();
  const inlineTimezoneMatch = /^(.*) in ([A-Za-z_][A-Za-z0-9_+\-/]*)$/.exec(
    trimmed
  );
  const schedule = inlineTimezoneMatch?.[1] ?? trimmed;
  const inlineTimezone = inlineTimezoneMatch?.[2];
  if (
    inlineTimezone &&
    taskTimezone &&
    validateTimezone(inlineTimezone) !== validateTimezone(taskTimezone)
  ) {
    throw new Error(
      `Schedule timezone "${inlineTimezone}" does not match task timezone "${taskTimezone}"`
    );
  }

  const intervalMatch = /^every ([1-9]\d*) (minute|minutes|hour|hours)$/.exec(
    schedule
  );
  if (intervalMatch) {
    if (inlineTimezone || taskTimezone) {
      throw new Error("Interval schedules cannot specify a timezone");
    }
    const count = Number(intervalMatch[1]);
    const unit = intervalMatch[2];
    if (count === 1 && unit.endsWith("s")) {
      throw new Error(`Use singular unit for "${rawSchedule}"`);
    }
    if (count !== 1 && !unit.endsWith("s")) {
      throw new Error(`Use plural unit for "${rawSchedule}"`);
    }
    return {
      kind: "interval",
      intervalMs: count * (unit.startsWith("hour") ? 60 * 60_000 : 60_000),
      normalizedSchedule: `every ${count} ${unit}`
    };
  }

  const timezone = inlineTimezone ?? taskTimezone ?? defaultTimezone;
  if (!timezone) {
    throw new Error(`Wall-clock schedule "${rawSchedule}" requires a timezone`);
  }
  const resolvedTimezone = validateTimezone(timezone);

  const dailyMatch = /^every day at ([0-2]\d:[0-5]\d)$/.exec(schedule);
  if (dailyMatch) {
    const { hour, minute } = parseTime(dailyMatch[1]);
    return {
      kind: "wall-clock",
      normalizedSchedule: `every day at ${dailyMatch[1]}`,
      timezone: resolvedTimezone,
      hour,
      minute,
      days: "daily"
    };
  }

  const weekdayMatch = /^every weekday at ([0-2]\d:[0-5]\d)$/.exec(schedule);
  if (weekdayMatch) {
    const { hour, minute } = parseTime(weekdayMatch[1]);
    return {
      kind: "wall-clock",
      normalizedSchedule: `every weekday at ${weekdayMatch[1]}`,
      timezone: resolvedTimezone,
      hour,
      minute,
      days: "weekday"
    };
  }

  const weeklyMatch = /^every week on ([a-z,\s]+) at ([0-2]\d:[0-5]\d)$/.exec(
    schedule
  );
  if (weeklyMatch) {
    const seen = new Set<number>();
    const days = weeklyMatch[1].split(",").map((day) => {
      const normalized = day.trim();
      const dayNumber = declaredScheduleDayNumbers[normalized];
      if (dayNumber === undefined) {
        throw new Error(`Invalid schedule day "${normalized}"`);
      }
      if (seen.has(dayNumber)) {
        throw new Error(`Duplicate schedule day "${normalized}"`);
      }
      seen.add(dayNumber);
      return dayNumber;
    });
    if (days.length === 0) {
      throw new Error("Weekly schedule requires at least one day");
    }
    const { hour, minute } = parseTime(weeklyMatch[2]);
    return {
      kind: "wall-clock",
      normalizedSchedule: `every week on ${weeklyMatch[1]
        .split(",")
        .map((day) => day.trim())
        .join(",")} at ${weeklyMatch[2]}`,
      timezone: resolvedTimezone,
      hour,
      minute,
      days
    };
  }

  throw new Error(`Unsupported schedule DSL "${rawSchedule}"`);
}

// findZonedInstant calls getZonedParts once per minute across a 28-hour
// window, so building a formatter per call dominated the CPU cost of resolving
// a wall-clock occurrence. Formatters are stateless, so keep one per timezone.
// The map holds at most one entry per distinct timezone, and an invalid
// timezone throws before anything is cached.
const zonedPartsFormatters = new Map<string, Intl.DateTimeFormat>();

function getZonedPartsFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = zonedPartsFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      calendar: "iso8601",
      numberingSystem: "latn",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
    zonedPartsFormatters.set(timezone, formatter);
  }
  return formatter;
}

function getZonedParts(date: Date, timezone: string): ZonedParts {
  const parts = getZonedPartsFormatter(timezone).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return {
    year: Number(part("year")),
    month: Number(part("month")),
    day: Number(part("day")),
    hour: Number(part("hour")),
    minute: Number(part("minute")),
    second: Number(part("second")),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      part("weekday")
    )
  };
}

function compareLocalParts(
  left: Pick<ZonedParts, "year" | "month" | "day" | "hour" | "minute">,
  right: Pick<ZonedParts, "year" | "month" | "day" | "hour" | "minute">
): number {
  const fields = ["year", "month", "day", "hour", "minute"] as const;
  for (const field of fields) {
    const diff = left[field] - right[field];
    if (diff !== 0) return diff;
  }
  return 0;
}

function findZonedInstant(
  target: Pick<ZonedParts, "year" | "month" | "day" | "hour" | "minute">,
  timezone: string
): Date {
  const approximate = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute
  );
  const start = approximate - 14 * 60 * 60_000;
  const end = approximate + 14 * 60 * 60_000;
  for (let time = start; time <= end; time += 60_000) {
    const candidate = new Date(time);
    const parts = getZonedParts(candidate, timezone);
    if (compareLocalParts(parts, target) === 0) return candidate;
  }
  for (let time = start; time <= end; time += 60_000) {
    const candidate = new Date(time);
    const parts = getZonedParts(candidate, timezone);
    if (compareLocalParts(parts, target) > 0) return candidate;
  }
  throw new Error(`Unable to resolve local time in timezone "${timezone}"`);
}

function addLocalDays(
  parts: Pick<ZonedParts, "year" | "month" | "day">,
  days: number
): Pick<ZonedParts, "year" | "month" | "day"> {
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days)
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function isAllowedWallClockDay(
  weekday: number,
  days: ParsedDeclaredSchedule & { kind: "wall-clock" }
): boolean {
  if (days.days === "daily") return true;
  if (days.days === "weekday") return weekday >= 1 && weekday <= 5;
  return days.days.includes(weekday);
}

/**
 * @internal The first occurrence after `now`. An interval continues from
 * `previousScheduledFor` when given, skipping missed occurrences.
 */
export function nextDeclaredScheduleTime(
  schedule: ParsedDeclaredSchedule,
  now: Date,
  previousScheduledFor?: number
): Date {
  if (schedule.kind === "interval") {
    let next =
      previousScheduledFor === undefined
        ? now.getTime() + schedule.intervalMs
        : previousScheduledFor + schedule.intervalMs;
    while (next <= now.getTime()) next += schedule.intervalMs;
    return new Date(next);
  }

  const nowParts = getZonedParts(now, schedule.timezone);
  for (let offset = 0; offset < 370; offset++) {
    const localDate = addLocalDays(nowParts, offset);
    const candidate = findZonedInstant(
      {
        ...localDate,
        hour: schedule.hour,
        minute: schedule.minute
      },
      schedule.timezone
    );
    const weekday = getZonedParts(candidate, schedule.timezone).weekday;
    if (!isAllowedWallClockDay(weekday, schedule)) continue;
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  throw new Error("Unable to compute next scheduled task occurrence");
}
