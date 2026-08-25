import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  bindLifecycleCapability,
  type LifecycleObject,
  type LifecycleServices
} from "../../lifecycle";
import { Scheduler, type Schedule } from "../../schedules";

/**
 * Capability-level Scheduler tests: real Durable Object storage, fake
 * Lifecycle services. This exercises Scheduler's own behavior — schema,
 * CRUD, idempotency, alarm contribution, due-row processing, retries —
 * without a Lifecycle, alarm arbitration, or an Agent. Context boundaries
 * and physical-alarm behavior are covered by lifecycle.test.ts, and the
 * full Agent surface by ../schedule.test.ts.
 */

class HarnessHost {
  readonly invocations: Array<{
    readonly callback: string;
    readonly payload: unknown;
    readonly scheduleId: string;
  }> = [];

  failuresBeforeSuccess = 0;

  remind(payload: unknown, schedule: Schedule<unknown>): void {
    this.invocations.push({
      callback: "remind",
      payload,
      scheduleId: schedule.id
    });
  }

  flaky(payload: unknown, schedule: Schedule<unknown>): void {
    if (this.failuresBeforeSuccess > 0) {
      this.failuresBeforeSuccess -= 1;
      throw new Error("flaky failure");
    }
    this.invocations.push({
      callback: "flaky",
      payload,
      scheduleId: schedule.id
    });
  }

  broken(): void {
    throw new Error("broken callback");
  }
}

type HarnessTarget = HarnessHost & LifecycleObject;

type Harness = {
  readonly scheduler: Scheduler<HarnessTarget>;
  readonly host: HarnessHost;
  readonly storage: DurableObjectStorage;
  readonly events: Array<{ readonly type: string; readonly payload: unknown }>;
  readonly errors: unknown[];
  readonly flags: {
    rearms: number;
    starting: boolean;
    alarmsDisabled: boolean;
  };
};

function createHarness(
  storage: DurableObjectStorage,
  options: { hungScheduleTimeoutSeconds?: number } = {}
): Harness {
  const host = new HarnessHost();
  const events: Array<{ type: string; payload: unknown }> = [];
  const errors: unknown[] = [];
  const flags = { rearms: 0, starting: false, alarmsDisabled: false };

  // SAFETY: the harness supplies storage and callback dispatch through fake
  // Lifecycle services below; the constructor argument only anchors callback
  // typing for set()/every().
  const scheduler = new Scheduler(host as unknown as HarnessTarget, {
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    ...options,
    onError: (error) => {
      errors.push(error);
    }
  });

  const hostRecord = host as unknown as Record<string, unknown>;
  const services: LifecycleServices = {
    storage,
    ready: async () => {},
    starting: () => flags.starting,
    alarms: {
      rearm: async () => {
        flags.rearms += 1;
      },
      disabled: () => flags.alarmsDisabled
    },
    callbacks: {
      has: (name) => typeof hostRecord[name] === "function",
      invoke: async (name, args) => {
        const method = hostRecord[name];
        if (typeof method !== "function") {
          throw new Error(`this.${name} is not a function`);
        }
        return method.apply(host, [...args]);
      }
    },
    events: {
      emit: (type, payload) => {
        events.push({ type, payload });
      }
    },
    routes: {
      source: undefined,
      toRoot: async () => {
        throw new Error("harness has no route transport");
      },
      to: async () => {
        throw new Error("harness has no route transport");
      }
    }
  };
  bindLifecycleCapability(scheduler, services);
  return { scheduler, host, storage, events, errors, flags };
}

async function withHarness(
  fn: (harness: Harness) => Promise<void>,
  options: { hungScheduleTimeoutSeconds?: number } = {}
): Promise<void> {
  const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (_instance, state) => {
    const harness = createHarness(state.storage, options);
    await harness.scheduler.onStart();
    await fn(harness);
  });
}

function backdate(storage: DurableObjectStorage, id: string): void {
  storage.sql.exec(
    "UPDATE cf_agents_schedules SET time = ? WHERE id = ?",
    Math.floor(Date.now() / 1000) - 5,
    id
  );
}

describe("Scheduler capability", () => {
  it("creates, reads, lists, and cancels schedules", async () => {
    await withHarness(async ({ scheduler, events, flags }) => {
      const schedule = await scheduler.schedule(60, "remind", {
        message: "hi"
      });
      expect(schedule.type).toBe("delayed");
      expect(events.map((event) => event.type)).toEqual(["schedule:create"]);
      expect(flags.rearms).toBeGreaterThan(0);

      expect(await scheduler.get(schedule.id)).toEqual(schedule);
      expect(await scheduler.list()).toEqual([schedule]);
      expect(await scheduler.list({ type: "cron" })).toEqual([]);
      expect(scheduler.getSchedules()).toEqual([schedule]);
      expect(scheduler.getSchedule(schedule.id)).toEqual(schedule);

      expect(await scheduler.cancel(schedule.id)).toBe(true);
      expect(events.map((event) => event.type)).toEqual([
        "schedule:create",
        "schedule:cancel"
      ]);
      expect(await scheduler.list()).toEqual([]);
      expect(await scheduler.cancel(schedule.id)).toBe(false);
    });
  });

  it("deduplicates one-shot schedules only when idempotent is requested", async () => {
    await withHarness(async ({ scheduler, events }) => {
      const first = await scheduler.schedule(
        60,
        "remind",
        { message: "same" },
        { idempotent: true }
      );
      const second = await scheduler.schedule(
        60,
        "remind",
        { message: "same" },
        { idempotent: true }
      );
      expect(second.id).toBe(first.id);
      expect(
        events.filter((event) => event.type === "schedule:create")
      ).toHaveLength(1);

      const third = await scheduler.schedule(60, "remind", {
        message: "same"
      });
      expect(third.id).not.toBe(first.id);
    });
  });

  it("deduplicates recurring schedules unless idempotency is opted out", async () => {
    await withHarness(async ({ scheduler }) => {
      const cron = await scheduler.schedule("0 * * * *", "remind", "tick");
      const cronAgain = await scheduler.schedule("0 * * * *", "remind", "tick");
      expect(cronAgain.id).toBe(cron.id);
      const cronForced = await scheduler.schedule(
        "0 * * * *",
        "remind",
        "tick",
        {
          idempotent: false
        }
      );
      expect(cronForced.id).not.toBe(cron.id);

      const interval = await scheduler.scheduleEvery(30, "remind", "tick");
      const intervalAgain = await scheduler.scheduleEvery(30, "remind", "tick");
      expect(intervalAgain.id).toBe(interval.id);
    });
  });

  it("rejects unknown callbacks and invalid inputs", async () => {
    await withHarness(async ({ scheduler }) => {
      await expect(scheduler.schedule(60, "nope")).rejects.toThrow(
        "this.nope is not a function"
      );
      await expect(
        scheduler.schedule(undefined as unknown as number, "remind")
      ).rejects.toThrow(/Invalid schedule type/);
      await expect(scheduler.scheduleEvery(0, "remind")).rejects.toThrow(
        "intervalSeconds must be a positive number"
      );
      await expect(
        scheduler.scheduleEvery(31 * 24 * 60 * 60, "remind")
      ).rejects.toThrow(/cannot exceed/);
    });
  });

  it("contributes the earliest pending schedule to alarm selection", async () => {
    await withHarness(async ({ scheduler, storage }) => {
      expect(scheduler.getNextAlarm()).toBeNull();

      await scheduler.schedule(120, "remind", "later");
      const sooner = await scheduler.schedule(60, "remind", "sooner");
      const next = scheduler.getNextAlarm();
      expect(next).not.toBeNull();
      expect(next as number).toBeGreaterThanOrEqual(Date.now() + 55_000);
      expect(next as number).toBeLessThanOrEqual(Date.now() + 61_000);

      // An overdue row (restart lost the alarm) is clamped to the near future.
      backdate(storage, sooner.id);
      const before = Date.now();
      const overdue = scheduler.getNextAlarm();
      expect(overdue as number).toBeGreaterThan(before);
      expect(overdue as number).toBeLessThanOrEqual(before + 1_000);
    });
  });

  it("executes due rows and advances one-shot, interval, and cron rows", async () => {
    await withHarness(async ({ scheduler, host, storage, events }) => {
      const oneShot = await scheduler.schedule(60, "remind", { n: 1 });
      const interval = await scheduler.scheduleEvery(600, "remind", { n: 2 });
      const cron = await scheduler.schedule("* * * * *", "remind", { n: 3 });
      backdate(storage, oneShot.id);
      backdate(storage, interval.id);
      backdate(storage, cron.id);

      await scheduler.onAlarm();

      expect(host.invocations).toHaveLength(3);
      expect(host.invocations).toContainEqual({
        callback: "remind",
        payload: { n: 1 },
        scheduleId: oneShot.id
      });
      expect(
        events.filter((event) => event.type === "schedule:execute")
      ).toHaveLength(3);

      // The one-shot row is consumed; recurring rows advance into the future.
      const remaining = await scheduler.list();
      expect(remaining.map((row) => row.id).sort()).toEqual(
        [interval.id, cron.id].sort()
      );
      const nowSeconds = Math.floor(Date.now() / 1000);
      for (const row of remaining) {
        expect(row.time).toBeGreaterThan(nowSeconds);
      }
    });
  });

  it("retries a failing callback before succeeding", async () => {
    await withHarness(async ({ scheduler, host, storage, events }) => {
      host.failuresBeforeSuccess = 1;
      const schedule = await scheduler.schedule(60, "flaky", "payload");
      backdate(storage, schedule.id);

      await scheduler.onAlarm();

      expect(host.invocations).toEqual([
        { callback: "flaky", payload: "payload", scheduleId: schedule.id }
      ]);
      expect(
        events.filter((event) => event.type === "schedule:retry")
      ).toHaveLength(1);
      expect(await scheduler.list()).toEqual([]);
    });
  });

  it("reports terminal callback errors and consumes the one-shot row", async () => {
    await withHarness(async ({ scheduler, storage, events, errors }) => {
      const schedule = await scheduler.schedule(60, "broken");
      backdate(storage, schedule.id);

      await scheduler.onAlarm();

      expect(errors).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "schedule:error")
      ).toHaveLength(1);
      expect(await scheduler.list()).toEqual([]);
    });
  });

  it("skips an in-flight interval and recovers a hung one", async () => {
    await withHarness(
      async ({ scheduler, host, storage }) => {
        const interval = await scheduler.scheduleEvery(600, "remind", "tick");
        const nowSeconds = Math.floor(Date.now() / 1000);

        // In flight and not yet hung: skipped, but a recheck is contributed.
        storage.sql.exec(
          "UPDATE cf_agents_schedules SET time = ?, running = 1, execution_started_at = ? WHERE id = ?",
          nowSeconds - 5,
          nowSeconds,
          interval.id
        );
        await scheduler.onAlarm();
        expect(host.invocations).toEqual([]);
        const recheck = scheduler.getNextAlarm();
        expect(recheck).toBe((nowSeconds + 60) * 1000);

        // Past the hung timeout: force reset and re-execute.
        storage.sql.exec(
          "UPDATE cf_agents_schedules SET execution_started_at = ? WHERE id = ?",
          nowSeconds - 120,
          interval.id
        );
        await scheduler.onAlarm();
        expect(host.invocations).toHaveLength(1);
      },
      { hungScheduleTimeoutSeconds: 60 }
    );
  });

  it("stops processing rows once teardown disables alarms", async () => {
    await withHarness(async ({ scheduler, host, storage, flags }) => {
      const first = await scheduler.schedule(60, "remind", { order: 1 });
      const second = await scheduler.schedule(90, "remind", { order: 2 });
      backdate(storage, first.id);
      backdate(storage, second.id);

      // Simulate a callback destroying the host mid-phase.
      host.remind = () => {
        flags.alarmsDisabled = true;
      };
      await scheduler.onAlarm();

      // Processing halted before advancing or executing further rows.
      expect((await scheduler.list()).map((row) => row.id).sort()).toEqual(
        [first.id, second.id].sort()
      );
    });
  });

  it("warns once for non-idempotent one-shots created during startup", async () => {
    await withHarness(async ({ scheduler, flags }) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        flags.starting = true;
        await scheduler.schedule(60, "remind", "a");
        await scheduler.schedule(60, "remind", "b");
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain('schedule("remind")');

        // Explicit idempotency choices and cron schedules do not warn.
        await scheduler.schedule(60, "flaky", "c", { idempotent: true });
        await scheduler.schedule("* * * * *", "flaky", "d");
        expect(warn).toHaveBeenCalledTimes(1);

        // Outside startup there is no warning.
        flags.starting = false;
        await scheduler.schedule(60, "broken", "e");
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
