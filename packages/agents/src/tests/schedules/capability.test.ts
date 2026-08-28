import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  backdateScheduleRow,
  type SchedulerHarnessObject
} from "../capabilities/scheduler";
import type { Scheduler } from "../../schedules";
import { captureDiagnosticsEvents } from "../shared/diagnostics-capture";

/**
 * Capability-level Scheduler tests: the capability installed on a minimal
 * real Durable Object (`SchedulerHarnessObject`) whose only capability is the
 * Scheduler. Tests drive real Lifecycle startup, real storage, real platform
 * alarms, and the real diagnostics event sink — no fakes. Alarm arbitration
 * across multiple capabilities and Agent's full surface are covered by
 * ../lifecycle/alarm-arbitration.test.ts and ../schedule.test.ts
 * respectively.
 */

function captureScheduleEvents(name: string) {
  return captureDiagnosticsEvents("agents:schedule", name);
}

describe("Scheduler capability", () => {
  it("creates, reads, lists, and cancels schedules against the real alarm", async () => {
    const name = crypto.randomUUID();
    const stub = env.SchedulerHarnessObject.getByName(name);
    const capture = captureScheduleEvents(name);

    try {
      await runInDurableObject(
        stub,
        async (instance: SchedulerHarnessObject, state) => {
          const schedule = await instance.scheduler.set(60, "remind", {
            message: "hi"
          });
          expect(schedule.type).toBe("delayed");
          // Lifecycle armed the physical alarm from the row's execution time.
          expect(await state.storage.getAlarm()).toBe(schedule.time * 1000);

          expect(await instance.scheduler.get(schedule.id)).toEqual(schedule);
          expect(await instance.scheduler.list()).toEqual([schedule]);
          expect(await instance.scheduler.list({ type: "cron" })).toEqual([]);
          expect(
            instance.scheduler.__DO_NOT_USE_WILL_REMOVE__getSchedules()
          ).toEqual([schedule]);
          expect(
            instance.scheduler.__DO_NOT_USE_WILL_REMOVE__getSchedule(
              schedule.id
            )
          ).toEqual(schedule);

          expect(await instance.scheduler.cancel(schedule.id)).toBe(true);
          expect(await instance.scheduler.list()).toEqual([]);
          expect(await instance.scheduler.cancel(schedule.id)).toBe(false);
          // No rows left, so the physical alarm is cleared.
          expect(await state.storage.getAlarm()).toBeNull();
        }
      );
      expect(capture.events.map((event) => event.type)).toEqual([
        "schedule:create",
        "schedule:cancel"
      ]);
    } finally {
      capture.stop();
    }
  });

  it("deduplicates one-shot schedules only when idempotent is requested", async () => {
    const name = crypto.randomUUID();
    const stub = env.SchedulerHarnessObject.getByName(name);
    const capture = captureScheduleEvents(name);

    try {
      await runInDurableObject(
        stub,
        async (instance: SchedulerHarnessObject) => {
          const first = await instance.scheduler.set(
            60,
            "remind",
            { message: "same" },
            { idempotent: true }
          );
          const second = await instance.scheduler.set(
            60,
            "remind",
            { message: "same" },
            { idempotent: true }
          );
          expect(second.id).toBe(first.id);

          const third = await instance.scheduler.set(60, "remind", {
            message: "same"
          });
          expect(third.id).not.toBe(first.id);
        }
      );
      // The dedup hit does not emit a second create event.
      expect(
        capture.events.filter((event) => event.type === "schedule:create")
      ).toHaveLength(2);
    } finally {
      capture.stop();
    }
  });

  it("deduplicates recurring schedules unless idempotency is opted out", async () => {
    const stub = env.SchedulerHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SchedulerHarnessObject) => {
      const cron = await instance.scheduler.set("0 * * * *", "remind", "tick");
      const cronAgain = await instance.scheduler.set(
        "0 * * * *",
        "remind",
        "tick"
      );
      expect(cronAgain.id).toBe(cron.id);
      const cronForced = await instance.scheduler.set(
        "0 * * * *",
        "remind",
        "tick",
        { idempotent: false }
      );
      expect(cronForced.id).not.toBe(cron.id);

      const interval = await instance.scheduler.every(600, "remind", "tick");
      const intervalAgain = await instance.scheduler.every(
        600,
        "remind",
        "tick"
      );
      expect(intervalAgain.id).toBe(interval.id);
    });
  });

  it("rejects unknown callbacks and invalid inputs", async () => {
    const stub = env.SchedulerHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SchedulerHarnessObject) => {
      // Unknown names are a compile error on the typed map; erase the
      // handler typing to exercise the runtime rejection.
      const untyped: Scheduler = instance.scheduler;
      await expect(untyped.set(60, "nope")).rejects.toThrow(
        'Unknown scheduled callback "nope"'
      );
      await expect(
        instance.scheduler.set(undefined as unknown as number, "remind")
      ).rejects.toThrow(/Invalid schedule type/);
      await expect(instance.scheduler.every(0, "remind")).rejects.toThrow(
        "intervalSeconds must be a positive number"
      );
      await expect(
        instance.scheduler.every(31 * 24 * 60 * 60, "remind")
      ).rejects.toThrow(/cannot exceed/);
    });
  });

  it("arms the physical alarm from the earliest pending schedule job", async () => {
    const stub = env.SchedulerHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: SchedulerHarnessObject, state) => {
        await instance.lifecycle.start();
        expect(await state.storage.getAlarm()).toBeNull();

        await instance.scheduler.set(120, "remind", "later");
        const sooner = await instance.scheduler.set(60, "remind", "sooner");
        expect(await state.storage.getAlarm()).toBe(sooner.time * 1000);

        // An overdue job (a restart lost the alarm) is clamped to the future.
        backdateScheduleRow(state.storage, sooner.id);
        const before = Date.now();
        await instance.lifecycle.rearmAlarm();
        const overdue = await state.storage.getAlarm();
        expect(overdue as number).toBeGreaterThan(before);
        expect(overdue as number).toBeLessThanOrEqual(before + 1_000);
      }
    );
  });

  it("executes due rows via the real alarm and advances each row kind", async () => {
    const name = crypto.randomUUID();
    const stub = env.SchedulerHarnessObject.getByName(name);
    const capture = captureScheduleEvents(name);

    try {
      const ids = await runInDurableObject(
        stub,
        async (instance: SchedulerHarnessObject, state) => {
          const oneShot = await instance.scheduler.set(60, "remind", {
            n: 1
          });
          const interval = await instance.scheduler.every(600, "remind", {
            n: 2
          });
          const cron = await instance.scheduler.set("* * * * *", "remind", {
            n: 3
          });
          backdateScheduleRow(state.storage, oneShot.id);
          backdateScheduleRow(state.storage, interval.id);
          backdateScheduleRow(state.storage, cron.id);
          return { oneShot: oneShot.id, interval: interval.id, cron: cron.id };
        }
      );

      expect(await runDurableObjectAlarm(stub)).toBe(true);

      await runInDurableObject(
        stub,
        async (instance: SchedulerHarnessObject, state) => {
          expect(instance.invocations).toHaveLength(3);
          expect(instance.invocations).toContainEqual({
            callback: "remind",
            payload: { n: 1 },
            scheduleId: ids.oneShot,
            hadHostContext: true
          });
          // Callbacks ran with the host as `this` and in host context.
          expect(
            instance.invocations.every((entry) => entry.hadHostContext)
          ).toBe(true);

          // One-shot consumed; recurring rows advanced into the future and
          // the physical alarm re-armed for them.
          const remaining = await instance.scheduler.list();
          expect(remaining.map((row) => row.id).sort()).toEqual(
            [ids.interval, ids.cron].sort()
          );
          // >= rather than >: a cron row advanced at a minute boundary can
          // land exactly on the current second.
          const nowSeconds = Math.floor(Date.now() / 1000);
          for (const row of remaining) {
            expect(row.time).toBeGreaterThanOrEqual(nowSeconds);
          }
          expect(await state.storage.getAlarm()).not.toBeNull();
        }
      );
      expect(
        capture.events.filter((event) => event.type === "schedule:execute")
      ).toHaveLength(3);
    } finally {
      capture.stop();
    }
  });

  it("retries a failing callback before succeeding", async () => {
    const name = crypto.randomUUID();
    const stub = env.SchedulerHarnessObject.getByName(name);
    const capture = captureScheduleEvents(name);

    try {
      const scheduleId = await runInDurableObject(
        stub,
        async (instance: SchedulerHarnessObject, state) => {
          instance.failuresBeforeSuccess = 1;
          const schedule = await instance.scheduler.set(60, "flaky", "payload");
          backdateScheduleRow(state.storage, schedule.id);
          return schedule.id;
        }
      );

      expect(await runDurableObjectAlarm(stub)).toBe(true);

      await runInDurableObject(
        stub,
        async (instance: SchedulerHarnessObject) => {
          expect(instance.invocations).toEqual([
            {
              callback: "flaky",
              payload: "payload",
              scheduleId,
              hadHostContext: true
            }
          ]);
          expect(await instance.scheduler.list()).toEqual([]);
        }
      );
      expect(
        capture.events.filter((event) => event.type === "schedule:retry")
      ).toHaveLength(1);
    } finally {
      capture.stop();
    }
  });

  it("reports terminal callback errors and consumes the one-shot row", async () => {
    const name = crypto.randomUUID();
    const stub = env.SchedulerHarnessObject.getByName(name);
    const capture = captureScheduleEvents(name);

    try {
      await runInDurableObject(
        stub,
        async (instance: SchedulerHarnessObject, state) => {
          const schedule = await instance.scheduler.set(60, "broken");
          backdateScheduleRow(state.storage, schedule.id);
        }
      );

      expect(await runDurableObjectAlarm(stub)).toBe(true);

      await runInDurableObject(
        stub,
        async (instance: SchedulerHarnessObject) => {
          expect(instance.callbackErrors).toEqual(["broken callback"]);
          expect(await instance.scheduler.list()).toEqual([]);
        }
      );
      expect(
        capture.events.filter((event) => event.type === "schedule:error")
      ).toHaveLength(1);
    } finally {
      capture.stop();
    }
  });

  it("skips an in-flight interval and recovers a hung one", async () => {
    const stub = env.SchedulerHarnessObject.getByName(crypto.randomUUID());

    const marks = await runInDurableObject(
      stub,
      async (instance: SchedulerHarnessObject, state) => {
        const interval = await instance.scheduler.every(600, "remind", "tick");
        const nowMs = Date.now();
        // In flight and not yet hung (harness hung timeout: 60s).
        state.storage.sql.exec(
          "UPDATE cf_agents_jobs SET time = ?, running = 1, execution_started_at = ? WHERE id = ?",
          nowMs - 5_000,
          nowMs,
          interval.id
        );
        return { id: interval.id, startedAt: nowMs };
      }
    );

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(
      stub,
      async (instance: SchedulerHarnessObject, state) => {
        // Skipped, but a hung-interval recheck was derived and armed.
        expect(instance.invocations).toEqual([]);
        const recheck = marks.startedAt + 60_000;
        expect(await state.storage.getAlarm()).toBe(recheck);

        // Past the hung timeout: the next alarm cycle force-resets and runs.
        state.storage.sql.exec(
          "UPDATE cf_agents_jobs SET execution_started_at = ? WHERE id = ?",
          marks.startedAt - 120_000,
          marks.id
        );
      }
    );

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, async (instance: SchedulerHarnessObject) => {
      expect(instance.invocations).toHaveLength(1);
    });
  });

  it("stops processing rows once teardown disables alarms", async () => {
    const stub = env.SchedulerHarnessObject.getByName(crypto.randomUUID());

    const ids = await runInDurableObject(
      stub,
      async (instance: SchedulerHarnessObject, state) => {
        const first = await instance.scheduler.set(60, "remind", {
          order: 1
        });
        const second = await instance.scheduler.set(90, "remind", {
          order: 2
        });
        backdateScheduleRow(state.storage, first.id);
        backdateScheduleRow(state.storage, second.id);
        // Simulate a callback tearing the host down mid-phase.
        instance.disableAlarmsOnNextCallback = true;
        return [first.id, second.id];
      }
    );

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(
      stub,
      async (instance: SchedulerHarnessObject, state) => {
        // Processing halted after the disabling callback: nothing advanced,
        // no further callbacks ran, and the physical alarm stayed cleared.
        expect(instance.invocations).toHaveLength(1);
        expect(
          (await instance.scheduler.list()).map((row) => row.id).sort()
        ).toEqual([...ids].sort());
        expect(await state.storage.getAlarm()).toBeNull();
      }
    );
  });

  it("warns once for non-idempotent one-shots created during real startup", async () => {
    const stub = env.SchedulerStartupWarnObject.getByName(crypto.randomUUID());

    const warnings = await stub.warnings();
    const scheduleWarnings = warnings.filter((warning) =>
      warning.includes("without { idempotent: true }")
    );
    expect(scheduleWarnings).toHaveLength(1);
    expect(scheduleWarnings[0]).toContain('Scheduling "maintenance"');

    // Outside startup the same call does not warn.
    expect(await stub.scheduleOutsideStartup()).toBe(0);
  });
});
