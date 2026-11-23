import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedTaskRun, type TaskHarnessObject } from "../capabilities/tasks";

const reported = "__cf_reported" as unknown as "pipeline";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

describe("Tasks reports, wait and the attempt cap", () => {
  it("reports pending, running and the terminal status, and wait resolves after the terminal report", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      let open!: () => void;
      instance.reportedGate = new Promise((resolve) => (open = resolve));
      await instance.tasks.run(reported, undefined as never, {
        runId: "r",
        retain: false
      });
      const waited = instance.tasks.wait("r");
      await until(() => instance.reports.length === 2);
      expect(instance.reports).toEqual(["r:pending", "r:running"]);
      open();
      const snapshot = await waited;
      expect(snapshot).toMatchObject({ status: "completed", result: "ok" });
      expect(instance.reports).toEqual([
        "r:pending",
        "r:running",
        "r:completed"
      ]);
      // retain: false removes the run once its terminal report returned.
      expect(await instance.tasks.get("r")).toBeNull();
      expect(await instance.tasks.wait("r", { timeoutMs: 1 })).toBeNull();
    });
  });

  it("delivers a terminal report whose onStatus threw again, and holds the run until then", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        instance.failReports = 1;
        await instance.tasks.run(reported, undefined as never, {
          runId: "r",
          retain: false
        });
        await until(
          async () => (await instance.tasks.get("r"))?.status === "completed"
        );
        expect(instance.reports).not.toContain("r:completed");
        // The retry job is due in 30 s; bring it forward.
        state.storage.sql.exec(
          "UPDATE cf_agents_jobs SET time = ? WHERE id = 'tasks:reports'",
          Date.now() - 1
        );
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await until(() => instance.reports.includes("r:completed"));
      expect(await instance.tasks.get("r")).toBeNull();
    });
  });

  it("ends a run `error` once its attempts are spent, without starting another", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        // Two attempts already ran and were cut off.
        seedTaskRun(state.storage, {
          runId: "r",
          definition: "__cf_reported",
          status: "running",
          generation: "dead-generation",
          attempt: 2,
          nextAt: Date.now() - 1000
        });
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await until(
        async () => (await instance.tasks.get("r"))?.status === "error"
      );
      expect(await instance.tasks.get("r")).toMatchObject({
        status: "error",
        error: { name: "TaskInterruptedError", message: "Interrupted 2 times" }
      });
      expect(instance.reports).toEqual(["r:error"]);
    });
  });
});

describe("Tasks park and release", () => {
  const parking = "__cf_parking" as unknown as "pipeline";

  it("parks a run until release hands its next attempt a value; a second release gets false", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.tasks.run(parking, undefined as never, {
          runId: "p",
          lane: "l",
          start: "now"
        });
        await instance.tasks.run("laned", { label: "behind" }, { lane: "l" });
        expect(await instance.tasks.get("p")).toMatchObject({
          status: "pending",
          waitReason: "park"
        });
        // Parked: no deadline, no job, and its lane waits behind it.
        expect(
          state.storage.sql
            .exec("SELECT id FROM cf_agents_jobs WHERE id = 'task:p'")
            .toArray()
        ).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(instance.lanedStarted).toEqual([]);

        expect(await instance.tasks.release("p", { value: "done" })).toBe(true);
        expect(await instance.tasks.release("p", { value: "again" })).toBe(
          false
        );
        await until(
          async () => (await instance.tasks.get("p"))?.status === "completed"
        );
        expect(await instance.tasks.get("p")).toMatchObject({
          result: "done"
        });
        await until(() => instance.lanedStarted.length === 1);
      }
    );
  });
});
