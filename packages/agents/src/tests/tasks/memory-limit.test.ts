import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { LifecycleJob } from "../../lifecycle/job-queue";
import {
  backdateTaskWake,
  seedTaskRun,
  seedTaskStep,
  type TaskHarnessObject,
  type TaskSchedulerCoexistObject
} from "../capabilities/tasks";

/**
 * Alarm memory-limit breaker (#1825) applied to Tasks runs.
 *
 * A task whose attempt deterministically exhausts memory must be contained
 * by the breaker like any other alarm-driven work: backed off between
 * strikes and terminally failed at the strike budget. The hazard specific
 * to Tasks is resurrection — the run row is the durable source of truth,
 * and startup reconciliation re-mirrors interrupted runs as due-now wakes,
 * which would defeat the breaker's queue-row backoff and outlive its seal
 * unless the capability participates in the breaker itself. An attempt that
 * outlives Tasks' five-second job handoff is tracked alarm work: the alarm
 * returns, and the handoff is classified when it settles.
 */

const OOM_STRIKES_KEY = "cf_agents:oom_alarm_strikes";

/** The queue job Lifecycle reports as executing when a run's wake strikes. */
function taskWakeJob(runId: string): LifecycleJob {
  return {
    id: `task:${runId}`,
    capability: "tasks",
    fn: "wake",
    time: Date.now() - 1_000,
    payload: undefined,
    retry: { maxAttempts: 1 },
    singleflight: false,
    exclusive: false,
    recoveryLoop: false,
    createdAt: Math.floor(Date.now() / 1000)
  };
}

/**
 * Poll the strike counter until `predicate` holds. Tracked alarm work is
 * classified after `alarm()` returns — up to the handler's ~5s delay later
 * for an attempt that was already running when the alarm found it — and the
 * breaker's isolate reset may interrupt the poll, which callers treat like
 * the reset surfacing from `runDurableObjectAlarm`.
 */
async function waitForStrikes(
  storage: DurableObjectStorage,
  predicate: (strikes: number | undefined) => boolean
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate(await storage.get<number>(OOM_STRIKES_KEY))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the alarm memory-limit breaker");
}

async function seedDoomedRun(
  name: string,
  runId: string,
  budget: number,
  definition: "oomLoop" | "oomStepLoop" | "lateOomStepLoop" = "oomLoop"
) {
  const stub = env.TaskHarnessObject.getByName(name);
  await runInDurableObject(stub, async (instance: TaskHarnessObject, state) => {
    await instance.lifecycle.start();
    await state.storage.put("oomLoopRemaining", budget);
    seedTaskRun(state.storage, {
      runId,
      definition,
      state: "pending",
      nextAt: Date.now() - 1_000
    });
    await instance.lifecycle.rearmAlarm();
  });
}

/** Fire the alarm and let the breaker's deferred isolate reset land. */
async function driveOomWake(name: string) {
  const stub = env.TaskHarnessObject.getByName(name);
  try {
    await runDurableObjectAlarm(stub);
  } catch (error) {
    // workerd may surface the intentional breaker reset to the test caller.
    // The durable strike/backoff writes landed before this reset was armed.
    if (
      !(error instanceof Error) ||
      !error.message.includes("Alarm memory-limit strike")
    ) {
      throw error;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

/** Backdate the run and its mirror wake so the next alarm drives it again. */
async function makeRunDue(name: string, runId: string) {
  const stub = env.TaskHarnessObject.getByName(name);
  await runInDurableObject(stub, async (instance: TaskHarnessObject, state) => {
    await instance.lifecycle.start();
    const past = Date.now() - 1_000;
    state.storage.sql.exec(
      "UPDATE cf_agents_task_runs SET next_at = ? WHERE run_id = ?",
      past,
      runId
    );
    state.storage.sql.exec(
      "UPDATE cf_agents_jobs SET time = ? WHERE id = ?",
      past,
      `task:${runId}`
    );
    await instance.lifecycle.rearmAlarm();
  });
}

async function readBreakerView(name: string, runId: string) {
  const stub = env.TaskHarnessObject.getByName(name);
  return runInDurableObject(
    stub,
    async (instance: TaskHarnessObject, state) => {
      // A fresh start runs Tasks' reconciliation — the exact path that
      // would resurrect a doomed run if the capability ignored the breaker.
      await instance.lifecycle.start();
      const run = state.storage.sql
        .exec(
          "SELECT state, next_at FROM cf_agents_task_runs WHERE run_id = ?",
          runId
        )
        .toArray()[0] as { state: string; next_at: number | null } | undefined;
      const wake = state.storage.sql
        .exec("SELECT time FROM cf_agents_jobs WHERE id = ?", `task:${runId}`)
        .toArray()[0] as { time: number } | undefined;
      const strikes = (await state.storage.get<number>(OOM_STRIKES_KEY)) ?? 0;
      const budget = (await state.storage.get<number>("oomLoopRemaining")) ?? 0;
      return { run, wake, strikes, budget };
    }
  );
}

describe("Tasks under the alarm memory-limit breaker (#1825)", () => {
  it("a strike demotes the doomed run to the backoff wake — reconciliation must not resurrect it", async () => {
    const name = `tasks-oom-strike-backoff-${crypto.randomUUID()}`;
    await seedDoomedRun(name, "oom-1", 5);

    await driveOomWake(name);

    const view = await readBreakerView(name, "oom-1");
    expect(view.strikes).toBe(1);
    expect(view.budget).toBe(4);
    // The run survives the strike but is parked past the breaker's ~30s
    // backoff — including after a fresh start's reconcile + wake re-mirror.
    expect(view.run?.state).not.toBe("failed");
    expect(view.run?.next_at ?? 0).toBeGreaterThan(Date.now() + 20_000);
    expect(view.wake?.time ?? 0).toBeGreaterThan(Date.now() + 20_000);
  });

  it("a platform failure inside step.do reaches the breaker without becoming a step retry", async () => {
    const name = `tasks-oom-step-strike-${crypto.randomUUID()}`;
    await seedDoomedRun(name, "oom-step-1", 5, "oomStepLoop");

    await driveOomWake(name);

    const view = await readBreakerView(name, "oom-step-1");
    expect(view.strikes).toBe(1);
    expect(view.budget).toBe(4);
    // The claim is stripped but the row stays `running`, so the backoff wake
    // reclaims it as an interrupted attempt with its step evidence intact.
    expect(view.run?.state).toBe("running");
    expect(view.run?.next_at ?? 0).toBeGreaterThan(Date.now() + 20_000);
    expect(view.wake?.time ?? 0).toBeGreaterThan(Date.now() + 20_000);
  });

  it("records one strike when several handoffs observe the same memory reset", async () => {
    const name = `tasks-twin-late-oom-${crypto.randomUUID()}`;
    const runId = "twin-late-oom";
    const stub = env.TaskHarnessObject.getByName(name);
    try {
      await runInDurableObject(
        stub,
        async (instance: TaskHarnessObject, state) => {
          await state.storage.put(OOM_STRIKES_KEY, 1);
          await state.storage.put("oomLoopRemaining", 1);
          await instance.tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
            "twinLateOom",
            undefined,
            { runId }
          );
          backdateTaskWake(state.storage, runId);
          await instance.lifecycle.rearmAlarm();
          await (instance as unknown as { alarm(): Promise<void> }).alarm();
          await waitForStrikes(state.storage, (strikes) => strikes !== 1);
        }
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("Alarm memory-limit strike")
      ) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Two observers of one reset: strike 1 -> 2, not -> 3 (which would seal
    // and terminally fail the run on a single reset).
    const view = await readBreakerView(name, runId);
    expect(view.strikes).toBe(2);
    expect(view.budget).toBe(0);
    expect(view.run?.state).toBe("running");
    expect(view.run?.next_at ?? 0).toBeGreaterThan(Date.now() + 20_000);
    expect(view.wake?.time ?? 0).toBeGreaterThan(Date.now() + 20_000);
  }, 15_000);

  it("preserves a strike through a clean sibling settling after it", async () => {
    const name = `tasks-oom-before-clean-sibling-${crypto.randomUUID()}`;
    const runId = "oom-before-clean-sibling";
    const stub = env.TaskHarnessObject.getByName(name);
    try {
      await runInDurableObject(
        stub,
        async (instance: TaskHarnessObject, state) => {
          await state.storage.put("oomLoopRemaining", 1);
          await instance.tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
            "oomBeforeCleanSibling",
            undefined,
            { runId }
          );
          backdateTaskWake(state.storage, runId);
          await instance.lifecycle.rearmAlarm();
          await (instance as unknown as { alarm(): Promise<void> }).alarm();
          await waitForStrikes(state.storage, (strikes) => strikes === 1);
          // The clean sibling settles ~2s after the strike — comfortably
          // after handleMemoryLimitReset's own awaited work (strike write,
          // onMemoryLimit, rearm, sync) has fully finished and removed the
          // OOM promise from the outstanding set — so if the bug is
          // present, the sibling's own settle finds the domain quiescent
          // and wrongly clears.
          await new Promise((resolve) => setTimeout(resolve, 2_500));
        }
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("Alarm memory-limit strike")
      ) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    const preserved = await readBreakerView(name, runId);
    expect(preserved.strikes).toBe(1);

    // A second, independent strike must build on the preserved count, not
    // restart at 1 — proving the first was never actually erased.
    await seedDoomedRun(name, "oom-before-clean-sibling-2", 5);
    await driveOomWake(name);
    const second = await readBreakerView(name, "oom-before-clean-sibling-2");
    expect(second.strikes).toBe(2);
  }, 15_000);

  it("keeps a queued attempt inside the alarm breaker after its bounded handoff", async () => {
    const name = `tasks-late-oom-backoff-${crypto.randomUUID()}`;
    const runId = "late-backoff";
    const stub = env.TaskHarnessObject.getByName(name);
    try {
      await runInDurableObject(
        stub,
        async (instance: TaskHarnessObject, state) => {
          await state.storage.put("oomLoopRemaining", 1);
          await instance.tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
            "lateOomStepLoop",
            undefined,
            { runId }
          );
          backdateTaskWake(state.storage, runId);
          await instance.lifecycle.rearmAlarm();
          await (instance as unknown as { alarm(): Promise<void> }).alarm();
          await waitForStrikes(state.storage, (strikes) => strikes === 1);
        }
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("Alarm memory-limit strike")
      ) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    const view = await readBreakerView(name, runId);
    expect(view.strikes).toBe(1);
    expect(view.budget).toBe(0);
    expect(view.run?.state).toBe("running");
    expect(view.run?.next_at ?? 0).toBeGreaterThan(Date.now() + 20_000);
    expect(view.wake?.time ?? 0).toBeGreaterThan(Date.now() + 20_000);
  }, 10_000);

  it("keeps a warm attempt inside the alarm breaker after handoff", async () => {
    const name = `tasks-warm-late-oom-${crypto.randomUUID()}`;
    const runId = "warm-late-oom";
    const stub = env.TaskHarnessObject.getByName(name);
    try {
      await runInDurableObject(
        stub,
        async (instance: TaskHarnessObject, state) => {
          await state.storage.put("oomLoopRemaining", 1);
          await instance.tasks.run("lateOomStepLoop", undefined, { runId });
          backdateTaskWake(state.storage, runId);
          await instance.lifecycle.rearmAlarm();
          await (instance as unknown as { alarm(): Promise<void> }).alarm();
          await waitForStrikes(state.storage, (strikes) => strikes === 1);
        }
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("Alarm memory-limit strike")
      ) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    const view = await readBreakerView(name, runId);
    expect(view.strikes).toBe(1);
    expect(view.budget).toBe(0);
    expect(view.run?.state).toBe("running");
    expect(view.run?.next_at ?? 0).toBeGreaterThan(Date.now() + 20_000);
  }, 15_000);

  it("clears stale strikes after all handed-off alarm work settles cleanly", async () => {
    const stub = env.TaskHarnessObject.getByName(
      `tasks-late-clean-${crypto.randomUUID()}`
    );
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await state.storage.put(OOM_STRIKES_KEY, 2);
        const receipt = await instance.tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
          "lateSuccess",
          undefined
        );
        backdateTaskWake(state.storage, receipt.runId);
        await instance.lifecycle.rearmAlarm();
        await (instance as unknown as { alarm(): Promise<void> }).alarm();

        // The alarm returned at the handoff with the attempt still running,
        // so the stale strikes must survive until that work settles clean.
        expect(await state.storage.get(OOM_STRIKES_KEY)).toBe(2);
        await waitForStrikes(state.storage, (strikes) => strikes === undefined);
        expect((await instance.tasks.get(receipt.runId))?.state).toBe(
          "completed"
        );
      }
    );
  }, 10_000);

  it("does not let a clean sibling hide another handed-off task's OOM", async () => {
    const name = `tasks-concurrent-late-oom-${crypto.randomUUID()}`;
    const doomedRunId = "concurrent-oom";
    const cleanRunId = "concurrent-clean";
    const stub = env.TaskHarnessObject.getByName(name);
    try {
      await runInDurableObject(
        stub,
        async (instance: TaskHarnessObject, state) => {
          await state.storage.put(OOM_STRIKES_KEY, 2);
          await state.storage.put("oomLoopRemaining", 1);
          await instance.tasks.run("alarmSiblingSuccess", undefined, {
            runId: cleanRunId
          });
          await instance.tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
            "lateOomStepLoop",
            undefined,
            { runId: doomedRunId }
          );
          const past = Date.now() - 1_000;
          state.storage.sql.exec(
            `UPDATE cf_agents_jobs SET time = ? WHERE id = ?`,
            past - 1,
            `task:${cleanRunId}`
          );
          state.storage.sql.exec(
            `UPDATE cf_agents_jobs SET time = ? WHERE id = ?`,
            past,
            `task:${doomedRunId}`
          );
          await instance.lifecycle.rearmAlarm();
          await (instance as unknown as { alarm(): Promise<void> }).alarm();
          await waitForStrikes(state.storage, (strikes) => strikes !== 2);
        }
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("Alarm memory-limit strike")
      ) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    const doomed = await readBreakerView(name, doomedRunId);
    expect(doomed.run?.state).toBe("failed");
    expect(doomed.wake).toBeUndefined();
    expect(doomed.strikes).toBe(0);
    // The breaker reset the isolate; the original stub is broken with it.
    await runInDurableObject(
      env.TaskHarnessObject.getByName(name),
      async (instance: TaskHarnessObject) => {
        expect((await instance.tasks.get(cleanRunId))?.state).toBe("completed");
      }
    );
  }, 15_000);

  it("a strike leaves other runs' deadlines untouched", async () => {
    const name = `tasks-oom-unrelated-${crypto.randomUUID()}`;
    const future = Date.now() + 60 * 60 * 1000;
    const stub = env.TaskHarnessObject.getByName(name);
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        await state.storage.put("oomLoopRemaining", 5);
        seedTaskRun(state.storage, {
          runId: "oom-executing",
          definition: "oomStepLoop",
          state: "pending",
          nextAt: Date.now() - 1_000
        });
        seedTaskRun(state.storage, {
          runId: "unrelated",
          definition: "checkpointing",
          state: "pending",
          nextAt: future
        });
        await instance.lifecycle.rearmAlarm();
      }
    );

    await driveOomWake(name);

    const struck = await readBreakerView(name, "oom-executing");
    expect(struck.strikes).toBe(1);
    expect(struck.run?.next_at ?? 0).toBeGreaterThan(Date.now() + 20_000);

    const unrelated = await readBreakerView(name, "unrelated");
    expect(unrelated.run).toEqual({ state: "pending", next_at: future });
    expect(unrelated.wake?.time).toBe(future);
  });

  it("ignores strikes attributed to another job owner", async () => {
    const name = `tasks-oom-foreign-strike-${crypto.randomUUID()}`;
    const runId = "foreign-strike";
    const past = Date.now() - 1_000;
    const stub = env.TaskHarnessObject.getByName(name);
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        seedTaskRun(state.storage, {
          runId,
          definition: "oomStepLoop",
          state: "pending",
          nextAt: past
        });
        await instance.tasks.onMemoryLimit({
          sealed: false,
          nextTime: Date.now() + 60_000,
          executing: {
            ...taskWakeJob("someone-elses"),
            id: "remind",
            capability: "scheduler",
            fn: "remind"
          }
        });
        const run = state.storage.sql
          .exec(
            "SELECT state, next_at FROM cf_agents_task_runs WHERE run_id = ?",
            runId
          )
          .toArray()[0];
        expect(run).toEqual({ state: "pending", next_at: past });
        await instance.tasks.cancel(runId);
      }
    );
  });

  it("sealing removes a non-retained recovery run, its journal, and its idempotency key", async () => {
    const name = `tasks-oom-non-retained-${crypto.randomUUID()}`;
    const runId = "oom-non-retained";
    const key = "recovery-key";
    const stub = env.TaskHarnessObject.getByName(name);
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        seedTaskRun(state.storage, {
          runId,
          definition: "oomStepLoop",
          state: "pending",
          nextAt: Date.now() - 1_000,
          retain: false,
          idempotencyKey: key
        });
        seedTaskStep(state.storage, {
          runId,
          name: "oom-step",
          kind: "do",
          state: "running",
          attempt: 1
        });
        await instance.tasks.onMemoryLimit({
          sealed: true,
          executing: taskWakeJob(runId)
        });

        const runs = state.storage.sql
          .exec(
            "SELECT run_id FROM cf_agents_task_runs WHERE run_id = ?",
            runId
          )
          .toArray();
        const steps = state.storage.sql
          .exec(
            "SELECT run_id FROM cf_agents_task_steps WHERE run_id = ?",
            runId
          )
          .toArray();
        const wakes = state.storage.sql
          .exec("SELECT id FROM cf_agents_jobs WHERE id = ?", `task:${runId}`)
          .toArray();
        expect(runs).toEqual([]);
        expect(steps).toEqual([]);
        expect(wakes).toEqual([]);

        const retried = await instance.tasks.run("oomStepLoop", undefined, {
          idempotencyKey: key
        });
        expect(retried.accepted).toBe(true);
      }
    );
  });

  it("backs off the queue row of the job that struck, not one an overlapping alarm invocation happened to finish", async () => {
    // A Scheduler job carries none of Tasks' own active-attempt tracking
    // (which would otherwise independently and correctly re-track a Task
    // run that a second overlapping alarm invocation re-dispatches,
    // masking a misattribution in JobDriver's own alarm-boundary
    // bookkeeping). This isolates JobDriver's attribution specifically.
    const name = `coexist-overlap-attribution-${crypto.randomUUID()}`;
    const stub = env.TaskSchedulerCoexistObject.getByName(name);
    let strikingJobId = "";
    try {
      await runInDurableObject(
        stub,
        async (instance: TaskSchedulerCoexistObject, state) => {
          await instance.lifecycle.start();
          await state.storage.put("oomLoopRemaining", 1);
          const schedule = await instance.scheduler.set(
            60,
            "slowOom",
            undefined
          );
          strikingJobId = schedule.id;
          // Mark it singleflight so a second overlapping alarm invocation's
          // own due-snapshot (which still includes this row — nothing
          // updates its queue-level `time` at claim time) skips it as
          // already running instead of racing a second, concurrent
          // dispatch of the very same job.
          state.storage.sql.exec(
            "UPDATE cf_agents_jobs SET time = ?, singleflight = 1 WHERE id = ?",
            Date.now() - 1_000,
            schedule.id
          );
          // Two genuinely overlapping alarm() invocations on the same
          // instance. The first claims the slow, striking scheduler job and
          // stays inside it for a full second. Shortly after, the second
          // skips that still-running row and dispatches a distinct, fast,
          // unrelated Task run entirely on its own — including reaching the
          // far end of #driveJob for that run — well before the first
          // observes the memory-limit reset. Attribution keyed off a shared
          // instance field would let the second invocation's own dispatch
          // clear it out from under the first.
          const overlapping = (
            instance as unknown as { alarm(): Promise<void> }
          ).alarm();
          await new Promise((resolve) => setTimeout(resolve, 100));
          await instance.tasks.__DO_NOT_USE_WILL_BREAK__enqueue("sleeper", {
            ms: 1
          });
          await (instance as unknown as { alarm(): Promise<void> }).alarm();
          await overlapping;
        }
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("Alarm memory-limit strike")
      ) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    await runInDurableObject(
      env.TaskSchedulerCoexistObject.getByName(name),
      async (_instance: TaskSchedulerCoexistObject, state) => {
        const row = state.storage.sql
          .exec("SELECT time FROM cf_agents_jobs WHERE id = ?", strikingJobId)
          .toArray()[0] as { time: number } | undefined;
        // Correctly attributed: the breaker backed off THIS job's queue row.
        // Misattribution (executing undefined, or the other job) would
        // leave it at its stale due time — hot-looping on the very next
        // alarm instead of backing off.
        expect(row?.time ?? 0).toBeGreaterThan(Date.now() + 20_000);
      }
    );
  }, 15_000);

  it("sealing at the strike budget terminally fails the run and ends the loop", async () => {
    const name = `tasks-oom-seal-${crypto.randomUUID()}`;
    await seedDoomedRun(name, "oom-2", 10);

    await driveOomWake(name);
    await makeRunDue(name, "oom-2");
    await driveOomWake(name);
    await makeRunDue(name, "oom-2");
    await driveOomWake(name);

    const view = await readBreakerView(name, "oom-2");
    // Sealed: the run is a persisted terminal failure, its wake is gone,
    // the strike counter reset, and the doomed handler stopped consuming
    // its budget — the loop is over, not limping on.
    expect(view.run?.state).toBe("failed");
    expect(view.wake).toBeUndefined();
    expect(view.strikes).toBe(0);
    expect(view.budget).toBe(7);

    // A later clean alarm cycle must not revive it.
    await driveOomWake(name);
    const after = await readBreakerView(name, "oom-2");
    expect(after.run?.state).toBe("failed");
    expect(after.budget).toBe(7);
  });
});
