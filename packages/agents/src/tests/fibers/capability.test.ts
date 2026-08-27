import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  backdateFiberWake,
  seedFiberRun,
  seedFiberStep,
  type FiberBatchHarnessObject,
  type FiberHarnessObject
} from "../capabilities/fibers";
import { captureDiagnosticsEvents } from "../shared/diagnostics-capture";
import type { FiberRunSnapshot, FiberValue } from "../../fibers";

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
      const first = await instance.pipeline.run(
        { label: "a" },
        { idempotencyKey: "K" }
      );
      expect(first.accepted).toBe(true);
      expect(first.definition).toBe("pipeline");

      // The same idempotency key joins the existing run.
      const joined = await instance.pipeline.run(
        { label: "a" },
        { idempotencyKey: "K" }
      );
      expect(joined.accepted).toBe(false);
      expect(joined.runId).toBe(first.runId);

      // A caller-selected run ID deduplicates the same way.
      const chosen = await instance.pipeline.run(
        { label: "b" },
        { runId: "custom-run" }
      );
      expect(chosen.runId).toBe("custom-run");
      const again = await instance.pipeline.run(
        { label: "b" },
        { runId: "custom-run" }
      );
      expect(again.accepted).toBe(false);

      // Reusing the key under a different definition is an error, not a join.
      await expect(
        instance.flaky.run({ label: "x" }, { idempotencyKey: "K" })
      ).rejects.toThrow(/already belongs to definition "pipeline"/);

      // Handles only see runs of their own definition.
      expect(await instance.flaky.get(first.runId)).toBeNull();
      expect((await instance.pipeline.getByIdempotencyKey("K"))?.runId).toBe(
        first.runId
      );

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
        const receipt = await instance.pipeline.run({ label: "warm" });
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
        const receipt = await instance.flaky.run({ label: "r" });
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
        const receipt = await instance.sleeper.run({ ms: 60_000 });
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
      const receipt = await instance.doomed.run(undefined);
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
        const receipt = await instance.gated.run(undefined);
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
      const receipt = await instance.sleeper.run({ ms: 60_000 });
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
      const receipt = await instance.blocked.run(undefined);
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
      const receipt = await instance.slowpoke.run(undefined);
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
      const receipt = await instance.clash.run(undefined);
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
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: FiberHarnessObject, state) => {
        const schedule = await instance.scheduler.set(120, "remind", "tick");
        expect(await state.storage.getAlarm()).toBe(schedule.time * 1000);

        // A sooner fiber deadline wins the shared alarm.
        const receipt = await instance.sleeper.run({ ms: 60_000 });
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
      const receipt = await instance.pipeline.run(
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
      const receipt = await instance.pipeline.run({ label: "keep" });
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
        instance.pipeline.run({ label: "x".repeat(1_100_000) })
      ).rejects.toThrow(/exceeds the 1048576-byte limit/);
      expect(await instance.fibers.list()).toEqual([]);
    });
  });

  it("validates and locks the definition registry", async () => {
    const stub = env.FiberHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: FiberHarnessObject) => {
      // Before startup, new definitions register freely.
      const fresh = instance.fibers.create("fresh", async () => undefined);
      expect(fresh.name).toBe("fresh");

      expect(() =>
        instance.fibers.create("fresh", async () => undefined)
      ).toThrow(/already registered/);
      expect(() =>
        instance.fibers.create("__cf_internal_x", async () => undefined)
      ).toThrow(/reserved/);
      expect(() => instance.fibers.create("", async () => undefined)).toThrow(
        /non-empty/
      );

      await instance.lifecycle.start();
      expect(() =>
        instance.fibers.create("late", async () => undefined)
      ).toThrow(/after startup/);
    });
  });
});
