import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryAlarmTimer, type MemoryAlarmTimer } from "../../../adapters/memory/alarms.js";
import { createTestClock, type TestClock } from "../../../adapters/memory/clock.js";
import { createMemoryKeyValueStore } from "../../../adapters/memory/store.js";
import { ValidationError } from "../../../kernel/errors.js";
import { createEventBus, type EventBus, type ObservabilityEvent } from "../../../kernel/events.js";
import type { IdSource } from "../../../kernel/ids.js";
import { createScheduler, type Scheduler } from "./scheduler.js";

function counterIds(): IdSource {
  let n = 0;
  return {
    newId(prefix: string) {
      n += 1;
      return `${prefix}_${n}`;
    },
  };
}

interface Harness {
  clock: TestClock;
  alarm: MemoryAlarmTimer;
  bus: EventBus;
  events: ObservabilityEvent[];
  dispatch: ReturnType<typeof vi.fn>;
  scheduler: Scheduler;
}

function harness(overrides?: { duplicateWarningThreshold?: number }): Harness {
  const clock = createTestClock(0);
  const alarm = createMemoryAlarmTimer(clock);
  const events: ObservabilityEvent[] = [];
  const bus = createEventBus({ agent: "test", name: "agent-1" }, () => clock.now());
  bus.subscribe("*", (e) => events.push(e));
  const dispatch = vi.fn(async () => {});
  const scheduler = createScheduler({
    store: createMemoryKeyValueStore(),
    alarm,
    clock,
    ids: counterIds(),
    bus,
    dispatch,
    ...overrides,
  });
  alarm.onAlarm(() => scheduler.onAlarm());
  return { clock, alarm, bus, events, dispatch, scheduler };
}

describe("createScheduler", () => {
  describe("create / get / cancel", () => {
    it("creates a once schedule with a generated id and computed nextRunAt", () => {
      const { scheduler } = harness();
      const s = scheduler.create({ kind: "once", at: 1000 }, "cb.once");
      expect(s.id).toBe("sched_1");
      expect(s.callback).toBe("cb.once");
      expect(s.spec).toEqual({ kind: "once", at: 1000 });
      expect(s.nextRunAt).toBe(1000);
      expect(scheduler.get(s.id)).toEqual(s);
    });

    it("creates an interval schedule with nextRunAt = now + everySeconds", () => {
      const { scheduler, clock } = harness();
      clock.set(5000);
      const s = scheduler.create({ kind: "interval", everySeconds: 30 }, "cb.interval");
      expect(s.nextRunAt).toBe(5000 + 30_000);
    });

    it("creates a cron schedule with nextRunAt from nextCronTime", () => {
      const { scheduler, clock } = harness();
      clock.set(0);
      const s = scheduler.create({ kind: "cron", expression: "0 0 * * *" }, "cb.cron");
      expect(s.nextRunAt).toBe(24 * 60 * 60 * 1000);
    });

    it("rejects an invalid cron expression", () => {
      const { scheduler } = harness();
      expect(() => scheduler.create({ kind: "cron", expression: "not a cron" }, "cb")).toThrow(
        ValidationError,
      );
    });

    it("rejects a non-positive interval", () => {
      const { scheduler } = harness();
      expect(() => scheduler.create({ kind: "interval", everySeconds: 0 }, "cb")).toThrow(ValidationError);
    });

    it("upserts when an explicit id is supplied", () => {
      const { scheduler } = harness();
      const s1 = scheduler.create({ kind: "once", at: 1000 }, "cb", undefined, { id: "fixed" });
      const s2 = scheduler.create({ kind: "once", at: 2000 }, "cb", undefined, { id: "fixed" });
      expect(s1.id).toBe("fixed");
      expect(s2.id).toBe("fixed");
      expect(scheduler.get("fixed")?.nextRunAt).toBe(2000);
      expect(scheduler.list()).toHaveLength(1);
    });

    it("returns undefined from get() for an unknown id", () => {
      const { scheduler } = harness();
      expect(scheduler.get("nope")).toBeUndefined();
    });

    it("cancel removes the schedule and returns true; false if absent", () => {
      const { scheduler } = harness();
      const s = scheduler.create({ kind: "once", at: 1000 }, "cb");
      expect(scheduler.cancel(s.id)).toBe(true);
      expect(scheduler.get(s.id)).toBeUndefined();
      expect(scheduler.cancel(s.id)).toBe(false);
    });
  });

  describe("alarm slot: earliest wins, re-arm on mutation", () => {
    it("arms the physical alarm to the earliest nextRunAt across schedules", () => {
      const { scheduler, alarm } = harness();
      scheduler.create({ kind: "once", at: 5000 }, "cb");
      scheduler.create({ kind: "once", at: 2000 }, "cb2");
      scheduler.create({ kind: "once", at: 9000 }, "cb3");
      expect(alarm.get()).toBe(2000);
      expect(scheduler.nextWake()).toBe(2000);
    });

    it("re-arms to the next earliest after the earliest is cancelled", () => {
      const { scheduler, alarm } = harness();
      const a = scheduler.create({ kind: "once", at: 2000 }, "cb");
      scheduler.create({ kind: "once", at: 5000 }, "cb2");
      scheduler.cancel(a.id);
      expect(alarm.get()).toBe(5000);
    });

    it("clears the physical alarm when no schedules remain", () => {
      const { scheduler, alarm } = harness();
      const a = scheduler.create({ kind: "once", at: 2000 }, "cb");
      scheduler.cancel(a.id);
      expect(alarm.get()).toBeNull();
      expect(scheduler.nextWake()).toBeNull();
    });
  });

  describe("dispatch on alarm fire", () => {
    it("dispatches a due once schedule and removes it afterward", async () => {
      const { scheduler, clock, dispatch } = harness();
      const s = scheduler.create({ kind: "once", at: 1000 }, "cb.once", { x: 1 });
      clock.set(1000);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      expect(dispatch).toHaveBeenCalledWith("cb.once", { x: 1 }, expect.objectContaining({ id: s.id }));
      expect(scheduler.get(s.id)).toBeUndefined();
    });

    it("re-arms an interval schedule to now + everySeconds after each fire", async () => {
      const { scheduler, clock, dispatch } = harness();
      const s = scheduler.create({ kind: "interval", everySeconds: 10 }, "cb.every");
      expect(s.nextRunAt).toBe(10_000);
      clock.set(10_000);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      expect(scheduler.get(s.id)?.nextRunAt).toBe(20_000);
    });

    it("re-arms a cron schedule using nextCronTime from the fire time (no backfill)", async () => {
      const { scheduler, clock, dispatch } = harness();
      const s = scheduler.create({ kind: "cron", expression: "0 * * * *" }, "cb.cron");
      expect(s.nextRunAt).toBe(60 * 60 * 1000);

      // Alarm fires very late (simulating a missed wakeup): jump far past several
      // occurrences. Only one dispatch happens, and the next run is computed from
      // "now", not backfilled for each missed slot.
      const lateTime = 5 * 60 * 60 * 1000 + 30_000;
      clock.set(lateTime);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      const next = scheduler.get(s.id)?.nextRunAt;
      expect(next).toBeGreaterThan(lateTime);
      // Next hour boundary strictly after lateTime.
      expect(next).toBe(6 * 60 * 60 * 1000);
    });

    it("dispatches multiple due schedules on a single alarm fire, earliest first", async () => {
      const { scheduler, clock, dispatch } = harness();
      const calls: string[] = [];
      dispatch.mockImplementation(async (callback: string) => {
        calls.push(callback);
      });
      scheduler.create({ kind: "once", at: 1000 }, "second");
      scheduler.create({ kind: "once", at: 500 }, "first");
      clock.set(1000);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
      expect(calls).toEqual(["first", "second"]);
    });
  });

  describe("crash-safety ordering", () => {
    it("persists a recurring schedule's next occurrence before dispatch, so it survives a dispatcher throw", async () => {
      const { scheduler, clock, dispatch } = harness();
      dispatch.mockRejectedValue(new Error("boom"));
      const s = scheduler.create({ kind: "interval", everySeconds: 10 }, "cb.every");
      clock.set(10_000);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      const after = scheduler.get(s.id);
      expect(after).toBeDefined();
      expect(after!.nextRunAt).toBe(20_000);
    });

    it("still deletes a once schedule that has no retry policy after a dispatcher throw", async () => {
      const { scheduler, clock, dispatch, events } = harness();
      dispatch.mockRejectedValue(new Error("boom"));
      const s = scheduler.create({ kind: "once", at: 1000 }, "cb.once");
      clock.set(1000);
      await vi.waitFor(() =>
        expect(events.some((e) => e.type === "schedule:error")).toBe(true),
      );
      expect(scheduler.get(s.id)).toBeUndefined();
    });
  });

  describe("retry policy", () => {
    it("retries a failing once schedule up to maxAttempts, then emits schedule:error and deletes it", async () => {
      const { scheduler, clock, dispatch, events } = harness();
      dispatch.mockRejectedValue(new Error("boom"));
      const s = scheduler.create({ kind: "once", at: 1000 }, "cb.once", undefined, {
        retry: { maxAttempts: 3, baseDelayMs: 100 },
      });

      clock.set(1000);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      let retryEvents = events.filter((e) => e.type === "schedule:retry");
      expect(retryEvents).toHaveLength(1);
      expect(retryEvents[0]!.payload).toMatchObject({ id: s.id, attempt: 1, maxAttempts: 3 });
      const afterFirst = scheduler.get(s.id);
      expect(afterFirst).toBeDefined();
      expect(afterFirst!.nextRunAt).toBeGreaterThan(1000);

      clock.set(afterFirst!.nextRunAt);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
      retryEvents = events.filter((e) => e.type === "schedule:retry");
      expect(retryEvents).toHaveLength(2);
      const afterSecond = scheduler.get(s.id);
      expect(afterSecond).toBeDefined();

      clock.set(afterSecond!.nextRunAt);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(3));
      const errorEvents = events.filter((e) => e.type === "schedule:error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]!.payload).toMatchObject({ id: s.id, attempts: 3 });
      expect(scheduler.get(s.id)).toBeUndefined();
    });

    it("stops retrying once dispatch succeeds and resumes normal recurrence", async () => {
      const { scheduler, clock, dispatch, events } = harness();
      let attempt = 0;
      dispatch.mockImplementation(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("boom");
      });
      const s = scheduler.create({ kind: "interval", everySeconds: 10 }, "cb.every", undefined, {
        retry: { maxAttempts: 5, baseDelayMs: 50 },
      });

      clock.set(10_000);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      const afterFail = scheduler.get(s.id)!;
      expect(afterFail.nextRunAt).toBeLessThan(20_000); // sooner retry, not the regular cadence

      clock.set(afterFail.nextRunAt);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
      expect(events.filter((e) => e.type === "schedule:error")).toHaveLength(0);
      const afterSuccess = scheduler.get(s.id)!;
      // Resumed cadence: next occurrence computed fresh from the success time.
      expect(afterSuccess.nextRunAt).toBe(afterFail.nextRunAt + 10_000);
    });

    it("emits schedule:error immediately for a failing schedule with no retry policy", async () => {
      const { scheduler, clock, dispatch, events } = harness();
      dispatch.mockRejectedValue(new Error("boom"));
      scheduler.create({ kind: "once", at: 1000 }, "cb.once");
      clock.set(1000);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      expect(events.filter((e) => e.type === "schedule:retry")).toHaveLength(0);
      expect(events.filter((e) => e.type === "schedule:error")).toHaveLength(1);
    });
  });

  describe("duplicate-callback detection", () => {
    it("emits schedule:duplicate_warning once the same callback crosses the threshold", () => {
      const { scheduler, events } = harness();
      scheduler.create({ kind: "once", at: 1000 }, "cb.dup");
      scheduler.create({ kind: "once", at: 2000 }, "cb.dup");
      expect(events.filter((e) => e.type === "schedule:duplicate_warning")).toHaveLength(0);
      scheduler.create({ kind: "once", at: 3000 }, "cb.dup");
      const warnings = events.filter((e) => e.type === "schedule:duplicate_warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.payload).toMatchObject({ callback: "cb.dup", kind: "once", count: 3 });
    });

    it("does not warn for distinct callbacks", () => {
      const { scheduler, events } = harness();
      scheduler.create({ kind: "once", at: 1000 }, "cb.a");
      scheduler.create({ kind: "once", at: 2000 }, "cb.b");
      scheduler.create({ kind: "once", at: 3000 }, "cb.c");
      expect(events.filter((e) => e.type === "schedule:duplicate_warning")).toHaveLength(0);
    });

    it("respects a custom duplicateWarningThreshold", () => {
      const { scheduler, events } = harness({ duplicateWarningThreshold: 2 });
      scheduler.create({ kind: "once", at: 1000 }, "cb.dup");
      expect(events.filter((e) => e.type === "schedule:duplicate_warning")).toHaveLength(0);
      scheduler.create({ kind: "once", at: 2000 }, "cb.dup");
      expect(events.filter((e) => e.type === "schedule:duplicate_warning")).toHaveLength(1);
    });

    it("upserting the same id does not count as a duplicate", () => {
      const { scheduler, events } = harness({ duplicateWarningThreshold: 2 });
      scheduler.create({ kind: "once", at: 1000 }, "cb.dup", undefined, { id: "fixed" });
      scheduler.create({ kind: "once", at: 2000 }, "cb.dup", undefined, { id: "fixed" });
      expect(events.filter((e) => e.type === "schedule:duplicate_warning")).toHaveLength(0);
    });
  });

  describe("$internal: namespacing", () => {
    it("excludes $internal: callbacks from list() by default", () => {
      const { scheduler } = harness();
      scheduler.create({ kind: "once", at: 1000 }, "user.cb");
      scheduler.create({ kind: "once", at: 2000 }, "$internal:heartbeat");
      expect(scheduler.list().map((s) => s.callback)).toEqual(["user.cb"]);
    });

    it("includes $internal: callbacks when includeInternal is true", () => {
      const { scheduler } = harness();
      scheduler.create({ kind: "once", at: 1000 }, "user.cb");
      scheduler.create({ kind: "once", at: 2000 }, "$internal:heartbeat");
      const all = scheduler.list({ includeInternal: true }).map((s) => s.callback);
      expect(all).toContain("user.cb");
      expect(all).toContain("$internal:heartbeat");
    });

    it("get() finds internal schedules directly by id regardless of namespacing", () => {
      const { scheduler } = harness();
      const s = scheduler.create({ kind: "once", at: 2000 }, "$internal:heartbeat");
      expect(scheduler.get(s.id)?.callback).toBe("$internal:heartbeat");
    });
  });

  describe("list criteria", () => {
    it("filters by callback", () => {
      const { scheduler } = harness();
      scheduler.create({ kind: "once", at: 1000 }, "cb.a");
      scheduler.create({ kind: "once", at: 2000 }, "cb.b");
      expect(scheduler.list({ callback: "cb.a" })).toHaveLength(1);
    });

    it("filters by kind", () => {
      const { scheduler } = harness();
      scheduler.create({ kind: "once", at: 1000 }, "cb.a");
      scheduler.create({ kind: "interval", everySeconds: 10 }, "cb.b");
      expect(scheduler.list({ kind: "interval" })).toHaveLength(1);
      expect(scheduler.list({ kind: "interval" })[0]!.callback).toBe("cb.b");
    });

    it("filters by dueBefore (time window)", () => {
      const { scheduler } = harness();
      scheduler.create({ kind: "once", at: 1000 }, "cb.a");
      scheduler.create({ kind: "once", at: 9000 }, "cb.b");
      const due = scheduler.list({ dueBefore: 5000 });
      expect(due).toHaveLength(1);
      expect(due[0]!.callback).toBe("cb.a");
    });
  });

  describe("events", () => {
    it("emits schedule:create on create and schedule:cancel on cancel", () => {
      const { scheduler, events } = harness();
      const s = scheduler.create({ kind: "once", at: 1000 }, "cb.a");
      expect(events.some((e) => e.type === "schedule:create" && e.payload.id === s.id)).toBe(true);
      scheduler.cancel(s.id);
      expect(events.some((e) => e.type === "schedule:cancel" && e.payload.id === s.id)).toBe(true);
    });

    it("emits schedule:execute for each dispatched schedule", async () => {
      const { scheduler, clock, dispatch, events } = harness();
      scheduler.create({ kind: "once", at: 1000 }, "cb.a");
      clock.set(1000);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      expect(events.some((e) => e.type === "schedule:execute")).toBe(true);
    });
  });
});

describe("createScheduler edge cases", () => {
  it("nextWake reflects the current earliest schedule even before any alarm fires", () => {
    const { scheduler } = harness();
    expect(scheduler.nextWake()).toBeNull();
    scheduler.create({ kind: "once", at: 42 }, "cb");
    expect(scheduler.nextWake()).toBe(42);
  });
});
