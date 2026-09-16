import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { CodexHarnessTestObject } from "./worker";

function fresh(): DurableObjectStub<CodexHarnessTestObject> {
  return env.CODEX_HARNESS_TEST.getByName(crypto.randomUUID());
}

describe("CodexRuntime on the shared Harness", () => {
  it("drives one prompt through the kernel and settles completed", async () => {
    const stub = fresh();
    const { receipt, result } = await stub.run("write the note");
    expect(receipt.accepted).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.stopReason.type).toBe("end_turn");
    expect(result.raw?.output).toContain("final answer");
    expect(result.raw?.transitions).toBeGreaterThan(2);
    expect(result.usage?.outputTokens).toBeGreaterThan(0);

    const messages = await stub.messages();
    expect(messages[0]).toMatchObject({ role: "user", text: "write the note" });
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant"
    ]);
    expect(messages.at(-1)?.text).toContain("final answer");
    // The first assistant message carries the round's tool calls.
    expect(messages[1]?.types).toEqual([
      "reasoning",
      "tool-workspace_write",
      "tool-workspace_read"
    ]);

    const status = await stub.status();
    expect(status.state).toBe("idle");
    expect(status.capabilities).toContain("workspace");
    expect(status.usage?.inputTokens).toBeGreaterThan(0);
  });

  it("writes the Workspace file its tools were asked for", async () => {
    const stub = fresh();
    await stub.run("write the note");
    const file = await stub.file("/stress/file-0-0.txt");
    expect(file.found).toBe(true);
    expect(file.content?.length).toBe(64);
  });

  it("replays core frames and kernel events from the durable log", async () => {
    const stub = fresh();
    const { receipt } = await stub.run("write the note");
    const types = await stub.eventTypes();
    expect(types.slice(0, 2)).toEqual(["session_opened", "operation_started"]);
    expect(types.at(-1)).toBe("operation_settled");
    expect(types).toContain("extension:kernel_event");
    expect(types).toContain("extension:kernel_checkpoint");
    // The model round is framed by its message, and each tool call by its
    // own pair, in the order the kernel asked for them.
    expect(types.indexOf("message_start")).toBeLessThan(
      types.indexOf("message_end")
    );
    expect(types.indexOf("message_end")).toBeLessThan(
      types.indexOf("tool_start")
    );
    expect(types.filter((type) => type === "tool_start")).toHaveLength(2);
    expect(types.filter((type) => type === "tool_end")).toHaveLength(2);
    expect(types.filter((type) => type === "message_end")).toHaveLength(2);

    const kernel = await stub.kernel(receipt.operationId);
    expect(kernel?.phase).toBe("completed");
    expect(kernel?.actionType).toBe("completed");
  });

  it("resumes a turn a lost incarnation left running", async () => {
    const stub = fresh();
    // Long enough that the turn is still mid-flight when the object dies.
    const receipt = await stub.start("long note", {
      rounds: 40,
      callsPerRound: 4,
      toolBytes: 4096
    });
    await evictDurableObject(stub);
    const result = await stub.wait(receipt.operationId);
    expect(result.status).toBe("completed");
    expect(result.raw?.transitions).toBeGreaterThan(2);
    // The default page is byte-budgeted, so a long turn's window holds the
    // tail of the transcript rather than the prompt that started it.
    const messages = await stub.messages();
    expect(messages.at(-1)?.text).toContain("final answer");
  });

  it("keeps the transcript and resumes across eviction", async () => {
    const stub = fresh();
    const first = await stub.run("first note");
    await evictDurableObject(stub);
    const before = await stub.messages();
    expect(before[0]?.text).toBe("first note");

    const second = await stub.run("second note", { rounds: 0 });
    expect(second.result.status).toBe("completed");
    const after = await stub.messages();
    expect(after.filter((message) => message.role === "user")).toHaveLength(2);
    expect(after.length).toBeGreaterThan(before.length);

    // Only the second turn's frames follow the first turn's cursor.
    const tail = await stub.eventTypes(first.result.cursor);
    expect(tail[0]).toBe("operation_started");
    expect(tail.at(-1)).toBe("operation_settled");
    expect(tail).not.toContain("tool_start");
  });
});
