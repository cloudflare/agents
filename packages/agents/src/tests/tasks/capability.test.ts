import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  backdateTaskWake,
  seedTaskRun,
  seedTaskStep,
  type TaskHarnessObject,
  type TaskSchedulerCoexistObject
} from "../capabilities/tasks";
import { captureDiagnosticsEvents } from "../shared/diagnostics-capture";
import type { Tasks, TaskRunSnapshot, TaskValue } from "../../tasks";

/**
 * Capability-level Tasks tests: the capability installed on a minimal real
 * Durable Object (`TaskHarnessObject`) through a real Lifecycle, driven by
 * real storage and real platform alarms — no fakes. Instance counters
 * separate real step execution from journal hits, which is how replay
 * memoization is proven.
 *
 * Imminent alarms auto-fire in workerd, so tests never assert that
 * `runDurableObjectAlarm` found one pending: parked states use far-future
 * deadlines to stay observable, wakes are forced by backdating them, and
 * outcomes are polled.
 */

function captureTaskEvents(name: string) {
  return captureDiagnosticsEvents("agents:task", name);
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

/** Poll until a condition holds. */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Tasks capability", () => {
  it("accepts runs durably and deduplicates acceptance", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const first = await instance.tasks.run(
        "pipeline",
        { label: "a" },
        { idempotencyKey: "K" }
      );
      expect(first.accepted).toBe(true);
      expect(first.definition).toBe("pipeline");

      // The same idempotency key joins the existing run.
      const joined = await instance.tasks.run(
        "pipeline",
        { label: "a" },
        { idempotencyKey: "K" }
      );
      expect(joined.accepted).toBe(false);
      expect(joined.runId).toBe(first.runId);

      // A caller-selected run ID deduplicates the same way.
      const chosen = await instance.tasks.run(
        "pipeline",
        { label: "b" },
        { runId: "custom-run" }
      );
      expect(chosen.runId).toBe("custom-run");
      const again = await instance.tasks.run(
        "pipeline",
        { label: "b" },
        { runId: "custom-run" }
      );
      expect(again.accepted).toBe(false);

      // Reusing the key under a different definition is an error, not a join.
      await expect(
        instance.tasks.run("flaky", { label: "x" }, { idempotencyKey: "K" })
      ).rejects.toThrow(/already belongs to definition "pipeline"/);

      // A matching identifier pair joins; a run matched by ID with a
      // DIFFERENT stored key is a conflict, not a silent join.
      const both = await instance.tasks.run(
        "pipeline",
        { label: "a" },
        { runId: first.runId, idempotencyKey: "K" }
      );
      expect(both.accepted).toBe(false);
      await expect(
        instance.tasks.run(
          "pipeline",
          { label: "a" },
          { runId: first.runId, idempotencyKey: "other-key" }
        )
      ).rejects.toThrow(/conflicting key "other-key"/);
      // The key is the dedup authority: a fresh runId alongside a key that
      // names an existing run joins that run (a repeated delivery pattern —
      // new nonce, stable event key); the receipt carries the real id.
      const redelivered = await instance.tasks.run(
        "pipeline",
        { label: "a" },
        { runId: "some-other-id", idempotencyKey: "K" }
      );
      expect(redelivered.accepted).toBe(false);
      expect(redelivered.runId).toBe(first.runId);
      expect(await instance.tasks.get("some-other-id")).toBeNull();

      // Handles only see runs of their own definition.
      expect(await instance.tasks.handle("flaky").get(first.runId)).toBeNull();
      // ...and cannot cancel across definitions either.
      expect(await instance.tasks.handle("flaky").cancel(first.runId)).toBe(
        false
      );
      expect((await instance.tasks.get(first.runId))?.state).not.toBe(
        "cancelled"
      );
      expect(
        (await instance.tasks.handle("pipeline").getByIdempotencyKey("K"))
          ?.runId
      ).toBe(first.runId);

      const listed = await instance.tasks.list({ definition: "pipeline" });
      expect(listed.map((run) => run.runId)).toContain(first.runId);
    });
  });

  it("completes a run through the warm path with journaled steps and host context", async () => {
    const name = crypto.randomUUID();
    const stub = env.TaskHarnessObject.getByName(name);
    const capture = captureTaskEvents(name);

    try {
      await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
        const receipt = await instance.tasks.run("pipeline", {
          label: "warm"
        });
        const snapshot = await waitForState(instance.tasks, receipt.runId, [
          "completed"
        ]);
        if (snapshot.state !== "completed") throw new Error("unreachable");
        expect(snapshot.result).toEqual({
          first: "first:warm",
          second: "second:first:warm",
          hadHostContext: true
        });
        expect(instance.stepRuns).toEqual([
          "pipeline:first",
          "pipeline:second"
        ]);
      });
      expect(capture.events.map((event) => event.type)).toEqual([
        "task:accepted",
        "task:attempt:started",
        "task:step:started",
        "task:step:completed",
        "task:step:started",
        "task:step:completed",
        "task:completed"
      ]);
    } finally {
      capture.stop();
    }
  });

  it("leaves internal enqueues for the durable wake and flags only recovery definitions", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const ordinary = await instance.tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
          "pipeline",
          {
            label: "queued"
          }
        );
        const recovery = await instance.tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
          "oomStepLoop",
          undefined
        );
        expect((await instance.tasks.get(ordinary.runId))?.state).toBe(
          "pending"
        );
        expect((await instance.tasks.get(recovery.runId))?.state).toBe(
          "pending"
        );
        expect(instance.stepRuns).toEqual([]);

        const flags = state.storage.sql
          .exec(
            `SELECT id, recovery_loop FROM cf_agents_jobs
             WHERE id IN (?, ?) ORDER BY id`,
            `task:${ordinary.runId}`,
            `task:${recovery.runId}`
          )
          .toArray() as Array<{ id: string; recovery_loop: number }>;
        expect(flags).toEqual(
          [
            { id: `task:${ordinary.runId}`, recovery_loop: 0 },
            { id: `task:${recovery.runId}`, recovery_loop: 1 }
          ].sort((left, right) => left.id.localeCompare(right.id))
        );
      }
    );
  });

  it("parks on a step retry and replays without re-executing completed steps", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());

    const runId = await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject) => {
        instance.failuresBeforeSuccess = 1;
        const receipt = await instance.tasks.run("flaky", { label: "r" });
        const parked = await waitForState(instance.tasks, receipt.runId, [
          "waiting"
        ]);
        if (parked.state !== "waiting") throw new Error("unreachable");
        expect(parked.reason).toBe("retry");
        expect(instance.stepRuns).toEqual(["flaky:seed", "flaky:unstable:1"]);
        return receipt.runId;
      }
    );

    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        backdateTaskWake(state.storage, runId, "unstable");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const snapshot = await waitForState(instance.tasks, runId, ["completed"]);
      if (snapshot.state !== "completed") throw new Error("unreachable");
      expect(snapshot.result).toBe("r-seed-ok");
      // The seed step ran once; only the unstable step executed twice.
      expect(instance.stepRuns).toEqual([
        "flaky:seed",
        "flaky:unstable:1",
        "flaky:unstable:2"
      ]);
    });
  });

  it("reclaims an interrupted attempt and replays from the journal", async () => {
    const name = crypto.randomUUID();
    const stub = env.TaskHarnessObject.getByName(name);
    const capture = captureTaskEvents(name);

    try {
      await runInDurableObject(
        stub,
        async (instance: TaskHarnessObject, state) => {
          await instance.lifecycle.start();
          // A run claimed by an isolate that no longer exists: state running,
          // a dead generation, and one journaled step with a sentinel value a
          // live execution could never produce.
          seedTaskRun(state.storage, {
            runId: "interrupted-run",
            definition: "pipeline",
            input: { label: "live" },
            state: "running",
            generation: "dead-generation",
            attempt: 1,
            nextAt: Date.now() - 1000
          });
          seedTaskStep(state.storage, {
            runId: "interrupted-run",
            name: "first",
            kind: "do",
            state: "completed",
            result: "first:JOURNAL"
          });
          await instance.lifecycle.rearmAlarm();
        }
      );

      await runDurableObjectAlarm(stub);

      await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
        const snapshot = await waitForState(instance.tasks, "interrupted-run", [
          "completed"
        ]);
        if (snapshot.state !== "completed") throw new Error("unreachable");
        // The journaled sentinel flowed into the rest of the replay: the
        // completed step was not re-executed.
        expect(snapshot.result).toEqual({
          first: "first:JOURNAL",
          second: "second:first:JOURNAL",
          hadHostContext: true
        });
        expect(instance.stepRuns).toEqual(["pipeline:second"]);
      });
      expect(capture.events.map((event) => event.type)).toContain(
        "task:attempt:interrupted"
      );
    } finally {
      capture.stop();
    }
  });

  it("sleeps durably, keeps the first recorded deadline, and resumes after it", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());

    const { runId, firstWake } = await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run("sleeper", { ms: 60_000 });
        const parked = await waitForState(instance.tasks, receipt.runId, [
          "waiting"
        ]);
        if (parked.state !== "waiting") throw new Error("unreachable");
        expect(parked.reason).toBe("sleep");
        // The physical alarm settles on the sleep deadline.
        await waitFor(
          async () => (await state.storage.getAlarm()) === parked.wakeAt
        );
        return { runId: receipt.runId, firstWake: parked.wakeAt };
      }
    );

    // Wake the run before its sleep deadline: it replays up to the sleep and
    // parks again without moving the recorded deadline.
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        backdateTaskWake(state.storage, runId);
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);

    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await waitFor(() => {
          const [row] = state.storage.sql
            .exec(
              "SELECT attempt, state FROM cf_agents_task_runs WHERE run_id = ?",
              runId
            )
            .toArray();
          return row?.attempt === 2 && row?.state === "waiting";
        });
        const parked = await instance.tasks.get(runId);
        if (parked?.state !== "waiting") throw new Error("expected waiting");
        expect(parked.wakeAt).toBe(firstWake);
        expect(instance.stepRuns).toEqual(["sleeper:before"]);

        backdateTaskWake(state.storage, runId, "nap");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const snapshot = await waitForState(instance.tasks, runId, ["completed"]);
      if (snapshot.state !== "completed") throw new Error("unreachable");
      expect(snapshot.result).toBe("done");
      expect(instance.stepRuns).toEqual(["sleeper:before", "sleeper:after"]);
    });
  });

  it("fails immediately on NonRetryableError and reports through onError", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("doomed");
      const snapshot = await waitForState(instance.tasks, receipt.runId, [
        "failed"
      ]);
      if (snapshot.state !== "failed") throw new Error("unreachable");
      expect(snapshot.error).toEqual({
        name: "NonRetryableError",
        message: "no retry"
      });
      // No retry attempts were made.
      expect(instance.stepRuns).toEqual(["doomed:boom"]);
      expect(instance.runErrors).toEqual(["no retry"]);
    });
  });

  it("suppresses replayed progress behind the live gate", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());

    const runId = await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        instance.failuresBeforeSuccess = 1;
        const receipt = await instance.tasks.run("gated");
        await waitForState(instance.tasks, receipt.runId, ["waiting"]);
        const [row] = state.storage.sql
          .exec(
            "SELECT status_message FROM cf_agents_task_runs WHERE run_id = ?",
            receipt.runId
          )
          .toArray();
        expect(row?.status_message).toBe("after:2");

        backdateTaskWake(state.storage, receipt.runId, "gate");
        await instance.lifecycle.rearmAlarm();
        return receipt.runId;
      }
    );

    await runDurableObjectAlarm(stub);

    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await waitForState(instance.tasks, runId, ["completed"]);
        // The replay re-ran the handler from the top (counter reached 4) but
        // its old-ground status calls were suppressed: the persisted message
        // still carries the first attempt's counter value.
        expect(instance.statusCounter).toBe(4);
        const [row] = state.storage.sql
          .exec(
            "SELECT status_message FROM cf_agents_task_runs WHERE run_id = ?",
            runId
          )
          .toArray();
        expect(row?.status_message).toBe("after:2");
        expect(instance.stepRuns).toEqual([
          "gated:work",
          "gated:gate:1",
          "gated:gate:2"
        ]);
      }
    );
  });

  it("cancels a parked run immediately", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("sleeper", { ms: 60_000 });
      await waitForState(instance.tasks, receipt.runId, ["waiting"]);

      expect(
        await instance.tasks.cancel(receipt.runId, "changed my mind")
      ).toBe(true);
      const snapshot = await instance.tasks.get(receipt.runId);
      expect(snapshot?.state).toBe("cancelled");
      if (snapshot?.state !== "cancelled") throw new Error("unreachable");
      expect(snapshot.reason).toBe("changed my mind");

      // A settled run cannot be cancelled again.
      expect(await instance.tasks.cancel(receipt.runId)).toBe(false);
      expect(instance.stepRuns).not.toContain("sleeper:after");
    });
  });

  it("cancels a live attempt cooperatively through its abort signal", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("blocked");
      await waitFor(() => instance.stepRuns.includes("blocked:hang"));

      expect(await instance.tasks.cancel(receipt.runId, "stop it")).toBe(true);
      const snapshot = await waitForState(instance.tasks, receipt.runId, [
        "cancelled"
      ]);
      if (snapshot.state !== "cancelled") throw new Error("unreachable");
      expect(snapshot.reason).toBe("stop it");
    });
  });

  it("times out a step that ignores its abort signal", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("slowpoke");
      const snapshot = await waitForState(instance.tasks, receipt.runId, [
        "failed"
      ]);
      if (snapshot.state !== "failed") throw new Error("unreachable");
      expect(snapshot.error.message).toMatch(/timed out after 40ms/);
    });
  });

  it("rejects duplicate step names before executing user code", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("clash");
      const snapshot = await waitForState(instance.tasks, receipt.runId, [
        "failed"
      ]);
      if (snapshot.state !== "failed") throw new Error("unreachable");
      expect(snapshot.error.name).toBe("DuplicateTaskStepError");
    });
  });

  it("fails visibly when replay diverges from the journal", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        // The journal says "first" was a sleep; the handler declares a do.
        seedTaskRun(state.storage, {
          runId: "diverged-run",
          definition: "pipeline",
          input: { label: "x" },
          state: "pending",
          nextAt: Date.now() - 1000
        });
        seedTaskStep(state.storage, {
          runId: "diverged-run",
          name: "first",
          kind: "sleep",
          state: "waiting",
          nextAt: Date.now() - 1000
        });
        await instance.lifecycle.rearmAlarm();
      }
    );

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const snapshot = await waitForState(instance.tasks, "diverged-run", [
        "failed"
      ]);
      if (snapshot.state !== "failed") throw new Error("unreachable");
      expect(snapshot.error.name).toBe("TaskReplayDivergedError");
      expect(instance.stepRuns).toEqual([]);
    });
  });

  it("fails a run whose definition is no longer registered", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        seedTaskRun(state.storage, {
          runId: "ghost-run",
          definition: "ghost",
          state: "pending",
          nextAt: Date.now() - 1000
        });
        await instance.lifecycle.rearmAlarm();
      }
    );

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const snapshot = await waitForState(instance.tasks, "ghost-run", [
        "failed"
      ]);
      if (snapshot.state !== "failed") throw new Error("unreachable");
      expect(snapshot.error.name).toBe("MissingTaskDefinitionError");
      expect(snapshot.error.message).toContain('"ghost"');
    });
  });

  it("coexists with the Scheduler on the shared alarm", async () => {
    const stub = env.TaskSchedulerCoexistObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskSchedulerCoexistObject, state) => {
        const schedule = await instance.scheduler.set(120, "remind", "tick");
        expect(await state.storage.getAlarm()).toBe(schedule.time * 1000);

        // A sooner task deadline wins the shared alarm.
        const receipt = await instance.tasks.run("sleeper", { ms: 60_000 });
        const parked = await waitForState(instance.tasks, receipt.runId, [
          "waiting"
        ]);
        if (parked.state !== "waiting") throw new Error("unreachable");
        expect(parked.wakeAt).toBeLessThan(schedule.time * 1000);
        await waitFor(
          async () => (await state.storage.getAlarm()) === parked.wakeAt
        );

        // Settling every task run hands the alarm back to the Scheduler —
        // it is re-armed, not deleted.
        await instance.tasks.cancel(receipt.runId);
        expect(await state.storage.getAlarm()).toBe(schedule.time * 1000);
      }
    );
  });

  it("a stalled attempt detaches at the dispatch budget instead of starving the queue", async () => {
    const stub = env.TaskSchedulerCoexistObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskSchedulerCoexistObject, state) => {
        await instance.lifecycle.start();
        // Seed directly so the QUEUE wake drives the run — the public run()
        // starts a warm attempt outside the dispatch loop.
        seedTaskRun(state.storage, {
          runId: "stall-1",
          definition: "stall",
          state: "pending",
          nextAt: Date.now() - 1_000
        });
        await instance.scheduler.set(0, "remind", "tick");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);

    await runInDurableObject(
      stub,
      async (instance: TaskSchedulerCoexistObject) => {
        // The stalled step was claimed, then execution detached at the
        // dispatch budget — so the schedule behind it fired within seconds,
        // not after the five-minute default step timeout.
        await waitFor(() => instance.remindRuns.includes("tick"), 15_000);
        expect(instance.stepRuns).toContain("stall:hang");
        await instance.tasks.cancel("stall-1");
      }
    );
  });

  it("a platform-class failure never settles the run; replay completes it", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    let runId = "";
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      instance.platformFailuresRemaining = 1;
      const receipt = await instance.tasks.run("platformFlaky");
      runId = receipt.runId;
      await waitFor(() => instance.platformFailuresRemaining === 0);
      // The warm attempt hit a platform-shaped reset AFTER journaling its
      // step: the run must remain claimed — not failed — with the claim
      // backstop as its durable wake, and onError must not observe it.
      const after = await instance.tasks.get(receipt.runId);
      expect(after?.state).toBe("running");
      expect(instance.runErrors).toEqual([]);
    });

    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        backdateTaskWake(state.storage, runId);
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const snapshot = await waitForState(instance.tasks, runId, ["completed"]);
      if (snapshot.state !== "completed") throw new Error("unreachable");
      expect(snapshot.result).toBe("seed-done");
      // The journaled step did not re-execute on replay.
      expect(instance.stepRuns).toEqual(["platform:seed"]);
    });
  });

  it("removes non-retained records after completion", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run(
        "pipeline",
        { label: "gone" },
        { retain: false }
      );
      const deadline = Date.now() + 5_000;
      for (;;) {
        const snapshot = await instance.tasks.get(receipt.runId);
        if (snapshot === null) break;
        expect(snapshot.state).not.toBe("failed");
        if (Date.now() > deadline) {
          throw new Error("non-retained run was not removed");
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(instance.stepRuns).toEqual(["pipeline:first", "pipeline:second"]);
    });
  });

  it("deletes retained terminal runs on request", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("pipeline", { label: "keep" });
      await waitForState(instance.tasks, receipt.runId, ["completed"]);

      expect(await instance.tasks.delete({ status: ["failed"] })).toBe(0);
      expect(await instance.tasks.delete()).toBe(1);
      expect(await instance.tasks.get(receipt.runId)).toBeNull();
    });
  });

  it("rejects oversized inputs at acceptance", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await expect(
        instance.tasks.run("pipeline", { label: "x".repeat(1_100_000) })
      ).rejects.toThrow(/exceeds the 1048576-byte limit/);
      expect(await instance.tasks.list()).toEqual([]);
    });
  });

  it("rejects names outside the declared definitions map", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      // Unknown names are a compile error on the typed map; erase the typing
      // to exercise the runtime rejection. The double cast is required: the
      // conditional output type in handle() makes the Handlers generic
      // invariant, so a typed map does not widen to the default surface.
      const untyped = instance.tasks as unknown as Tasks;
      await expect(untyped.run("nope")).rejects.toThrow(
        'Unknown Task definition "nope"'
      );
      expect(() => untyped.handle("nope")).toThrow(
        'Unknown Task definition "nope"'
      );
      await expect(untyped.run("__cf_internal_x")).rejects.toThrow(/reserved/);
      await expect(untyped.run("")).rejects.toThrow(/non-empty/);

      // A handle is a pure lens over the declared map, so it can be created
      // at any time — including after Lifecycle startup.
      await instance.lifecycle.start();
      expect(instance.tasks.handle("pipeline").name).toBe("pipeline");
    });
  });

  it("replays after unclean interruption, resuming from the journal", async () => {
    const name = crypto.randomUUID();
    const stub = env.TaskHarnessObject.getByName(name);
    const capture = captureTaskEvents(name);

    try {
      await runInDurableObject(
        stub,
        async (instance: TaskHarnessObject, state) => {
          await instance.lifecycle.start();
          seedTaskRun(state.storage, {
            runId: "guarded-run",
            definition: "guarded",
            input: { label: "ctx" },
            state: "running",
            generation: "dead-generation",
            attempt: 1,
            nextAt: Date.now() - 1000
          });
          seedTaskStep(state.storage, {
            runId: "guarded-run",
            name: "g-first",
            kind: "do",
            state: "completed",
            result: "g:JOURNAL"
          });
          seedTaskStep(state.storage, {
            runId: "guarded-run",
            name: "g-second",
            kind: "do",
            state: "running",
            attempt: 1
          });
          await instance.lifecycle.rearmAlarm();
        }
      );

      await runDurableObjectAlarm(stub);

      await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
        const snapshot = await waitForState(instance.tasks, "guarded-run", [
          "completed"
        ]);
        if (snapshot.state !== "completed") throw new Error("unreachable");
        // Replay from the top: the journaled first step short-circuited and
        // only the interrupted second step re-executed.
        expect(snapshot.result).toBe("run-done:g:JOURNAL");
        expect(instance.stepRuns).toEqual(["guarded:second"]);
        // The handler observed durable evidence of the interruption at
        // entry: the step the lost attempt left mid-execution.
        expect(instance.guardedEntries).toEqual(["entry:ctx:g-second"]);
      });
      const types = capture.events.map((event) => event.type);
      expect(types).toContain("task:attempt:interrupted");
    } finally {
      capture.stop();
    }
  });

  it("clean step failures retry without looking like interruptions", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    const runId = await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject) => {
        instance.failuresBeforeSuccess = 1;
        const receipt = await instance.tasks.run("guarded", { label: "r" });
        const parked = await waitForState(instance.tasks, receipt.runId, [
          "waiting"
        ]);
        if (parked.state !== "waiting") throw new Error("unreachable");
        expect(parked.reason).toBe("retry");
        return receipt.runId;
      }
    );

    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        backdateTaskWake(state.storage, runId, "g-second");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const snapshot = await waitForState(instance.tasks, runId, ["completed"]);
      if (snapshot.state !== "completed") throw new Error("unreachable");
      expect(snapshot.result).toBe("run-done:g:r");
      // Both handler entries saw a clean journal — a retry park is not an
      // interruption, so no step was ever left mid-execution at entry.
      expect(instance.guardedEntries).toEqual(["entry:r:none", "entry:r:none"]);
    });
  });
});
