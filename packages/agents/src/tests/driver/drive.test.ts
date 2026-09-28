import { describe, expect, it } from "vitest";
import { HarnessDriver } from "../../driver";
import type {
  HarnessDriverInspection,
  HarnessDriverRuntime,
  HarnessDriverSubmission
} from "../../driver";
import { withCapabilityHarness } from "../shared/capability-harness";

type Input = { text: string };
type Result = { answer: string };

class Runtime implements HarnessDriverRuntime<Input, Result> {
  inspection: HarnessDriverInspection<Result> = { status: "not-admitted" };
  driveResult:
    | { status: "continue" }
    | { status: "waiting"; notBefore: number }
    | { status: "completed"; result: Result } = { status: "continue" };
  calls: string[] = [];

  async inspect(_scope: string, _operationId: string) {
    this.calls.push("inspect");
    return this.inspection;
  }

  async admit(_scope: string, _operationId: string, _input: Input) {
    this.calls.push("admit");
    this.inspection = { status: "active" };
  }

  async drive(_scope: string, _operationId: string, _signal: AbortSignal) {
    this.calls.push("drive");
    return this.driveResult;
  }

  async cancel(_scope: string, _operationId: string) {
    this.calls.push("cancel");
    return { status: "cancelled" as const };
  }
}

describe("HarnessDriver drive", () => {
  it("admits the queue head and reschedules a native wait", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      const notBefore = Date.now() + 60_000;
      runtime.driveResult = { status: "waiting", notBefore };
      const driver = new HarnessDriver({ id: "test", runtime });
      const { lifecycle } = install(driver);
      await lifecycle.start();
      await driver.submit("main", { text: "hello" }, { operationId: "op-1" });
      await storage.deleteAlarm();

      await driver.onJob({ job: driver.jobs()[0], attempt: 1 });
      await driver.waitForIdle("main");

      expect(runtime.calls).toEqual(["inspect", "admit", "drive"]);
      expect(driver.jobs()[0].time).toBe(notBefore);
      expect(await driver.pending("main")).toMatchObject([
        { operationId: "op-1", status: "admitted" }
      ]);
      await storage.deleteAlarm();
    });
  });

  it("parks at a native inspection deadline without driving", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      const notBefore = Date.now() + 60_000;
      runtime.inspection = { status: "waiting", notBefore };
      const driver = new HarnessDriver({ id: "test", runtime });
      const { lifecycle } = install(driver);
      await lifecycle.start();
      await driver.submit("main", { text: "hello" }, { operationId: "op-1" });
      await storage.deleteAlarm();

      await driver.onJob({ job: driver.jobs()[0], attempt: 1 });
      await driver.waitForIdle("main");

      expect(runtime.calls).toEqual(["inspect"]);
      expect(driver.jobs()[0].time).toBe(notBefore);
      await storage.deleteAlarm();
    });
  });

  it("reconciles native admission before the driver acknowledgement", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      runtime.inspection = { status: "active" };
      runtime.driveResult = {
        status: "waiting",
        notBefore: Date.now() + 60_000
      };
      const driver = new HarnessDriver({ id: "test", runtime });
      const { lifecycle } = install(driver);
      await lifecycle.start();
      await driver.submit("main", { text: "hello" }, { operationId: "op-1" });
      await storage.deleteAlarm();

      await driver.onJob({ job: driver.jobs()[0], attempt: 1 });
      await driver.waitForIdle("main");

      expect(runtime.calls).toEqual(["inspect", "drive"]);
      expect(await driver.pending("main")).toMatchObject([
        { operationId: "op-1", status: "admitted" }
      ]);
      await storage.deleteAlarm();
    });
  });

  it("settles the native result before removing intake", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      runtime.inspection = { status: "completed", result: { answer: "done" } };
      const settled: Array<{
        submission: HarnessDriverSubmission<Input>;
        result: Result;
        intakePresent: boolean;
      }> = [];
      let driver: HarnessDriver<Input, Result>;
      driver = new HarnessDriver({
        id: "test",
        runtime,
        settle: async (submission, result) => {
          settled.push({
            submission,
            result,
            intakePresent: (await driver.pending()).length === 1
          });
        }
      });
      const { lifecycle } = install(driver);
      await lifecycle.start();
      await driver.submit("main", { text: "hello" }, { operationId: "op-1" });
      await storage.deleteAlarm();

      await driver.onJob({ job: driver.jobs()[0], attempt: 1 });
      await driver.waitForIdle("main");
      expect(settled).toMatchObject([
        {
          submission: { operationId: "op-1" },
          result: { answer: "done" },
          intakePresent: true
        }
      ]);
      expect(await driver.pending()).toEqual([]);
      await storage.deleteAlarm();
    });
  });

  it("terminalizes a permanently throwing adapter after bounded attempts", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      let inspections = 0;
      const failures: Array<{ name: string; message: string }> = [];
      const runtime: HarnessDriverRuntime<Input, Result> = {
        inspect: async () => {
          inspections += 1;
          throw new TypeError("adapter unavailable");
        },
        admit: async () => {},
        drive: async () => ({ status: "continue" }),
        cancel: async () => ({ status: "cancelled" })
      };
      const driver = new HarnessDriver({
        id: "test",
        runtime,
        maxAttempts: 3,
        retryBaseMs: 1,
        fail: (_submission, error) => {
          failures.push(error);
        }
      });
      const { lifecycle } = install(driver);
      await lifecycle.start();
      await driver.submit("main", { text: "hello" }, { operationId: "op-1" });
      await storage.deleteAlarm();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await driver.onJob({ job: driver.jobs()[0], attempt: 1 });
        await driver.waitForIdle("main");
      }

      expect(inspections).toBe(3);
      expect(failures).toEqual([
        { name: "TypeError", message: "adapter unavailable" }
      ]);
      expect(await driver.pending()).toEqual([]);
      expect(driver.jobs()).toEqual([]);
      await storage.deleteAlarm();
    });
  });

  it("retries terminal failure settlement without reinspecting native work", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      runtime.inspection = {
        status: "failed",
        error: { name: "NativeError", message: "native failure" }
      };
      let settlements = 0;
      const driver = new HarnessDriver({
        id: "test",
        runtime,
        retryBaseMs: 1,
        fail: () => {
          settlements += 1;
          if (settlements === 1) throw new Error("stream unavailable");
        }
      });
      const { lifecycle } = install(driver);
      await lifecycle.start();
      await driver.submit("main", { text: "hello" }, { operationId: "op-1" });
      await storage.deleteAlarm();

      await driver.onJob({ job: driver.jobs()[0], attempt: 1 });
      await driver.waitForIdle("main");
      expect(await driver.pending()).toMatchObject([
        {
          operationId: "op-1",
          failure: { name: "NativeError", message: "native failure" }
        }
      ]);

      await driver.onJob({ job: driver.jobs()[0], attempt: 1 });
      await driver.waitForIdle("main");

      expect(runtime.calls).toEqual(["inspect"]);
      expect(settlements).toBe(2);
      expect(await driver.pending()).toEqual([]);
      await storage.deleteAlarm();
    });
  });

  it("retries completed result settlement without failing native work", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      runtime.inspection = { status: "completed", result: { answer: "done" } };
      let settlements = 0;
      let failures = 0;
      const driver = new HarnessDriver({
        id: "test",
        runtime,
        retryBaseMs: 1,
        settle: () => {
          settlements += 1;
          if (settlements === 1) throw new Error("stream unavailable");
        },
        fail: () => {
          failures += 1;
        }
      });
      const { lifecycle } = install(driver);
      await lifecycle.start();
      await driver.submit("main", { text: "hello" }, { operationId: "op-1" });
      await storage.deleteAlarm();

      await driver.onJob({ job: driver.jobs()[0], attempt: 1 });
      await driver.waitForIdle("main");
      await driver.onJob({ job: driver.jobs()[0], attempt: 1 });
      await driver.waitForIdle("main");

      expect(settlements).toBe(2);
      expect(failures).toBe(0);
      expect(await driver.pending()).toEqual([]);
      await storage.deleteAlarm();
    });
  });

  it("settles only the queue head and yields for the next submission", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      runtime.inspection = { status: "completed", result: { answer: "done" } };
      const driver = new HarnessDriver({ id: "test", runtime });
      const { lifecycle } = install(driver);
      await lifecycle.start();
      await driver.submit("main", { text: "first" }, { operationId: "op-1" });
      await driver.submit("main", { text: "second" }, { operationId: "op-2" });
      await storage.deleteAlarm();

      await driver.onJob({ job: driver.jobs()[0], attempt: 1 });
      await driver.waitForIdle("main");

      expect(driver.jobs()).toHaveLength(1);
      expect(
        (await driver.pending("main")).map((row) => row.operationId)
      ).toEqual(["op-2"]);
      await storage.deleteAlarm();
    });
  });
});
