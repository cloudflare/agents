import { describe, expect, it, vi } from "vitest";
import { createTestClock } from "./clock.js";
import { createMemoryAlarmTimer } from "./alarms.js";

describe("createMemoryAlarmTimer", () => {
  it("set()/get() round-trip the alarm time", () => {
    const clock = createTestClock(0);
    const alarm = createMemoryAlarmTimer(clock);
    alarm.set(1000);
    expect(alarm.get()).toBe(1000);
  });

  it("get() is null when no alarm is set", () => {
    const clock = createTestClock(0);
    const alarm = createMemoryAlarmTimer(clock);
    expect(alarm.get()).toBeNull();
  });

  it("set() replaces any previous alarm", () => {
    const clock = createTestClock(0);
    const alarm = createMemoryAlarmTimer(clock);
    alarm.set(1000);
    alarm.set(2000);
    expect(alarm.get()).toBe(2000);
  });

  it("clear() removes the alarm", () => {
    const clock = createTestClock(0);
    const alarm = createMemoryAlarmTimer(clock);
    alarm.set(1000);
    alarm.clear();
    expect(alarm.get()).toBeNull();
  });

  it("fires onAlarm once when the clock advances past the alarm time", () => {
    const clock = createTestClock(0);
    const alarm = createMemoryAlarmTimer(clock);
    const handler = vi.fn();
    alarm.onAlarm(handler);
    alarm.set(1000);
    clock.advance(500);
    expect(handler).not.toHaveBeenCalled();
    clock.advance(600);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("clears the slot before invoking the callback", () => {
    const clock = createTestClock(0);
    const alarm = createMemoryAlarmTimer(clock);
    let alarmDuringCallback: number | null = -1;
    alarm.onAlarm(() => {
      alarmDuringCallback = alarm.get();
    });
    alarm.set(1000);
    clock.advance(1000);
    expect(alarmDuringCallback).toBeNull();
  });

  it("does not fire again on subsequent advances once fired", () => {
    const clock = createTestClock(0);
    const alarm = createMemoryAlarmTimer(clock);
    const handler = vi.fn();
    alarm.onAlarm(handler);
    alarm.set(1000);
    clock.advance(1000);
    clock.advance(1000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("supports an async onAlarm handler that re-arms the alarm", async () => {
    const clock = createTestClock(0);
    const alarm = createMemoryAlarmTimer(clock);
    let fireCount = 0;
    alarm.onAlarm(async () => {
      fireCount++;
      await Promise.resolve();
      if (fireCount < 2) {
        alarm.set(clock.now()); // re-arm immediately (still due)
      }
    });
    alarm.set(1000);
    clock.advance(1000);
    // allow microtasks (the async handler's re-arm + re-check) to flush
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fireCount).toBe(2);
  });

  it("clearing a fired alarm before it re-arms leaves get() null", () => {
    const clock = createTestClock(0);
    const alarm = createMemoryAlarmTimer(clock);
    alarm.onAlarm(() => {
      // no re-arm
    });
    alarm.set(1000);
    clock.advance(1000);
    expect(alarm.get()).toBeNull();
  });
});
