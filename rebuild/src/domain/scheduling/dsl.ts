import { ValidationError } from "../../kernel/errors.js";

export type ParsedSchedule =
  | { kind: "interval"; everyMs: number }
  | {
      kind: "wall-clock";
      hour: number;
      minute: number;
      days: "all" | "weekday" | number[];
      inlineTimezone?: string;
    };

const DAY_NAMES: Record<string, number> = {
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
  saturday: 6,
};

const SHORT_DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const MINUTE_RE = /^every\s+minute$/i;
const MINUTES_RE = /^every\s+(\d+)\s+minutes$/i;
const HOUR_RE = /^every\s+hour$/i;
const HOURS_RE = /^every\s+(\d+)\s+hours$/i;
const DAY_RE = /^every\s+day\s+at\s+(\d{1,2}):(\d{1,2})(?:\s+in\s+(.+))?$/i;
const WEEKDAY_RE = /^every\s+weekday\s+at\s+(\d{1,2}):(\d{1,2})(?:\s+in\s+(.+))?$/i;
const WEEK_RE =
  /^every\s+week\s+on\s+([a-zA-Z]+(?:\s*,\s*[a-zA-Z]+)*)\s+at\s+(\d{1,2}):(\d{1,2})(?:\s+in\s+(.+))?$/i;

function grammarError(raw: string): ValidationError {
  return new ValidationError(
    `invalid schedule "${raw}": expected one of "every minute", "every <n> minutes", ` +
      `"every hour", "every <n> hours", "every day at HH:mm [in <tz>]", ` +
      `"every weekday at HH:mm [in <tz>]", or "every week on <day[,day...]> at HH:mm [in <tz>]"`,
  );
}

function parseTimeOfDay(hourStr: string, minuteStr: string, raw: string): { hour: number; minute: number } {
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new ValidationError(`invalid schedule "${raw}": hour "${hourStr}" out of range [0, 23]`);
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new ValidationError(`invalid schedule "${raw}": minute "${minuteStr}" out of range [0, 59]`);
  }
  return { hour, minute };
}

function validateTimezone(tz: string, raw: string): string {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    throw new ValidationError(`invalid schedule "${raw}": unknown IANA timezone "${tz}"`);
  }
  return tz;
}

function parsePositiveInt(str: string, unit: string, raw: string): number {
  const n = Number(str);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`invalid schedule "${raw}": "${str}" ${unit} must be a positive integer`);
  }
  return n;
}

function parseDayList(dayList: string, raw: string): number[] {
  const tokens = dayList.split(",").map((t) => t.trim().toLowerCase());
  const days = new Set<number>();
  for (const token of tokens) {
    const day = DAY_NAMES[token];
    if (day === undefined) {
      throw new ValidationError(`invalid schedule "${raw}": unknown day "${token}"`);
    }
    days.add(day);
  }
  if (days.size === 0) {
    throw new ValidationError(`invalid schedule "${raw}": no days specified`);
  }
  return [...days].sort((a, b) => a - b);
}

/** Parses Think's human-friendly schedule DSL. Throws ValidationError on anything else. */
export function parseScheduleDsl(raw: string): ParsedSchedule {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw grammarError(raw);
  }

  if (MINUTE_RE.test(trimmed)) {
    return { kind: "interval", everyMs: 60_000 };
  }

  let match = MINUTES_RE.exec(trimmed);
  if (match) {
    const n = parsePositiveInt(match[1]!, "minutes", trimmed);
    return { kind: "interval", everyMs: n * 60_000 };
  }

  if (HOUR_RE.test(trimmed)) {
    return { kind: "interval", everyMs: 3_600_000 };
  }

  match = HOURS_RE.exec(trimmed);
  if (match) {
    const n = parsePositiveInt(match[1]!, "hours", trimmed);
    return { kind: "interval", everyMs: n * 3_600_000 };
  }

  match = DAY_RE.exec(trimmed);
  if (match) {
    const { hour, minute } = parseTimeOfDay(match[1]!, match[2]!, trimmed);
    const inlineTimezone = match[3] ? validateTimezone(match[3].trim(), trimmed) : undefined;
    return {
      kind: "wall-clock",
      hour,
      minute,
      days: "all",
      ...(inlineTimezone ? { inlineTimezone } : {}),
    };
  }

  match = WEEKDAY_RE.exec(trimmed);
  if (match) {
    const { hour, minute } = parseTimeOfDay(match[1]!, match[2]!, trimmed);
    const inlineTimezone = match[3] ? validateTimezone(match[3].trim(), trimmed) : undefined;
    return {
      kind: "wall-clock",
      hour,
      minute,
      days: "weekday",
      ...(inlineTimezone ? { inlineTimezone } : {}),
    };
  }

  match = WEEK_RE.exec(trimmed);
  if (match) {
    const days = parseDayList(match[1]!, trimmed);
    const { hour, minute } = parseTimeOfDay(match[2]!, match[3]!, trimmed);
    const inlineTimezone = match[4] ? validateTimezone(match[4].trim(), trimmed) : undefined;
    return {
      kind: "wall-clock",
      hour,
      minute,
      days,
      ...(inlineTimezone ? { inlineTimezone } : {}),
    };
  }

  throw grammarError(raw);
}

// --- Timezone-aware wall-clock math -----------------------------------

function getZonedParts(
  utcMs: number,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  // Some locales render midnight as "24" with hour12: false.
  const hour = map.hour === "24" ? 0 : Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function getOffsetMinutes(utcMs: number, timeZone: string): number {
  const p = getZonedParts(utcMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - utcMs) / 60_000);
}

/**
 * Maps a wall-clock date/time in `timeZone` to the corresponding UTC instant.
 * DST-correct: resolves the standard offset-probing fixed point, and for a
 * wall time that falls inside a spring-forward gap (does not exist), rolls
 * forward using the pre-transition offset — landing on the instant that,
 * read back in the zone, is shifted forward by exactly the gap duration.
 */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = getOffsetMinutes(guess, timeZone);
  const candidate1 = guess - offset1 * 60_000;
  const offset2 = getOffsetMinutes(candidate1, timeZone);
  if (offset2 === offset1) return candidate1;

  const candidate2 = guess - offset2 * 60_000;
  const offset3 = getOffsetMinutes(candidate2, timeZone);
  if (offset3 === offset2) return candidate2;

  // Neither candidate round-trips: the wall time falls in a spring-forward
  // gap. Roll forward using the smaller (pre-transition) offset.
  const offsetBefore = Math.min(offset1, offset2);
  return guess - offsetBefore * 60_000;
}

function addDaysToYmd(
  year: number,
  month: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function daysMatch(days: "all" | "weekday" | number[], weekday: number): boolean {
  if (days === "all") return true;
  if (days === "weekday") return weekday >= 1 && weekday <= 5;
  return days.includes(weekday);
}

const SEARCH_HORIZON_DAYS = 14;

/** Next strictly-future occurrence (epoch ms) of `schedule` after `nowMs`. */
export function nextOccurrence(schedule: ParsedSchedule, nowMs: number, timezone?: string): number {
  if (schedule.kind === "interval") {
    return nowMs + schedule.everyMs;
  }

  const tz = schedule.inlineTimezone ?? timezone;
  if (!tz) {
    throw new ValidationError(
      "wall-clock schedule has no timezone: provide an inline 'in <tz>' clause, a task-level timezone, or an agent default timezone",
    );
  }
  // Validate lazily in case an unvalidated timezone was passed through `timezone`.
  validateTimezone(tz, `nextOccurrence(timezone="${tz}")`);

  const nowParts = getZonedParts(nowMs, tz);

  for (let offset = 0; offset <= SEARCH_HORIZON_DAYS; offset++) {
    const { year, month, day } = addDaysToYmd(nowParts.year, nowParts.month, nowParts.day, offset);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (!daysMatch(schedule.days, weekday)) continue;

    const candidate = zonedTimeToUtc(year, month, day, schedule.hour, schedule.minute, tz);
    if (candidate > nowMs) return candidate;
  }

  // Unreachable for well-formed `days` sets (every set has a match within 7 days).
  throw new ValidationError("no matching occurrence found within the search horizon");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Stable, human-readable description of a schedule. Used for hashing/dedup. */
export function describeSchedule(schedule: ParsedSchedule): string {
  if (schedule.kind === "interval") {
    if (schedule.everyMs % 3_600_000 === 0) {
      const n = schedule.everyMs / 3_600_000;
      return n === 1 ? "every hour" : `every ${n} hours`;
    }
    const n = schedule.everyMs / 60_000;
    return n === 1 ? "every minute" : `every ${n} minutes`;
  }

  const time = `${pad2(schedule.hour)}:${pad2(schedule.minute)}`;
  const tzSuffix = schedule.inlineTimezone ? ` in ${schedule.inlineTimezone}` : "";

  if (schedule.days === "all") {
    return `every day at ${time}${tzSuffix}`;
  }
  if (schedule.days === "weekday") {
    return `every weekday at ${time}${tzSuffix}`;
  }
  const names = [...schedule.days].sort((a, b) => a - b).map((d) => SHORT_DAY_NAMES[d]);
  return `every week on ${names.join(",")} at ${time}${tzSuffix}`;
}
