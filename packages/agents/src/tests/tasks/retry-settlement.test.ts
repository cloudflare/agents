import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TaskSettlement } from "../../tasks/settlement";
import type { TaskHarnessObject } from "../capabilities/tasks";

const retrying = "__cf_test_retrying" as unknown as "pipeline";

type Row = { status: string; wait_reason: string | null; next_at: number };

function runRow(storage: DurableObjectStorage, runId: string): Row {
  return storage.sql
    .exec<Row>(
      "SELECT status, wait_reason, next_at FROM cf_agents_task_runs WHERE run_id = ?",
      runId
    )
    .one();
}

describe("Tasks retry settlement", () => {
  it("waits until the time it names, then runs the next attempt", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    const at = Date.now() + 200;
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const attempts: number[] = [];
        instance.tasks.register(retrying, async (_input, step) => {
          attempts.push(step.attempt);
          return step.attempt === 1 ? TaskSettlement.retry(at) : "done";
        });
        await instance.tasks.run(retrying, undefined as never, {
          runId: "r",
          start: "now"
        });

        expect(attempts).toEqual([1]);
        expect(runRow(state.storage, "r")).toEqual({
          status: "pending",
          wait_reason: "retry",
          next_at: at
        });
        expect(await state.storage.getAlarm()).toBe(at);
        expect(
          state.storage.sql
            .exec("SELECT 1 FROM cf_agents_task_steps WHERE run_id = 'r'")
            .toArray()
        ).toEqual([]);
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      expect(await instance.tasks.get("r")).toMatchObject({
        status: "completed",
        result: "done"
      });
    });
  });

  it("ends a run that waits to retry when it is cancelled", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await instance.lifecycle.start();
      instance.tasks.register(retrying, async () =>
        TaskSettlement.retry(Date.now() + 60_000)
      );
      await instance.tasks.run(retrying, undefined as never, {
        runId: "c",
        start: "now"
      });

      expect(await instance.tasks.cancel("c", "gone")).toBe(true);
      expect(await instance.tasks.get("c")).toMatchObject({
        status: "aborted",
        reason: "gone"
      });
    });
  });

  it("runs a parked run again, with its checkpoint, when settled with a retry", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await instance.lifecycle.start();
      const seen: unknown[] = [];
      instance.tasks.register(retrying, async (_input, step) => {
        const outcome = step.checkpoint.get("outcome");
        seen.push(outcome);
        return outcome === undefined ? TaskSettlement.park("outcome") : outcome;
      });
      await instance.tasks.run(retrying, undefined as never, {
        runId: "p",
        start: "now"
      });
      expect(instance.tasks.peek("p")).toMatchObject({
        status: "pending",
        waitReason: "park"
      });

      const settle = () =>
        instance.tasks.settle("p", TaskSettlement.retry(Date.now()), {
          checkpoint: { outcome: "posted" }
        });
      const [first, second] = await Promise.all([settle(), settle()]);
      expect([first, second].sort()).toEqual([false, true]);
      await instance.tasks.runDue(retrying);

      expect(seen).toEqual([undefined, "posted"]);
      expect(await instance.tasks.get("p")).toMatchObject({
        status: "completed",
        result: "posted"
      });
    });
  });
});
