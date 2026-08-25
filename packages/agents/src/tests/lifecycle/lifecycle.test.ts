import {
  env,
  evictDurableObject,
  runDurableObjectAlarm
} from "cloudflare:test";
import {
  subscribe as subscribeDiagnostic,
  unsubscribe as unsubscribeDiagnostic
} from "node:diagnostics_channel";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getCurrentAgent } from "../../lifecycle";
import worker from "./worker";

function requireWebSocket(response: Response): WebSocket {
  if (!response.webSocket) {
    throw new Error("Expected a WebSocket upgrade response");
  }
  return response.webSocket;
}

describe("Lifecycle", () => {
  it("installs fetch and dispatches startup, capabilities, then the host", async () => {
    const name = crypto.randomUUID();
    const response = await exports.default.fetch(
      `https://example.com/agents/plain-lifecycle-object/${name}`
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name,
      hasInternalPropsHeader: false,
      events: [
        "capability:start:routed",
        "host:start:routed",
        "capability:request",
        "host:request"
      ]
    });
  });

  it("rejects installing runtime handlers twice", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());

    expect(await stub.installHandlersAgainForTest()).toBe(
      "Durable Object lifecycle handlers are already installed"
    );
  });

  it("lets the first capability response intercept a request", async () => {
    const name = crypto.randomUUID();
    const response = await worker.fetch(
      new Request(
        `https://example.com/agents/plain-lifecycle-object/${name}?capability`
      ),
      env
    );

    expect(await response.json()).toEqual([
      "capability:start:routed",
      "host:start:routed",
      "capability:request"
    ]);
  });

  it("installs alarm and dispatches capabilities before the host", async () => {
    const name = crypto.randomUUID();
    const stub = env.PlainLifecycleObject.getByName(name);
    await stub.startFromRpc({ label: "rpc" });
    await stub.scheduleAlarm();

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.getEvents()).toEqual([
      "capability:start:rpc",
      "host:start:rpc",
      "capability:alarm",
      "host:alarm"
    ]);
  });

  it("owns one physical alarm across capability and host contributions", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());
    const now = Date.now();

    expect(
      await stub.setAlarmContributions(now + 30_000, now + 20_000, now + 40_000)
    ).toBe(now + 20_000);
    expect(
      await stub.setAlarmContributions(null, now + 30_000, now + 10_000)
    ).toBe(now + 10_000);
    expect(
      await stub.setAlarmContributions(now + 5_000, null, null, now + 40_000)
    ).toBe(now + 40_000);
    expect(await stub.setAlarmContributions(null, null, null)).toBeNull();

    const contexts = await stub.getAlarmContributionContexts();
    expect(contexts.capability.length).toBeGreaterThan(0);
    expect(contexts.capability.every((hasHost) => !hasHost)).toBe(true);
    expect(contexts.host.length).toBeGreaterThan(0);
    expect(contexts.host.every((hasHost) => hasHost)).toBe(true);
  });

  it("applies alarm rearm requests made during capability startup", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());
    const before = Date.now();
    const alarm = await stub.startWithAlarmContribution();

    expect(alarm).not.toBeNull();
    expect(alarm as number).toBeGreaterThanOrEqual(before + 59_000);
    expect(alarm as number).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it("routes messages to the matching local capability", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());

    expect(await stub.routeCapability({ value: "routed" })).toEqual({
      payload: { value: "routed" },
      source: null
    });
  });

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

      await evictDurableObject(stub);
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

  it("disposes live capability resources in reverse registration order", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());

    expect(await stub.disposeCapabilities()).toEqual([
      "dispose:second",
      "dispose:first"
    ]);
  });

  it("scopes current context to Lifecycle Object host hooks", async () => {
    const name = crypto.randomUUID();
    const requestUrl = `https://example.com/agents/plain-lifecycle-object/${name}`;
    await worker.fetch(new Request(requestUrl), env);

    const stub = env.PlainLifecycleObject.getByName(name);
    expect(await stub.contextAccessorsAreAliases()).toBe(true);
    const requestContexts = [
      { hostName: name, phase: "start", requestUrl: null },
      { hostName: name, phase: "request", requestUrl }
    ];
    expect(await stub.getHostContextEvents()).toEqual(requestContexts);
    expect(await stub.getCapabilityContextEvents()).toEqual([
      { hasCurrentHost: false, phase: "start" },
      { hasCurrentHost: false, phase: "request" }
    ]);

    await stub.scheduleAlarm();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const alarmContexts = [
      ...requestContexts,
      { hostName: name, phase: "alarm", requestUrl: null }
    ];
    expect(await stub.getHostContextEvents()).toEqual(alarmContexts);
    expect(await stub.getCapabilityContextEvents()).toEqual([
      { hasCurrentHost: false, phase: "start" },
      { hasCurrentHost: false, phase: "request" },
      { hasCurrentHost: false, phase: "alarm" }
    ]);
  });

  it("does not leak an inherited Agent context into capabilities", async () => {
    const name = crypto.randomUUID();
    const stub = env.PlainLifecycleObject.getByName(name);

    expect(await stub.startFromForeignContext({ label: "foreign" })).toEqual({
      capability: [{ hasCurrentHost: false, phase: "start" }],
      host: [{ hostName: name, phase: "start", requestUrl: null }]
    });
  });

  it("installs always-hibernating WebSocket handlers", async () => {
    const name = crypto.randomUUID();
    const response = await worker.fetch(
      new Request(`https://example.com/agents/plain-lifecycle-object/${name}`, {
        headers: { Upgrade: "websocket" }
      }),
      env
    );
    const socket = requireWebSocket(response);
    socket.accept();

    const connected = await new Promise<string>((resolve) => {
      socket.addEventListener(
        "message",
        (event) => resolve(String(event.data)),
        { once: true }
      );
    });
    expect(connected).toBe(`connected:${name}`);

    socket.send("hello");
    const echoed = await new Promise<string>((resolve) => {
      socket.addEventListener(
        "message",
        (event) => resolve(String(event.data)),
        { once: true }
      );
    });
    expect(echoed).toBe("echo:hello");
    const closed = new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
    });
    socket.close(1000, "done");
    await closed;

    const contexts =
      await env.PlainLifecycleObject.getByName(
        name
      ).getWebSocketContextEvents();
    expect(contexts).toHaveLength(3);
    expect(contexts).toEqual([
      {
        connectionId: contexts[0]?.connectionId,
        hostName: name,
        phase: "connect",
        requestUrl: `https://example.com/agents/plain-lifecycle-object/${name}`
      },
      {
        connectionId: contexts[0]?.connectionId,
        hostName: name,
        phase: "message",
        requestUrl: null
      },
      {
        connectionId: contexts[0]?.connectionId,
        hostName: name,
        phase: "close",
        requestUrl: null
      }
    ]);
    expect(contexts[0]?.connectionId).not.toBeNull();
  });

  it("reads an old __ps_name record without writing new fallback state", async () => {
    const id = env.PlainLifecycleObject.newUniqueId();
    const stub = env.PlainLifecycleObject.get(id);
    await stub.seedLegacyNameForTest("migrated-name");

    const response = await stub.fetch(new Request("https://example.com"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "migrated-name" });
  });

  it("explains unsupported identity and local runtime remedies", async () => {
    const stub = env.PlainLifecycleObject.get(
      env.PlainLifecycleObject.newUniqueId()
    );
    const response = await stub.fetch(new Request("https://example.com"));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("idFromName() or getByName()");
    expect(body).toContain("update Wrangler/workerd");
    expect(body).toContain("compatibility_date");
    expect(body).toContain("2026-03-15");
  });
});
