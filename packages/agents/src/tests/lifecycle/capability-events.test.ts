import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import {
  subscribe as subscribeDiagnostic,
  unsubscribe as unsubscribeDiagnostic
} from "node:diagnostics_channel";
import { describe, expect, it } from "vitest";
import { getCurrentAgent } from "../../lifecycle";
import { nativeAgentStub } from "../../index";

describe("Lifecycle capability events", () => {
  it("buffers capability events emitted during startup", async () => {
    const name = crypto.randomUUID();
    const stub = env.PlainLifecycleObject.getByName(name);
    const observed: Array<Record<string, unknown>> = [];
    const contexts: boolean[] = [];
    const handler = (event: unknown) => {
      if (event === null || typeof event !== "object") return;
      const record = event as Record<string, unknown>;
      if (record.name !== name) return;
      observed.push(record);
      contexts.push(getCurrentAgent().agent !== undefined);
    };
    subscribeDiagnostic("agents:lifecycle", handler);

    try {
      await stub.startFromRpc({ label: "startup-event" });
      expect(observed).toEqual([
        expect.objectContaining({
          source: "startup-probe",
          type: "lifecycle:startup-probe",
          agent: "PlainLifecycleObject",
          name,
          payload: { label: "startup-event" }
        })
      ]);
      expect(contexts).toEqual([false]);
    } finally {
      unsubscribeDiagnostic("agents:lifecycle", handler);
    }
  });

  it("publishes standalone Scheduler events through Lifecycle", async () => {
    const name = crypto.randomUUID();
    const stub = env.ScheduledLifecycleObject.getByName(name);
    const observed: Array<Record<string, unknown>> = [];
    const observedContexts: string[] = [];
    const handler = (event: unknown) => {
      if (event === null || typeof event !== "object") return;
      const record = event as Record<string, unknown>;
      observed.push(record);
      if (record.name === name && record.type === "schedule:execute") {
        observedContexts.push(
          getCurrentAgent().agent === undefined
            ? "scheduler:no-context"
            : "scheduler:context"
        );
      }
    };
    subscribeDiagnostic("agents:schedule", handler);

    try {
      const scheduleId = await stub.scheduleReminder("hello from Scheduler");

      await evictDurableObject(nativeAgentStub(stub));
      expect(await runDurableObjectAlarm(stub)).toBe(true);

      expect(await stub.getSchedulerResult()).toEqual({
        events: ["callback:context", "host:context"],
        message: "hello from Scheduler",
        callbackScheduleId: scheduleId,
        callbackScheduleMessage: "hello from Scheduler",
        alarm: null,
        scheduleCount: 0
      });
      const schedulerEvents = observed.filter((event) => event.name === name);
      expect(schedulerEvents.map((event) => event.type)).toEqual([
        "schedule:create",
        "schedule:execute"
      ]);
      expect(schedulerEvents).toContainEqual(
        expect.objectContaining({
          type: "schedule:execute",
          source: "scheduler",
          agent: "ScheduledLifecycleObject",
          name
        })
      );
      expect(observedContexts).toEqual(["scheduler:no-context"]);
    } finally {
      unsubscribeDiagnostic("agents:schedule", handler);
    }
  });

  it("does not fail Scheduler when the Lifecycle event sink throws", async () => {
    const stub = env.ScheduledLifecycleObject.getByName(crypto.randomUUID());
    const scheduleId = await stub.scheduleReminderWithFailingEventSink(
      "sink failures are isolated"
    );

    expect(scheduleId).not.toBe("");
    expect((await stub.getSchedulerResult()).scheduleCount).toBe(1);
  });
});
