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

    // Use a future delay so the alarm doesn't auto-fire before
    // runDurableObjectAlarm can trigger it manually.
    const status = await agentStub.scheduleSelfDestructingAlarm(86400);
    expect(status).toBe("scheduled");

    // Trigger the alarm. The callback calls destroy() which nukes storage.
    // The scheduling system must handle this gracefully without throwing.
    const result = await runDurableObjectAlarm(agentStub);
    expect(result).toBe(true);
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
