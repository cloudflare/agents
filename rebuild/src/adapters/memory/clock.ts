import type { Clock } from "../../ports/clock.js";

export interface TestClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
  /** Internal hook other in-memory adapters (e.g. MemoryAlarmTimer) use to react to time changes. */
  subscribe(fn: (now: number) => void): () => void;
}

export function createTestClock(startAt = 0): TestClock {
  let current = startAt;
  const listeners = new Set<(now: number) => void>();

  function notify(): void {
    for (const fn of listeners) fn(current);
  }

  return {
    now(): number {
      return current;
    },
    advance(ms: number): void {
      current += ms;
      notify();
    },
    set(ms: number): void {
      current = ms;
      notify();
    },
    subscribe(fn: (now: number) => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
