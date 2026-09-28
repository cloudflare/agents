import { describe, expect, it } from "vitest";
import { HarnessDriver } from "../../driver";
import type { HarnessDriverRuntime } from "../../driver";
import { withCapabilityHarness } from "../shared/capability-harness";

type Input = { text: string };
type Result = { text: string };

function runtime(): HarnessDriverRuntime<Input, Result> {
  return {
    inspect: async () => ({ status: "not-admitted" }),
    admit: async () => {},
    drive: async () => ({ status: "waiting", notBefore: Date.now() + 1_000 }),
    cancel: async () => ({ status: "cancelled" })
  };
}

describe("HarnessDriver", () => {
  it("atomically accepts a submission and creates one scope job", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const driver = new HarnessDriver({ id: "test", runtime: runtime() });
      const { lifecycle } = install(driver);
      await lifecycle.start();

      const before = Date.now();
      const receipt = await driver.submit(
        "lane-a",
        { text: "hello" },
        { operationId: "op-1", streamId: "stream-1" }
      );

      expect(receipt).toMatchObject({
        operationId: "op-1",
        scope: "lane-a",
        accepted: true
      });
      expect(receipt.submittedAt).toBeGreaterThanOrEqual(before);
      expect(await driver.pending("lane-a")).toMatchObject([
        {
          operationId: "op-1",
          input: { text: "hello" },
          streamId: "stream-1",
          status: "queued"
        }
      ]);
      expect(driver.jobs()).toHaveLength(1);
      expect(driver.jobs()[0]).toMatchObject({
        fn: "drive",
        payload: { scope: "lane-a" },
        singleflight: true
      });
      expect(await storage.getAlarm()).not.toBeNull();
      await storage.deleteAlarm();
    });
  });

  it("deduplicates a repeated operation identifier", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const driver = new HarnessDriver({ id: "test", runtime: runtime() });
      const { lifecycle } = install(driver);
      await lifecycle.start();

      const first = await driver.submit(
        "lane-a",
        { text: "first" },
        { operationId: "op-1" }
      );
      const duplicate = await driver.submit(
        "lane-b",
        { text: "second" },
        { operationId: "op-1" }
      );

      expect(first.accepted).toBe(true);
      expect(duplicate).toEqual({ ...first, accepted: false });
      expect(await driver.pending()).toHaveLength(1);
      expect(driver.jobs()).toHaveLength(1);
      await storage.deleteAlarm();
    });
  });

  it("recreates missing scope jobs during startup", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const first = new HarnessDriver({ id: "test", runtime: runtime() });
      const installed = install(first);
      await installed.lifecycle.start();
      await first.submit("lane-a", { text: "first" }, { operationId: "op-1" });
      storage.sql.exec(
        "DELETE FROM cf_agents_jobs WHERE capability = ?",
        first.capabilityId
      );
      await installed.lifecycle.rearmAlarm();
      expect(first.jobs()).toEqual([]);

      const second = new HarnessDriver({ id: "test", runtime: runtime() });
      const restarted = install(second);
      await restarted.lifecycle.start();

      expect(second.jobs()).toHaveLength(1);
      expect(second.jobs()[0].payload).toEqual({ scope: "lane-a" });
      expect(await storage.getAlarm()).not.toBeNull();
      await storage.deleteAlarm();
    });
  });
});
