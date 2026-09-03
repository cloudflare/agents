import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runInDurableObject,
  runDurableObjectAlarm
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import type { TestAlarmInitAgent } from "./agents/schedule";
import { nativeAgentStub } from "../index";

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

    // Backdate and trigger the alarm. The callback calls destroy(), which
    // nukes storage before Lifecycle would ordinarily invoke host onAlarm.
    await agentStub.makeSelfDestructingAlarmDue();
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

    // Clear the auto-scheduled alarm to prevent it from racing with
    // the manual runDurableObjectAlarm call below.
    await agentStub.clearStoredAlarm();
    await agentStub.setStoredAlarm(Date.now() + 1000);

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

  it("restores the scheduling capability after real eviction", async () => {
    const instanceName = "alarm-eviction-test";
    const agentStub = await getAgentByName(
      env.TestAlarmInitAgent,
      instanceName
    );

    const scheduleId = await agentStub.scheduleNameCheck(86400);
    await agentStub.clearStoredAlarm();
    await runInDurableObject(
      agentStub,
      async (instance: TestAlarmInitAgent) => {
        const past = Date.now() - 1_000;
        instance.sql`
          UPDATE cf_agents_jobs SET time = ${past} WHERE id = ${scheduleId}
        `;
      }
    );
    await agentStub.setStoredAlarm(Date.now() + 1000);
    await evictDurableObject(nativeAgentStub(agentStub));

    await runDurableObjectAlarm(agentStub);

    await runInDurableObject(
      agentStub,
      async (instance: TestAlarmInitAgent) => {
        expect(instance._onStartCalled).toBe(true);
        expect(instance._callbackError).toBeNull();
        expect(instance._capturedName).toBe(instanceName);
      }
    );
  });

  it("keeps capability hooks context-free and callback/host hooks contextual", async () => {
    const agentStub = await getAgentByName(
      env.TestAlarmInitAgent,
      "alarm-context-boundaries"
    );

    const scheduleId = await agentStub.scheduleContextCheck(86400);
    await agentStub.clearStoredAlarm();
    await runInDurableObject(
      agentStub,
      async (instance: TestAlarmInitAgent) => {
        const past = Date.now() - 1_000;
        instance.sql`
          UPDATE cf_agents_jobs SET time = ${past} WHERE id = ${scheduleId}
        `;
      }
    );
    await agentStub.setStoredAlarm(Date.now() + 1000);

    await runDurableObjectAlarm(agentStub);

    await runInDurableObject(
      agentStub,
      async (instance: TestAlarmInitAgent) => {
        expect(instance._scheduleContextEvents).toEqual([
          "capability:no-context",
          "callback:context",
          "host:context"
        ]);
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

    // Clear the auto-scheduled alarm to prevent it from racing with
    // the manual runDurableObjectAlarm call below.
    await agentStub.clearStoredAlarm();
    await agentStub.setStoredAlarm(Date.now() + 1000);

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
