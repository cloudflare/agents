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
});
