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

  it("arm the report job during a reportWake report, and cancel it once the report returns", async () => {
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
          reportWake: true,
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

        // A reset inside the report would leave this job to deliver it.
        expect(jobsDuringReport).toEqual(["tasks:reports"]);
        expect(jobIds(state.storage)).toEqual([]);
        expect(reports).toBe(1);
      }
    );
  });
});
