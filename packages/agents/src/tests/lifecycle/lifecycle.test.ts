import { env, runDurableObjectAlarm } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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
