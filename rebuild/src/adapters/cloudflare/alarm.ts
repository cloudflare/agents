import type { AlarmTimer } from "../../ports/alarms.js";

export interface DurableAlarmTimer extends AlarmTimer {
  /**
   * Waits for the Durable Object alarm slot to catch up with the synchronous
   * mirror. Hosts should await this before ending an externally observable
   * turn that called set() or clear().
   */
  flush(): Promise<void>;
  onPlatformAlarm(): number | null;
}

/**
 * Mirrors the async Durable Object alarm slot behind the synchronous alarm
 * port. The host seeds `initial` from `ctx.storage.getAlarm()` during
 * activation before constructing domain code.
 */
export function createDurableAlarmTimer(options: {
  storage: DurableObjectStorage;
  initial: number | null;
}): DurableAlarmTimer {
  let alarmAt = options.initial;
  let pendingWrite: Promise<void> = Promise.resolve();

  function enqueueWrite(write: () => Promise<void>): void {
    pendingWrite = pendingWrite.then(write, write);
    void pendingWrite.catch(() => undefined);
  }

  return {
    set(at: number): void {
      alarmAt = at;
      enqueueWrite(() => options.storage.setAlarm(at));
    },
    get(): number | null {
      return alarmAt;
    },
    clear(): void {
      alarmAt = null;
      enqueueWrite(() => options.storage.deleteAlarm());
    },
    flush(): Promise<void> {
      return pendingWrite;
    },
    onPlatformAlarm(): number | null {
      const firedAt = alarmAt;
      alarmAt = null;
      return firedAt;
    },
  };
}
