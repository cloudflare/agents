import { describe, expect, it } from "vitest";
import { repairTranscript, sanitizeForPersistence } from "./repair.js";
import type { ChatMessage, MessagePart, ToolPart } from "./model.js";
import { userMessage } from "./model.js";

describe("repairTranscript", () => {
  it("flips an interrupted tool part to output-error by default, preserving call + input", () => {
    const messages: ChatMessage[] = [
      {
        id: "1",
        role: "assistant",
        parts: [
          { type: "text", text: "let me check" },
          { type: "tool-search", toolCallId: "call_1", state: "input-available", input: { q: "x" } },
        ],
      },
    ];
    const report = repairTranscript(messages);
    const part = report.messages[0]!.parts[1] as ToolPart;
    expect(part).toEqual({
      type: "tool-search",
      toolCallId: "call_1",
      state: "output-error",
      input: { q: "x" },
      errorText: "Tool call was interrupted before completing.",
    });
    expect(report.changed).toBe(true);
  });

  it("handles input-streaming and approval-requested as unsettled too", () => {
    const messages: ChatMessage[] = [
      {
        id: "1",
        role: "assistant",
        parts: [
          { type: "tool-a", toolCallId: "c1", state: "input-streaming" },
          { type: "tool-b", toolCallId: "c2", state: "approval-requested", approval: { id: "appr_1" } },
        ],
      },
    ];
    const report = repairTranscript(messages);
    const parts = report.messages[0]!.parts as ToolPart[];
    expect(parts[0]!.state).toBe("output-error");
    expect(parts[1]!.state).toBe("output-error");
    expect(report.toolCallIds.sort()).toEqual(["c1", "c2"]);
  });

  it("lets a custom repairPart hook override the default repair", () => {
    const messages: ChatMessage[] = [
      {
        id: "1",
        role: "assistant",
        parts: [{ type: "tool-search", toolCallId: "call_1", state: "input-available", input: {} }],
      },
    ];
    const custom: MessagePart = { type: "text", text: "cancelled by user" };
    const report = repairTranscript(messages, { repairPart: () => custom });
    expect(report.messages[0]!.parts[0]).toEqual(custom);
  });

  it("drops (backstops) a tool part that a custom repairPart leaves without output or error", () => {
    const messages: ChatMessage[] = [
      {
        id: "1",
        role: "assistant",
        parts: [
          { type: "text", text: "before" },
          { type: "tool-search", toolCallId: "call_1", state: "input-available", input: {} },
        ],
      },
    ];
    const report = repairTranscript(messages, {
      repairPart: (part) => ({ ...part, state: "input-available" }) as ToolPart,
    });
    expect(report.messages[0]!.parts).toEqual([{ type: "text", text: "before" }]);
    expect(report.removedToolCalls).toBe(1);
    expect(report.toolCallIds).toEqual(["call_1"]);
  });

  it("normalizes a stringified JSON tool input", () => {
    const messages: ChatMessage[] = [
      {
        id: "1",
        role: "assistant",
        parts: [
          {
            type: "tool-search",
            toolCallId: "call_1",
            state: "output-available",
            input: '{"q":"x"}',
            output: { ok: true },
          },
        ],
      },
    ];
    const report = repairTranscript(messages);
    const part = report.messages[0]!.parts[0] as ToolPart;
    expect(part.input).toEqual({ q: "x" });
    expect(report.normalizedInputs).toBe(1);
    expect(report.changed).toBe(true);
  });

  it("leaves a non-JSON string input untouched and does not count it as normalized", () => {
    const messages: ChatMessage[] = [
      {
        id: "1",
        role: "assistant",
        parts: [
          {
            type: "tool-search",
            toolCallId: "call_1",
            state: "output-available",
            input: "not json",
            output: { ok: true },
          },
        ],
      },
    ];
    const report = repairTranscript(messages);
    const part = report.messages[0]!.parts[0] as ToolPart;
    expect(part.input).toBe("not json");
    expect(report.normalizedInputs).toBe(0);
  });

  it("leaves settled tool parts (output-available / output-error) untouched", () => {
    const messages: ChatMessage[] = [
      {
        id: "1",
        role: "assistant",
        parts: [
          { type: "tool-a", toolCallId: "c1", state: "output-available", input: {}, output: { x: 1 } },
          { type: "tool-b", toolCallId: "c2", state: "output-error", input: {}, errorText: "boom" },
        ],
      },
    ];
    const report = repairTranscript(messages);
    expect(report.messages).toEqual(messages);
    expect(report.changed).toBe(false);
    expect(report.removedToolCalls).toBe(0);
    expect(report.toolCallIds).toEqual([]);
  });

  it("leaves user and system messages completely untouched", () => {
    const messages: ChatMessage[] = [
      { id: "0", role: "system", parts: [{ type: "text", text: "be nice" }] },
      userMessage("hi", "1"),
    ];
    const report = repairTranscript(messages);
    expect(report.messages).toEqual(messages);
    expect(report.changed).toBe(false);
  });

  it("reports accurate counts across a mixed transcript", () => {
    const messages: ChatMessage[] = [
      userMessage("hi", "0"),
      {
        id: "1",
        role: "assistant",
        parts: [
          { type: "tool-a", toolCallId: "c1", state: "input-available", input: '{"n":1}' },
          { type: "tool-b", toolCallId: "c2", state: "output-available", input: {}, output: { ok: true } },
        ],
      },
    ];
    const report = repairTranscript(messages);
    expect(report.removedToolCalls).toBe(1);
    expect(report.normalizedInputs).toBe(1);
    expect(report.toolCallIds).toEqual(["c1"]);
    expect(report.changed).toBe(true);
  });
});

describe("sanitizeForPersistence", () => {
  it("preserves the standard shape of a message", () => {
    const msg: ChatMessage = {
      id: "1",
      role: "assistant",
      parts: [{ type: "text", text: "hi" }],
      metadata: { channelId: "c1" },
      createdAt: 123,
    };
    expect(sanitizeForPersistence(msg)).toEqual(msg);
  });

  it("drops unknown/transient top-level properties", () => {
    const msg = {
      id: "1",
      role: "assistant",
      parts: [{ type: "text", text: "hi" }],
      _streamProviderMetadata: { chunkId: "abc" },
    } as unknown as ChatMessage;
    const sanitized = sanitizeForPersistence(msg);
    expect(sanitized).toEqual({ id: "1", role: "assistant", parts: [{ type: "text", text: "hi" }] });
    expect((sanitized as unknown as Record<string, unknown>)["_streamProviderMetadata"]).toBeUndefined();
  });

  it("drops unknown/transient properties on tool parts", () => {
    const msg = {
      id: "1",
      role: "assistant",
      parts: [
        {
          type: "tool-search",
          toolCallId: "call_1",
          state: "output-available",
          output: { ok: true },
          providerMetadata: { anthropic: { chunk: 3 } },
        },
      ],
    } as unknown as ChatMessage;
    const sanitized = sanitizeForPersistence(msg);
    expect(sanitized.parts[0]).toEqual({
      type: "tool-search",
      toolCallId: "call_1",
      state: "output-available",
      output: { ok: true },
    });
  });

  it("drops function values and other non-JSON values", () => {
    const msg = {
      id: "1",
      role: "assistant",
      parts: [{ type: "text", text: "hi" }],
      metadata: { onDone: () => {}, keep: "yes" },
    } as unknown as ChatMessage;
    const sanitized = sanitizeForPersistence(msg);
    expect(sanitized.metadata).toEqual({ keep: "yes" });
  });

  it("keeps file part fields intact", () => {
    const msg: ChatMessage = {
      id: "1",
      role: "user",
      parts: [{ type: "file", mediaType: "image/png", data: "abc123", filename: "x.png" }],
    };
    expect(sanitizeForPersistence(msg)).toEqual(msg);
  });
});
