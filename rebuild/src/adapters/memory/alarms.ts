import type { AlarmTimer } from "../../ports/alarms.js";
import type { TestClock } from "./clock.js";

export interface MemoryAlarmTimer extends AlarmTimer {
  /** Registers the callback invoked when the alarm fires. Replaces any previous handler. */
  onAlarm(handler: () => void | Promise<void>): void;
}

/**
 * Wires a single-slot alarm to a TestClock: when the clock advances past the
 * armed time, the registered handler fires once. The slot is cleared before
 * the handler runs (matching Durable Object semantics), so a handler may
 * re-arm the alarm (even to a time already due) from within itself.
 */
export function createMemoryAlarmTimer(clock: TestClock): MemoryAlarmTimer {
  let alarmAt: number | null = null;
  let handler: (() => void | Promise<void>) | undefined;

  function checkFire(now: number): void {
    if (alarmAt === null || now < alarmAt) return;
    const fn = handler;
    alarmAt = null;
    if (!fn) return;
    const result = fn();
    if (result instanceof Promise) {
      result.then(() => checkFire(clock.now()));
    } else {
      checkFire(clock.now());
    }
  }

  clock.subscribe(checkFire);

  return {
    set(at: number): void {
      alarmAt = at;
      checkFire(clock.now());
    },
    get(): number | null {
      return alarmAt;
    },
    clear(): void {
      alarmAt = null;
    },
    onAlarm(fn: () => void | Promise<void>): void {
      handler = fn;
    },
  };
}
