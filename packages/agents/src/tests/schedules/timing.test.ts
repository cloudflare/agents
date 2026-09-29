import { describe, expect, it } from "vitest";
import {
  MAX_INTERVAL_SECONDS,
  isRecurring,
  nextCronTimeMs,
  parseInterval,
  parseWhen
} from "../../schedules/schedule-timing";

const NOW_MS = Date.UTC(2026, 0, 1, 0, 30, 0);

describe("parseWhen", () => {
  it("parses a Date into a one-shot scheduled timing", () => {
    const runAt = new Date(Date.UTC(2026, 0, 2, 12, 0, 0, 500));
    expect(parseWhen(runAt, NOW_MS, "remind")).toEqual({
      type: "scheduled",
      time: Math.floor(runAt.getTime() / 1000)
    });
  });

  it("parses a number of seconds into a delayed timing", () => {
    expect(parseWhen(90, NOW_MS, "remind")).toEqual({
      type: "delayed",
      time: Math.floor((NOW_MS + 90_000) / 1000),
      delayInSeconds: 90
    });
  });

  it("parses a cron expression with its next execution time", () => {
    const timing = parseWhen("0 * * * *", NOW_MS, "remind");
    expect(timing).toEqual({
      type: "cron",
      cron: "0 * * * *",
      time: Math.floor(Date.UTC(2026, 0, 1, 1, 0, 0) / 1000)
    });
  });

  it("rejects a when value that is not a Date, number, or string", () => {
    expect(() =>
      parseWhen(undefined as unknown as number, NOW_MS, "remind")
    ).toThrow(/Invalid schedule type/);
  });
});

describe("parseInterval", () => {
  it("parses an interval with the first run one interval from now", () => {
    expect(parseInterval(30, NOW_MS)).toEqual({
      type: "interval",
      time: Math.floor((NOW_MS + 30_000) / 1000),
      intervalSeconds: 30
    });
  });

  it("rejects non-positive intervals", () => {
    expect(() => parseInterval(0, NOW_MS)).toThrow(
      "intervalSeconds must be a positive number"
    );
    expect(() => parseInterval(-5, NOW_MS)).toThrow(
      "intervalSeconds must be a positive number"
    );
  });

  it("rejects intervals longer than 30 days", () => {
    expect(() => parseInterval(MAX_INTERVAL_SECONDS + 1, NOW_MS)).toThrow(
      /cannot exceed/
    );
    expect(parseInterval(MAX_INTERVAL_SECONDS, NOW_MS).type).toBe("interval");
  });
});

describe("isRecurring", () => {
  it("marks cron and interval timings as recurring", () => {
    expect(isRecurring(parseWhen("* * * * *", NOW_MS, "cb"))).toBe(true);
    expect(isRecurring(parseInterval(30, NOW_MS))).toBe(true);
    expect(isRecurring(parseWhen(60, NOW_MS, "cb"))).toBe(false);
    expect(isRecurring(parseWhen(new Date(NOW_MS), NOW_MS, "cb"))).toBe(false);
  });
});

describe("nextCronTimeMs", () => {
  it("returns the next execution strictly after now", () => {
    const next = nextCronTimeMs("0 0 * * *", NOW_MS);
    expect(next).toBe(Date.UTC(2026, 0, 2, 0, 0, 0));
    expect(next).toBeGreaterThan(NOW_MS);
  });
});
