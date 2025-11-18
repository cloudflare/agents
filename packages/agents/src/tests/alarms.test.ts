import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import { getAgentByName } from "..";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("scheduled destroys", () => {
  it("should not throw when a scheduled callback nukes storage", async () => {
    let agentStub = await getAgentByName(
      env.TestDestroyScheduleAgent,
      "alarm-destroy-repro"
    );

    // Alarm should fire immediately
    await agentStub.scheduleSelfDestructingAlarm();
    await expect(agentStub.getStatus()).resolves.toBe("scheduled");

    // Let the alarm run
    await new Promise((resolve) => setTimeout(resolve, 50));

    agentStub = await getAgentByName(
      env.TestDestroyScheduleAgent,
      "alarm-destroy-repro"
    );

    await expect(agentStub.getStatus()).resolves.toBe("unscheduled");
  });
});
