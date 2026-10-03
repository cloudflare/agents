import { describe, expect, it } from "vitest";
import type { DriverRuntime } from "../../driver";
import { withCapabilityHarness } from "../shared/capability-harness";
import {
  type Input,
  type Result,
  ScriptedRuntime,
  gate,
  setup
} from "./scripted";

describe("Driver stop", () => {
  it("returns false for an unknown scope or operation", async () => {
    await withCapabilityHarness(async (harness) => {
      const { driver } = await setup(harness);

      expect(await driver.wake("missing")).toBe(false);
      expect(await driver.stop("missing")).toBe(false);
    });
  });

  it("stops a queued operation without touching the one in front of it", async () => {
    await withCapabilityHarness(async (harness) => {
      const runtime = new ScriptedRuntime().answer({ then: "park" });
      const { driver, cycle, jobTime, submit } = await setup(harness, runtime);
      await submit("op-1");
      await submit("op-2");
      await cycle();
      expect(jobTime()).toBeUndefined();

      expect(await driver.stop("op-2")).toBe(true);

      expect(runtime.calls).toEqual(["step:op-1", "stop:op-2"]);
      expect(await driver.pending()).toMatchObject([{ id: "op-1" }]);
      // op-1 is still parked: stopping op-2 did not wake it.
      expect(jobTime()).toBeUndefined();
    });
  });

  it("stops the oldest operation and moves on to the next", async () => {
    await withCapabilityHarness(async (harness) => {
      const runtime = new ScriptedRuntime().answer({ then: "park" });
      const { driver, cycle, jobTime, submit } = await setup(harness, runtime);
      await submit("op-1");
      await submit("op-2");
      await cycle();

      expect(await driver.stop("op-1")).toBe(true);
      await harness.storage.deleteAlarm();

      expect(await driver.pending()).toMatchObject([{ id: "op-2" }]);
      expect(jobTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  it("keeps the operation until the runtime's stop resolves", async () => {
    await withCapabilityHarness(async (harness) => {
      const runtime = new ScriptedRuntime().answer({ then: "park" });
      let stops = 0;
      runtime.stopAnswer = async () => {
        stops += 1;
        if (stops === 1) throw new Error("sandbox unreachable");
      };
      const { driver, cycle, jobTime, submit } = await setup(harness, runtime, {
        retryBaseMs: 1
      });
      await submit("op-1");
      await cycle();

      await expect(driver.stop("op-1")).rejects.toThrow("sandbox unreachable");
      await harness.storage.deleteAlarm();
      expect(await driver.pending()).toMatchObject([
        { id: "op-1", stopRequested: true }
      ]);
      expect(jobTime()).toBeDefined();

      // The loop retries the stop. It does not step a stopping operation.
      await cycle();
      expect(runtime.calls).toEqual(["step:op-1", "stop:op-1", "stop:op-1"]);
      expect(await driver.pending()).toEqual([]);
    });
  });

  it("removes the operation when the runtime has no stop", async () => {
    await withCapabilityHarness(async (harness) => {
      const runtime: DriverRuntime<Input, Result> = {
        step: async () => ({ then: "park" })
      };
      const { driver, cycle, submit } = await setup(harness, runtime);
      await submit("op-1");
      await cycle();

      expect(await driver.stop("op-1")).toBe(true);
      expect(await driver.pending()).toEqual([]);
    });
  });

  it("aborts the running step and waits for it before stopping", async () => {
    await withCapabilityHarness(async (harness) => {
      const started = gate();
      const runtime = new ScriptedRuntime().answer(
        async (_operation, signal) => {
          started.open();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              runtime.calls.push("step:aborted");
              // Unwinding takes a moment, like a model stream closing.
              setTimeout(() => {
                runtime.calls.push("step:unwound");
                reject(signal.reason);
              }, 20);
            });
          });
          return { then: "continue" };
        }
      );
      const failures: unknown[] = [];
      const { capability, driver, jobTime, submit } = await setup(
        harness,
        runtime,
        {
          maxAttempts: 1,
          onFail: (operation) => {
            failures.push(operation.id);
          }
        }
      );
      await submit("op-1");
      await submit("op-2");

      await capability.onJob({ job: capability.jobs()[0], attempt: 1 });
      await started.promise;
      expect(await driver.stop("op-1")).toBe(true);
      await harness.storage.deleteAlarm();

      expect(runtime.calls).toEqual([
        "step:op-1",
        "step:aborted",
        "step:unwound",
        "stop:op-1"
      ]);
      // The aborted step's error is not a failure, and nobody else pays for it.
      expect(failures).toEqual([]);
      expect(await driver.pending()).toMatchObject([
        { id: "op-2", attempt: 0, stopRequested: false }
      ]);
      expect(jobTime()).toBeLessThanOrEqual(Date.now());
    });
  });
});
