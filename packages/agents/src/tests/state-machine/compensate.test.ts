import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  backdateTaskWake,
  type TaskHarnessObject
} from "../capabilities/tasks";
import { captureDiagnosticsEvents } from "../shared/diagnostics-capture";
import type { TaskChange, TaskRunSnapshot, TaskValue } from "../../tasks";

/** Poll one run until it reaches one of the given states. */
async function waitForState(
  tasks: { get(runId: string): Promise<TaskRunSnapshot<TaskValue> | null> },
  runId: string,
  states: ReadonlyArray<TaskRunSnapshot<TaskValue>["state"]>,
  timeoutMs = 5_000
): Promise<TaskRunSnapshot<TaskValue>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await tasks.get(runId);
    if (snapshot && states.includes(snapshot.state)) return snapshot;
    if (Date.now() > deadline) {
      throw new Error(
        `Run ${runId} stuck in state "${snapshot?.state}" after ${timeoutMs}ms`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("per-effect compensate", () => {
  it("runs a parked job's compensations in reverse before settling a cancel", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("refundable", {});
      await waitForState(instance.tasks, receipt.runId, ["waiting"]);
      expect(instance.compensations).toEqual([]);
      const changes: TaskChange[] = [];
      const stop = instance.tasks.watch(receipt.runId, (change) =>
        changes.push(change)
      );
      expect(
        await instance.tasks.cancel(receipt.runId, "changed my mind")
      ).toBe(true);
      stop();
      // Terminal when cancel() resolves, compensations already run.
      expect((await instance.tasks.get(receipt.runId))?.state).toBe(
        "cancelled"
      );
      expect(instance.compensations).toEqual(["refund:42", "release"]);
      expect(changes.map((change) => change.type)).toEqual([
        "compensating",
        "progress",
        "progress",
        "settled"
      ]);
      // The replay that collected them executed no step again.
      expect(instance.stepRuns).toEqual([]);
    });
  });

  it("compensates a machine transition without onCancel the same way", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("refundableMachine");
      await waitForState(instance.tasks, receipt.runId, ["waiting"]);
      expect(await instance.tasks.cancel(receipt.runId)).toBe(true);
      expect((await instance.tasks.get(receipt.runId))?.state).toBe(
        "cancelled"
      );
      expect(instance.compensations).toEqual(["refund:42", "release"]);
    });
  });

  it("bounds a walk that awaits outside a step and still compensates", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("refundable", { hang: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await instance.tasks.get(receipt.runId))?.state).toBe("running");
      expect(
        await instance.tasks.cancel(receipt.runId, "stop", { wait: true })
      ).toBe(true);
      // The walk re-enters the same await; the harness step timeout (2 s)
      // bounds it, and the pass runs with what the walk collected.
      const settled = await waitForState(
        instance.tasks,
        receipt.runId,
        ["cancelled"],
        10_000
      );
      expect(settled.state).toBe("cancelled");
      expect(instance.compensations).toEqual(["refund:42", "release"]);
    });
  }, 15_000);

  it("compensates before a parked run fails at its deadline", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    let runId = "";
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run(
          "refundable",
          {},
          { deadline: Date.now() + 60_000 }
        );
        runId = receipt.runId;
        await waitForState(instance.tasks, runId, ["waiting"]);
        state.storage.sql.exec(
          "UPDATE cf_agents_task_runs SET deadline_at = ? WHERE run_id = ?",
          Date.now() - 1,
          runId
        );
        backdateTaskWake(state.storage, runId);
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const failed = await waitForState(instance.tasks, runId, ["failed"]);
      if (failed.state !== "failed") throw new Error("unreachable");
      expect(failed.error.name).toBe("StateMachineDeadlineExceededError");
      expect(instance.compensations).toEqual(["refund:42", "release"]);
      expect(instance.runErrorRuns).toEqual([
        {
          runId,
          definition: "refundable",
          name: "StateMachineDeadlineExceededError"
        }
      ]);
    });
  });

  it("records a failed compensation and runs the rest", async () => {
    const name = crypto.randomUUID();
    const stub = env.TaskHarnessObject.getByName(name);
    const capture = captureDiagnosticsEvents("agents:task", name);
    try {
      await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
        const receipt = await instance.tasks.run("refundable", {
          failRefund: true
        });
        await waitForState(instance.tasks, receipt.runId, ["waiting"]);
        expect(await instance.tasks.cancel(receipt.runId)).toBe(true);
        expect((await instance.tasks.get(receipt.runId))?.state).toBe(
          "cancelled"
        );
        expect(instance.compensations).toEqual(["release"]);
        const failed = capture.events.filter(
          (event) => event.type === "task:step:compensation-failed"
        );
        expect(failed.map((event) => event.payload)).toEqual([
          {
            runId: receipt.runId,
            definition: "refundable",
            step: "charge",
            error: "Error"
          }
        ]);
      });
    } finally {
      capture.stop();
    }
  });

  it("bounds a compensation by its step's timeout", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("refundable", {
        slowRefund: true
      });
      await waitForState(instance.tasks, receipt.runId, ["waiting"]);
      const started = Date.now();
      expect(await instance.tasks.cancel(receipt.runId)).toBe(true);
      expect(Date.now() - started).toBeLessThan(1_500);
      expect((await instance.tasks.get(receipt.runId))?.state).toBe(
        "cancelled"
      );
      expect(instance.compensations).toEqual(["release"]);
    });
  });

  it("does not repeat a compensation an earlier pass recorded", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run("refundable", {});
        await waitForState(instance.tasks, receipt.runId, ["waiting"]);
        // As a pass interrupted after "charge" would have left the journal.
        state.storage.sql.exec(
          `UPDATE cf_agents_task_journal SET compensated_at = ?
           WHERE run_id = ? AND name = 'charge'`,
          Date.now(),
          receipt.runId
        );
        expect(await instance.tasks.cancel(receipt.runId)).toBe(true);
        expect((await instance.tasks.get(receipt.runId))?.state).toBe(
          "cancelled"
        );
        expect(instance.compensations).toEqual(["release"]);
      }
    );
  });

  it("settles at once when nothing completed", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("napper", { ms: 60_000 });
      await waitForState(instance.tasks, receipt.runId, ["waiting"]);
      expect(await instance.tasks.cancel(receipt.runId)).toBe(true);
      expect((await instance.tasks.get(receipt.runId))?.state).toBe(
        "cancelled"
      );
      expect(instance.compensations).toEqual([]);
    });
  });
});
