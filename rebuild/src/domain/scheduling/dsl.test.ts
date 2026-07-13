import { describe, expect, it } from "vitest";
import { ValidationError } from "../../kernel/errors.js";
import { describeSchedule, nextOccurrence, parseScheduleDsl, type ParsedSchedule } from "./dsl.js";

describe("parseScheduleDsl — grammar productions", () => {
  it("parses 'every minute'", () => {
    expect(parseScheduleDsl("every minute")).toEqual({ kind: "interval", everyMs: 60_000 });
  });

  it("parses 'every <n> minutes'", () => {
    expect(parseScheduleDsl("every 5 minutes")).toEqual({ kind: "interval", everyMs: 300_000 });
  });

  it("parses 'every hour'", () => {
    expect(parseScheduleDsl("every hour")).toEqual({ kind: "interval", everyMs: 3_600_000 });
  });

  it("parses 'every <n> hours'", () => {
    expect(parseScheduleDsl("every 3 hours")).toEqual({ kind: "interval", everyMs: 10_800_000 });
  });

  it("parses 'every day at HH:mm'", () => {
    expect(parseScheduleDsl("every day at 08:00")).toEqual({
      kind: "wall-clock",
      hour: 8,
      minute: 0,
      days: "all",
    });
  });

  it("parses 'every day at HH:mm' with non-zero-padded time", () => {
    expect(parseScheduleDsl("every day at 8:5")).toEqual({
      kind: "wall-clock",
      hour: 8,
      minute: 5,
      days: "all",
    });
  });

  it("parses 'every day at HH:mm in <tz>'", () => {
    expect(parseScheduleDsl("every day at 08:00 in Europe/London")).toEqual({
      kind: "wall-clock",
      hour: 8,
      minute: 0,
      days: "all",
      inlineTimezone: "Europe/London",
    });
  });

  it("parses 'every weekday at HH:mm'", () => {
    expect(parseScheduleDsl("every weekday at 09:30")).toEqual({
      kind: "wall-clock",
      hour: 9,
      minute: 30,
      days: "weekday",
    });
  });

  it("parses 'every weekday at HH:mm in <tz>'", () => {
    expect(parseScheduleDsl("every weekday at 09:30 in America/New_York")).toEqual({
      kind: "wall-clock",
      hour: 9,
      minute: 30,
      days: "weekday",
      inlineTimezone: "America/New_York",
    });
  });

  it("parses 'every week on <day> at HH:mm'", () => {
    expect(parseScheduleDsl("every week on monday at 07:00")).toEqual({
      kind: "wall-clock",
      hour: 7,
      minute: 0,
      days: [1],
    });
  });

  it("parses 'every week on <day,day> at HH:mm' with abbreviations, case-insensitive", () => {
    expect(parseScheduleDsl("every week on Mon,WED,fri at 07:00")).toEqual({
      kind: "wall-clock",
      hour: 7,
      minute: 0,
      days: [1, 3, 5],
    });
  });

  it("parses 'every week on <days> at HH:mm in <tz>', deduping and sorting days", () => {
    expect(parseScheduleDsl("every week on sun, sunday, saturday at 23:59 in Europe/London")).toEqual({
      kind: "wall-clock",
      hour: 23,
      minute: 59,
      days: [0, 6],
      inlineTimezone: "Europe/London",
    });
  });
});

describe("parseScheduleDsl — rejections", () => {
  it("rejects garbage", () => {
    expect(() => parseScheduleDsl("not a schedule")).toThrow(ValidationError);
  });

  it("rejects empty string", () => {
    expect(() => parseScheduleDsl("")).toThrow(ValidationError);
  });

  it("rejects 'every week at HH:mm' (missing day list)", () => {
    expect(() => parseScheduleDsl("every week at 08:00")).toThrow(ValidationError);
  });

  it("rejects an unknown day token", () => {
    expect(() => parseScheduleDsl("every week on funday at 08:00")).toThrow(ValidationError);
  });

  it("rejects a bad time (hour out of range)", () => {
    expect(() => parseScheduleDsl("every day at 24:00")).toThrow(ValidationError);
  });

  it("rejects a bad time (minute out of range)", () => {
    expect(() => parseScheduleDsl("every day at 08:60")).toThrow(ValidationError);
  });

  it("rejects a malformed time", () => {
    expect(() => parseScheduleDsl("every day at noon")).toThrow(ValidationError);
  });

  it("rejects zero minutes interval", () => {
    expect(() => parseScheduleDsl("every 0 minutes")).toThrow(ValidationError);
  });

  it("rejects zero hours interval", () => {
    expect(() => parseScheduleDsl("every 0 hours")).toThrow(ValidationError);
  });

  it("rejects an invalid IANA timezone", () => {
    expect(() => parseScheduleDsl("every day at 08:00 in Not/AZone")).toThrow(ValidationError);
  });

  it("rejects 'every 1 minute' (singular with a number is not in the grammar)", () => {
    expect(() => parseScheduleDsl("every 1 minute")).toThrow(ValidationError);
  });
});

describe("nextOccurrence — interval schedules", () => {
  it("is timezone-free and strictly future", () => {
    const schedule: ParsedSchedule = { kind: "interval", everyMs: 300_000 };
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(nextOccurrence(schedule, now)).toBe(now + 300_000);
  });
});

describe("nextOccurrence — wall-clock schedules", () => {
  it("computes the next daily occurrence in UTC when no timezone is given but not required", () => {
    // days:"all" at 08:00, resolved via explicit UTC timezone
    const schedule: ParsedSchedule = { kind: "wall-clock", hour: 8, minute: 0, days: "all" };
    const now = Date.UTC(2026, 0, 15, 7, 0, 0); // 07:00 UTC
    const next = nextOccurrence(schedule, now, "UTC");
    expect(next).toBe(Date.UTC(2026, 0, 15, 8, 0, 0));
  });

  it("rolls to the next day if the time already passed today", () => {
    const schedule: ParsedSchedule = { kind: "wall-clock", hour: 8, minute: 0, days: "all" };
    const now = Date.UTC(2026, 0, 15, 9, 0, 0); // 09:00 UTC, past 08:00
    const next = nextOccurrence(schedule, now, "UTC");
    expect(next).toBe(Date.UTC(2026, 0, 16, 8, 0, 0));
  });

  it("is always strictly future, even at exactly the target instant", () => {
    const schedule: ParsedSchedule = { kind: "wall-clock", hour: 8, minute: 0, days: "all" };
    const now = Date.UTC(2026, 0, 15, 8, 0, 0); // exactly 08:00 UTC
    const next = nextOccurrence(schedule, now, "UTC");
    expect(next).toBeGreaterThan(now);
    expect(next).toBe(Date.UTC(2026, 0, 16, 8, 0, 0));
  });

  it("throws ValidationError when no timezone can be resolved", () => {
    const schedule: ParsedSchedule = { kind: "wall-clock", hour: 8, minute: 0, days: "all" };
    const now = Date.UTC(2026, 0, 15, 0, 0, 0);
    expect(() => nextOccurrence(schedule, now)).toThrow(ValidationError);
  });

  it("prefers the schedule's inline timezone over the passed-in timezone", () => {
    // 08:00 Europe/London (winter, GMT/UTC+0) == 08:00 UTC
    const schedule: ParsedSchedule = {
      kind: "wall-clock",
      hour: 8,
      minute: 0,
      days: "all",
      inlineTimezone: "Europe/London",
    };
    const now = Date.UTC(2026, 0, 15, 0, 0, 0);
    const next = nextOccurrence(schedule, now, "America/New_York");
    expect(next).toBe(Date.UTC(2026, 0, 15, 8, 0, 0));
  });

  it("resolves weekday sets, skipping non-matching days", () => {
    const schedule: ParsedSchedule = { kind: "wall-clock", hour: 9, minute: 0, days: "weekday" };
    // Saturday 2026-01-17
    const now = Date.UTC(2026, 0, 17, 0, 0, 0);
    const next = nextOccurrence(schedule, now, "UTC");
    // Monday 2026-01-19 09:00
    expect(next).toBe(Date.UTC(2026, 0, 19, 9, 0, 0));
    expect(new Date(next).getUTCDay()).toBe(1);
  });

  it("resolves an explicit weekday set", () => {
    const schedule: ParsedSchedule = { kind: "wall-clock", hour: 7, minute: 0, days: [2, 4] }; // Tue, Thu
    // Wednesday 2026-01-14
    const now = Date.UTC(2026, 0, 14, 0, 0, 0);
    const next = nextOccurrence(schedule, now, "UTC");
    // Thursday 2026-01-15 07:00
    expect(next).toBe(Date.UTC(2026, 0, 15, 7, 0, 0));
    expect(new Date(next).getUTCDay()).toBe(4);
  });

  it("DST spring-forward: a wall time that becomes ambiguous around the London transition still yields a strictly future, correctly-offset UTC instant", () => {
    // Europe/London DST starts 2026-03-29 at 01:00 UTC (clocks jump 01:00->02:00 local).
    // A daily 02:30 schedule crosses from GMT (UTC+0) to BST (UTC+1) on this day.
    const schedule: ParsedSchedule = {
      kind: "wall-clock",
      hour: 2,
      minute: 30,
      days: "all",
      inlineTimezone: "Europe/London",
    };
    // Starting just after 02:30 GMT on the 28th, the next occurrence is
    // 02:30 local on the 29th — but by then the clocks have sprung forward,
    // so 02:30 BST is UTC 01:30, not UTC 02:30.
    const dayBefore = Date.UTC(2026, 2, 28, 3, 0, 0);
    const beforeNext = nextOccurrence(schedule, dayBefore);
    expect(beforeNext).toBe(Date.UTC(2026, 2, 29, 1, 30, 0));

    // On transition day itself, 02:30 local == 01:30 UTC (BST, UTC+1).
    const transitionDay = Date.UTC(2026, 2, 29, 3, 0, 0); // after the local 02:30 instant already computed above has passed
    const afterNext = nextOccurrence(schedule, transitionDay);
    expect(afterNext).toBe(Date.UTC(2026, 2, 30, 1, 30, 0));
    expect(afterNext).toBeGreaterThan(transitionDay);
  });

  it("DST spring-forward gap: a wall time inside the skipped hour rolls forward to the next valid instant", () => {
    // 01:00-01:59 local does not exist in Europe/London on 2026-03-29.
    const schedule: ParsedSchedule = {
      kind: "wall-clock",
      hour: 1,
      minute: 30,
      days: "all",
      inlineTimezone: "Europe/London",
    };
    const now = Date.UTC(2026, 2, 28, 12, 0, 0); // the day before, well before the transition
    const next = nextOccurrence(schedule, now);
    expect(next).toBeGreaterThan(now);
    // The naive local 01:30 does not exist; it rolls forward by the 1-hour gap
    // and lands at the instant that reads back as 02:30 BST == 01:30 UTC.
    expect(next).toBe(Date.UTC(2026, 2, 29, 1, 30, 0));
    const localRead = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(next));
    expect(localRead).toBe("02:30");
  });
});

describe("describeSchedule", () => {
  it("describes a minute interval", () => {
    expect(describeSchedule({ kind: "interval", everyMs: 60_000 })).toBe("every minute");
    expect(describeSchedule({ kind: "interval", everyMs: 300_000 })).toBe("every 5 minutes");
  });

  it("describes an hour interval", () => {
    expect(describeSchedule({ kind: "interval", everyMs: 3_600_000 })).toBe("every hour");
    expect(describeSchedule({ kind: "interval", everyMs: 7_200_000 })).toBe("every 2 hours");
  });

  it("describes a daily wall-clock schedule", () => {
    expect(describeSchedule({ kind: "wall-clock", hour: 8, minute: 0, days: "all" })).toBe(
      "every day at 08:00",
    );
  });

  it("describes a daily wall-clock schedule with an inline timezone", () => {
    expect(
      describeSchedule({
        kind: "wall-clock",
        hour: 8,
        minute: 5,
        days: "all",
        inlineTimezone: "Europe/London",
      }),
    ).toBe("every day at 08:05 in Europe/London");
  });

  it("describes a weekday wall-clock schedule", () => {
    expect(describeSchedule({ kind: "wall-clock", hour: 9, minute: 30, days: "weekday" })).toBe(
      "every weekday at 09:30",
    );
  });

  it("describes a weekly wall-clock schedule with a sorted, stable day list", () => {
    expect(
      describeSchedule({ kind: "wall-clock", hour: 7, minute: 0, days: [5, 1, 3] }),
    ).toBe("every week on mon,wed,fri at 07:00");
  });

  it("is stable regardless of input day order (used for hashing)", () => {
    const a = describeSchedule({ kind: "wall-clock", hour: 7, minute: 0, days: [1, 3, 5] });
    const b = describeSchedule({ kind: "wall-clock", hour: 7, minute: 0, days: [5, 3, 1] });
    expect(a).toBe(b);
  });
});
