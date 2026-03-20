import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import type { TestAlarmInitAgent } from "./agents/schedule";

describe("scheduled destroys", () => {
  it("should not throw when a scheduled callback nukes storage", async () => {
    const agentStub = await getAgentByName(
      env.TestDestroyScheduleAgent,
      "alarm-destroy-repro"
    );

    // Alarm should fire immediately
    await agentStub.scheduleSelfDestructingAlarm();
    await expect(agentStub.getStatus()).resolves.toBe("scheduled");

    // Trigger the alarm deterministically. The alarm callback calls destroy()
    // which nukes storage and breaks the output gate — expect the error as
    // proof the alarm ran and the DO was destroyed.
    await expect(runDurableObjectAlarm(agentStub)).rejects.toThrow("destroyed");

    const freshStub = await getAgentByName(
      env.TestDestroyScheduleAgent,
      "alarm-destroy-repro"
    );

    await expect(freshStub.getStatus()).resolves.toBe("unscheduled");
  });
});

describe("alarm initialization", () => {
  it("should have this.name accessible during scheduled callback", async () => {
    const instanceName = "alarm-name-test";
    const agentStub = await getAgentByName(
      env.TestAlarmInitAgent,
      instanceName
    );

    // Verify onStart was called during initial RPC — read instance field directly
    await runInDurableObject(
      agentStub,
      async (instance: TestAlarmInitAgent) => {
        expect(instance._onStartCalled).toBe(true);
      }
    );

    // Schedule a callback that reads this.name (fires immediately with delay=0)
    await agentStub.scheduleNameCheck(0);

    // Trigger the alarm deterministically instead of polling with setTimeout
    await runDurableObjectAlarm(agentStub);

    // The callback should have captured the name without throwing
    await runInDurableObject(
      agentStub,
      async (instance: TestAlarmInitAgent) => {
        expect(instance._callbackError).toBeNull();
        expect(instance._capturedName).toBe(instanceName);
      }
    );
  });

  it("should call onStart before executing scheduled callbacks", async () => {
    const agentStub = await getAgentByName(
      env.TestAlarmInitAgent,
      "alarm-onstart-test"
    );

    // onStart should have been called
    await runInDurableObject(
      agentStub,
      async (instance: TestAlarmInitAgent) => {
        expect(instance._onStartCalled).toBe(true);
      }
    );

    // Schedule and trigger alarm deterministically
    await agentStub.scheduleNameCheck(0);
    await runDurableObjectAlarm(agentStub);

    // No errors from accessing this.name
    await runInDurableObject(
      agentStub,
      async (instance: TestAlarmInitAgent) => {
        expect(instance._callbackError).toBeNull();
      }
    );
  });
});
