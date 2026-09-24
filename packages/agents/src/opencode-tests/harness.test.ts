import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
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
