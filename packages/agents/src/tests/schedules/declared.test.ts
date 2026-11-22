import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getCurrentAgent } from "../../lifecycle";
import type {
  DeclaredScheduleContext,
  DeclaredSchedules
} from "../../schedules";
import {
  nextDeclaredScheduleTime,
  parseDeclaredSchedule,
  tryParseDeclaredSchedule
} from "../../schedules/declared-timing";
import type { SchedulerHarnessObject } from "../capabilities/scheduler";
import { captureDiagnosticsEvents } from "../shared/diagnostics-capture";

/**
 * Declared schedules on the Scheduler capability, driven on a minimal real
 * Durable Object (`SchedulerHarnessObject`) with real storage and real
 * alarms.
 */

function jobTime(storage: DurableObjectStorage, id: string): number | null {
  const [row] = storage.sql
    .exec<{ time: number }>(
      "SELECT time FROM cf_agents_jobs WHERE id = ?",
      `declared:${id}`
    )
    .toArray();
  return row?.time ?? null;
}

/**
 * Move a declared job's wake into the past, as a late alarm or the alarm
 * breaker's backoff would, and return the occurrence it still stands for.
 */
function makeDue(storage: DurableObjectStorage, id: string): number {
  const [row] = storage.sql
    .exec<{ payload: string }>(
      "SELECT payload FROM cf_agents_jobs WHERE id = ?",
      `declared:${id}`
    )
    .toArray();
  storage.sql.exec(
    "UPDATE cf_agents_jobs SET time = ? WHERE id = ?",
    Date.now() - 5_000,
    `declared:${id}`
  );
  return (JSON.parse(row.payload) as { declared: { scheduledFor: number } })
    .declared.scheduledFor;
}

describe("Scheduler declared schedules", () => {
  it("reconciles one job per declared name to the declaration", async () => {
    const stub = env.SchedulerHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: SchedulerHarnessObject, state) => {
        const run = () => {};
        const unrelated = await instance.scheduler.set(3600, "remind", "x");

        await instance.scheduler.declare({
          report: { schedule: "every day at 09:00 in UTC", run },
          tick: { schedule: "every 5 minutes", run }
        });
        const report = jobTime(state.storage, "report");
        const tick = jobTime(state.storage, "tick");
        expect(report).not.toBeNull();
        expect(tick).not.toBeNull();
        const listed = instance.scheduler
          .listDeclared()
          .sort((a, b) => a.name.localeCompare(b.name));
        expect(listed.map((info) => info.name)).toEqual(["report", "tick"]);
        expect(listed[0]).toMatchObject({
          schedule: "every day at 09:00",
          scheduleKind: "wall-clock",
          timezone: "UTC",
          nextRunAt: report
        });
        // Declared jobs are not ordinary schedules.
        expect(
          (await instance.scheduler.list()).map((schedule) => schedule.id)
        ).toEqual([unrelated.id]);

        // Same timing: nothing moves.
        await instance.scheduler.declare({
          report: {
            schedule: "every day at 09:00 in UTC",
            metadata: { changed: true },
            run
          },
          tick: { schedule: "every 5 minutes", run }
        });
        expect(jobTime(state.storage, "report")).toBe(report);
        expect(jobTime(state.storage, "tick")).toBe(tick);

        // Changed timing re-arms; a removed name is cancelled.
        await instance.scheduler.declare({
          report: { schedule: "every day at 10:00 in UTC", run }
        });
        expect(jobTime(state.storage, "report")).not.toBe(report);
        expect(jobTime(state.storage, "tick")).toBeNull();

        await instance.scheduler.declare({});
        expect(instance.scheduler.listDeclared()).toEqual([]);
        expect(
          (await instance.scheduler.list()).map((schedule) => schedule.id)
        ).toEqual([unrelated.id]);
      }
    );
  });

  it("re-arms wall-clock schedules when the default timezone changes", async () => {
    const stub = env.SchedulerHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: SchedulerHarnessObject, state) => {
        const declaration = {
          reminder: { schedule: "every day at 09:00" as const, run() {} }
        };
        await instance.scheduler.declare(declaration, {
          defaultTimezone: "UTC"
        });
        const before = jobTime(state.storage, "reminder");
        await instance.scheduler.declare(declaration, {
          defaultTimezone: () => "America/New_York"
        });
        expect(jobTime(state.storage, "reminder")).not.toBe(before);
        expect(instance.scheduler.listDeclared()[0].timezone).toBe(
          "America/New_York"
        );
      }
    );
  });

  it("rejects an invalid declaration and keeps the last good one running", async () => {
    const stub = env.SchedulerHarnessObject.getByName(crypto.randomUUID());
    let runs = 0;
    await runInDurableObject(
      stub,
      async (instance: SchedulerHarnessObject, state) => {
        await instance.scheduler.declare({
          keep: {
            schedule: "every 1 hour",
            run() {
              runs += 1;
            }
          }
        });
        const kept = jobTime(state.storage, "keep");

        await expect(
          instance.scheduler.declare({
            keep: { schedule: "every 1 hour", run() {} },
            "bad name": { schedule: "every 1 hour", run() {} }
          })
        ).rejects.toThrow(/Invalid declared schedule name/);
        await expect(
          instance.scheduler.declare({
            wallClock: { schedule: "every day at 09:00", run() {} }
          })
        ).rejects.toThrow(/requires a timezone/);
        expect(jobTime(state.storage, "keep")).toBe(kept);
        expect(instance.scheduler.listDeclared()).toHaveLength(1);
        makeDue(state.storage, "keep");
      }
    );

    await runDurableObjectAlarm(stub);

    expect(runs).toBe(1);
  });

  it("runs a due occurrence in host context and arms the next one", async () => {
    const name = crypto.randomUUID();
    const stub = env.SchedulerHarnessObject.getByName(name);
    const capture = captureDiagnosticsEvents("agents:schedule", name);
    const runs: Array<DeclaredScheduleContext & { hostContext: boolean }> = [];
    try {
      const scheduledFor = await runInDurableObject(
        stub,
        async (instance: SchedulerHarnessObject, state) => {
          await instance.scheduler.declare(
            {
              digest: {
                schedule: "every 1 hour",
                metadata: { kind: "digest" },
                run(context) {
                  runs.push({
                    ...context,
                    hostContext:
                      getCurrentAgent<SchedulerHarnessObject>().agent ===
                      instance
                  });
                }
              }
            },
            { idempotencyKeyPrefix: "tenant-a" }
          );
          return makeDue(state.storage, "digest");
        }
      );

      expect(await runDurableObjectAlarm(stub)).toBe(true);

      // The wake moved (late alarm, breaker backoff); the occurrence did not.
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        name: "digest",
        scheduledFor,
        occurrenceKey: `digest:${scheduledFor}`,
        idempotencyKey: `tenant-a:digest:${scheduledFor}`,
        schedule: "every 1 hour",
        scheduleKind: "interval",
        metadata: { kind: "digest" },
        hostContext: true
      });
      expect(runs[0].scheduledForDate.getTime()).toBe(scheduledFor);
      await runInDurableObject(
        stub,
        async (instance: SchedulerHarnessObject, state) => {
          expect(jobTime(state.storage, "digest")).toBe(
            scheduledFor + 3_600_000
          );
          expect(instance.scheduler.listDeclared()[0].nextRunAt).toBe(
            scheduledFor + 3_600_000
          );
        }
      );
      expect(capture.events.map((event) => event.type)).toContain(
        "schedule:execute"
      );
    } finally {
      capture.stop();
    }
  });

  it("retries a failing occurrence, reports it, and still arms the next one", async () => {
    const stub = env.SchedulerHarnessObject.getByName(crypto.randomUUID());
    let attempts = 0;
    const scheduledFor = await runInDurableObject(
      stub,
      async (instance: SchedulerHarnessObject, state) => {
        await instance.scheduler.declare({
          broken: {
            schedule: "every 1 hour",
            retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
            run() {
              attempts += 1;
              throw new Error("declared failure");
            }
          }
        });
        return makeDue(state.storage, "broken");
      }
    );

    await runDurableObjectAlarm(stub);

    expect(attempts).toBe(3);
    await runInDurableObject(
      stub,
      async (instance: SchedulerHarnessObject, state) => {
        expect(instance.callbackErrors).toEqual(["declared failure"]);
        expect(jobTime(state.storage, "broken")).toBe(scheduledFor + 3_600_000);
      }
    );
  });

  it("retires a job whose name left the declaration before it ran", async () => {
    const stub = env.SchedulerHarnessObject.getByName(crypto.randomUUID());
    let declared = true;
    let ran = false;
    await runInDurableObject(
      stub,
      async (instance: SchedulerHarnessObject, state) => {
        await instance.scheduler.declare((): DeclaredSchedules =>
          declared
            ? {
                gone: {
                  schedule: "every 1 hour",
                  run() {
                    ran = true;
                  }
                }
              }
            : {}
        );
        makeDue(state.storage, "gone");
      }
    );
    declared = false;

    await runDurableObjectAlarm(stub);

    expect(ran).toBe(false);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(jobTime(state.storage, "gone")).toBeNull();
    });
  });

  it("reconciles each group on its own", async () => {
    const stub = env.SchedulerHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: SchedulerHarnessObject, state) => {
        const run = () => {};
        await instance.scheduler.declare({
          app: { schedule: "every 1 hour", run }
        });
        await instance.scheduler.declare(
          { lib: { schedule: "every 1 hour", run } },
          { group: "library" }
        );
        expect(
          instance.scheduler.listDeclared().find((info) => info.name === "lib")
            ?.group
        ).toBe("library");

        await instance.scheduler.declare({}, { group: "library" });
        expect(jobTime(state.storage, "app")).not.toBeNull();
        expect(jobTime(state.storage, "library:lib")).toBeNull();

        await instance.scheduler.declare(
          { lib: { schedule: "every 1 hour", run } },
          { group: "library" }
        );
        await instance.scheduler.declare({});
        expect(jobTime(state.storage, "app")).toBeNull();
        expect(jobTime(state.storage, "library:lib")).not.toBeNull();
      }
    );
  });

  it("applies declarations in call order, so a slow older one cannot undo a newer one", async () => {
    const stub = env.SchedulerHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: SchedulerHarnessObject, state) => {
        let finishOlder: (schedules: DeclaredSchedules) => void = () => {};
        const older = instance.scheduler.declare(
          () =>
            new Promise<DeclaredSchedules>((resolve) => {
              finishOlder = resolve;
            })
        );
        const newer = instance.scheduler.declare({
          reminder: { schedule: "every 1 hour", run() {} }
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        finishOlder({});
        await Promise.all([older, newer]);
        expect(jobTime(state.storage, "reminder")).not.toBeNull();
      }
    );
  });

  it("keeps a declaration that an occurrence's own run made", async () => {
    const stub = env.SchedulerHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: SchedulerHarnessObject, state) => {
        const minutely: DeclaredSchedules = {
          cleanup: { schedule: "every 1 minute", run() {} }
        };
        await instance.scheduler.declare({
          cleanup: {
            schedule: "every 1 hour",
            run: () => instance.scheduler.declare(minutely)
          }
        });
        makeDue(state.storage, "cleanup");
      }
    );

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: SchedulerHarnessObject) => {
      expect(instance.scheduler.listDeclared()).toEqual([
        expect.objectContaining({ name: "cleanup", schedule: "every 1 minute" })
      ]);
    });
  });

  it("namespaces default idempotency keys by group", async () => {
    const name = crypto.randomUUID();
    const stub = env.SchedulerHarnessObject.getByName(name);
    const keys: string[] = [];
    await runInDurableObject(
      stub,
      async (instance: SchedulerHarnessObject, state) => {
        const run = (context: DeclaredScheduleContext) => {
          keys.push(context.idempotencyKey);
        };
        await instance.scheduler.declare({
          report: { schedule: "every 1 hour", run }
        });
        await instance.scheduler.declare(
          { report: { schedule: "every 1 hour", run } },
          { group: "library" }
        );
        makeDue(state.storage, "report");
        makeDue(state.storage, "library:report");
      }
    );

    await runDurableObjectAlarm(stub);

    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(
      keys.some((key) =>
        key.startsWith(
          `schedule:SchedulerHarnessObject:${name}:library:report:`
        )
      )
    ).toBe(true);
  });

  it("uses a class-qualified default idempotency key and accepts any valid name", async () => {
    const name = crypto.randomUUID();
    const stub = env.SchedulerHarnessObject.getByName(name);
    const keys: string[] = [];
    const scheduledFor = await runInDurableObject(
      stub,
      async (instance: SchedulerHarnessObject, state) => {
        // A name that is also an Object.prototype key.
        const schedules: DeclaredSchedules = Object.fromEntries([
          [
            "constructor",
            {
              schedule: "every 1 hour",
              run(context: DeclaredScheduleContext) {
                keys.push(context.idempotencyKey);
              }
            }
          ]
        ]);
        await instance.scheduler.declare(schedules);
        return makeDue(state.storage, "constructor");
      }
    );

    await runDurableObjectAlarm(stub);

    expect(keys).toEqual([
      `schedule:SchedulerHarnessObject:${name}:constructor:${scheduledFor}`
    ]);
  });

  it("carries Think's former declared-task rows forward on upgrade", async () => {
    const stub = env.SchedulerHarnessObject.getByName(crypto.randomUUID());
    // Think's exact occurrence has milliseconds; the old job time is rounded.
    const legacyTime = Math.floor(Date.now() / 1000) * 1000 + 42 * 60_000 + 456;
    await runInDurableObject(
      stub,
      async (instance: SchedulerHarnessObject, state) => {
        await instance.lifecycle.start();
        const sql = state.storage.sql;
        sql.exec(`CREATE TABLE cf_think_scheduled_tasks (
          owner_key TEXT NOT NULL, task_id TEXT NOT NULL,
          schedule_hash TEXT NOT NULL, task_hash TEXT NOT NULL,
          schedule_id TEXT, next_run_at INTEGER,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY (owner_key, task_id))`);
        sql.exec(
          "INSERT INTO cf_think_scheduled_tasks VALUES ('owner', 'report', 'h', 't', 'legacy-root', ?, 0, 0)",
          legacyTime
        );
        const legacyJob = (id: string, ownerPath: string | null) =>
          sql.exec(
            `INSERT INTO cf_agents_jobs (id, capability, fn, time, payload)
             VALUES (?, 'scheduler', '_runDeclaredScheduledTask', ?, ?)`,
            id,
            Math.floor(legacyTime / 1000) * 1000,
            JSON.stringify({
              payload: {
                taskId: "report",
                scheduleHash: "h",
                // The table row wins over a stale payload.
                scheduledFor: legacyTime - 7
              },
              type: "scheduled",
              owner_path: ownerPath,
              owner_path_key: ownerPath
            })
          );
        legacyJob("legacy-root", null);
        legacyJob("legacy-facet", "facet/child");
        // A task whose row never got written: the payload's exact time is used.
        sql.exec(
          `INSERT INTO cf_agents_jobs (id, capability, fn, time, payload)
           VALUES ('legacy-digest', 'scheduler', '_runDeclaredScheduledTask', ?, ?)`,
          Math.floor(legacyTime / 1000) * 1000,
          JSON.stringify({
            payload: {
              taskId: "digest",
              scheduleHash: "h",
              scheduledFor: legacyTime + 1
            },
            type: "scheduled",
            owner_path: null,
            owner_path_key: null
          })
        );
        await state.storage.put("cf_agents:schedules_schema_version", 2);
      }
    );

    await evictDurableObject(stub);

    await runInDurableObject(
      stub,
      async (instance: SchedulerHarnessObject, state) => {
        await instance.lifecycle.start();
        const tables = state.storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE name = 'cf_think_scheduled_tasks'"
          )
          .toArray();
        expect(tables).toEqual([]);
        const legacy = state.storage.sql
          .exec(
            "SELECT id FROM cf_agents_jobs WHERE fn = '_runDeclaredScheduledTask'"
          )
          .toArray();
        expect(legacy).toEqual([]);

        // The application's group does not take Think's carried times.
        const declaration = {
          report: { schedule: "every 1 hour" as const, run() {} }
        };
        await instance.scheduler.declare(declaration);
        expect(jobTime(state.storage, "report")).not.toBe(legacyTime);

        // Think's group keeps the exact pending occurrences.
        await instance.scheduler.declare(
          { ...declaration, digest: declaration.report },
          { group: "think" }
        );
        expect(jobTime(state.storage, "think:report")).toBe(legacyTime);
        expect(jobTime(state.storage, "think:digest")).toBe(legacyTime + 1);
        expect(
          instance.scheduler
            .listDeclared()
            .find((info) => info.group === "think" && info.name === "report")
            ?.nextRunAt
        ).toBe(legacyTime);
        expect(
          await state.storage.get("cf_agents:declared_schedules_legacy_next")
        ).toBeUndefined();
      }
    );
  });
});

describe("declared schedule expressions", () => {
  const error = (
    schedule: string,
    timezone?: string,
    defaultTimezone?: string
  ) => {
    const result = tryParseDeclaredSchedule(
      schedule,
      timezone,
      defaultTimezone
    );
    return result.ok ? null : result.error;
  };

  it("rejects malformed expressions and timezone conflicts", () => {
    expect(error("every day at 25:00", "UTC")).toMatch(
      /Unsupported schedule DSL|Invalid schedule time/
    );
    expect(error("every weekday at 09:00")).toMatch(/requires a timezone/);
    expect(error("every 1 minutes")).toMatch(/singular/);
    expect(error("every day at 09:00", "Not/A_Zone")).toMatch(
      /Invalid timezone/
    );
    expect(error("every day at 09:00 in UTC", "Europe/London")).toMatch(
      /does not match/
    );
    expect(error("every 2 hours", "UTC")).toMatch(
      /Interval schedules cannot specify a timezone/
    );
    expect(error("every week on monday,monday at 09:00", "UTC")).toMatch(
      /Duplicate schedule day/
    );
    expect(error("every week on mon,fri at 23:30", undefined, "UTC")).toBe(
      null
    );
  });

  it("computes late interval and DST wall-clock occurrences", () => {
    const next = (
      schedule: string,
      nowIso: string,
      timezone?: string,
      previous?: number
    ) =>
      nextDeclaredScheduleTime(
        parseDeclaredSchedule(schedule, timezone, undefined),
        new Date(nowIso),
        previous
      ).toISOString();

    expect(
      next(
        "every 1 hour",
        "2026-01-01T10:30:00.000Z",
        undefined,
        Date.parse("2026-01-01T08:00:00.000Z")
      )
    ).toBe("2026-01-01T11:00:00.000Z");
    expect(
      next("every day at 01:30", "2026-03-28T23:00:00.000Z", "Europe/London")
    ).toBe("2026-03-29T01:00:00.000Z");
    expect(
      next("every day at 01:30", "2026-10-24T23:00:00.000Z", "Europe/London")
    ).toBe("2026-10-25T00:30:00.000Z");
  });

  it("reuses one date formatter per timezone", () => {
    const schedule = parseDeclaredSchedule(
      "every week on mon,fri at 23:30",
      "America/New_York",
      undefined
    );
    const now = new Date("2026-01-01T12:00:00.000Z");
    nextDeclaredScheduleTime(schedule, now);
    const original = Intl.DateTimeFormat;
    let constructions = 0;
    Intl.DateTimeFormat = new Proxy(original, {
      construct(target, args, newTarget) {
        constructions++;
        return Reflect.construct(target, args, newTarget);
      }
    });
    try {
      nextDeclaredScheduleTime(schedule, now);
    } finally {
      Intl.DateTimeFormat = original;
    }
    expect(constructions).toBe(0);
  });
});
