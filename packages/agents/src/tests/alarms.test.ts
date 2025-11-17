import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("scheduled destroys", () => {
  it("should not throw when a scheduled callback nukes storage", async () => {
    const agentId = env.TestDestroyScheduleAgent.idFromName(
      "alarm-destroy-repro"
    );
    let agentStub = env.TestDestroyScheduleAgent.get(agentId);

    // Alarm should fire immediately
    await agentStub.scheduleSelfDestructingAlarm();
    await expect(agentStub.getStatus()).resolves.toBe("scheduled");

    // Let the alarm run
    await new Promise((resolve) => setTimeout(resolve, 50));

    agentStub = env.TestDestroyScheduleAgent.get(agentId);
    await expect(agentStub.getStatus()).resolves.toBe("unscheduled");
  });
});
