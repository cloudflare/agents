import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PiHarnessTestObject } from "./worker";

function fresh(): DurableObjectStub<PiHarnessTestObject> {
  return env.PI_HARNESS_TEST.getByName(crypto.randomUUID());
}

describe("example-local PiHarness", () => {
  it("uses a pi-ai provider and restores its transcript after eviction", async () => {
    const stub = fresh();
    const first = await stub.runMultiply(4, 3);
    expect(first).toMatchObject({
      status: "completed",
      result: 12,
      messages: ["multiply 4", "", "", "tool complete"]
    });

    const eventTypes = await stub.eventTypes(first.operationId);
    for (const expected of [
      "operation_start",
      "turn_start",
      "tool_start",
      "tool_end",
      "turn_end",
      "operation_end"
    ]) {
      expect(eventTypes.includes(expected)).toBe(true);
    }

    await evictDurableObject(stub);
    expect(await stub.messages()).toEqual(first.messages);

    const second = await stub.runMultiply(2, 5);
    expect(second).toMatchObject({ status: "completed", result: 10 });
    expect((await stub.messages()).at(-1)).toBe("tool complete");
  });
});
