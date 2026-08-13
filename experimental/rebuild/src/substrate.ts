/**
 * Substrate seams the runtime is hosted on. Two tiny interfaces so the same
 * engine/runtime code runs in a Durable Object and under plain Node:
 *
 * - SqlDatabase: structurally compatible with DO `SqlStorage` semantics
 *   (synchronous exec returning rows, synchronous transactions). Node tests
 *   adapt `node:sqlite`; a DO adapts `ctx.storage.sql` + `transactionSync`.
 * - Clock: time + timer scheduling. Node uses timers; a DO maps schedule()
 *   onto its alarm.
 */

export type SqlRow = Record<string, string | number | null | Uint8Array>;

export interface SqlDatabase {
  /** Execute one statement with positional `?` bindings; returns all rows. */
  exec(query: string, ...bindings: ReadonlyArray<unknown>): SqlRow[];
  /** Run fn atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T;
}

export type CancelTimer = () => void;

export interface Clock {
  now(): number;
  /** Schedule fn once after ms. Returns a cancel function. */
  schedule(ms: number, fn: () => void): CancelTimer;
}

export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    schedule(ms, fn) {
      const t = setTimeout(fn, ms);
      // Never keep the host process alive just for a pending pump timer.
      (t as unknown as { unref?: () => void }).unref?.();
      return () => clearTimeout(t);
    }
  };
}
