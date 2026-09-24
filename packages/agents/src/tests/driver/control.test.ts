import { describe, expect, it } from "vitest";
import { HarnessDriver } from "../../driver";
import type { HarnessDriverRuntime } from "../../driver";
import { withCapabilityHarness } from "../shared/capability-harness";

type Input = { text: string };
type Result = { answer: string };

class Runtime implements HarnessDriverRuntime<Input, Result> {
  cancelled: string[] = [];
  cancelResult:
    | { status: "cancelled" }
    | { status: "not-found" }
    | { status: "pending"; notBefore?: number } = { status: "cancelled" };

  async inspect() {
    return { status: "not-admitted" } as const;
  }

  async admit() {}

  async drive() {
    return { status: "continue" } as const;
  }

  async cancel(_scope: string, operationId: string) {
    this.cancelled.push(operationId);
    return this.cancelResult;
  }
}

describe("HarnessDriver control", () => {
  it("returns false when waking or deferring an unknown scope", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const driver = new HarnessDriver({ id: "test", runtime: new Runtime() });
      const { lifecycle } = install(driver);
      await lifecycle.start();

      expect(await driver.wake("missing")).toBe(false);
      expect(await driver.defer("missing", Date.now())).toBe(false);
      await expect(driver.defer("missing", Number.NaN)).rejects.toThrow(
        "Invalid job time"
      );
    });
  });
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
            return runtime.cancel(scope, operationId);
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

  it("keeps cancellation intake until the runtime acknowledges it", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      const notBefore = Date.now() + 60_000;
      runtime.cancelResult = { status: "pending", notBefore };
      const driver = new HarnessDriver({ id: "test", runtime });
      const { lifecycle } = install(driver);
      await lifecycle.start();
      await driver.submit("main", { text: "first" }, { operationId: "op-1" });
      await storage.deleteAlarm();

      expect(await driver.cancel("op-1")).toBe(true);
      await storage.deleteAlarm();

      expect(await driver.pending()).toMatchObject([
        { operationId: "op-1", cancelRequested: true }
      ]);
      expect(driver.jobs()[0].time).toBe(notBefore);
      await storage.deleteAlarm();
    });
  });

  it("keeps cancellation intake when the runtime throws", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      runtime.cancel = async () => {
        throw new Error("cancel unavailable");
      };
      const driver = new HarnessDriver({ id: "test", runtime });
      const { lifecycle } = install(driver);
      await lifecycle.start();
      await driver.submit("main", { text: "first" }, { operationId: "op-1" });
      await storage.deleteAlarm();

      await expect(driver.cancel("op-1")).rejects.toThrow("cancel unavailable");

      expect(await driver.pending()).toMatchObject([
        { operationId: "op-1", cancelRequested: true }
      ]);
      expect(driver.jobs()).toHaveLength(1);
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
