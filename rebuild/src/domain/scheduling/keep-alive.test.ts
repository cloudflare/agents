import { describe, expect, it } from "vitest";
import { createMemoryAlarmTimer } from "../../adapters/memory/alarms.js";
import { createTestClock } from "../../adapters/memory/clock.js";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { createEventBus } from "../../kernel/events.js";
import type { IdSource } from "../../kernel/ids.js";
import { createScheduler, type Scheduler } from "./scheduler.js";
import { createKeepAlive } from "./keep-alive.js";

function counterIds(): IdSource {
  let n = 0;
  return {
    newId(prefix: string) {
      n += 1;
      return `${prefix}_${n}`;
    },
  };
}

function schedulerHarness(): { scheduler: Scheduler; clock: ReturnType<typeof createTestClock> } {
  const clock = createTestClock(0);
  const alarm = createMemoryAlarmTimer(clock);
  const bus = createEventBus({ agent: "test", name: "agent-1" }, () => clock.now());
  const scheduler = createScheduler({
    store: createMemoryKeyValueStore(),
    alarm,
    clock,
    ids: counterIds(),
    bus,
    dispatch: async () => {},
  });
  alarm.onAlarm(() => scheduler.onAlarm());
  return { scheduler, clock };
}

describe("createKeepAlive", () => {
  it("starts with zero active refs and no heartbeat schedule", () => {
    const { scheduler } = schedulerHarness();
    const keepAlive = createKeepAlive(scheduler);
    expect(keepAlive.activeRefs()).toBe(0);
    expect(scheduler.list({ includeInternal: true })).toHaveLength(0);
  });

  it("acquire() increments refs and installs an internal heartbeat schedule", () => {
    const { scheduler } = schedulerHarness();
    const keepAlive = createKeepAlive(scheduler);
    keepAlive.acquire();
    expect(keepAlive.activeRefs()).toBe(1);

    const all = scheduler.list({ includeInternal: true });
    expect(all).toHaveLength(1);
    expect(all[0]!.callback.startsWith("$internal:")).toBe(true);
    expect(all[0]!.spec.kind).toBe("interval");
  });

  it("the heartbeat schedule is invisible to a default (non-internal) list()", () => {
    const { scheduler } = schedulerHarness();
    const keepAlive = createKeepAlive(scheduler);
    keepAlive.acquire();
    expect(scheduler.list()).toHaveLength(0);
  });

  it("defaults the heartbeat interval to 30s", () => {
    const { scheduler, clock } = schedulerHarness();
    const keepAlive = createKeepAlive(scheduler);
    clock.set(1000);
    keepAlive.acquire();
    const [schedule] = scheduler.list({ includeInternal: true });
    expect(schedule!.nextRunAt).toBe(1000 + 30_000);
  });

  it("accepts a custom keepAliveIntervalMs", () => {
    const { scheduler, clock } = schedulerHarness();
    const keepAlive = createKeepAlive(scheduler, { intervalMs: 5_000 });
    clock.set(1000);
    keepAlive.acquire();
    const [schedule] = scheduler.list({ includeInternal: true });
    expect(schedule!.nextRunAt).toBe(1000 + 5_000);
  });

  it("does not recreate the heartbeat schedule for additional refs", () => {
    const { scheduler } = schedulerHarness();
    const keepAlive = createKeepAlive(scheduler);
    keepAlive.acquire();
    const firstId = scheduler.list({ includeInternal: true })[0]!.id;
    keepAlive.acquire();
    expect(keepAlive.activeRefs()).toBe(2);
    const all = scheduler.list({ includeInternal: true });
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(firstId);
  });

  it("the disposer decrements refs and cancels the heartbeat once refs reach zero", () => {
    const { scheduler } = schedulerHarness();
    const keepAlive = createKeepAlive(scheduler);
    const release1 = keepAlive.acquire();
    const release2 = keepAlive.acquire();
    expect(keepAlive.activeRefs()).toBe(2);

    release1();
    expect(keepAlive.activeRefs()).toBe(1);
    expect(scheduler.list({ includeInternal: true })).toHaveLength(1);

    release2();
    expect(keepAlive.activeRefs()).toBe(0);
    expect(scheduler.list({ includeInternal: true })).toHaveLength(0);
  });

  it("disposers are idempotent: calling one twice only releases once", () => {
    const { scheduler } = schedulerHarness();
    const keepAlive = createKeepAlive(scheduler);
    const release = keepAlive.acquire();
    keepAlive.acquire();
    expect(keepAlive.activeRefs()).toBe(2);

    release();
    release();
    release();
    expect(keepAlive.activeRefs()).toBe(1);
    expect(scheduler.list({ includeInternal: true })).toHaveLength(1);
  });

  it("re-acquiring after dropping to zero re-installs the heartbeat", () => {
    const { scheduler } = schedulerHarness();
    const keepAlive = createKeepAlive(scheduler);
    const release = keepAlive.acquire();
    release();
    expect(scheduler.list({ includeInternal: true })).toHaveLength(0);

    keepAlive.acquire();
    expect(keepAlive.activeRefs()).toBe(1);
    expect(scheduler.list({ includeInternal: true })).toHaveLength(1);
  });

  describe("while()", () => {
    it("holds a ref for the duration of the async fn and releases after it resolves", async () => {
      const { scheduler } = schedulerHarness();
      const keepAlive = createKeepAlive(scheduler);
      let refsDuring = -1;

      const result = await keepAlive.while(async () => {
        refsDuring = keepAlive.activeRefs();
        return "done";
      });

      expect(result).toBe("done");
      expect(refsDuring).toBe(1);
      expect(keepAlive.activeRefs()).toBe(0);
      expect(scheduler.list({ includeInternal: true })).toHaveLength(0);
    });

    it("releases the ref even when the fn throws", async () => {
      const { scheduler } = schedulerHarness();
      const keepAlive = createKeepAlive(scheduler);

      await expect(
        keepAlive.while(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(keepAlive.activeRefs()).toBe(0);
      expect(scheduler.list({ includeInternal: true })).toHaveLength(0);
    });

    it("nested while() calls keep the heartbeat alive until the outermost releases", async () => {
      const { scheduler } = schedulerHarness();
      const keepAlive = createKeepAlive(scheduler);

      await keepAlive.while(async () => {
        await keepAlive.while(async () => {
          expect(keepAlive.activeRefs()).toBe(2);
        });
        expect(keepAlive.activeRefs()).toBe(1);
        expect(scheduler.list({ includeInternal: true })).toHaveLength(1);
      });

      expect(keepAlive.activeRefs()).toBe(0);
      expect(scheduler.list({ includeInternal: true })).toHaveLength(0);
    });
  });
});
