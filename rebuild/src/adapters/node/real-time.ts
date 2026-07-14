import type { AlarmTimer } from "../../ports/alarms.js";
import type { Clock } from "../../ports/clock.js";

export const realClock: Clock = { now: () => Date.now() };

/**
 * Wall-clock AlarmTimer over setTimeout — the demo's stand-in for the Durable
 * Object alarm slot. Mirrors MemoryAlarmTimer semantics: single slot, slot
 * clears before the handler runs, handler may re-arm. Timers are unref'd so a
 * pending alarm never keeps the process alive on its own.
 */
export interface RealAlarmTimer extends AlarmTimer {
  onAlarm(handler: () => void | Promise<void>): void;
  dispose(): void;
}

export function createRealAlarmTimer(clock: Clock = realClock): RealAlarmTimer {
  let at: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let handler: (() => void | Promise<void>) | undefined;

  function disarm(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function arm(): void {
    disarm();
    if (at === null) return;
    const delay = Math.max(0, at - clock.now());
    timer = setTimeout(() => {
      timer = undefined;
      at = null; // slot clears before the handler runs (DO semantics)
      void handler?.();
    }, delay);
    timer.unref?.();
  }

  return {
    set(when) {
      at = when;
      arm();
    },
    get: () => at,
    clear() {
      at = null;
      disarm();
    },
    onAlarm(fn) {
      handler = fn;
    },
    dispose: disarm,
  };
}
