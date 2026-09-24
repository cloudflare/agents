import { describe, expect, it } from "vitest";
import { HarnessDriver } from "../../driver";
import type { HarnessDriverRuntime } from "../../driver";
import { withCapabilityHarness } from "../shared/capability-harness";

type Input = { text: string };
type Result = { answer: string };

class Runtime implements HarnessDriverRuntime<Input, Result> {
  cancelled: string[] = [];

  async inspect() {
    return { status: "not-admitted" } as const;
  }

  async admit() {}

  async drive() {
    return { status: "continue" } as const;
  }

  async cancel(_scope: string, operationId: string) {
    this.cancelled.push(operationId);
  }
}

describe("HarnessDriver control", () => {
  it("wakes a future scope job without changing intake order", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      const driver = new HarnessDriver({ id: "test", runtime });
      const { lifecycle } = install(driver);
      await lifecycle.start();
      await driver.submit("main", { text: "first" }, { operationId: "op-1" });
      await driver.submit("main", { text: "second" }, { operationId: "op-2" });
      await storage.deleteAlarm();
      const future = Date.now() + 60_000;
      await driver.defer("main", future);
      await storage.deleteAlarm();
      expect(driver.jobs()[0].time).toBe(future);

      const before = Date.now();
      expect(await driver.wake("main")).toBe(true);
      await storage.deleteAlarm();

      expect(driver.jobs()[0].time).toBeGreaterThanOrEqual(before);
      expect(driver.jobs()[0].time).toBeLessThan(future);
      expect(
        (await driver.pending("main")).map((row) => row.operationId)
      ).toEqual(["op-1", "op-2"]);
      await storage.deleteAlarm();
    });
  });

  it("cancels native work before removing its intake row", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      let driver: HarnessDriver<Input, Result>;
      let intakePresent = false;
      driver = new HarnessDriver({
        id: "test",
        runtime: {
          ...runtime,
          inspect: runtime.inspect.bind(runtime),
          admit: runtime.admit.bind(runtime),
          drive: runtime.drive.bind(runtime),
          cancel: async (scope, operationId) => {
            intakePresent = (await driver.pending(scope)).length === 1;
            await runtime.cancel(scope, operationId);
          }
        }
      });
      const { lifecycle } = install(driver);
      await lifecycle.start();
      await driver.submit("main", { text: "first" }, { operationId: "op-1" });
      await storage.deleteAlarm();

      expect(await driver.cancel("op-1")).toBe(true);

      expect(intakePresent).toBe(true);
      expect(runtime.cancelled).toEqual(["op-1"]);
      expect(await driver.pending()).toEqual([]);
      expect(driver.jobs()).toEqual([]);
      expect(await storage.getAlarm()).toBeNull();
    });
  });

  it("keeps the scope job when cancellation reveals more queued work", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      const driver = new HarnessDriver({ id: "test", runtime });
      const { lifecycle } = install(driver);
      await lifecycle.start();
      await driver.submit("main", { text: "first" }, { operationId: "op-1" });
      await driver.submit("main", { text: "second" }, { operationId: "op-2" });
      await storage.deleteAlarm();

      expect(await driver.cancel("op-1")).toBe(true);
      await storage.deleteAlarm();

      expect(
        (await driver.pending("main")).map((row) => row.operationId)
      ).toEqual(["op-2"]);
      expect(driver.jobs()).toHaveLength(1);
      expect(driver.jobs()[0].payload).toEqual({ scope: "main" });
      await storage.deleteAlarm();
    });
  });

  it("returns false when cancellation finds no operation", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const runtime = new Runtime();
      const driver = new HarnessDriver({ id: "test", runtime });
      const { lifecycle } = install(driver);
      await lifecycle.start();

      expect(await driver.cancel("missing")).toBe(false);
      expect(runtime.cancelled).toEqual([]);
    });
  });
});
