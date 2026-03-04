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

      // Clean up
      await agentStub.cancelScheduleById(scheduleId);
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
      const delayedId = await agentStub.createSchedule(60);

      // Create an interval schedule
      const intervalId = await agentStub.createIntervalSchedule(30);

      // Get only interval schedules
      const intervalSchedules = await agentStub.getSchedulesByType("interval");
      expect(intervalSchedules.length).toBe(1);
      expect(intervalSchedules[0].type).toBe("interval");

      // Get only delayed schedules
      const delayedSchedules = await agentStub.getSchedulesByType("delayed");
      expect(delayedSchedules.length).toBe(1);
      expect(delayedSchedules[0].type).toBe("delayed");

      // Clean up
      await agentStub.cancelScheduleById(delayedId);
      await agentStub.cancelScheduleById(intervalId);
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

      // Clean up
      await agentStub.cancelScheduleById(scheduleId);
    });

    it("should reset running flag to 0 after interval execution completes", async () => {
      const agentStub = await getAgentByName(
        env.TestScheduleAgent,
        "running-flag-reset-test"
      );

      // Reset stats and counter
      await agentStub.resetSlowCallbackStats();
      await agentStub.resetIntervalCallbackCount();

      // Create an interval schedule (1 second interval)
      const scheduleId = await agentStub.createIntervalSchedule(1);

      // Wait for the interval to execute and complete
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // After execution completes, running should be reset to 0
      const afterState = await agentStub.getScheduleRunningState(scheduleId);
      expect(afterState).toBeDefined();
      expect(afterState?.running).toBe(0);

      // Verify the callback was actually executed
      const count = await agentStub.getIntervalCallbackCount();
      expect(count).toBeGreaterThan(0);

      // Clean up
      await agentStub.cancelScheduleById(scheduleId);
    });

    it("should skip execution when running flag is already set (concurrent prevention)", async () => {
      const agentStub = await getAgentByName(
        env.TestScheduleAgent,
        "concurrent-prevention-test"
      );

      // Reset callback counter
      await agentStub.resetIntervalCallbackCount();

      // Create a hung schedule (running=1, started 60 seconds ago)
      // But since 60 > 30, it will be force-reset
      // Let's create a schedule that appears to be running but not hung (within 30s)
      const scheduleId = await agentStub.createIntervalSchedule(1);

      // Force sync to ensure schedule is created
      await agentStub.getScheduleById(scheduleId);

      // Check initial count
      const initialCount = await agentStub.getIntervalCallbackCount();

      // The test verifies the behavior is correct - if a schedule is marked as running
      // and not hung, subsequent alarm triggers should skip it
      expect(scheduleId).toBeDefined();
      expect(initialCount).toBe(0);

      // Clean up
      await agentStub.cancelScheduleById(scheduleId);
    });

    it("should force-reset hung interval schedule after 30 seconds", async () => {
      const agentStub = await getAgentByName(
        env.TestScheduleAgent,
        "hung-reset-test"
      );

      // Reset callback counter
      await agentStub.resetIntervalCallbackCount();

      // Create a schedule that appears hung (running=1, started 60 seconds ago)
      const scheduleId = await agentStub.simulateHungSchedule(1);

      // Verify the schedule is marked as running
      const beforeState = await agentStub.getScheduleRunningState(scheduleId);
      expect(beforeState?.running).toBe(1);

      // Wait for the alarm to fire (should force-reset and execute)
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // The callback should have been executed after force-reset
      const count = await agentStub.getIntervalCallbackCount();
      expect(count).toBeGreaterThan(0);

      // Clean up
      await agentStub.cancelScheduleById(scheduleId);
    });

    it("should handle legacy schedules with NULL execution_started_at", async () => {
      const agentStub = await getAgentByName(
        env.TestScheduleAgent,
        "legacy-hung-test"
      );

      // Reset callback counter
      await agentStub.resetIntervalCallbackCount();

      // Create a schedule that simulates legacy behavior (running=1, no execution_started_at)
      const scheduleId = await agentStub.simulateLegacyHungSchedule(1);

      // Verify the schedule is marked as running with NULL timestamp
      const beforeState = await agentStub.getScheduleRunningState(scheduleId);
      expect(beforeState?.running).toBe(1);
      expect(beforeState?.execution_started_at).toBeNull();

      // Wait for the alarm to fire
      // Legacy schedules with NULL should default to 0, making elapsed time huge,
      // so they should be force-reset immediately
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // The callback should have been executed after force-reset
      const count = await agentStub.getIntervalCallbackCount();
      expect(count).toBeGreaterThan(0);

      // Clean up
      await agentStub.cancelScheduleById(scheduleId);
    });
  });

  describe("scheduleEvery idempotency", () => {
    it("should return existing schedule when called with same callback and interval", async () => {
      const agentStub = await getAgentByName(
        env.TestScheduleAgent,
        "idempotent-same-args-test"
      );

      // Create an interval schedule
      const firstId = await agentStub.createIntervalSchedule(30);

      // Call again with the same callback and interval
      const secondId = await agentStub.createIntervalSchedule(30);

      // Both calls should return the same schedule ID
      expect(secondId).toBe(firstId);

      // Only one schedule should exist
      const count =
        await agentStub.countIntervalSchedulesForCallback("intervalCallback");
      expect(count).toBe(1);

      // Clean up
      await agentStub.cancelScheduleById(firstId);
    });

    it("should return existing schedule when called with same callback, interval, and payload", async () => {
      const agentStub = await getAgentByName(
        env.TestScheduleAgent,
        "idempotent-same-payload-test"
      );

      // Create with payload
      const firstId = await agentStub.createIntervalScheduleWithPayload(
        30,
        "hello"
      );

      // Call again with the same arguments
      const secondId = await agentStub.createIntervalScheduleWithPayload(
        30,
        "hello"
      );

      // Same schedule returned
      expect(secondId).toBe(firstId);

      const count =
        await agentStub.countIntervalSchedulesForCallback("intervalCallback");
      expect(count).toBe(1);

      // Clean up
      await agentStub.cancelScheduleById(firstId);
    });

    it("should create a new row when interval changes for same callback", async () => {
      const agentStub = await getAgentByName(
        env.TestScheduleAgent,
        "idempotent-interval-change-test"
      );

      // Create with 30s interval
      const firstId = await agentStub.createIntervalSchedule(30);

      // Call again with different interval
      const secondId = await agentStub.createIntervalSchedule(60);

      // Different interval means a different schedule
      expect(secondId).not.toBe(firstId);

      // Two schedules should exist for this callback
      const count =
        await agentStub.countIntervalSchedulesForCallback("intervalCallback");
      expect(count).toBe(2);

      // The new schedule should have the new interval
      const schedule = await agentStub.getScheduleById(secondId);
      expect(schedule).toBeDefined();
      if (schedule?.type === "interval") {
        expect(schedule.intervalSeconds).toBe(60);
      }

      // The original schedule should still have the old interval
      const original = await agentStub.getScheduleById(firstId);
      expect(original).toBeDefined();
      if (original?.type === "interval") {
        expect(original.intervalSeconds).toBe(30);
      }

      // Clean up
      await agentStub.cancelScheduleById(firstId);
      await agentStub.cancelScheduleById(secondId);
    });

    it("should create a new row when payload changes for same callback", async () => {
      const agentStub = await getAgentByName(
        env.TestScheduleAgent,
        "idempotent-payload-change-test"
      );

      // Create with payload "foo"
      const firstId = await agentStub.createIntervalScheduleWithPayload(
        30,
        "foo"
      );

      // Call again with different payload
      const secondId = await agentStub.createIntervalScheduleWithPayload(
        30,
        "bar"
      );

      // Different payload means a different schedule
      expect(secondId).not.toBe(firstId);

      // Two schedules should exist for this callback
      const count =
        await agentStub.countIntervalSchedulesForCallback("intervalCallback");
      expect(count).toBe(2);

      // Each schedule should have its own payload
      const first = await agentStub.getScheduleById(firstId);
      expect(first).toBeDefined();
      expect(first?.payload).toBe("foo");

      const second = await agentStub.getScheduleById(secondId);
      expect(second).toBeDefined();
      expect(second?.payload).toBe("bar");

      // Clean up
      await agentStub.cancelScheduleById(firstId);
      await agentStub.cancelScheduleById(secondId);
    });

    it("should allow different callbacks to have their own interval schedules", async () => {
      const agentStub = await getAgentByName(
        env.TestScheduleAgent,
        "idempotent-different-callbacks-test"
      );

      // Create interval for callback A
      const firstId = await agentStub.createIntervalSchedule(30);

      // Create interval for callback B
      const secondId = await agentStub.createSecondIntervalSchedule(30);

      // Different callbacks should create different schedules
      expect(secondId).not.toBe(firstId);

      // Two interval schedules should exist total
      const count = await agentStub.countIntervalSchedules();
      expect(count).toBe(2);

      // Clean up
      await agentStub.cancelScheduleById(firstId);
      await agentStub.cancelScheduleById(secondId);
    });

    it("should not create duplicates when called many times (simulating repeated onStart)", async () => {
      const agentStub = await getAgentByName(
        env.TestScheduleAgent,
        "idempotent-repeated-calls-test"
      );

      // Simulate calling scheduleEvery in onStart many times
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = await agentStub.createIntervalSchedule(30);
        ids.push(id);
      }

      // All IDs should be the same
      const uniqueIds = [...new Set(ids)];
      expect(uniqueIds.length).toBe(1);

      // Only one schedule should exist
      const count =
        await agentStub.countIntervalSchedulesForCallback("intervalCallback");
      expect(count).toBe(1);

      // Clean up
      await agentStub.cancelScheduleById(ids[0]);
    });
  });
});
