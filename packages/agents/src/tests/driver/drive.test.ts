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
