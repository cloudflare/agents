import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import { getAgentByName } from "..";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("schedule operations", () => {
  describe("cancelSchedule", () => {
    it("should return false when cancelling a non-existent schedule", async () => {
      const agentStub = await getAgentByName(
        env.TestScheduleAgent,
        "cancel-nonexistent-test"
      );

      // This should NOT throw, and should return false
      const result = await agentStub.cancelScheduleById("non-existent-id");
      expect(result).toBe(false);
    });

    it("should return true when cancelling an existing schedule", async () => {
      const agentStub = await getAgentByName(
        env.TestScheduleAgent,
        "cancel-existing-test"
      );

      // Create a schedule first (60 seconds delay)
      const scheduleId = await agentStub.createSchedule(60);

      // Cancel should succeed and return true
      const result = await agentStub.cancelScheduleById(scheduleId);
      expect(result).toBe(true);
    });
  });

  describe("getSchedule", () => {
    it("should return undefined when getting a non-existent schedule", async () => {
      const agentStub = await getAgentByName(
        env.TestScheduleAgent,
        "get-nonexistent-test"
      );

      const result = await agentStub.getScheduleById("non-existent-id");
      expect(result).toBeUndefined();
    });

    it("should return schedule when getting an existing schedule", async () => {
      const agentStub = await getAgentByName(
        env.TestScheduleAgent,
        "get-existing-test"
      );

      // Create a schedule first (60 seconds delay)
      const scheduleId = await agentStub.createSchedule(60);

      const result = await agentStub.getScheduleById(scheduleId);
      expect(result).toBeDefined();
      expect(result?.id).toBe(scheduleId);
      expect(result?.callback).toBe("testCallback");
    });
  });

  describe("scheduleEvery (interval scheduling)", () => {
    it("should create an interval schedule with correct type", async () => {
      const agentStub = await getAgentByName(
        env.TestScheduleAgent,
        "interval-create-test"
      );

      const scheduleId = await agentStub.createIntervalSchedule(30);

      const result = await agentStub.getScheduleById(scheduleId);
      expect(result).toBeDefined();
      expect(result?.type).toBe("interval");
      if (result?.type === "interval") {
        expect(result.intervalSeconds).toBe(30);
      }
      expect(result?.callback).toBe("intervalCallback");
    });

    it("should cancel an interval schedule", async () => {
      const agentStub = await getAgentByName(
        env.TestScheduleAgent,
        "interval-cancel-test"
      );

      const scheduleId = await agentStub.createIntervalSchedule(30);

      // Verify it exists
      const beforeCancel = await agentStub.getScheduleById(scheduleId);
      expect(beforeCancel).toBeDefined();

      // Cancel it
      const cancelled = await agentStub.cancelScheduleById(scheduleId);
      expect(cancelled).toBe(true);

      // Verify it's gone
      const afterCancel = await agentStub.getScheduleById(scheduleId);
      expect(afterCancel).toBeUndefined();
    });

    it("should filter schedules by interval type", async () => {
      const agentStub = await getAgentByName(
        env.TestScheduleAgent,
        "interval-filter-test"
      );

      // Create a delayed schedule
      await agentStub.createSchedule(60);

      // Create an interval schedule
      await agentStub.createIntervalSchedule(30);

      // Get only interval schedules
      const intervalSchedules = await agentStub.getSchedulesByType("interval");
      expect(intervalSchedules.length).toBe(1);
      expect(intervalSchedules[0].type).toBe("interval");

      // Get only delayed schedules
      const delayedSchedules = await agentStub.getSchedulesByType("delayed");
      expect(delayedSchedules.length).toBe(1);
      expect(delayedSchedules[0].type).toBe("delayed");
    });

    it("should persist interval schedule after callback throws", async () => {
      const agentStub = await getAgentByName(
        env.TestScheduleAgent,
        "interval-error-resilience-test"
      );

      // Create an interval schedule with a throwing callback
      const scheduleId = await agentStub.createThrowingIntervalSchedule(1);

      // Let the alarm run (the callback will throw)
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // The schedule should still exist (not deleted like one-time schedules)
      const result = await agentStub.getScheduleById(scheduleId);
      expect(result).toBeDefined();
      expect(result?.type).toBe("interval");
    });
  });
});
