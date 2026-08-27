import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  backdateFiberWake,
  seedFiberRun,
  seedFiberStep,
  type FiberBatchHarnessObject,
  type FiberHarnessObject,
  type FiberSchedulerCoexistObject
} from "../capabilities/fibers";
import { captureDiagnosticsEvents } from "../shared/diagnostics-capture";
import type { Fibers, FiberRunSnapshot, FiberValue } from "../../fibers";

/**
 * Capability-level Fibers tests: the capability installed on a minimal real
 * Durable Object (`FiberHarnessObject`) through a real Lifecycle, driven by
 * real storage and real platform alarms — no fakes. Instance counters
 * separate real step execution from journal hits, which is how replay
 * memoization is proven.
 *
 * Imminent alarms auto-fire in workerd, so tests never assert that
 * `runDurableObjectAlarm` found one pending: parked states use far-future
 * deadlines to stay observable, wakes are forced by backdating them, and
 * outcomes are polled.
 */

function captureFiberEvents(name: string) {
  return captureDiagnosticsEvents("agents:fiber", name);
}

/** Poll one run until it reaches one of the given states. */
async function waitForState(
  fibers: { get(runId: string): Promise<FiberRunSnapshot<FiberValue> | null> },
  runId: string,
  states: ReadonlyArray<FiberRunSnapshot<FiberValue>["state"]>,
  timeoutMs = 5_000
): Promise<FiberRunSnapshot<FiberValue>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await fibers.get(runId);
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

describe("Fibers capability", () => {
  it("accepts runs durably and deduplicates acceptance", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      const first = await instance.fibers.run(
        "pipeline",
        { label: "a" },
        { idempotencyKey: "K" }
      );
      expect(first.accepted).toBe(true);
      expect(first.definition).toBe("pipeline");

      // The same idempotency key joins the existing run.
      const joined = await instance.fibers.run(
        "pipeline",
        { label: "a" },
        { idempotencyKey: "K" }
      );
      expect(joined.accepted).toBe(false);
      expect(joined.runId).toBe(first.runId);

      // A caller-selected run ID deduplicates the same way.
      const chosen = await instance.fibers.run(
        "pipeline",
        { label: "b" },
        { runId: "custom-run" }
      );
      expect(chosen.runId).toBe("custom-run");
      const again = await instance.fibers.run(
        "pipeline",
        { label: "b" },
        { runId: "custom-run" }
      );
      expect(again.accepted).toBe(false);

      // Reusing the key under a different definition is an error, not a join.
      await expect(
        instance.fibers.run("flaky", { label: "x" }, { idempotencyKey: "K" })
      ).rejects.toThrow(/already belongs to definition "pipeline"/);

      // Handles only see runs of their own definition.
      expect(await instance.fibers.handle("flaky").get(first.runId)).toBeNull();
      expect(
        (await instance.fibers.handle("pipeline").getByIdempotencyKey("K"))
          ?.runId
      ).toBe(first.runId);

      const listed = await instance.fibers.list({ definition: "pipeline" });
      expect(listed.map((run) => run.runId)).toContain(first.runId);
    });
  });

  it("completes a run through the warm path with journaled steps and host context", async () => {
    const name = crypto.randomUUID();
    const stub = env.FiberHarnessObject.getByName(name);
    const capture = captureFiberEvents(name);

    try {
      await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
        const receipt = await instance.fibers.run("pipeline", {
          label: "warm"
        });
        const snapshot = await waitForState(instance.fibers, receipt.runId, [
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
        "fiber:accepted",
        "fiber:attempt:started",
        "fiber:step:started",
        "fiber:step:completed",
        "fiber:step:started",
        "fiber:step:completed",
        "fiber:completed"
      ]);
    } finally {
      capture.stop();
    }
  });

  it("parks on a step retry and replays without re-executing completed steps", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());

    const runId = await runInDurableObject(
      stub,
      async (instance: FiberHarnessObject) => {
        instance.failuresBeforeSuccess = 1;
        const receipt = await instance.fibers.run("flaky", { label: "r" });
        const parked = await waitForState(instance.fibers, receipt.runId, [
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
      async (instance: FiberHarnessObject, state) => {
        backdateFiberWake(state.storage, runId, "unstable");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      const snapshot = await waitForState(instance.fibers, runId, [
        "completed"
      ]);
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
    const stub = env.FiberHarnessObject.getByName(name);
    const capture = captureFiberEvents(name);

    try {
      await runInDurableObject(
        stub,
        async (instance: FiberHarnessObject, state) => {
          await instance.lifecycle.start();
          // A run claimed by an isolate that no longer exists: state running,
          // a dead generation, and one journaled step with a sentinel value a
          // live execution could never produce.
          seedFiberRun(state.storage, {
            runId: "interrupted-run",
            definition: "pipeline",
            input: { label: "live" },
            state: "running",
            generation: "dead-generation",
            attempt: 1,
            nextAt: Date.now() - 1000
          });
          seedFiberStep(state.storage, {
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

      await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
        const snapshot = await waitForState(
          instance.fibers,
          "interrupted-run",
          ["completed"]
        );
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
        "fiber:attempt:interrupted"
      );
    } finally {
      capture.stop();
    }
  });

  it("sleeps durably, keeps the first recorded deadline, and resumes after it", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());

    const { runId, firstWake } = await runInDurableObject(
      stub,
      async (instance: FiberHarnessObject, state) => {
        const receipt = await instance.fibers.run("sleeper", { ms: 60_000 });
        const parked = await waitForState(instance.fibers, receipt.runId, [
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
      async (instance: FiberHarnessObject, state) => {
        backdateFiberWake(state.storage, runId);
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);

    await runInDurableObject(
      stub,
      async (instance: FiberHarnessObject, state) => {
        await waitFor(() => {
          const [row] = state.storage.sql
            .exec(
              "SELECT attempt, state FROM cf_fiber_runs WHERE run_id = ?",
              runId
            )
            .toArray();
          return row?.attempt === 2 && row?.state === "waiting";
        });
        const parked = await instance.fibers.get(runId);
        if (parked?.state !== "waiting") throw new Error("expected waiting");
        expect(parked.wakeAt).toBe(firstWake);
        expect(instance.stepRuns).toEqual(["sleeper:before"]);

        backdateFiberWake(state.storage, runId, "nap");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      const snapshot = await waitForState(instance.fibers, runId, [
        "completed"
      ]);
      if (snapshot.state !== "completed") throw new Error("unreachable");
      expect(snapshot.result).toBe("done");
      expect(instance.stepRuns).toEqual(["sleeper:before", "sleeper:after"]);
    });
  });

  it("fails immediately on NonRetryableError and reports through onError", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      const receipt = await instance.fibers.run("doomed");
      const snapshot = await waitForState(instance.fibers, receipt.runId, [
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
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());

    const runId = await runInDurableObject(
      stub,
      async (instance: FiberHarnessObject, state) => {
        instance.failuresBeforeSuccess = 1;
        const receipt = await instance.fibers.run("gated");
        await waitForState(instance.fibers, receipt.runId, ["waiting"]);
        const [row] = state.storage.sql
          .exec(
            "SELECT status_message FROM cf_fiber_runs WHERE run_id = ?",
            receipt.runId
          )
          .toArray();
        expect(row?.status_message).toBe("after:2");

        backdateFiberWake(state.storage, receipt.runId, "gate");
        await instance.lifecycle.rearmAlarm();
        return receipt.runId;
      }
    );

    await runDurableObjectAlarm(stub);

    await runInDurableObject(
      stub,
      async (instance: FiberHarnessObject, state) => {
        await waitForState(instance.fibers, runId, ["completed"]);
        // The replay re-ran the handler from the top (counter reached 4) but
        // its old-ground status calls were suppressed: the persisted message
        // still carries the first attempt's counter value.
        expect(instance.statusCounter).toBe(4);
        const [row] = state.storage.sql
          .exec(
            "SELECT status_message FROM cf_fiber_runs WHERE run_id = ?",
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
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      const receipt = await instance.fibers.run("sleeper", { ms: 60_000 });
      await waitForState(instance.fibers, receipt.runId, ["waiting"]);

      expect(
        await instance.fibers.cancel(receipt.runId, "changed my mind")
      ).toBe(true);
      const snapshot = await instance.fibers.get(receipt.runId);
      expect(snapshot?.state).toBe("cancelled");
      if (snapshot?.state !== "cancelled") throw new Error("unreachable");
      expect(snapshot.reason).toBe("changed my mind");

      // A settled run cannot be cancelled again.
      expect(await instance.fibers.cancel(receipt.runId)).toBe(false);
      expect(instance.stepRuns).not.toContain("sleeper:after");
    });
  });

  it("cancels a live attempt cooperatively through its abort signal", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      const receipt = await instance.fibers.run("blocked");
      await waitFor(() => instance.stepRuns.includes("blocked:hang"));

      expect(await instance.fibers.cancel(receipt.runId, "stop it")).toBe(true);
      const snapshot = await waitForState(instance.fibers, receipt.runId, [
        "cancelled"
      ]);
      if (snapshot.state !== "cancelled") throw new Error("unreachable");
      expect(snapshot.reason).toBe("stop it");
    });
  });

  it("times out a step that ignores its abort signal", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      const receipt = await instance.fibers.run("slowpoke");
      const snapshot = await waitForState(instance.fibers, receipt.runId, [
        "failed"
      ]);
      if (snapshot.state !== "failed") throw new Error("unreachable");
      expect(snapshot.error.message).toMatch(/timed out after 40ms/);
    });
  });

  it("rejects duplicate step names before executing user code", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      const receipt = await instance.fibers.run("clash");
      const snapshot = await waitForState(instance.fibers, receipt.runId, [
        "failed"
      ]);
      if (snapshot.state !== "failed") throw new Error("unreachable");
      expect(snapshot.error.name).toBe("DuplicateFiberStepError");
    });
  });

  it("fails visibly when replay diverges from the journal", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: FiberHarnessObject, state) => {
        await instance.lifecycle.start();
        // The journal says "first" was a sleep; the handler declares a do.
        seedFiberRun(state.storage, {
          runId: "diverged-run",
          definition: "pipeline",
          input: { label: "x" },
          state: "pending",
          nextAt: Date.now() - 1000
        });
        seedFiberStep(state.storage, {
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

    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      const snapshot = await waitForState(instance.fibers, "diverged-run", [
        "failed"
      ]);
      if (snapshot.state !== "failed") throw new Error("unreachable");
      expect(snapshot.error.name).toBe("FiberReplayDivergedError");
      expect(instance.stepRuns).toEqual([]);
    });
  });

  it("fails a run whose definition is no longer registered", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: FiberHarnessObject, state) => {
        await instance.lifecycle.start();
        seedFiberRun(state.storage, {
          runId: "ghost-run",
          definition: "ghost",
          state: "pending",
          nextAt: Date.now() - 1000
        });
        await instance.lifecycle.rearmAlarm();
      }
    );

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      const snapshot = await waitForState(instance.fibers, "ghost-run", [
        "failed"
      ]);
      if (snapshot.state !== "failed") throw new Error("unreachable");
      expect(snapshot.error.name).toBe("MissingFiberDefinitionError");
      expect(snapshot.error.message).toContain('"ghost"');
    });
  });

  it("coexists with the Scheduler on the shared alarm", async () => {
    const stub = env.FiberSchedulerCoexistObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: FiberSchedulerCoexistObject, state) => {
        const schedule = await instance.scheduler.set(120, "remind", "tick");
        expect(await state.storage.getAlarm()).toBe(schedule.time * 1000);

        // A sooner fiber deadline wins the shared alarm.
        const receipt = await instance.fibers.run("sleeper", { ms: 60_000 });
        const parked = await waitForState(instance.fibers, receipt.runId, [
          "waiting"
        ]);
        if (parked.state !== "waiting") throw new Error("unreachable");
        expect(parked.wakeAt).toBeLessThan(schedule.time * 1000);
        await waitFor(
          async () => (await state.storage.getAlarm()) === parked.wakeAt
        );

        // Settling every fiber run hands the alarm back to the Scheduler —
        // it is re-armed, not deleted.
        await instance.fibers.cancel(receipt.runId);
        expect(await state.storage.getAlarm()).toBe(schedule.time * 1000);
      }
    );
  });

  it("bounds each alarm batch and continues on follow-up alarms", async () => {
    const stub = env.FiberBatchHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: FiberBatchHarnessObject, state) => {
        await instance.lifecycle.start();
        const base = Date.now() - 10_000;
        for (const n of [1, 2, 3]) {
          seedFiberRun(state.storage, {
            runId: `tick-${n}`,
            definition: "tick",
            input: { n },
            state: "pending",
            nextAt: base + n
          });
        }
        await instance.lifecycle.rearmAlarm();
      }
    );

    // With maxRunsPerAlarm: 1, each alarm invocation claims one run and the
    // post-alarm rearm chains a continuation for the rest.
    await runDurableObjectAlarm(stub);
    await runInDurableObject(
      stub,
      async (instance: FiberBatchHarnessObject) => {
        await waitFor(() => instance.ticks.length === 3);
        // Deadline order was preserved across the chained batches.
        expect(instance.ticks).toEqual(["tick:1", "tick:2", "tick:3"]);
        for (const n of [1, 2, 3]) {
          const snapshot = await instance.fibers.get(`tick-${n}`);
          expect(snapshot?.state).toBe("completed");
        }
      }
    );
  });

  it("removes non-retained records after completion", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      const receipt = await instance.fibers.run(
        "pipeline",
        { label: "gone" },
        { retain: false }
      );
      const deadline = Date.now() + 5_000;
      for (;;) {
        const snapshot = await instance.fibers.get(receipt.runId);
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
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      const receipt = await instance.fibers.run("pipeline", { label: "keep" });
      await waitForState(instance.fibers, receipt.runId, ["completed"]);

      expect(await instance.fibers.delete({ status: ["failed"] })).toBe(0);
      expect(await instance.fibers.delete()).toBe(1);
      expect(await instance.fibers.get(receipt.runId)).toBeNull();
    });
  });

  it("rejects oversized inputs at acceptance", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      await expect(
        instance.fibers.run("pipeline", { label: "x".repeat(1_100_000) })
      ).rejects.toThrow(/exceeds the 1048576-byte limit/);
      expect(await instance.fibers.list()).toEqual([]);
    });
  });

  it("rejects names outside the declared definitions map", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      // Unknown names are a compile error on the typed map; erase the typing
      // to exercise the runtime rejection. The double cast is required: the
      // conditional output type in handle() makes the Handlers generic
      // invariant, so a typed map does not widen to the default surface.
      const untyped = instance.fibers as unknown as Fibers;
      await expect(untyped.run("nope")).rejects.toThrow(
        'Unknown Fiber definition "nope"'
      );
      expect(() => untyped.handle("nope")).toThrow(
        'Unknown Fiber definition "nope"'
      );
      await expect(untyped.run("__cf_internal_x")).rejects.toThrow(/reserved/);
      await expect(untyped.run("")).rejects.toThrow(/non-empty/);

      // A handle is a pure lens over the declared map, so it can be created
      // at any time — including after Lifecycle startup.
      await instance.lifecycle.start();
      expect(instance.fibers.handle("pipeline").name).toBe("pipeline");
    });
  });

  it("invokes recovery on unclean interruption and applies a complete decision", async () => {
    const name = crypto.randomUUID();
    const stub = env.FiberHarnessObject.getByName(name);
    const capture = captureFiberEvents(name);

    try {
      await runInDurableObject(
        stub,
        async (instance: FiberHarnessObject, state) => {
          instance.recoveryMode = "complete";
          await instance.lifecycle.start();
          seedFiberRun(state.storage, {
            runId: "guarded-run",
            definition: "guarded",
            input: { label: "ctx" },
            state: "running",
            generation: "dead-generation",
            attempt: 1,
            nextAt: Date.now() - 1000
          });
          seedFiberStep(state.storage, {
            runId: "guarded-run",
            name: "g-first",
            kind: "do",
            state: "completed",
            result: "g:JOURNAL"
          });
          seedFiberStep(state.storage, {
            runId: "guarded-run",
            name: "g-second",
            kind: "do",
            state: "running",
            attempt: 1,
            checkpoint: { phase: "submitted" }
          });
          await instance.lifecycle.rearmAlarm();
        }
      );

      await runDurableObjectAlarm(stub);

      await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
        const snapshot = await waitForState(instance.fibers, "guarded-run", [
          "completed"
        ]);
        if (snapshot.state !== "completed") throw new Error("unreachable");
        // The recovery decision settled the run; nothing was replayed.
        expect(snapshot.result).toBe("recovered");
        expect(instance.stepRuns).toEqual([]);
        // The callback saw the input, the interrupted step, and its checkpoint.
        expect(instance.recoveryCalls).toEqual([
          'guarded:ctx:g-second:{"phase":"submitted"}'
        ]);
      });
      const types = capture.events.map((event) => event.type);
      expect(types).toContain("fiber:recovery:started");
      expect(types).toContain("fiber:recovery:decided");
    } finally {
      capture.stop();
    }
  });

  it("recovery replay resumes from the journal", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: FiberHarnessObject, state) => {
        instance.recoveryMode = "replay";
        await instance.lifecycle.start();
        seedFiberRun(state.storage, {
          runId: "guarded-replay",
          definition: "guarded",
          input: { label: "rp" },
          state: "running",
          generation: "dead-generation",
          attempt: 1,
          nextAt: Date.now() - 1000
        });
        seedFiberStep(state.storage, {
          runId: "guarded-replay",
          name: "g-first",
          kind: "do",
          state: "completed",
          result: "g:JOURNAL"
        });
        seedFiberStep(state.storage, {
          runId: "guarded-replay",
          name: "g-second",
          kind: "do",
          state: "running",
          attempt: 1
        });
        await instance.lifecycle.rearmAlarm();
      }
    );

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      const snapshot = await waitForState(instance.fibers, "guarded-replay", [
        "completed"
      ]);
      if (snapshot.state !== "completed") throw new Error("unreachable");
      // Replay used the journaled first step and re-executed the second.
      expect(snapshot.result).toBe("run-done:g:JOURNAL");
      expect(instance.stepRuns).toEqual(["guarded:second"]);
      expect(instance.recoveryCalls).toHaveLength(1);
    });
  });

  it("recovery decisions can fail or cancel the run", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: FiberHarnessObject, state) => {
        instance.recoveryMode = "fail";
        await instance.lifecycle.start();
        seedFiberRun(state.storage, {
          runId: "guarded-fail",
          definition: "guarded",
          input: { label: "f" },
          state: "running",
          generation: "dead-generation",
          attempt: 1,
          nextAt: Date.now() - 1000
        });
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(
      stub,
      async (instance: FiberHarnessObject, state) => {
        const failed = await waitForState(instance.fibers, "guarded-fail", [
          "failed"
        ]);
        if (failed.state !== "failed") throw new Error("unreachable");
        expect(failed.error.message).toBe("recover says fail");

        instance.recoveryMode = "cancel";
        seedFiberRun(state.storage, {
          runId: "guarded-cancel",
          definition: "guarded",
          input: { label: "c" },
          state: "running",
          generation: "dead-generation",
          attempt: 1,
          nextAt: Date.now() - 1000
        });
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      const cancelled = await waitForState(instance.fibers, "guarded-cancel", [
        "cancelled"
      ]);
      if (cancelled.state !== "cancelled") throw new Error("unreachable");
      expect(cancelled.reason).toBe("recover says cancel");
    });
  });

  it("clean step failures retry without invoking recovery", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    const runId = await runInDurableObject(
      stub,
      async (instance: FiberHarnessObject) => {
        instance.failuresBeforeSuccess = 1;
        const receipt = await instance.fibers.run("guarded", { label: "r" });
        const parked = await waitForState(instance.fibers, receipt.runId, [
          "waiting"
        ]);
        if (parked.state !== "waiting") throw new Error("unreachable");
        expect(parked.reason).toBe("retry");
        expect(instance.recoveryCalls).toEqual([]);
        return receipt.runId;
      }
    );

    await runInDurableObject(
      stub,
      async (instance: FiberHarnessObject, state) => {
        backdateFiberWake(state.storage, runId, "g-second");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      const snapshot = await waitForState(instance.fibers, runId, [
        "completed"
      ]);
      if (snapshot.state !== "completed") throw new Error("unreachable");
      expect(snapshot.result).toBe("run-done:g:r");
      // The retry policy owned both attempts; recovery never ran.
      expect(instance.recoveryCalls).toEqual([]);
    });
  });

  it("retries a throwing recovery with backoff and exhausts its budget", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: FiberHarnessObject, state) => {
        instance.recoveryMode = "explode";
        await instance.lifecycle.start();
        seedFiberRun(state.storage, {
          runId: "guarded-explode",
          definition: "guarded",
          input: { label: "x" },
          state: "running",
          generation: "dead-generation",
          attempt: 1,
          nextAt: Date.now() - 1000
        });
        seedFiberStep(state.storage, {
          runId: "guarded-explode",
          name: "g-second",
          kind: "do",
          state: "running",
          attempt: 1
        });
        await instance.lifecycle.rearmAlarm();
      }
    );

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      // The first failure parks the run in a visible recovering state with a
      // future backoff deadline.
      const parked = await waitForState(instance.fibers, "guarded-explode", [
        "recovering"
      ]);
      if (parked.state !== "recovering") throw new Error("unreachable");
      expect(parked.interruptedStep).toBe("g-second");
      expect(instance.recoveryCalls).toHaveLength(1);
    });

    // Each backdated wake retries recovery until the budget (5) exhausts.
    for (let round = 2; round <= 5; round++) {
      await runInDurableObject(
        stub,
        async (instance: FiberHarnessObject, state) => {
          backdateFiberWake(state.storage, "guarded-explode");
          await instance.lifecycle.rearmAlarm();
        }
      );
      await runDurableObjectAlarm(stub);
    }

    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      const snapshot = await waitForState(instance.fibers, "guarded-explode", [
        "failed"
      ]);
      if (snapshot.state !== "failed") throw new Error("unreachable");
      expect(snapshot.error.message).toBe("recover exploded");
      expect(instance.recoveryCalls).toHaveLength(5);
    });
  });

  it("replay decisions can defer to a future time", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: FiberHarnessObject, state) => {
        instance.recoveryMode = "replay-later";
        await instance.lifecycle.start();
        seedFiberRun(state.storage, {
          runId: "guarded-later",
          definition: "guarded",
          input: { label: "l" },
          state: "running",
          generation: "dead-generation",
          attempt: 1,
          nextAt: Date.now() - 1000
        });
        await instance.lifecycle.rearmAlarm();
      }
    );

    await runDurableObjectAlarm(stub);

    await runInDurableObject(
      stub,
      async (instance: FiberHarnessObject, state) => {
        const parked = await waitForState(instance.fibers, "guarded-later", [
          "waiting"
        ]);
        if (parked.state !== "waiting") throw new Error("unreachable");
        expect(parked.reason).toBe("recovery");
        expect(parked.wakeAt).toBeGreaterThan(Date.now() + 30_000);

        backdateFiberWake(state.storage, "guarded-later");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      const snapshot = await waitForState(instance.fibers, "guarded-later", [
        "completed"
      ]);
      if (snapshot.state !== "completed") throw new Error("unreachable");
      // The deferred replay ran the whole handler (no journal was seeded).
      expect(snapshot.result).toBe("run-done:g:l");
      expect(instance.stepRuns).toEqual(["guarded:first", "guarded:second"]);
    });
  });

  it("persists step checkpoints for later recovery", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: FiberHarnessObject, state) => {
        const receipt = await instance.fibers.run("checkpointing");
        await waitForState(instance.fibers, receipt.runId, ["completed"]);
        const [row] = state.storage.sql
          .exec(
            "SELECT checkpoint FROM cf_fiber_steps WHERE run_id = ? AND step_name = 'mark'",
            receipt.runId
          )
          .toArray();
        expect(row?.checkpoint).toBe('{"phase":"submitted"}');
      }
    );
  });
});
