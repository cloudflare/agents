import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChatAgentDO } from "./worker.js";

let delegationCounter = 0;

function freshRoot(label: string): {
  name: string;
  stub: DurableObjectStub<ChatAgentDO>;
} {
  const name = `${label}-${delegationCounter++}`;
  const id = env.CHAT_AGENT_DO.idFromName(name);
  const stub = env.CHAT_AGENT_DO.get(id) as DurableObjectStub<ChatAgentDO>;
  return { name, stub };
}

function textDeltas(events: unknown[]): string {
  return events
    .filter(
      (event): event is { type: "text-delta"; delta: string } =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "text-delta" &&
        "delta" in event &&
        typeof event.delta === "string"
    )
    .map((event) => event.delta)
    .join("");
}

describe("Cloudflare facet delegation", () => {
  it("keeps child names isolated and returns the same live instance for the same name", async () => {
    const { stub } = freshRoot("isolation");
    await stub.__init({ name: "isolation-root" });

    await stub.childInspect("alpha", { op: "put", key: "value", value: "alpha-value" });
    expect(await stub.childInspect("alpha", { op: "get", key: "value" })).toBe("alpha-value");
    expect(await stub.childInspect("beta", { op: "get", key: "value" })).toBeNull();

    const first = await stub.childInspect("alpha", { op: "instanceId" });
    const second = await stub.childInspect("alpha", { op: "instanceId" });
    expect(second).toBe(first);
  });

  it("passes the root selfPath as the child parentPath", async () => {
    const { name, stub } = freshRoot("path");
    await stub.__init({ name });

    await expect(stub.childInspect("child", { op: "parentPath" })).resolves.toEqual([
      { className: "ChatAgent", name }
    ]);
  });

  it("__call allows the delegation surface and rejects private or unknown names", async () => {
    const { stub } = freshRoot("allowlist");
    await stub.__init({ name: "allowlist-root" });

    await expect(stub.childCall("child", "inspectRun")).resolves.toMatchObject({
      status: "completed"
    });
    await expect(stub.childCallOutcome("child", "_private")).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("Unknown method")
    });
    await expect(stub.childCallOutcome("child", "missingMethod")).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("Unknown method")
    });
  });

  it("relays a child chat stream across the facet boundary", async () => {
    const { stub } = freshRoot("relay");
    await stub.__init({ name: "relay-root" });

    const events = await stub.childChatEvents("child", "hello");

    expect(events).toContainEqual({ type: "start", info: expect.objectContaining({ requestId: expect.any(String) }) });
    expect(textDeltas(events)).toContain("child:hello");
    expect(events).toContainEqual({ type: "done" });
  });

  it("delivers a child scheduled callback through the root physical alarm", async () => {
    const { stub } = freshRoot("child-alarm");
    await stub.__init({ name: "child-alarm-root" });

    const childAt = (await stub.childInspect("child", { op: "scheduleNote" })) as number;
    expect(await stub.readPlatformAlarm()).toBe(childAt);

    await stub.childInspect("child", { op: "makeNoteDue" });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await stub.childInspect("child", { op: "noteFiredCount" })).toBe(1);
    expect(await stub.readPlatformAlarm()).toBeNull();
  });

  it("uses the earliest root-or-child alarm and then re-arms to the remaining root alarm", async () => {
    const { stub } = freshRoot("min");
    await stub.__init({ name: "min-root" });

    const rootAt = await stub.scheduleRootNote(10);
    const childAt = (await stub.childInspect("child", { op: "scheduleNote" })) as number;
    expect(childAt).toBeLessThan(rootAt);
    expect(await stub.readPlatformAlarm()).toBe(childAt);

    await stub.childInspect("child", { op: "makeNoteDue" });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await stub.childInspect("child", { op: "noteFiredCount" })).toBe(1);
    expect(await stub.noteFiredCount()).toBe(0);
    expect(await stub.readPlatformAlarm()).toBe(rootAt);
  });

  it("destroy wipes child storage and alarm rows, while abort keeps storage", async () => {
    const { stub } = freshRoot("lifecycle");
    await stub.__init({ name: "lifecycle-root" });

    await stub.childInspect("abort-child", { op: "put", key: "value", value: "kept" });
    const beforeAbort = await stub.childInspect("abort-child", { op: "instanceId" });
    await stub.abortChild("abort-child", "test abort");
    expect(await stub.childInspect("abort-child", { op: "get", key: "value" })).toBe("kept");
    expect(await stub.childInspect("abort-child", { op: "instanceId" })).not.toBe(beforeAbort);

    await stub.childInspect("destroy-child", { op: "put", key: "value", value: "removed" });
    await stub.childInspect("destroy-child", { op: "scheduleNote" });
    expect(await stub.readPlatformAlarm()).not.toBeNull();

    await stub.destroyChild("destroy-child");
    expect(await stub.childInspect("destroy-child", { op: "get", key: "value" })).toBeNull();
    expect(await stub.readPlatformAlarm()).toBeNull();
  });
});
