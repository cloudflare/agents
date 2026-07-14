import type { Scheduler } from "./scheduler.js";

/** Internal namespacing keeps the heartbeat out of user-facing listSchedules(). */
const KEEP_ALIVE_CALLBACK = "$internal:keep-alive";
const KEEP_ALIVE_ID = "$internal:keep-alive";
const DEFAULT_INTERVAL_MS = 30_000;

export interface KeepAlive {
  /** Takes a ref, arming the heartbeat if this is the first. Returns an idempotent disposer. */
  acquire(): () => void;
  /** Holds a ref for the duration of `fn`, releasing on success or throw. */
  while<T>(fn: () => Promise<T>): Promise<T>;
  /** Current number of outstanding refs. */
  activeRefs(): number;
}

/**
 * Ref-counted heartbeat that keeps the scheduler's alarm armed (preventing
 * Durable Object idle-eviction) for as long as at least one ref is held.
 */
export function createKeepAlive(scheduler: Scheduler, options?: { intervalMs?: number }): KeepAlive {
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
  let refs = 0;

  function ensureHeartbeat(): void {
    scheduler.create(
      { kind: "interval", everySeconds: intervalMs / 1000 },
      KEEP_ALIVE_CALLBACK,
      undefined,
      { id: KEEP_ALIVE_ID },
    );
  }

  function teardownHeartbeat(): void {
    scheduler.cancel(KEEP_ALIVE_ID);
  }

  function acquire(): () => void {
    refs += 1;
    if (refs === 1) ensureHeartbeat();

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      refs -= 1;
      if (refs === 0) teardownHeartbeat();
    };
  }

  async function whileHeld<T>(fn: () => Promise<T>): Promise<T> {
    const release = acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return {
    acquire,
    while: whileHeld,
    activeRefs(): number {
      return refs;
    },
  };
}
