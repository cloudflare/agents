import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedTaskRun, type TaskHarnessObject } from "../capabilities/tasks";

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

const jobFor = (storage: DurableObjectStorage, runId: string) =>
  storage.sql
    .exec("SELECT id FROM cf_agents_jobs WHERE id = ?", `task:${runId}`)
    .toArray().length;

describe("Tasks lanes", () => {
  it("runs a lane's runs one at a time in arrival order; a queued run holds no deadline or job", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const first = gate();
        instance.lanedGates.set("a", first.promise);
        await instance.tasks.run(
          "laned",
          { label: "a" },
          { runId: "a", lane: "l" }
        );
        await instance.tasks.run(
          "laned",
          { label: "b" },
          { runId: "b", lane: "l" }
        );
        await instance.tasks.run(
          "laned",
          { label: "c" },
          { runId: "c", lane: "other" }
        );
        await until(() => instance.lanedStarted.length === 2);
        // Another lane is not held up; b waits behind a.
        expect(instance.lanedStarted).toEqual(["a", "c"]);
        const queued = state.storage.sql
          .exec("SELECT next_at FROM cf_agents_task_runs WHERE run_id = 'b'")
          .one();
        expect(queued.next_at).toBeNull();
        expect(jobFor(state.storage, "b")).toBe(0);

        first.open();
        await until(
          async () => (await instance.tasks.get("b"))?.status === "completed"
        );
        expect(instance.lanedStarted).toEqual(["a", "c", "b"]);
      }
    );
  });

  it("starts nothing in a held lane until it is released", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await instance.lifecycle.start();
      instance.tasks.holdLane("l");
      await instance.tasks.run(
        "laned",
        { label: "a" },
        { runId: "a", lane: "l" }
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(instance.lanedStarted).toEqual([]);
      await instance.tasks.releaseLane("l");
      await until(
        async () => (await instance.tasks.get("a"))?.status === "completed"
      );
      expect(instance.lanedStarted).toEqual(["a"]);
    });
  });

  it("re-runs a lane's interrupted run before the runs queued behind it", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        // a was running in an isolate that is gone; b was queued behind it.
        seedTaskRun(state.storage, {
          runId: "a",
          definition: "laned",
          input: { label: "a" },
          status: "running",
          generation: "dead-generation",
          attempt: 1,
          nextAt: Date.now() - 1000
        });
        state.storage.sql.exec(
          "UPDATE cf_agents_task_runs SET lane = 'l', seq = 1 WHERE run_id = 'a'"
        );
        await instance.tasks.run(
          "laned",
          { label: "b" },
          { runId: "b", lane: "l" }
        );
        expect(
          state.storage.sql
            .exec("SELECT seq FROM cf_agents_task_runs WHERE run_id = 'b'")
            .one().seq
        ).toBe(2);
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await until(
        async () => (await instance.tasks.get("b"))?.status === "completed"
      );
      expect(instance.lanedStarted).toEqual(["a", "b"]);
    });
  });

  it("clears a lane: its running and queued runs end skipped, and the running attempt's later writes are dropped", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const first = gate();
      instance.lanedGates.set("a", first.promise);
      await instance.tasks.run(
        "laned",
        { label: "a" },
        { runId: "a", lane: "l" }
      );
      await instance.tasks.run(
        "laned",
        { label: "b" },
        { runId: "b", lane: "l" }
      );
      await until(() => instance.lanedStarted.length === 1);
      const clearing = instance.tasks.clear("l", "reset");
      // Written before the first await.
      expect((await instance.tasks.get("a"))?.status).toBe("skipped");
      await clearing;
      expect(await instance.tasks.get("b")).toMatchObject({
        status: "skipped",
        reason: "reset"
      });
      first.open();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect((await instance.tasks.get("a"))?.status).toBe("skipped");
      expect(instance.lanedStarted).toEqual(["a"]);
    });
  });
});
