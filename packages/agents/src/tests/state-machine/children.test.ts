import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  backdateTaskWake,
  interruptTaskRun,
  type TaskHarnessObject
} from "../capabilities/tasks";
import type { TaskRunSnapshot, TaskValue } from "../../tasks";

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

function runColumns(
  storage: DurableObjectStorage,
  runId: string
): {
  parent_run_id: string | null;
  abort_mark: string | null;
  stream_epoch: number;
  stream_retired: number;
  progress: number;
} {
  return storage.sql
    .exec<{
      parent_run_id: string | null;
      abort_mark: string | null;
      stream_epoch: number;
      stream_retired: number;
      progress: number;
    }>(
      `SELECT parent_run_id, abort_mark, stream_epoch, stream_retired, progress
       FROM cf_agents_task_runs WHERE run_id = ?`,
      runId
    )
    .one();
}

describe("children", () => {
  it("spawns children, receives their notes, and joins them", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run("parent", {});
        const done = await waitForState(instance.tasks, receipt.runId, [
          "completed"
        ]);
        if (done.state !== "completed") throw new Error("unreachable");
        expect(done.result).toBe(
          `${JSON.stringify({
            first: "first:kid",
            second: "second:first:kid",
            hadHostContext: true
          })}|3`
        );
        // The children carry the parent; their notes were consumed by join.
        expect(
          runColumns(state.storage, `${receipt.runId}:kid-1`).parent_run_id
        ).toBe(receipt.runId);
        const view = await instance.tasks.view(receipt.runId);
        expect(view?.mailbox).toEqual([]);
        expect(view?.children).toEqual([]);
        expect(instance.stepRuns).toEqual([
          "pipeline:first",
          "pipeline:second"
        ]);
      }
    );
  });

  it("cascades a cancel to in-tree children and leaves background children running", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const tree = await instance.tasks.run("guardian", {
          background: false
        });
        const detached = await instance.tasks.run("guardian", {
          background: true
        });
        await waitForState(instance.tasks, tree.runId, ["waiting"]);
        await waitForState(instance.tasks, detached.runId, ["waiting"]);
        await waitForState(instance.tasks, `${tree.runId}:ward`, ["waiting"]);
        await waitForState(instance.tasks, `${detached.runId}:ward`, [
          "waiting"
        ]);

        expect(await instance.tasks.cancel(tree.runId, "stop")).toBe(true);
        const ward = await instance.tasks.get(`${tree.runId}:ward`);
        expect(ward?.state).toBe("cancelled");
        if (ward?.state === "cancelled")
          expect(ward.reason).toBe("parent aborted");
        expect(runColumns(state.storage, `${tree.runId}:ward`).abort_mark).toBe(
          "parent"
        );

        expect(await instance.tasks.cancel(detached.runId, "stop")).toBe(true);
        expect(
          (await instance.tasks.get(`${detached.runId}:ward`))?.state
        ).toBe("waiting");
        expect(await instance.tasks.cancel(`${detached.runId}:ward`)).toBe(
          true
        );
      }
    );
  });

  it("cascades into a child that declares onCancel through its cancel transition", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const tree = await instance.tasks.run("guardianOfGuarded");
      await waitForState(instance.tasks, `${tree.runId}:ward`, ["waiting"]);
      expect(
        await instance.tasks.cancel(tree.runId, "stop", { wait: true })
      ).toBe(true);
      const ward = await waitForState(instance.tasks, `${tree.runId}:ward`, [
        "cancelled"
      ]);
      expect(ward.state).toBe("cancelled");
      expect(instance.cancelLog).toEqual(["hold:parent"]);
    });
  });

  it("join reports a faulted child as data rather than throwing", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("parentOfStuck");
      const done = await waitForState(instance.tasks, receipt.runId, [
        "completed"
      ]);
      if (done.state !== "completed") throw new Error("unreachable");
      expect(done.result).toBe("error:StateMachineNoProgressError");
    });
  });

  it("derives a child's run id from the turn when none is given", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const parent = await instance.tasks.run("spawnerDefault");
      const child = await waitForState(instance.tasks, `${parent.runId}:t0:0`, [
        "waiting"
      ]);
      expect(child.definition).toBe("napper");
      const view = await instance.tasks.view(parent.runId);
      expect(view?.checkpoint).toEqual({
        phase: "wait",
        child: `${parent.runId}:t0:0`
      });
      expect(await instance.tasks.cancel(parent.runId)).toBe(true);
    });
  });

  it("joins a released child: its note outlives the run row", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("releaser");
      const done = await waitForState(instance.tasks, receipt.runId, [
        "completed"
      ]);
      if (done.state !== "completed") throw new Error("unreachable");
      expect(done.result).toBe("3");
      // `retain: false` released the child once its note was delivered.
      expect(await instance.tasks.get(`${receipt.runId}:released`)).toBeNull();
    });
  });

  it("terminate takes the children with it", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const tree = await instance.tasks.run("guardian", { background: false });
      await waitForState(instance.tasks, `${tree.runId}:ward`, ["waiting"]);
      expect(await instance.tasks.terminate(tree.runId)).toBe(true);
      expect((await instance.tasks.get(`${tree.runId}:ward`))?.state).toBe(
        "cancelled"
      );
    });
  });
});

describe("engine-owned streams", () => {
  it("settles a transition's stream with its commit and opens the next epoch", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run("streamer");
        const done = await waitForState(instance.tasks, receipt.runId, [
          "completed"
        ]);
        if (done.state !== "completed") throw new Error("unreachable");
        expect(done.result).toBe(`${receipt.runId}:main#1`);
        const first = await instance.streams.status(`${receipt.runId}:main#0`);
        expect(first?.state).toBe("completed");
        expect(first?.cursor).toBe(2);
        expect(first?.tag).toBe(`${receipt.runId}:main`);
        const second = await instance.streams.status(`${receipt.runId}:main#1`);
        expect(second?.state).toBe("completed");
        expect(second?.cursor).toBe(1);
        const columns = runColumns(state.storage, receipt.runId);
        expect(columns.stream_epoch).toBe(1);
        expect(columns.stream_retired).toBe(2);
        // The first stream's two chunks were credited at the commit.
        expect(columns.progress).toBe(2);
        const view = await instance.tasks.view(receipt.runId);
        expect(view?.streams).toEqual([
          {
            name: "main",
            tag: `${receipt.runId}:main`,
            streamId: `${receipt.runId}:main#1`,
            epoch: 1,
            cursor: 1,
            state: "completed"
          }
        ]);
      }
    );
  });

  it("settles the run when the machine closed its own stream first", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("closingStreamer");
      const done = await waitForState(instance.tasks, receipt.runId, [
        "completed"
      ]);
      if (done.state !== "completed") throw new Error("unreachable");
      // A stream the machine settled itself carries no commit, so the
      // terminal write runs on its own rather than riding a settle that
      // transitions nothing.
      expect(done.result).toBe(`${receipt.runId}:out#0`);
      expect(
        (await instance.streams.status(`${receipt.runId}:out#0`))?.state
      ).toBe("completed");
    });
  });

  it("leaves the stream live when the terminal result cannot serialize", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const runId = crypto.randomUUID();
      await expect(
        instance.tasks.run("cyclicStreamer", undefined, {
          runId,
          start: "attached"
        })
      ).rejects.toThrow(/Cannot serialize result of Task definition/);
      // The stream and the run agree: nothing settled, so the stream is
      // still live for the attempt that reclaims the run.
      expect((await instance.streams.status(`${runId}:out#0`))?.state).toBe(
        "streaming"
      );
      expect((await instance.tasks.get(runId))?.state).not.toBe("completed");
    });
  });

  it("seals a lost attempt's live stream and rotates the epoch on reclaim", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    let runId = "";
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run("napStreamer");
        runId = receipt.runId;
        await waitForState(instance.tasks, runId, ["waiting"]);
        expect((await instance.streams.status(`${runId}:out#0`))?.state).toBe(
          "streaming"
        );
        // The isolate holding the attempt dies mid-transition.
        interruptTaskRun(state.storage, runId);
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await waitForState(instance.tasks, runId, ["waiting"]);
        const sealed = await instance.streams.status(`${runId}:out#0`);
        expect(sealed?.state).toBe("errored");
        expect(sealed?.cursor).toBe(2);
        const live = await instance.streams.status(`${runId}:out#1`);
        expect(live?.state).toBe("streaming");
        expect(live?.cursor).toBe(2);
        const columns = runColumns(state.storage, runId);
        expect(columns.stream_epoch).toBe(1);
        expect(columns.stream_retired).toBe(2);
        backdateTaskWake(state.storage, runId, "nap");
        expect(await instance.tasks.cancel(runId)).toBe(true);
      }
    );
  });
});
