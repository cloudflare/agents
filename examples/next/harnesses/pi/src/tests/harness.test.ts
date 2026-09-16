import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PiHarnessTestObject } from "./worker";

function fresh(): DurableObjectStub<PiHarnessTestObject> {
  return env.PI_HARNESS_TEST.getByName(crypto.randomUUID());
}

describe("pi on the shared Harness", () => {
  it("drives a pi tool call and restores its transcript after eviction", async () => {
    const stub = fresh();
    const first = await stub.runMultiply(4, 3);
    expect(first).toMatchObject({
      status: "completed",
      result: 12,
      messages: ["multiply 4", "", "", "tool complete"]
    });

    const status = await stub.status();
    expect(status.state).toBe("idle");
    expect(status.capabilities).toEqual(
      expect.arrayContaining(["sessions", "steer", "compact", "usage"])
    );

    await evictDurableObject(stub);
    expect(await stub.messages()).toEqual(first.messages);

    // The tool context is re-read on every wake, so the revision changes.
    const second = await stub.runMultiply(2, 5);
    expect(second).toMatchObject({ status: "completed", result: 10 });
    expect((await stub.messages()).at(-1)).toBe("tool complete");
  });

  it("records the operation on the durable log, core events and all", async () => {
    const stub = fresh();
    const first = await stub.runMultiply(4, 3);
    const types = await stub.eventTypes();
    for (const expected of [
      "session_opened",
      "operation_started",
      "message_start",
      "message_end",
      "tool_start",
      "tool_end",
      "extension:turn_start",
      "extension:turn_end",
      "operation_settled"
    ]) {
      expect(types).toContain(expected);
    }
    // A second turn replays from the first one's cursor and nothing earlier.
    // Pi admits the prompt before the base marks the operation running, so a
    // turn opens with the user message on the session log.
    await stub.runMultiply(2, 3);
    const tail = await stub.eventTypes(first.cursor);
    expect(tail).toContain("operation_started");
    expect(tail.at(-1)).toBe("operation_settled");
    expect(tail).not.toContain("session_opened");
  });

  it("accepts a steered prompt while an operation runs", async () => {
    const stub = fresh();
    await stub.startWaiting();
    const steered = await stub.steer("also mention the weather");
    expect(steered.accepted).toBe(true);
    expect(steered.status).toBe("completed");
    expect(steered.entryId).toEqual(expect.any(String));
  });

  it("interrupts a running operation", async () => {
    const stub = fresh();
    const operationId = await stub.startWaiting();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const interrupted = await stub.interrupt(operationId);
    expect(interrupted.requested).toBe(operationId);
    expect(interrupted.status).toBe("aborted");
    expect(interrupted.stopReason).toBe("interrupted");
  });
});
