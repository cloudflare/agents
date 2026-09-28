import { describe, expect, it } from "vitest";
import { withCapabilityHarness } from "../shared/capability-harness";
import { ScriptedRuntime, gate, setup } from "./scripted";

describe("Driver step", () => {
  it("steps the oldest operation and sleeps until the step's time", async () => {
    await withCapabilityHarness(async (harness) => {
      const until = Date.now() + 60_000;
      const runtime = new ScriptedRuntime().answer({ then: "sleep", until });
      const { driver, cycle, jobTime, submit } = await setup(harness, runtime);
      await submit("op-1");
      await submit("op-2");

      await cycle();

      expect(runtime.operations).toEqual([
        { scope: "main", id: "op-1", input: { text: "op-1" }, attempt: 0 }
      ]);
      expect(jobTime()).toBe(until);
      expect(await driver.pending("main")).toMatchObject([
        { id: "op-1", status: "running" },
        { id: "op-2", status: "queued" }
      ]);
    });
  });

  it("steps again at once after continue", async () => {
    await withCapabilityHarness(async (harness) => {
      const runtime = new ScriptedRuntime().answer({ then: "continue" });
      const { cycle, jobTime, submit } = await setup(harness, runtime);
      await submit("op-1");

      await cycle();

      expect(jobTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  it("parks with no job until woken", async () => {
    await withCapabilityHarness(async (harness) => {
      const runtime = new ScriptedRuntime().answer(
        { then: "park" },
        { then: "done", result: { answer: "ok" } }
      );
      const { driver, cycle, jobTime, submit } = await setup(harness, runtime);
      await submit("op-1");

      await cycle();
      expect(jobTime()).toBeUndefined();
      expect(await driver.pending()).toHaveLength(1);

      expect(await driver.wake("main")).toBe(true);
      await harness.storage.deleteAlarm();
      await cycle();

      expect(runtime.calls).toEqual(["step:op-1", "step:op-1"]);
      expect(await driver.pending()).toEqual([]);
    });
  });

  it("removes a done operation and moves on to the next in its scope", async () => {
    await withCapabilityHarness(async (harness) => {
      const runtime = new ScriptedRuntime().answer(
        { then: "done", result: { answer: "one" } },
        { then: "done", result: { answer: "two" } }
      );
      const { driver, cycle, jobTime, submit } = await setup(harness, runtime);
      await submit("op-1");
      await submit("op-2");

      await cycle();
      expect(await driver.pending()).toMatchObject([{ id: "op-2" }]);
      expect(jobTime()).toBeLessThanOrEqual(Date.now());

      await cycle();
      expect(runtime.calls).toEqual(["step:op-1", "step:op-2"]);
      expect(await driver.pending()).toEqual([]);
      expect(jobTime()).toBeUndefined();
    });
  });

  it("retries a throwing step with backoff and resets the count once one returns", async () => {
    await withCapabilityHarness(async (harness) => {
      const runtime = new ScriptedRuntime().answer(
        async () => {
          throw new Error("model unavailable");
        },
        { then: "sleep", until: Date.now() + 60_000 }
      );
      const { driver, cycle, jobTime, submit } = await setup(harness, runtime, {
        retryBaseMs: 5_000
      });
      await submit("op-1");

      const before = Date.now();
      await cycle();
      expect(jobTime()).toBeGreaterThanOrEqual(before + 5_000);
      expect(await driver.pending()).toMatchObject([{ attempt: 1 }]);

      await cycle();
      expect(runtime.operations.map((operation) => operation.attempt)).toEqual([
        0, 1
      ]);
      expect(await driver.pending()).toMatchObject([{ attempt: 0 }]);
    });
  });

  it("calls onFail after maxAttempts and moves on", async () => {
    await withCapabilityHarness(async (harness) => {
      const boom = async (): Promise<never> => {
        throw new TypeError("broken tool");
      };
      const runtime = new ScriptedRuntime().answer(boom, boom);
      const failures: unknown[] = [];
      const { driver, cycle, jobTime, submit } = await setup(harness, runtime, {
        maxAttempts: 2,
        retryBaseMs: 1,
        onFail: (operation, error) => {
          failures.push({
            id: operation.id,
            attempt: operation.attempt,
            error
          });
        }
      });
      await submit("op-1");
      await submit("op-2");

      await cycle();
      await cycle();

      expect(failures).toEqual([
        {
          id: "op-1",
          attempt: 2,
          error: { name: "TypeError", message: "broken tool" }
        }
      ]);
      expect(await driver.pending()).toMatchObject([
        { id: "op-2", attempt: 0 }
      ]);
      expect(jobTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  it("retries onFail without stepping the operation again", async () => {
    await withCapabilityHarness(async (harness) => {
      const runtime = new ScriptedRuntime().answer(async () => {
        throw new Error("broken");
      });
      let calls = 0;
      const { driver, cycle, submit } = await setup(harness, runtime, {
        maxAttempts: 1,
        retryBaseMs: 1,
        onFail: () => {
          calls += 1;
          if (calls === 1) throw new Error("could not publish the failure");
        }
      });
      await submit("op-1");

      await cycle();
      expect(calls).toBe(1);
      expect(await driver.pending()).toHaveLength(1);

      await cycle();
      expect(calls).toBe(2);
      expect(runtime.calls).toEqual(["step:op-1"]);
      expect(await driver.pending()).toEqual([]);
    });
  });

  it("treats a malformed answer as a throwing step", async () => {
    await withCapabilityHarness(async (harness) => {
      const runtime = new ScriptedRuntime().answer({
        then: "sleep",
        until: Number.NaN
      });
      const { driver, cycle, submit } = await setup(harness, runtime, {
        retryBaseMs: 1
      });
      await submit("op-1");

      await cycle();

      expect(await driver.pending()).toMatchObject([{ attempt: 1 }]);
    });
  });

  it("keeps a wake that lands while a step that parks is in flight", async () => {
    await withCapabilityHarness(async (harness) => {
      const held = gate();
      const runtime = new ScriptedRuntime().answer(async () => {
        await held.promise;
        return { then: "park" };
      });
      const { capability, driver, jobTime, submit } = await setup(
        harness,
        runtime
      );
      await submit("op-1");

      await capability.onJob({ job: capability.jobs()[0], attempt: 1 });
      // An approval answered now must not be lost when the step parks on
      // what it saw before the answer.
      expect(await driver.wake("main")).toBe(true);
      held.open();
      await driver.waitForIdle("main");
      await harness.storage.deleteAlarm();

      expect(jobTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  it("keeps a wake that lands while a step that sleeps is in flight", async () => {
    await withCapabilityHarness(async (harness) => {
      const held = gate();
      const runtime = new ScriptedRuntime().answer(async () => {
        await held.promise;
        return { then: "sleep", until: Date.now() + 60_000 };
      });
      const { capability, driver, jobTime, submit } = await setup(
        harness,
        runtime
      );
      await submit("op-1");

      await capability.onJob({ job: capability.jobs()[0], attempt: 1 });
      expect(await driver.wake("main")).toBe(true);
      held.open();
      await driver.waitForIdle("main");
      await harness.storage.deleteAlarm();

      expect(jobTime()).toBeLessThanOrEqual(Date.now());
    });
  });
});
