import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedTaskRun, type TaskHarnessObject } from "../capabilities/tasks";

const attached = "__cf_test_attached" as unknown as "pipeline";

function jobIds(storage: DurableObjectStorage): string[] {
  return storage.sql
    .exec<{ id: string }>("SELECT id FROM cf_agents_jobs")
    .toArray()
    .map((row) => row.id);
}

describe("Tasks attached definitions", () => {
  it("arm no wake job for an attached run, and refuse any other start", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        let jobsDuringAttempt: string[] = [];
        instance.tasks.register(
          attached,
          async () => {
            jobsDuringAttempt = jobIds(state.storage);
            return "ok";
          },
          { attached: true }
        );

        await instance.tasks.run(attached, undefined as never, {
          runId: "a",
          start: "now"
        });

        expect(jobsDuringAttempt).toEqual([]);
        expect(jobIds(state.storage)).toEqual([]);
        expect(await state.storage.getAlarm()).toBeNull();
        expect(await instance.tasks.get("a")).toMatchObject({
          status: "completed",
          result: "ok"
        });
        await expect(
          instance.tasks.run(attached, undefined as never, { runId: "b" })
        ).rejects.toThrow('starts only with start: "now"');
      }
    );
  });

  it("wake an attempt a reset cut off on the next start", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const attempts: number[] = [];
        instance.tasks.register(
          attached,
          async (_input, step) => {
            attempts.push(step.attempt);
            return "recovered";
          },
          { attached: true }
        );
        seedTaskRun(state.storage, {
          runId: "cut",
          definition: attached,
          status: "running",
          generation: "dead-generation",
          attempt: 1,
          nextAt: Date.now() + 60_000
        });

        await instance.tasks.onStart();
        expect(jobIds(state.storage)).toContain("task:cut");
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      expect(await instance.tasks.get("cut")).toMatchObject({
        status: "completed",
        result: "recovered"
      });
    });
  });

  it("wake on the next start a run a reset cut off between its accept and its claim", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        instance.tasks.register(attached, async () => "late", {
          attached: true
        });
        // Accepted, never claimed, and no wake job: what a reset between
        // the two leaves.
        seedTaskRun(state.storage, {
          runId: "accepted",
          definition: attached,
          status: "pending",
          nextAt: Date.now()
        });
        state.storage.sql.exec("DELETE FROM cf_agents_jobs");

        await instance.tasks.onStart();
        expect(jobIds(state.storage)).toContain("task:accepted");
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      expect(await instance.tasks.get("accepted")).toMatchObject({
        status: "completed",
        result: "late"
      });
    });
  });

  it("keep the report job through an attached run's terminal report", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const reportName = "__cf_test_report_wake" as unknown as "pipeline";
        let jobsDuringReport: string[] = [];
        let reports = 0;
        instance.tasks.register(reportName, async () => "done", {
          attached: true,
          onStatus: async (record) => {
            if (record.status !== "completed") return;
            reports += 1;
            jobsDuringReport = jobIds(state.storage);
          }
        });

        await instance.tasks.run(reportName, undefined as never, {
          runId: "w",
          start: "now"
        });

        // A reset inside the report leaves this job to deliver it.
        expect(jobsDuringReport).toEqual(["tasks:reports"]);
        expect(reports).toBe(1);
      }
    );
  });

  it("do not start a terminal report twice when its job fires while it still runs", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const name = "__cf_test_long_report" as unknown as "pipeline";
        let open!: () => void;
        const gate = new Promise<void>((resolve) => (open = resolve));
        let reports = 0;
        instance.tasks.register(name, async () => "done", {
          attached: true,
          onStatus: async (record) => {
            if (record.status !== "completed") return;
            reports += 1;
            await gate;
          }
        });

        const running = instance.tasks.run(name, undefined as never, {
          runId: "long",
          start: "now"
        });
        for (let i = 0; i < 100 && reports === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        // The report job comes due while the report still runs.
        await instance.tasks.onJob({
          job: { id: "tasks:reports", fn: "reports" }
        } as never);
        expect(reports).toBe(1);
        expect(jobIds(state.storage)).toEqual(["tasks:reports"]);

        open();
        await running;
        expect(reports).toBe(1);
      }
    );
  });

  it("deliver the reports after one that keeps failing", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const stuck = "__cf_test_stuck_report" as unknown as "pipeline";
        const fine = "__cf_test_fine_report" as unknown as "pipeline";
        const delivered: string[] = [];
        instance.tasks.register(stuck, async () => "x", {
          attached: true,
          onStatus: (record) => {
            if (record.status === "completed") throw new Error("not yet");
          }
        });
        instance.tasks.register(fine, async () => "x", {
          attached: true,
          onStatus: (record) => {
            if (record.status === "completed") delivered.push(record.runId);
          }
        });
        const now = Date.now();
        for (const [runId, definition, settledAt] of [
          ["first", stuck, now - 2],
          ["second", fine, now - 1]
        ] as const) {
          await instance.tasks.importRun({
            runId,
            definition,
            status: "completed",
            attempt: 1,
            createdAt: settledAt,
            settledAt
          });
        }
        state.storage.sql.exec(
          "UPDATE cf_agents_task_runs SET notified = NULL"
        );

        await instance.tasks.onJob({
          job: { id: "tasks:reports", fn: "reports" }
        } as never);

        expect(delivered).toEqual(["second"]);
        expect(jobIds(state.storage)).toContain("tasks:reports");
      }
    );
  });
});
