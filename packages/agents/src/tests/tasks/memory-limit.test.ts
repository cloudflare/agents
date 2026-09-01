import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedTaskRun, type TaskHarnessObject } from "../capabilities/tasks";

/**
 * Alarm memory-limit breaker (#1825) applied to Tasks runs.
 *
 * A task whose attempt deterministically exhausts memory must be contained
 * by the breaker like any other alarm-driven work: backed off between
 * strikes and terminally failed at the strike budget. The hazard specific
 * to Tasks is resurrection — the run row is the durable source of truth,
 * and startup reconciliation re-mirrors interrupted runs as due-now wakes,
 * which would defeat the breaker's queue-row backoff and outlive its seal
 * unless the capability participates in the breaker itself.
 */

const OOM_STRIKES_KEY = "cf_agents:oom_alarm_strikes";

async function seedDoomedRun(
  name: string,
  runId: string,
  budget: number,
  definition: "oomLoop" | "oomStepLoop" = "oomLoop"
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
  await runDurableObjectAlarm(stub);
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
    const name = "tasks-oom-strike-backoff";
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
    expect(view.run?.state).toBe("pending");
    expect(view.run?.next_at ?? 0).toBeGreaterThan(Date.now() + 20_000);
    expect(view.wake?.time ?? 0).toBeGreaterThan(Date.now() + 20_000);
  });

  it("backs off sibling runs of the striking definition without rewriting unrelated run deadlines", async () => {
    const name = `tasks-oom-definition-group-${crypto.randomUUID()}`;
    const past = Date.now() - 1_000;
    const future = Date.now() + 60 * 60 * 1000;
    const stub = env.TaskHarnessObject.getByName(name);
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        await state.storage.put("oomLoopRemaining", 5);
        seedTaskRun(state.storage, {
          runId: "oom-group-executing",
          definition: "oomStepLoop",
          state: "pending",
          nextAt: past,
          recoveryLoop: true
        });
        seedTaskRun(state.storage, {
          runId: "oom-group-sibling",
          definition: "oomStepLoop",
          state: "pending",
          nextAt: past,
          recoveryLoop: true
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

    const sibling = await readBreakerView(name, "oom-group-sibling");
    expect(sibling.run?.state).toBe("pending");
    expect(sibling.run?.next_at ?? 0).toBeGreaterThan(Date.now() + 20_000);
    expect(sibling.wake?.time ?? 0).toBeGreaterThan(Date.now() + 20_000);

    const unrelated = await readBreakerView(name, "unrelated");
    expect(unrelated.run).toEqual({ state: "pending", next_at: future });
    expect(unrelated.wake?.time).toBe(future);
  });

  it("backs off flagged Task definitions when another job owner struck", async () => {
    const name = `tasks-oom-foreign-strike-${crypto.randomUUID()}`;
    const runId = "flagged-foreign-strike";
    const stub = env.TaskHarnessObject.getByName(name);
    const nextTime = Date.now() + 60_000;
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        seedTaskRun(state.storage, {
          runId,
          definition: "oomStepLoop",
          state: "pending",
          nextAt: Date.now() - 1_000,
          recoveryLoop: true
        });
        await instance.tasks.onMemoryLimit({ sealed: false, nextTime });
      }
    );

    const view = await readBreakerView(name, runId);
    expect(view.run).toEqual({ state: "pending", next_at: nextTime });
    expect(view.wake?.time).toBe(nextTime);
  });

  it("sealing at the strike budget terminally fails the run and ends the loop", async () => {
    const name = "tasks-oom-seal";
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
