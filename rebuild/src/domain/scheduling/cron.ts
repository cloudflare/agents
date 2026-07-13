import { ValidationError } from "../../kernel/errors.js";

/** Parsed 5-field cron expression: minute hour day-of-month month day-of-week. */
export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** Whether the day-of-month field was anything other than a bare "*". */
  domRestricted: boolean;
  /** Whether the day-of-week field was anything other than a bare "*". */
  dowRestricted: boolean;
}

interface FieldRange {
  min: number;
  max: number;
}

const FIELD_RANGES: readonly FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day-of-week (7 is an alias for Sunday)
];

/** Parses a standard 5-field cron expression. Throws ValidationError on any malformed input. */
export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ValidationError(
      `cron expression must have 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}: "${expr}"`,
    );
  }

  const [minuteField, hourField, domField, monthField, dowField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  const minute = parseField(minuteField, FIELD_RANGES[0]!);
  const hour = parseField(hourField, FIELD_RANGES[1]!);
  const dayOfMonth = parseField(domField, FIELD_RANGES[2]!);
  const month = parseField(monthField, FIELD_RANGES[3]!);
  const dayOfWeek = parseField(dowField, FIELD_RANGES[4]!, { normalizeSeven: true });

  return {
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dayOfMonth.values,
    month: month.values,
    dayOfWeek: dayOfWeek.values,
    domRestricted: dayOfMonth.restricted,
    dowRestricted: dayOfWeek.restricted,
  };
}

function parseField(
  raw: string,
  range: FieldRange,
  options?: { normalizeSeven?: boolean },
): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  const items = raw.split(",");
  for (const item of items) {
    for (const value of parseListItem(item, range)) {
      values.add(options?.normalizeSeven && value === 7 ? 0 : value);
    }
  }
  if (values.size === 0) {
    throw new ValidationError(`cron field "${raw}" produced no values`);
  }
  return { values, restricted: raw !== "*" };
}

function parseListItem(item: string, range: FieldRange): number[] {
  let base = item;
  let step = 1;

  const slash = item.indexOf("/");
  if (slash !== -1) {
    base = item.slice(0, slash);
    const stepStr = item.slice(slash + 1);
    if (!/^\d+$/.test(stepStr)) {
      throw new ValidationError(`invalid cron step "${item}"`);
    }
    step = Number(stepStr);
    if (step <= 0) {
      throw new ValidationError(`cron step must be positive, got "${item}"`);
    }
  }

  let lo: number;
  let hi: number;
  if (base === "*") {
    lo = range.min;
    hi = range.max;
  } else if (base.includes("-")) {
    const parts = base.split("-");
    if (parts.length !== 2 || !/^\d+$/.test(parts[0]!) || !/^\d+$/.test(parts[1]!)) {
      throw new ValidationError(`invalid cron range "${item}"`);
    }
    lo = Number(parts[0]);
    hi = Number(parts[1]);
    if (lo > hi) {
      throw new ValidationError(`invalid cron range "${item}": start greater than end`);
    }
  } else {
    if (!/^\d+$/.test(base)) {
      throw new ValidationError(`invalid cron field value "${item}"`);
    }
    lo = Number(base);
    // A bare number with a step (e.g. "5/15") means "start at 5, step to max".
    hi = slash !== -1 ? range.max : lo;
  }

  if (lo < range.min || hi > range.max) {
    throw new ValidationError(
      `cron value "${item}" out of range [${range.min}, ${range.max}]`,
    );
  }

  const out: number[] = [];
  for (let v = lo; v <= hi; v += step) out.push(v);
  return out;
}

function domDowMatch(spec: CronSpec, dom: number, dow: number): boolean {
  const domMatch = spec.dayOfMonth.has(dom);
  const dowMatch = spec.dayOfWeek.has(dow);
  if (spec.domRestricted && spec.dowRestricted) return domMatch || dowMatch;
  if (spec.domRestricted) return domMatch;
  if (spec.dowRestricted) return dowMatch;
  return true;
}

function startOfNextMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0));
}

function startOfNextDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0));
}

function startOfNextHour(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1, 0, 0),
  );
}

const SEARCH_HORIZON_YEARS = 8;

/**
 * Computes the next time (epoch ms) matching `spec`, strictly after `afterMs`.
 * `timezoneOffsetMinutes` shifts the wall clock by a fixed offset (not DST-aware);
 * omit it (or pass 0) to compute purely in UTC.
 */
export function nextCronTime(
  spec: CronSpec,
  afterMs: number,
  timezoneOffsetMinutes = 0,
): number {
  const offsetMs = timezoneOffsetMinutes * 60_000;
  const start = new Date(afterMs + offsetMs);
  let cursor = new Date(
    Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate(),
      start.getUTCHours(),
      start.getUTCMinutes(),
      0,
    ) + 60_000,
  );

  const horizon = Date.UTC(cursor.getUTCFullYear() + SEARCH_HORIZON_YEARS, 0, 1);

  while (cursor.getTime() < horizon) {
    const month = cursor.getUTCMonth() + 1;
    if (!spec.month.has(month)) {
      cursor = startOfNextMonth(cursor);
      continue;
    }

    const dom = cursor.getUTCDate();
    const dow = cursor.getUTCDay();
    if (!domDowMatch(spec, dom, dow)) {
      cursor = startOfNextDay(cursor);
      continue;
    }

    const hour = cursor.getUTCHours();
    if (!spec.hour.has(hour)) {
      cursor = startOfNextHour(cursor);
      continue;
    }

    const minute = cursor.getUTCMinutes();
    if (!spec.minute.has(minute)) {
      cursor = new Date(cursor.getTime() + 60_000);
      continue;
    }

    return cursor.getTime() - offsetMs;
  }

  throw new ValidationError(
    `cron expression has no matching time within ${SEARCH_HORIZON_YEARS} years`,
  );
}
