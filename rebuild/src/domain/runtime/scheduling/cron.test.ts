import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../kernel/errors.js";
import { nextCronTime, parseCron } from "./cron.js";

describe("parseCron", () => {
  it("accepts a bare wildcard expression", () => {
    expect(() => parseCron("* * * * *")).not.toThrow();
  });

  it("accepts numbers, lists, ranges, and steps in every field", () => {
    expect(() => parseCron("0,30 9-17 1,15 1-6 1-5")).not.toThrow();
    expect(() => parseCron("*/15 */2 1-30/5 */3 */2")).not.toThrow();
  });

  it("rejects an expression with too few fields", () => {
    expect(() => parseCron("* * * *")).toThrow(ValidationError);
  });

  it("rejects an expression with too many fields", () => {
    expect(() => parseCron("* * * * * *")).toThrow(ValidationError);
  });

  it("rejects an out-of-range minute", () => {
    expect(() => parseCron("60 * * * *")).toThrow(ValidationError);
  });

  it("rejects an out-of-range hour", () => {
    expect(() => parseCron("* 24 * * *")).toThrow(ValidationError);
  });

  it("rejects an out-of-range day-of-month", () => {
    expect(() => parseCron("* * 32 * *")).toThrow(ValidationError);
    expect(() => parseCron("* * 0 * *")).toThrow(ValidationError);
  });

  it("rejects an out-of-range month", () => {
    expect(() => parseCron("* * * 13 *")).toThrow(ValidationError);
    expect(() => parseCron("* * * 0 *")).toThrow(ValidationError);
  });

  it("rejects an out-of-range day-of-week", () => {
    expect(() => parseCron("* * * * 8")).toThrow(ValidationError);
  });

  it("accepts day-of-week 7 as an alias for Sunday", () => {
    expect(() => parseCron("* * * * 7")).not.toThrow();
  });

  it("rejects a non-numeric field", () => {
    expect(() => parseCron("abc * * * *")).toThrow(ValidationError);
  });

  it("rejects a zero step", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow(ValidationError);
  });

  it("rejects an inverted range", () => {
    expect(() => parseCron("50-10 * * * *")).toThrow(ValidationError);
  });
});

describe("nextCronTime", () => {
  it("every minute: returns the start of the next minute", () => {
    const spec = parseCron("* * * * *");
    const after = Date.UTC(2026, 0, 15, 10, 30, 25); // 10:30:25
    const next = nextCronTime(spec, after);
    expect(next).toBe(Date.UTC(2026, 0, 15, 10, 31, 0));
  });

  it("every hour on the hour: rolls over to the next hour", () => {
    const spec = parseCron("0 * * * *");
    const after = Date.UTC(2026, 0, 15, 10, 30, 0);
    const next = nextCronTime(spec, after);
    expect(next).toBe(Date.UTC(2026, 0, 15, 11, 0, 0));
  });

  it("daily at midnight: rolls over to the next day, including month rollover", () => {
    const spec = parseCron("0 0 * * *");
    const after = Date.UTC(2026, 0, 31, 12, 0, 0); // Jan 31, noon
    const next = nextCronTime(spec, after);
    expect(next).toBe(Date.UTC(2026, 1, 1, 0, 0, 0)); // Feb 1, midnight
  });

  it("first of month at midnight: rolls over across a leap-year February", () => {
    const spec = parseCron("0 0 1 * *");
    const after = Date.UTC(2028, 1, 15, 0, 0, 0); // Feb 15 2028 (leap year)
    const next = nextCronTime(spec, after);
    expect(next).toBe(Date.UTC(2028, 2, 1, 0, 0, 0)); // Mar 1 2028
  });

  it("first of month at midnight: rolls over year boundary", () => {
    const spec = parseCron("0 0 1 * *");
    const after = Date.UTC(2026, 11, 15, 0, 0, 0); // Dec 15 2026
    const next = nextCronTime(spec, after);
    expect(next).toBe(Date.UTC(2027, 0, 1, 0, 0, 0)); // Jan 1 2027
  });

  it("*/15 step: finds the next quarter-hour boundary", () => {
    const spec = parseCron("*/15 * * * *");
    const after = Date.UTC(2026, 0, 15, 10, 7, 0);
    expect(nextCronTime(spec, after)).toBe(Date.UTC(2026, 0, 15, 10, 15, 0));
  });

  it("*/15 step: rolls into the next hour after the last slot", () => {
    const spec = parseCron("*/15 * * * *");
    const after = Date.UTC(2026, 0, 15, 10, 50, 0);
    expect(nextCronTime(spec, after)).toBe(Date.UTC(2026, 0, 15, 11, 0, 0));
  });

  it("business hours on weekdays: skips the weekend", () => {
    const spec = parseCron("0 9-17 * * 1-5");
    // Saturday 2026-01-17 noon
    const after = Date.UTC(2026, 0, 17, 12, 0, 0);
    expect(new Date(after).getUTCDay()).toBe(6); // sanity: Saturday
    const next = nextCronTime(spec, after);
    // Monday 2026-01-19 09:00
    expect(next).toBe(Date.UTC(2026, 0, 19, 9, 0, 0));
  });

  it("dom-or-dow: when both restricted, either matching field fires (dow match, dom no match)", () => {
    const spec = parseCron("0 0 1,15 * 3"); // 1st/15th OR every Wednesday
    // 2026-01-07 is a Wednesday, not the 1st or 15th
    const after = Date.UTC(2026, 0, 6, 12, 0, 0);
    const target = Date.UTC(2026, 0, 7, 0, 0, 0);
    expect(new Date(target).getUTCDay()).toBe(3); // sanity: Wednesday
    expect(nextCronTime(spec, after)).toBe(target);
  });

  it("dom-or-dow: when both restricted, dom match fires even off the weekday", () => {
    const spec = parseCron("0 0 1,15 * 3"); // 1st/15th OR every Wednesday
    // Start just after the Jan 14 Wednesday match; Jan 15 is a Thursday
    // (dow=4) but matches via dom=15.
    const after = Date.UTC(2026, 0, 14, 12, 0, 0);
    const next = nextCronTime(spec, after);
    expect(new Date(next).getUTCDay()).toBe(4); // Thursday, not Wednesday
    expect(next).toBe(Date.UTC(2026, 0, 15, 0, 0, 0));
  });

  it("dow-only restricted: every Monday at midnight", () => {
    const spec = parseCron("0 0 * * 1");
    const after = Date.UTC(2026, 0, 15, 0, 0, 0); // Thursday
    const next = nextCronTime(spec, after);
    expect(new Date(next).getUTCDay()).toBe(1);
    expect(next).toBeGreaterThan(after);
  });

  it("applies a fixed timezone offset", () => {
    const spec = parseCron("0 9 * * *"); // 09:00 local
    const after = Date.UTC(2026, 0, 15, 0, 0, 0);
    // UTC-5 local time: local 09:00 == UTC 14:00
    const next = nextCronTime(spec, after, -5 * 60);
    expect(next).toBe(Date.UTC(2026, 0, 15, 14, 0, 0));
  });

  it("throws when no matching time exists within the search horizon", () => {
    const spec = parseCron("0 0 31 2 *"); // Feb 31st never exists
    const after = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(() => nextCronTime(spec, after)).toThrow(ValidationError);
  });
});
