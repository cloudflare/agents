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

describe("alarm initialization", () => {
  it("should have this.name accessible during scheduled callback", async () => {
    const instanceName = "alarm-name-test";
    const agentStub = await getAgentByName(
      env.TestAlarmInitAgent,
      instanceName
    );

    // Verify onStart was called during initial RPC
    await expect(agentStub.getOnStartCalled()).resolves.toBe(true);

    // Schedule a callback that reads this.name (fires immediately with delay=0)
    await agentStub.scheduleNameCheck(0);

    // Wait for the alarm to fire
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The callback should have captured the name without throwing
    const error = await agentStub.getCallbackError();
    expect(error).toBeNull();

    const capturedName = await agentStub.getCapturedName();
    expect(capturedName).toBe(instanceName);
  });

  it("should call onStart before executing scheduled callbacks", async () => {
    const agentStub = await getAgentByName(
      env.TestAlarmInitAgent,
      "alarm-onstart-test"
    );

    // onStart should have been called
    const onStartCalled = await agentStub.getOnStartCalled();
    expect(onStartCalled).toBe(true);

    // Schedule and let alarm fire
    await agentStub.scheduleNameCheck(0);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // No errors from accessing this.name
    const error = await agentStub.getCallbackError();
    expect(error).toBeNull();
  });
});
