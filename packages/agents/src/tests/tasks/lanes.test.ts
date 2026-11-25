import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
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

  it("lists one lane's runs, open and settled", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const first = gate();
      instance.lanedGates.set("a", first.promise);
      for (const [runId, lane] of [
        ["a", "l"],
        ["b", "l"],
        ["c", "other"]
      ] as const) {
        await instance.tasks.run("laned", { label: runId }, { runId, lane });
      }
      await until(
        async () => (await instance.tasks.get("c"))?.status === "completed"
      );
      const listed = (
        lane: string,
        status?: ("pending" | "running" | "completed")[]
      ) =>
        instance.tasks
          .peekList({
            definition: "laned",
            lane,
            order: "oldest",
            ...(status && { status })
          })
          .map((record) => record.runId);
      expect(listed("l")).toEqual(["a", "b"]);
      expect(listed("other")).toEqual(["c"]);
      expect(listed("l", ["pending"])).toEqual(["b"]);
      first.open();
      await until(
        async () => (await instance.tasks.get("b"))?.status === "completed"
      );
      expect(listed("l", ["completed"])).toEqual(["a", "b"]);
    });
  });

  it("hands a queued run its caller's local when it starts here, and tells a local no attempt took", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await instance.lifecycle.start();
      const first = gate();
      instance.lanedGates.set("a", first.promise);
      let dropped = 0;
      const lane = { lane: "l" } as const;
      await instance.tasks.run(
        "laned",
        { label: "a" },
        { ...lane, local: "A" }
      );
      await instance.tasks.run(
        "laned",
        { label: "b" },
        { ...lane, local: "B" }
      );
      await instance.tasks.run(
        "laned",
        { label: "c" },
        { ...lane, runId: "c", local: { dropped: () => dropped++ } }
      );
      await until(() => instance.lanedStarted.length === 1);
      // c ends before an attempt took its local: it is told, once.
      await instance.tasks.cancel("c");
      expect(dropped).toBe(1);
      first.open();
      await until(() => instance.lanedStarted.length === 2);
      // b started here as a settled, with the local its caller passed.
      expect(instance.lanedLocals).toEqual(["A", "B"]);
      await until(
        async () =>
          (await instance.tasks.list({ status: ["pending", "running"] }))
            .length === 0
      );
      expect(dropped).toBe(1);
    });
  });

  it("moves the lane on when a dropped local throws", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await instance.lifecycle.start();
      const first = gate();
      instance.lanedGates.set("a", first.promise);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const lane = { lane: "l" } as const;
      await instance.tasks.run(
        "laned",
        { label: "a" },
        { ...lane, local: "A" }
      );
      await instance.tasks.run(
        "laned",
        { label: "b" },
        {
          ...lane,
          runId: "b",
          local: {
            dropped: () => {
              throw new Error("dropped threw");
            }
          }
        }
      );
      await instance.tasks.run(
        "laned",
        { label: "c" },
        { ...lane, local: "C" }
      );
      await until(() => instance.lanedStarted.length === 1);
      await instance.tasks.cancel("b");
      first.open();
      await until(() => instance.lanedStarted.length === 2);
      expect(instance.lanedStarted).toEqual(["a", "c"]);
      error.mockRestore();
    });
  });

  it("moves the lane on when the cancelled head's dropped local throws", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await instance.lifecycle.start();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      // Held, so the head keeps its local until it is cancelled.
      instance.tasks.holdLane("l");
      const lane = { lane: "l" } as const;
      await instance.tasks.run(
        "laned",
        { label: "b" },
        {
          ...lane,
          runId: "b",
          local: {
            dropped: () => {
              throw new Error("dropped threw");
            }
          }
        }
      );
      await instance.tasks.run(
        "laned",
        { label: "c" },
        { ...lane, local: "C" }
      );
      await instance.tasks.cancel("b");
      await instance.tasks.releaseLane("l");
      await until(() => instance.lanedStarted.length === 1);
      expect(instance.lanedStarted).toEqual(["c"]);
      expect(instance.lanedLocals).toEqual(["C"]);
      error.mockRestore();
    });
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

describe("Tasks clear and the checkpoint", () => {
  it("keeps the checkpoint of a definition that keeps it, and clears the rest", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        // Registered here, not by the harness: the other tests keep the
        // plain clear (no definition keeps its checkpoint).
        instance.tasks.register("__cf_kept", async () => "kept", {
          keepCheckpoint: true
        });
        await instance.tasks.get("warm");
        const now = Date.now();
        for (const [runId, definition, seq] of [
          ["kept", "__cf_kept", 1],
          ["plain", "__cf_echo", 2]
        ] as const) {
          state.storage.sql.exec(
            `INSERT INTO cf_agents_task_runs
               (run_id, definition, status, retain, attempt, cancel_requested,
                created_at, updated_at, lane, seq, checkpoint)
             VALUES (?, ?, 'pending', 1, 0, 0, ?, ?, 'l', ?, ?)`,
            runId,
            definition,
            now,
            now,
            seq,
            JSON.stringify({ note: runId })
          );
        }
        await instance.tasks.clear("l", "stop");
        const rows = Object.fromEntries(
          state.storage.sql
            .exec<{
              run_id: string;
              status: string;
              checkpoint: string | null;
            }>(
              "SELECT run_id, status, checkpoint FROM cf_agents_task_runs WHERE lane = 'l'"
            )
            .toArray()
            .map((row) => [row.run_id, row])
        );
        expect(rows.kept).toMatchObject({ status: "skipped" });
        expect(JSON.parse(rows.kept.checkpoint!)).toEqual({ note: "kept" });
        expect(rows.plain).toMatchObject({
          status: "skipped",
          checkpoint: null
        });
      }
    );
  });
});
