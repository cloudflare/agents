import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  backdateTaskWake,
  versionedV1,
  type TaskHarnessObject,
  type VersionedState
} from "../capabilities/tasks";
import type {
  TaskDefinitions,
  TaskMachine,
  TaskRunSnapshot,
  Tasks,
  TaskValue
} from "../../tasks";

/** The harness's Tasks, typed for the names its dynamic resolver supplies. */
function dynamicTasks(instance: TaskHarnessObject): Tasks<TaskDefinitions> {
  return instance.tasks as unknown as Tasks<TaskDefinitions>;
}

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

type RunColumns = {
  checkpoint: string | null;
  checkpoint_turn: number;
  transitions: number;
  stall: number;
  outcome: string | null;
  attempt: number;
  definition: string;
  wait_reason: string | null;
  paused: number;
};

function columns(storage: DurableObjectStorage, runId: string): RunColumns {
  return storage.sql
    .exec<RunColumns>(
      `SELECT checkpoint, checkpoint_turn, transitions, stall, outcome, attempt,
              definition, wait_reason, paused
       FROM cf_agents_task_runs WHERE run_id = ?`,
      runId
    )
    .one();
}

function journalRows(storage: DurableObjectStorage, runId: string): number {
  return storage.sql
    .exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cf_agents_task_journal WHERE run_id = ?",
      runId
    )
    .one().n;
}

describe("the turn loop", () => {
  it("drives a machine through its transitions in one invocation and settles on its terminal", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run("counter", { from: 0 });
        const snapshot = await waitForState(instance.tasks, receipt.runId, [
          "completed"
        ]);
        if (snapshot.state !== "completed") throw new Error("unreachable");
        expect(snapshot.result).toBe(3);
        // `initial` committed at turn 0, then one commit per transition.
        const row = columns(state.storage, receipt.runId);
        expect(row.checkpoint_turn).toBe(3);
        expect(row.transitions).toBe(3);
        expect(row.attempt).toBe(1);
        expect(JSON.parse(row.checkpoint ?? "null")).toEqual({
          phase: "counting",
          value: 3
        });
      }
    );
  });

  it("faults a machine that makes no progress and keeps its row at retain:false (Rule A)", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run("stuck", undefined, {
          retain: false
        });
        const snapshot = await waitForState(instance.tasks, receipt.runId, [
          "failed"
        ]);
        if (snapshot.state !== "failed") throw new Error("unreachable");
        expect(snapshot.error.name).toBe("StateMachineNoProgressError");
        expect(snapshot.outcome).toBe("faulted");
        expect(columns(state.storage, receipt.runId).outcome).toBe("faulted");
        expect(instance.runErrorRuns).toContainEqual({
          runId: receipt.runId,
          definition: "stuck",
          name: "StateMachineNoProgressError"
        });
      }
    );
  });

  it("faults a machine that spins past its transition budget (Rule B)", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("spinner");
      const snapshot = await waitForState(
        instance.tasks,
        receipt.runId,
        ["failed"],
        20_000
      );
      if (snapshot.state !== "failed") throw new Error("unreachable");
      expect(snapshot.error.name).toBe("StateMachineTransitionBudgetError");
      expect(snapshot.error.message).toContain("spin");
      expect(snapshot.outcome).toBe("faulted");
    });
  }, 30_000);

  it("parks a machine on a sleep at the same turn, then resumes and retires the turn's journal", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    let runId = "";
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run("napper", { ms: 60_000 });
        runId = receipt.runId;
        const parked = await waitForState(instance.tasks, runId, ["waiting"]);
        if (parked.state !== "waiting") throw new Error("unreachable");
        expect(parked.reason).toBe("sleep");
        const row = columns(state.storage, runId);
        expect(row.checkpoint_turn).toBe(0);
        expect(JSON.parse(row.checkpoint ?? "null")).toEqual({
          phase: "nap",
          ms: 60_000
        });
        expect(journalRows(state.storage, runId)).toBe(1);
        backdateTaskWake(state.storage, runId, "rest");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const done = await waitForState(instance.tasks, runId, ["completed"]);
        if (done.state !== "completed") throw new Error("unreachable");
        expect(done.result).toBe("rested");
        expect(columns(state.storage, runId).checkpoint_turn).toBe(1);
        expect(journalRows(state.storage, runId)).toBe(0);
      }
    );
  });
  it("completes a phase whose only progress is a memo", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("memoist");
      const snapshot = await waitForState(instance.tasks, receipt.runId, [
        "completed"
      ]);
      if (snapshot.state !== "completed") throw new Error("unreachable");
      expect(snapshot.result).toBe("t-0");
    });
  });
});

describe("the abort protocol", () => {
  it("runs onCancel in a fresh invocation and settles on its terminal", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run("guardedMachine", {
          decline: false
        });
        await waitForState(instance.tasks, receipt.runId, ["waiting"]);
        expect(
          await instance.tasks.cancel(receipt.runId, "stop", { wait: true })
        ).toBe(true);
        const snapshot = await instance.tasks.get(receipt.runId);
        expect(snapshot?.state).toBe("cancelled");
        expect(instance.cancelLog).toEqual(["hold:cancel"]);
        // A fresh claim, not the parked one's.
        expect(columns(state.storage, receipt.runId).attempt).toBe(2);
        expect(await instance.tasks.cancel(receipt.runId)).toBe(false);
      }
    );
  });

  it("lets onCancel decline by returning a checkpoint, clearing the mark", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("guardedMachine", {
        decline: true
      });
      await waitForState(instance.tasks, receipt.runId, ["waiting"]);
      expect(
        await instance.tasks.cancel(receipt.runId, "stop", { wait: true })
      ).toBe(true);
      const snapshot = await waitForState(instance.tasks, receipt.runId, [
        "completed"
      ]);
      if (snapshot.state !== "completed") throw new Error("unreachable");
      expect(snapshot.result).toBe(1);
      expect(instance.cancelLog).toEqual(["hold:cancel"]);
    });
  });

  it("terminate settles without running onCancel", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("guardedMachine", {
        decline: true
      });
      await waitForState(instance.tasks, receipt.runId, ["waiting"]);
      expect(await instance.tasks.terminate(receipt.runId, "now")).toBe(true);
      const snapshot = await instance.tasks.get(receipt.runId);
      expect(snapshot?.state).toBe("cancelled");
      expect(instance.cancelLog).toEqual([]);
      expect(await instance.tasks.terminate(receipt.runId)).toBe(false);
    });
  });

  it("takes the inline default for a machine without onCancel", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("napper", { ms: 60_000 });
      await waitForState(instance.tasks, receipt.runId, ["waiting"]);
      expect(await instance.tasks.cancel(receipt.runId, "bye")).toBe(true);
      const snapshot = await instance.tasks.get(receipt.runId);
      expect(snapshot?.state).toBe("cancelled");
    });
  });

  it("enforces the turn watchdog on a transition that never returns", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("hung", undefined, {
        turnTimeout: 100
      });
      const snapshot = await waitForState(
        instance.tasks,
        receipt.runId,
        ["failed"],
        10_000
      );
      if (snapshot.state !== "failed") throw new Error("unreachable");
      expect(snapshot.error.name).toBe("StateMachineTurnDeadlineExceededError");
    });
  }, 15_000);
});

describe("pause and resume", () => {
  it("holds a parked run through its wake and resumes it", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    let runId = "";
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run("napper", { ms: 60_000 });
        runId = receipt.runId;
        await waitForState(instance.tasks, runId, ["waiting"]);
        expect(await instance.tasks.pause(runId)).toBe(true);
        expect(await instance.tasks.pause(runId)).toBe(false);
        const paused = await instance.tasks.get(runId);
        expect(paused?.state).toBe("waiting");
        if (paused?.state === "waiting") {
          expect(paused.reason).toBe("paused");
        }
        // The sleep's wake passes; a paused run is not dispatched.
        backdateTaskWake(state.storage, runId, "rest");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      expect((await instance.tasks.get(runId))?.state).toBe("waiting");
      expect(await instance.tasks.resume(runId)).toBe(true);
      expect(await instance.tasks.resume(runId)).toBe(false);
      const done = await waitForState(instance.tasks, runId, ["completed"]);
      if (done.state !== "completed") throw new Error("unreachable");
      expect(done.result).toBe("rested");
    });
  });
});

describe("versioning", () => {
  const versionedV2 = {
    initial: { phase: "two", n: 0, migrated: false } as VersionedState,
    phases: {
      one: async (state, ctx) => ctx.complete(state.n),
      two: async (state, ctx) => ctx.complete(state.n)
    },
    migrate: (checkpoint, fromVersion) => ({
      state: {
        phase: "two",
        n: (checkpoint as { n: number }).n * 10 + fromVersion,
        migrated: true
      } as VersionedState
    })
  } satisfies TaskMachine<VersionedState, never, number>;

  it("adopts a parked run into a newer version through migrate", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    let runId = "";
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await dynamicTasks(instance).run("versioned@v1");
        runId = receipt.runId;
        await waitForState(instance.tasks, runId, ["waiting"]);
        delete instance.dynamic["versioned@v1"];
        instance.dynamic["versioned@v2"] = versionedV2;
        backdateTaskWake(state.storage, runId, "wait");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const snapshot = await waitForState(instance.tasks, runId, [
          "completed"
        ]);
        if (snapshot.state !== "completed") throw new Error("unreachable");
        expect(snapshot.result).toBe(11);
        expect(snapshot.definition).toBe("versioned@v2");
        expect(columns(state.storage, runId).definition).toBe("versioned@v2");
      }
    );
  });
  it("orphans a run whose newer version declares no migrate, and reopen brings it back", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    let runId = "";
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await dynamicTasks(instance).run(
          "versioned@v1",
          undefined,
          { retain: false }
        );
        runId = receipt.runId;
        await waitForState(instance.tasks, runId, ["waiting"]);
        delete instance.dynamic["versioned@v1"];
        instance.dynamic["versioned@v2"] = {
          initial: versionedV2.initial,
          phases: versionedV2.phases
        } satisfies TaskMachine<VersionedState, never, number>;
        backdateTaskWake(state.storage, runId, "wait");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const orphaned = await waitForState(instance.tasks, runId, ["failed"]);
        if (orphaned.state !== "failed") throw new Error("unreachable");
        expect(orphaned.error.name).toBe("StateMachineOrphanedDefinitionError");
        expect(orphaned.outcome).toBe("orphaned");
        // Preserved despite retain:false, checkpoint intact.
        expect(
          JSON.parse(columns(state.storage, runId).checkpoint ?? "null")
        ).toEqual({ phase: "one", n: 1 });

        instance.dynamic["versioned@v1"] = versionedV1;
        expect(await instance.tasks.reopen(runId)).toBe(true);
        expect(await instance.tasks.reopen(runId)).toBe(false);
        backdateTaskWake(state.storage, runId, "wait");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      // Reopened at retain:false, the run completes and is released: the
      // row goes, and no further error is observed.
      const deadline = Date.now() + 5_000;
      while ((await instance.tasks.get(runId)) !== null) {
        if (Date.now() > deadline) throw new Error("reopened run not released");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(
        instance.runErrorRuns.filter((run) => run.runId === runId)
      ).toEqual([
        {
          runId,
          definition: "versioned@v1",
          name: "StateMachineOrphanedDefinitionError"
        }
      ]);
    });
  });
});
