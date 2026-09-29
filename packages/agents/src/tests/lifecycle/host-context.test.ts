import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { routeAgentRequest } from "../..";

describe("Lifecycle host context", () => {
  it("scopes current context to Lifecycle Object host hooks", async () => {
    const name = crypto.randomUUID();
    const requestUrl = `https://example.com/agents/plain-lifecycle-object/${name}`;
    await routeAgentRequest(new Request(requestUrl), env, {
      props: { label: "routed" }
    });

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
    // Capability job context (outside ambient host context) is proven by
    // ../lifecycle/alarm-arbitration.test.ts through getJobContexts().
    expect(await stub.getCapabilityContextEvents()).toEqual([
      { hasCurrentHost: false, phase: "start" },
      { hasCurrentHost: false, phase: "request" }
    ]);
  });

  it("enters host context only through runInHostContext", async () => {
    const name = crypto.randomUUID();
    const stub = env.PlainLifecycleObject.getByName(name);

    expect(await stub.probeHostBoundary()).toEqual({
      outsideHostName: null,
      insideHostName: name
    });
  });

  it("does not leak an inherited Agent context into capabilities", async () => {
    const name = crypto.randomUUID();
    const stub = env.PlainLifecycleObject.getByName(name);

    expect(await stub.startFromForeignContext({ label: "foreign" })).toEqual({
      capability: [{ hasCurrentHost: false, phase: "start" }],
      host: [{ hostName: name, phase: "start", requestUrl: null }]
    });
  });
});
