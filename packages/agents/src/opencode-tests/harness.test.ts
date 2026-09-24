import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OpenCodeHarnessTestObject } from "./worker";

function namespace() {
  return (
    env as unknown as {
      OpenCodeHarnessTestObject: DurableObjectNamespace<OpenCodeHarnessTestObject>;
    }
  ).OpenCodeHarnessTestObject;
}

describe("OpenCodeHarness workerd integration", () => {
  it("admits one native prompt for a stable operation identifier", async () => {
    const stub = namespace().getByName(crypto.randomUUID());
    const sessionId = await stub.createSession();

    expect(await stub.submitPrompt(sessionId, "op-1", "hello")).toEqual({
      operationId: "op-1",
      sessionId,
      accepted: true
    });
    await runDurableObjectAlarm(stub);

    expect(await stub.pending(sessionId)).toMatchObject([
      { operationId: "op-1", sessionId }
    ]);
    expect(await stub.submitPrompt(sessionId, "op-1", "hello again")).toEqual({
      operationId: "op-1",
      sessionId,
      accepted: false
    });
  });

  it("creates and restores independent native sessions", async () => {
    const name = crypto.randomUUID();
    const stub = namespace().getByName(name);

    const first = await stub.createSession();
    const second = await stub.createSession();

    expect(first).not.toBe(second);
    expect(await stub.snapshot(first)).toMatchObject({ sessionId: first });
    expect(await stub.snapshot(second)).toMatchObject({ sessionId: second });

    await stub.dispose();
    await evictDurableObject(stub);
    const restored = namespace().getByName(name);

    expect(await restored.snapshot(first)).toMatchObject({ sessionId: first });
    expect(await restored.snapshot(second)).toMatchObject({
      sessionId: second
    });
  });

  it("boots over Durable Object SQLite and restores its default session", async () => {
    const name = crypto.randomUUID();
    const stub = namespace().getByName(name);

    const sessionId = await stub.sessionId();
    expect(sessionId).toBeTruthy();
    expect(await stub.snapshot()).toMatchObject({
      sessionId,
      messages: [],
      running: false
    });

    await stub.dispose();
    await evictDurableObject(stub);
    const restored = namespace().getByName(name);

    expect(await restored.sessionId()).toBe(sessionId);
    expect(await restored.snapshot()).toMatchObject({
      sessionId,
      messages: [],
      running: false
    });
  });
});
