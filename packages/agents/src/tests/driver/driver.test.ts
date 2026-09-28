import { describe, expect, it } from "vitest";
import { Driver } from "../../driver";
import type { DriverRuntime } from "../../driver";
import { withCapabilityHarness } from "../shared/capability-harness";

type Input = { text: string };
type Result = { text: string };

function runtime(): DriverRuntime<Input, Result> {
  return {
    inspect: async () => ({ status: "not-admitted" }),
    admit: async () => {},
    drive: async () => ({ status: "waiting", notBefore: Date.now() + 1_000 }),
    cancel: async () => ({ status: "cancelled" })
  };
}

describe("Driver", () => {
  it("atomically accepts a submission and creates one scope job", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const capability = new Driver();
      const driver = capability.register("test", runtime());
      const { lifecycle } = install(capability);
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
      expect(capability.jobs()).toHaveLength(1);
      expect(capability.jobs()[0]).toMatchObject({
        fn: "drive",
        payload: { runtimeId: "test", scope: "lane-a" },
        singleflight: true
      });
      expect(await storage.getAlarm()).not.toBeNull();
      await storage.deleteAlarm();
    });
  });

  it("deduplicates a repeated operation identifier", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const capability = new Driver();
      const driver = capability.register("test", runtime());
      const { lifecycle } = install(capability);
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
      expect(capability.jobs()).toHaveLength(1);
      await storage.deleteAlarm();
    });
  });

  it("recreates missing scope jobs during startup", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const firstCapability = new Driver();
      const first = firstCapability.register("test", runtime());
      const installed = install(firstCapability);
      await installed.lifecycle.start();
      await first.submit("lane-a", { text: "first" }, { operationId: "op-1" });
      storage.sql.exec(
        "DELETE FROM cf_agents_jobs WHERE capability = ?",
        firstCapability.capabilityId
      );
      await installed.lifecycle.rearmAlarm();
      expect(firstCapability.jobs()).toEqual([]);

      const secondCapability = new Driver();
      secondCapability.register("test", runtime());
      const restarted = install(secondCapability);
      await restarted.lifecycle.start();

      expect(secondCapability.jobs()).toHaveLength(1);
      expect(secondCapability.jobs()[0].payload).toEqual({
        runtimeId: "test",
        scope: "lane-a"
      });
      expect(await storage.getAlarm()).not.toBeNull();
      await storage.deleteAlarm();
    });
  });

  it("keeps the queues of two runtimes on one driver apart", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const capability = new Driver();
      const think = capability.register("think", runtime());
      const pi = capability.register("pi", runtime());
      const { lifecycle } = install(capability);
      await lifecycle.start();

      await think.submit("main", { text: "a" }, { operationId: "op-1" });
      await pi.submit("main", { text: "b" }, { operationId: "op-1" });

      expect(await think.pending()).toMatchObject([
        { runtimeId: "think", operationId: "op-1", input: { text: "a" } }
      ]);
      expect(await pi.pending()).toMatchObject([
        { runtimeId: "pi", operationId: "op-1", input: { text: "b" } }
      ]);
      expect(
        capability
          .jobs()
          .map((job) => job.payload)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      ).toEqual([
        { runtimeId: "pi", scope: "main" },
        { runtimeId: "think", scope: "main" }
      ]);
      await storage.deleteAlarm();
    });
  });

  it("rejects an empty or duplicate runtime id", () => {
    const capability = new Driver();
    capability.register("think", runtime());
    expect(() => capability.register("think", runtime())).toThrow(
      "Driver runtime think is already registered"
    );
    expect(() => capability.register(" ", runtime())).toThrow(
      "Driver runtime id must not be empty"
    );
  });

  it("leaves submissions of an unregistered runtime durable", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const firstCapability = new Driver();
      const first = firstCapability.register("gone", runtime());
      const installed = install(firstCapability);
      await installed.lifecycle.start();
      await first.submit("main", { text: "a" }, { operationId: "op-1" });
      const [job] = firstCapability.jobs();

      const secondCapability = new Driver();
      const restarted = install(secondCapability);
      await restarted.lifecycle.start();

      await expect(
        secondCapability.onJob({ job, attempt: 1 })
      ).resolves.toBeUndefined();
      expect(
        storage.sql
          .exec(
            "SELECT operation_id FROM cf_agents_driver_submissions WHERE runtime_id = ?",
            "gone"
          )
          .toArray()
      ).toEqual([{ operation_id: "op-1" }]);
      await storage.deleteAlarm();
    });
  });
});
