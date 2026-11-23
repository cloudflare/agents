import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedTaskRun, type TaskHarnessObject } from "../capabilities/tasks";
import { TaskSettlement } from "../../tasks/settlement";

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

describe("Tasks park and settle", () => {
  const parking = "__cf_parking" as unknown as "pipeline";

  it("parks a run, holding its lane, until settle ends it; a second settle gets false", async () => {
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

        expect(await instance.tasks.settle("p", "done")).toBe(true);
        expect(await instance.tasks.settle("p", "again")).toBe(false);
        expect(await instance.tasks.get("p")).toMatchObject({
          status: "completed",
          result: "done"
        });
        await until(() => instance.lanedStarted.length === 1);
      }
    );
  });

  it("settles a run a reset left running, without another attempt", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        seedTaskRun(state.storage, {
          runId: "gone",
          definition: "laned",
          input: { label: "gone" },
          status: "running",
          generation: "dead-generation",
          attempt: 1,
          nextAt: Date.now() + 60_000
        });
        expect(
          await instance.tasks.settle("gone", TaskSettlement.aborted("stale"))
        ).toBe(true);
        expect(await instance.tasks.get("gone")).toMatchObject({
          status: "aborted",
          reason: "stale"
        });
        expect(instance.lanedStarted).toEqual([]);
      }
    );
  });
});

describe("Tasks reports after a reset", () => {
  it("delivers on start a terminal report a reset cut short", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.tasks.run(reported, undefined as never, {
          runId: "r",
          start: "now"
        });
        await until(() => instance.reports.includes("r:completed"));
        // As if the isolate died before `notified` was written.
        state.storage.sql.exec(
          "UPDATE cf_agents_task_runs SET notified = NULL WHERE run_id = 'r'"
        );
        instance.reports.length = 0;
        await (
          instance.tasks as unknown as { onStart(): Promise<void> }
        ).onStart();
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await until(() => instance.reports.includes("r:completed"));
      expect(instance.reports).toEqual(["r:completed"]);
    });
  });
});

describe("Tasks outcomes a run cannot keep as they are", () => {
  it("ends a run `error` when its result cannot be stored, and cuts a long error message", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await instance.tasks.run("unstorable", undefined, {
        runId: "u",
        start: "now"
      });
      expect(await instance.tasks.get("u")).toMatchObject({
        status: "error",
        error: { name: "TaskSerializationError" }
      });
      await instance.tasks.run("verbose", undefined, {
        runId: "v",
        start: "now"
      });
      const verbose = await instance.tasks.get("v");
      if (verbose?.status !== "error") throw new Error("unreachable");
      expect(verbose.error.message.length).toBe(10_001);
    });
  });
});

describe("Tasks input past one row", () => {
  it("keeps a framework run's large input in pieces, hands it whole to the handler, and deletes the pieces with the run", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        // 1.2 million code units, ending on a character outside the BMP so a
        // piece boundary could fall between the halves of its pair.
        const big = `${"a".repeat(499_999)}😀${"b".repeat(700_000)}`;
        await instance.tasks.run(
          "__cf_echo" as unknown as "pipeline",
          big as never,
          { runId: "big", retain: false, start: "now" }
        );
        expect(instance.tasks.inputOf("big")).toBeUndefined();
        const pieces = state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM cf_agents_task_parts")
          .one().n;
        expect(pieces).toBe(0);
        await instance.tasks.run(
          "__cf_echo" as unknown as "pipeline",
          big as never,
          { runId: "kept", start: "alarm" }
        );
        expect(instance.tasks.inputOf("kept")).toBe(big);
        expect(
          state.storage.sql
            .exec("SELECT COUNT(*) AS n FROM cf_agents_task_parts")
            .one().n
        ).toBe(3);
        await instance.tasks.cancel("kept");
        expect(instance.tasks.deleteRun("kept")).toBe(true);
        expect(
          state.storage.sql
            .exec("SELECT COUNT(*) AS n FROM cf_agents_task_parts")
            .one().n
        ).toBe(0);
      }
    );
  });

  it("hands a large input to the handler whole", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const big = "c".repeat(1_500_000);
      await instance.tasks.run(
        "__cf_echo" as unknown as "pipeline",
        big as never,
        { runId: "echo", start: "now" }
      );
      const record = instance.tasks.peek("echo");
      expect(record?.status).toBe("completed");
      expect(record?.result).toBe(1_500_000);
    });
  });
});

describe("Tasks terminal reports across a reset", () => {
  it("keeps a run's wake until its terminal report returned, and gives a run with none the report job", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const jobIds = () =>
          state.storage.sql
            .exec<{ id: string }>("SELECT id FROM cf_agents_jobs ORDER BY id")
            .toArray()
            .map((row) => row.id);
        let open!: () => void;
        instance.terminalReportGate = new Promise(
          (resolve) => (open = resolve)
        );
        instance.reportedGate = new Promise(() => {});

        // A run with a wake: cancelled while it waits to start.
        await instance.tasks.run(reported, undefined as never, {
          runId: "woken",
          start: "alarm"
        });
        expect(jobIds()).toContain("task:woken");
        const cancelled = instance.tasks.cancel("woken");
        await until(() => instance.reports.includes("woken:pending"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Aborted, its report under way: a reset now would find the wake.
        expect((await instance.tasks.get("woken"))?.status).toBe("aborted");
        expect(jobIds()).toContain("task:woken");
        open();
        await cancelled;
        expect(instance.reports).toContain("woken:aborted");
        expect(jobIds()).not.toContain("task:woken");
      }
    );
  });

  it("delivers the report a reset cut short when the kept wake comes due", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        // As a reset leaves it: aborted, unreported, its wake still there.
        await instance.tasks.run(reported, undefined as never, {
          runId: "cut",
          start: "alarm"
        });
        state.storage.sql.exec(
          "UPDATE cf_agents_task_runs SET status = 'aborted', next_at = NULL, settled_at = ? WHERE run_id = 'cut'",
          Date.now()
        );
        state.storage.sql.exec(
          "UPDATE cf_agents_jobs SET time = ? WHERE id = 'task:cut'",
          Date.now() - 1
        );
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      expect(instance.reports).toContain("cut:aborted");
      expect(instance.tasks.isSettled("cut")).toBe(true);
    });
  });

  it("gives a cancelled run queued in a lane the report job while its report runs", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        instance.reportedGate = new Promise(() => {});
        let open!: () => void;
        await instance.tasks.run(reported, undefined as never, {
          runId: "head",
          lane: "l",
          start: "alarm"
        });
        await instance.tasks.run(reported, undefined as never, {
          runId: "queued",
          lane: "l",
          start: "alarm"
        });
        instance.terminalReportGate = new Promise(
          (resolve) => (open = resolve)
        );
        const cancelled = instance.tasks.cancel("queued");
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(
          state.storage.sql
            .exec("SELECT id FROM cf_agents_jobs WHERE id = 'tasks:reports'")
            .toArray()
        ).toHaveLength(1);
        open();
        await cancelled;
        expect(instance.reports).toContain("queued:aborted");
      }
    );
  });

  it("replays more terminal reports than one batch holds", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        instance.failReports = 1;
        await instance.tasks.run(reported, undefined as never, {
          runId: "first",
          start: "now"
        });
        const now = Date.now();
        for (let i = 0; i < 120; i++) {
          state.storage.sql.exec(
            `INSERT INTO cf_agents_task_runs
               (run_id, definition, status, retain, attempt, cancel_requested,
                created_at, updated_at, settled_at)
             VALUES (?, '__cf_reported', 'skipped', 1, 0, 0, ?, ?, ?)`,
            `s${i}`,
            now,
            now,
            now + i
          );
        }
        state.storage.sql.exec(
          "UPDATE cf_agents_jobs SET time = ? WHERE id = 'tasks:reports'",
          now - 1
        );
      }
    );
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      expect(
        instance.reports.filter((entry) => entry.endsWith(":skipped"))
      ).toHaveLength(120);
      expect(instance.reports).toContain("first:completed");
    });
  });
});

describe("Tasks record reads for framework definitions", () => {
  it("lists pending runs by whether they are parked", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const parking = "__cf_parking" as unknown as "pipeline";
      await instance.tasks.run(parking, undefined as never, {
        runId: "parked",
        start: "now"
      });
      await instance.tasks.run(parking, undefined as never, {
        runId: "waiting",
        start: "alarm"
      });
      const ids = (parked: boolean) =>
        instance.tasks
          .peekList({
            definition: "__cf_parking",
            status: ["pending"],
            parked,
            limit: 1
          })
          .map((record) => record.runId);
      expect(ids(true)).toEqual(["parked"]);
      expect(ids(false)).toEqual(["waiting"]);
    });
  });

  it("imports a completed run with its result and metadata past 1 MiB", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const big = "m".repeat(1_200_000);
      expect(
        await instance.tasks.importRun({
          runId: "old",
          definition: "__cf_echo",
          status: "completed",
          attempt: 1,
          metadata: { big },
          result: { answer: 42 },
          createdAt: 1,
          settledAt: 2
        })
      ).toBe(true);
      const record = instance.tasks.peek("old");
      expect(record?.result).toEqual({ answer: 42 });
      expect(String(record?.metadata?.big).length).toBe(1_200_000);
      expect(
        instance.tasks.updateMetadata("old", (metadata) => ({
          ...metadata,
          more: true
        }))
      ).toBe(true);
    });
  });
});
