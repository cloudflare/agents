import { describe, expect, it } from "vitest";
import { applyChunks } from "../apply-chunks";

describe("applyChunks", () => {
  it("keeps provider metadata from a part's start and end", () => {
    const message = applyChunks({ id: "m1", role: "assistant", parts: [] }, [
      { type: "reasoning-start", id: "r", providerMetadata: { a: 1 } },
      { type: "reasoning-delta", id: "r", delta: "thinking" },
      { type: "reasoning-end", id: "r", providerMetadata: { b: 2 } },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Hi" },
      { type: "text-end", id: "t" }
    ]);
    expect(message.parts).toEqual([
      { type: "reasoning", text: "thinking", providerMetadata: { a: 1, b: 2 } },
      { type: "text", text: "Hi" }
    ]);
  });

  it("keeps a client tool call's owner through its answer", () => {
    const asked = applyChunks({ id: "m1", role: "assistant", parts: [] }, [
      {
        type: "tool-input-start",
        toolCallId: "c1",
        toolName: "getLocation",
        owner: "alice"
      },
      {
        type: "tool-input-available",
        toolCallId: "c1",
        toolName: "getLocation",
        input: {},
        owner: "alice"
      }
    ]);
    expect(asked.parts).toEqual([
      {
        type: "tool",
        toolCallId: "c1",
        toolName: "getLocation",
        state: "input-available",
        input: {},
        owner: "alice"
      }
    ]);
    // A later response continues the same message with the output.
    const answered = applyChunks(asked, [
      { type: "tool-output-available", toolCallId: "c1", output: "Lisbon" },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "You are in Lisbon" },
      { type: "text-end", id: "t" }
    ]);
    expect(answered.parts).toEqual([
      {
        type: "tool",
        toolCallId: "c1",
        toolName: "getLocation",
        state: "output-available",
        input: {},
        output: "Lisbon",
        owner: "alice"
      },
      { type: "text", text: "You are in Lisbon" }
    ]);
    // The message it extended is untouched.
    expect(asked.parts[0]).toMatchObject({ state: "input-available" });
  });

  it("does not add a replayed tool call twice", () => {
    const start = {
      type: "tool-input-start" as const,
      toolCallId: "c1",
      toolName: "search"
    };
    const message = applyChunks({ id: "m1", role: "assistant", parts: [] }, [
      start,
      start
    ]);
    expect(message.parts).toHaveLength(1);
  });

  it("clears preliminary when a final output arrives without it", () => {
    const message = applyChunks({ id: "m1", role: "assistant", parts: [] }, [
      {
        type: "tool-input-available",
        toolCallId: "c1",
        toolName: "count",
        input: {}
      },
      {
        type: "tool-output-available",
        toolCallId: "c1",
        output: 1,
        preliminary: true
      },
      { type: "tool-output-available", toolCallId: "c1", output: 2 }
    ]);
    expect(message.parts[0]).toEqual({
      type: "tool",
      toolCallId: "c1",
      toolName: "count",
      state: "output-available",
      input: {},
      output: 2
    });
  });

  it("keeps a pending approval when the call's input arrives late", () => {
    const message = applyChunks({ id: "m1", role: "assistant", parts: [] }, [
      { type: "tool-input-start", toolCallId: "c1", toolName: "deploy" },
      { type: "tool-approval-request", toolCallId: "c1", approvalId: "a1" },
      {
        type: "tool-input-available",
        toolCallId: "c1",
        toolName: "deploy",
        input: { env: "prod" }
      }
    ]);
    expect(message.parts[0]).toMatchObject({
      state: "approval-requested",
      approval: { id: "a1" },
      input: { env: "prod" }
    });
  });
});
