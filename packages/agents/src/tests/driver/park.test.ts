import { describe, expect, it } from "vitest";
import { Driver } from "../../driver";
import type {
  DriverDriveResult,
  DriverInspection,
  DriverRuntime
} from "../../driver";
import { withCapabilityHarness } from "../shared/capability-harness";

type Input = { text: string };
type Result = { answer: string };

class Runtime implements DriverRuntime<Input, Result> {
  inspection: DriverInspection<Result> = { status: "not-admitted" };
  driveResult: DriverDriveResult<Result> = { status: "waiting" };
  gate: Promise<void> | undefined;
  calls: string[] = [];

  async inspect() {
    this.calls.push("inspect");
    return this.inspection;
  }

  async admit() {
    this.calls.push("admit");
    this.inspection = { status: "active" };
  }

  async drive() {
    this.calls.push("drive");
    if (this.gate) await this.gate;
    return this.driveResult;
  }

  async cancel() {
    return { status: "cancelled" as const };
  }
}

describe("Driver open-ended waits", () => {
  it("parks a drive that waits without a deadline and holds no job", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      const capability = new Driver();
      const driver = capability.register("test", runtime);
      const { lifecycle } = install(capability);
      await lifecycle.start();
      await driver.submit("main", { text: "hello" }, { operationId: "op-1" });
      await storage.deleteAlarm();

      await capability.onJob({ job: capability.jobs()[0], attempt: 1 });
      await driver.waitForIdle("main");

      expect(runtime.calls).toEqual(["inspect", "admit", "drive"]);
      expect(capability.jobs()).toEqual([]);
      expect(await driver.pending("main")).toMatchObject([
        { operationId: "op-1", status: "admitted" }
      ]);
      await storage.deleteAlarm();
    });
  });

  it("parks at an inspection that waits without a deadline", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      runtime.inspection = { status: "waiting" };
      const capability = new Driver();
      const driver = capability.register("test", runtime);
      const { lifecycle } = install(capability);
      await lifecycle.start();
      await driver.submit("main", { text: "hello" }, { operationId: "op-1" });
      await storage.deleteAlarm();

      await capability.onJob({ job: capability.jobs()[0], attempt: 1 });
      await driver.waitForIdle("main");

      expect(runtime.calls).toEqual(["inspect"]);
      expect(capability.jobs()).toEqual([]);
      await storage.deleteAlarm();
    });
  });

  it("drives a parked scope again when it is woken", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      const capability = new Driver();
      const driver = capability.register("test", runtime);
      const { lifecycle } = install(capability);
      await lifecycle.start();
      await driver.submit("main", { text: "hello" }, { operationId: "op-1" });
      await storage.deleteAlarm();
      await capability.onJob({ job: capability.jobs()[0], attempt: 1 });
      await driver.waitForIdle("main");
      expect(capability.jobs()).toEqual([]);

      runtime.driveResult = { status: "completed", result: { answer: "ok" } };
      expect(await driver.wake("main")).toBe(true);
      await storage.deleteAlarm();
      expect(capability.jobs()).toHaveLength(1);

      await capability.onJob({ job: capability.jobs()[0], attempt: 1 });
      await driver.waitForIdle("main");

      expect(runtime.calls).toEqual([
        "inspect",
        "admit",
        "drive",
        "inspect",
        "drive"
      ]);
      expect(await driver.pending()).toEqual([]);
      expect(capability.jobs()).toEqual([]);
      await storage.deleteAlarm();
    });
  });

  it("keeps a wake that lands while the drive is in flight", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      let release!: () => void;
      runtime.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const capability = new Driver();
      const driver = capability.register("test", runtime);
      const { lifecycle } = install(capability);
      await lifecycle.start();
      await driver.submit("main", { text: "hello" }, { operationId: "op-1" });
      await storage.deleteAlarm();

      await capability.onJob({ job: capability.jobs()[0], attempt: 1 });
      // The drive has not returned yet. An approval answered now must not
      // be lost when the drive parks on what it saw before the answer.
      expect(await driver.wake("main")).toBe(true);
      release();
      await driver.waitForIdle("main");

      const before = Date.now();
      expect(capability.jobs()).toHaveLength(1);
      expect(capability.jobs()[0].time).toBeLessThanOrEqual(before);
      await storage.deleteAlarm();
    });
  });

  it("keeps a wake that lands before a deadline reschedule", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      runtime.driveResult = {
        status: "waiting",
        notBefore: Date.now() + 60_000
      };
      let release!: () => void;
      runtime.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const capability = new Driver();
      const driver = capability.register("test", runtime);
      const { lifecycle } = install(capability);
      await lifecycle.start();
      await driver.submit("main", { text: "hello" }, { operationId: "op-1" });
      await storage.deleteAlarm();

      await capability.onJob({ job: capability.jobs()[0], attempt: 1 });
      expect(await driver.wake("main")).toBe(true);
      release();
      await driver.waitForIdle("main");

      expect(capability.jobs()).toHaveLength(1);
      expect(capability.jobs()[0].time).toBeLessThanOrEqual(Date.now());
      await storage.deleteAlarm();
    });
  });
});
