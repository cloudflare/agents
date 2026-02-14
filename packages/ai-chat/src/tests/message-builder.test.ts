import { describe, it, expect } from "vitest";
import {
  applyChunkToParts,
  type MessageParts,
  type StreamChunkData
} from "../message-builder";

function makeParts(): MessageParts {
  return [];
}

describe("applyChunkToParts", () => {
  describe("text chunks", () => {
    it("text-start creates a streaming text part", () => {
      const parts = makeParts();
      const handled = applyChunkToParts(parts, {
        type: "text-start",
        id: "t1"
      });
      expect(handled).toBe(true);
      expect(parts.length).toBe(1);
      expect(parts[0]).toEqual({
        type: "text",
        text: "",
        state: "streaming"
      });
    });

    it("text-delta appends to existing text part", () => {
      const parts = makeParts();
      applyChunkToParts(parts, { type: "text-start", id: "t1" });
      applyChunkToParts(parts, {
        type: "text-delta",
        id: "t1",
        delta: "Hello "
      });
      applyChunkToParts(parts, {
        type: "text-delta",
        id: "t1",
        delta: "world!"
      });
      expect(parts.length).toBe(1);
      expect((parts[0] as { text: string }).text).toBe("Hello world!");
    });

    it("text-delta creates new text part with streaming state if no text-start received", () => {
      const parts = makeParts();
      applyChunkToParts(parts, {
        type: "text-delta",
        id: "t1",
        delta: "fallback"
      });
      expect(parts.length).toBe(1);
      expect((parts[0] as { text: string }).text).toBe("fallback");
      expect((parts[0] as { state: string }).state).toBe("streaming");
    });

    it("text-end marks fallback text part as done", () => {
      const parts = makeParts();
      // No text-start — simulates stream resumption
      applyChunkToParts(parts, {
        type: "text-delta",
        id: "t1",
        delta: "resumed"
      });
      applyChunkToParts(parts, { type: "text-end", id: "t1" });
      expect((parts[0] as { state: string }).state).toBe("done");
      expect((parts[0] as { text: string }).text).toBe("resumed");
    });

    it("text-end marks text part as done", () => {
      const parts = makeParts();
      applyChunkToParts(parts, { type: "text-start", id: "t1" });
      applyChunkToParts(parts, {
        type: "text-delta",
        id: "t1",
        delta: "content"
      });
      applyChunkToParts(parts, { type: "text-end", id: "t1" });
      expect((parts[0] as { state: string }).state).toBe("done");
      expect((parts[0] as { text: string }).text).toBe("content");
    });

    it("handles a full text lifecycle", () => {
      const parts = makeParts();
      applyChunkToParts(parts, { type: "text-start", id: "t1" });
      applyChunkToParts(parts, {
        type: "text-delta",
        id: "t1",
        delta: "The "
      });
      applyChunkToParts(parts, {
        type: "text-delta",
        id: "t1",
        delta: "answer is 42."
      });
      applyChunkToParts(parts, { type: "text-end", id: "t1" });

      expect(parts.length).toBe(1);
      expect(parts[0]).toEqual({
        type: "text",
        text: "The answer is 42.",
        state: "done"
      });
    });
  });

  describe("reasoning chunks", () => {
    it("reasoning-start creates a streaming reasoning part", () => {
      const parts = makeParts();
      applyChunkToParts(parts, { type: "reasoning-start", id: "r1" });
      expect(parts.length).toBe(1);
      expect(parts[0]).toEqual({
        type: "reasoning",
        text: "",
        state: "streaming"
      });
    });

    it("reasoning-delta appends to reasoning part", () => {
      const parts = makeParts();
      applyChunkToParts(parts, { type: "reasoning-start", id: "r1" });
      applyChunkToParts(parts, {
        type: "reasoning-delta",
        id: "r1",
        delta: "thinking..."
      });
      expect((parts[0] as { text: string }).text).toBe("thinking...");
    });

    it("reasoning-end marks reasoning as done", () => {
      const parts = makeParts();
      applyChunkToParts(parts, { type: "reasoning-start", id: "r1" });
      applyChunkToParts(parts, {
        type: "reasoning-delta",
        id: "r1",
        delta: "done thinking"
      });
      applyChunkToParts(parts, { type: "reasoning-end", id: "r1" });
      expect((parts[0] as { state: string }).state).toBe("done");
    });

    it("reasoning-delta creates fallback part when no reasoning-start received", () => {
      const parts = makeParts();
      // No reasoning-start — simulates stream resumption where start was missed
      applyChunkToParts(parts, {
        type: "reasoning-delta",
        id: "r1",
        delta: "resumed thinking"
      });
      expect(parts.length).toBe(1);
      expect(parts[0]).toEqual({
        type: "reasoning",
        text: "resumed thinking",
        state: "streaming"
      });

      // Subsequent deltas append normally
      applyChunkToParts(parts, {
        type: "reasoning-delta",
        id: "r1",
        delta: " more"
      });
      expect((parts[0] as { text: string }).text).toBe("resumed thinking more");
    });
  });

  describe("file chunks", () => {
    it("creates a file part", () => {
      const parts = makeParts();
      applyChunkToParts(parts, {
        type: "file",
        mediaType: "image/png",
        url: "https://example.com/image.png"
      });
      expect(parts.length).toBe(1);
      expect(parts[0]).toEqual({
        type: "file",
        mediaType: "image/png",
        url: "https://example.com/image.png"
      });
    });
  });

  describe("source chunks", () => {
    it("creates a source-url part", () => {
      const parts = makeParts();
      applyChunkToParts(parts, {
        type: "source-url",
        sourceId: "s1",
        url: "https://example.com",
        title: "Example"
      });
      expect(parts[0]).toEqual({
        type: "source-url",
        sourceId: "s1",
        url: "https://example.com",
        title: "Example",
        providerMetadata: undefined
      });
    });

    it("creates a source-document part", () => {
      const parts = makeParts();
      applyChunkToParts(parts, {
        type: "source-document",
        sourceId: "d1",
        mediaType: "application/pdf",
        title: "Doc",
        filename: "doc.pdf"
      });
      expect(parts[0]).toEqual({
        type: "source-document",
        sourceId: "d1",
        mediaType: "application/pdf",
        title: "Doc",
        filename: "doc.pdf",
        providerMetadata: undefined
      });
    });
  });

  describe("tool chunks", () => {
    it("tool-input-available creates a tool part", () => {
      const parts = makeParts();
      applyChunkToParts(parts, {
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "getWeather",
        input: { city: "London" }
      });
      expect(parts.length).toBe(1);
      const part = parts[0] as Record<string, unknown>;
      expect(part.type).toBe("tool-getWeather");
      expect(part.toolCallId).toBe("call_1");
      expect(part.state).toBe("input-available");
      expect(part.input).toEqual({ city: "London" });
    });

    it("tool-output-available updates existing tool part", () => {
      const parts = makeParts();
      applyChunkToParts(parts, {
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "getWeather",
        input: { city: "London" }
      });
      applyChunkToParts(parts, {
        type: "tool-output-available",
        toolCallId: "call_1",
        output: "Sunny, 22°C"
      });
      expect(parts.length).toBe(1);
      const part = parts[0] as Record<string, unknown>;
      expect(part.state).toBe("output-available");
      expect(part.output).toBe("Sunny, 22°C");
    });

    it("tool-output-available is a no-op if tool part not found", () => {
      const parts = makeParts();
      // No tool-input-available first
      applyChunkToParts(parts, {
        type: "tool-output-available",
        toolCallId: "nonexistent",
        output: "result"
      });
      expect(parts.length).toBe(0); // Nothing added
    });
  });

  describe("step chunks", () => {
    it("start-step adds a step-start part", () => {
      const parts = makeParts();
      applyChunkToParts(parts, { type: "start-step" });
      expect(parts.length).toBe(1);
      expect(parts[0].type).toBe("step-start");
    });

    it("step-start (client alias) also adds a step-start part", () => {
      const parts = makeParts();
      applyChunkToParts(parts, { type: "step-start" });
      expect(parts.length).toBe(1);
      expect(parts[0].type).toBe("step-start");
    });
  });

  describe("unrecognized chunks", () => {
    it("returns false for unknown chunk types", () => {
      const parts = makeParts();
      const handled = applyChunkToParts(parts, {
        type: "unknown-type"
      } as StreamChunkData);
      expect(handled).toBe(false);
      expect(parts.length).toBe(0);
    });
  });

  describe("mixed content", () => {
    it("builds a complex message with text + reasoning + tool + file", () => {
      const parts = makeParts();

      // Reasoning first
      applyChunkToParts(parts, { type: "reasoning-start", id: "r1" });
      applyChunkToParts(parts, {
        type: "reasoning-delta",
        id: "r1",
        delta: "Let me think..."
      });
      applyChunkToParts(parts, { type: "reasoning-end", id: "r1" });

      // Step boundary
      applyChunkToParts(parts, { type: "start-step" });

      // Text
      applyChunkToParts(parts, { type: "text-start", id: "t1" });
      applyChunkToParts(parts, {
        type: "text-delta",
        id: "t1",
        delta: "Here's the weather"
      });
      applyChunkToParts(parts, { type: "text-end", id: "t1" });

      // Tool call
      applyChunkToParts(parts, {
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "getWeather",
        input: { city: "London" }
      });
      applyChunkToParts(parts, {
        type: "tool-output-available",
        toolCallId: "call_1",
        output: { temp: 22, condition: "Sunny" }
      });

      // File
      applyChunkToParts(parts, {
        type: "file",
        mediaType: "image/png",
        url: "https://example.com/chart.png"
      });

      // reasoning + step-start + text + tool (updated in place) + file = 5
      expect(parts.length).toBe(5);
      expect(parts[0].type).toBe("reasoning");
      expect(parts[1].type).toBe("step-start");
      expect(parts[2].type).toBe("text");
      expect(parts[3].type).toBe("tool-getWeather");
      expect((parts[3] as Record<string, unknown>).state).toBe(
        "output-available"
      );
      expect(parts[4].type).toBe("file");
    });
  });

  describe("tool streaming lifecycle", () => {
    it("tool-input-start creates a tool part in input-streaming state", () => {
      const parts = makeParts();
      const handled = applyChunkToParts(parts, {
        type: "tool-input-start",
        toolCallId: "call_1",
        toolName: "getWeather"
      });
      expect(handled).toBe(true);
      expect(parts.length).toBe(1);
      const part = parts[0] as Record<string, unknown>;
      expect(part.type).toBe("tool-getWeather");
      expect(part.toolCallId).toBe("call_1");
      expect(part.state).toBe("input-streaming");
      expect(part.input).toBeUndefined();
    });

    it("tool-input-delta updates the tool part with partial input", () => {
      const parts = makeParts();
      applyChunkToParts(parts, {
        type: "tool-input-start",
        toolCallId: "call_1",
        toolName: "getWeather"
      });
      applyChunkToParts(parts, {
        type: "tool-input-delta",
        toolCallId: "call_1",
        input: { city: "Lon" }
      });
      expect(parts.length).toBe(1);
      expect((parts[0] as Record<string, unknown>).input).toEqual({
        city: "Lon"
      });
      expect((parts[0] as Record<string, unknown>).state).toBe(
        "input-streaming"
      );
    });

    it("tool-input-available finalizes an existing streaming tool part", () => {
      const parts = makeParts();
      applyChunkToParts(parts, {
        type: "tool-input-start",
        toolCallId: "call_1",
        toolName: "getWeather"
      });
      applyChunkToParts(parts, {
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "getWeather",
        input: { city: "London" }
      });
      expect(parts.length).toBe(1);
      const part = parts[0] as Record<string, unknown>;
      expect(part.state).toBe("input-available");
      expect(part.input).toEqual({ city: "London" });
    });

    it("tool-input-available creates a new part if no tool-input-start", () => {
      const parts = makeParts();
      applyChunkToParts(parts, {
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "getWeather",
        input: { city: "London" }
      });
      expect(parts.length).toBe(1);
      expect((parts[0] as Record<string, unknown>).state).toBe(
        "input-available"
      );
    });

    it("full tool streaming lifecycle: start -> delta -> available -> output", () => {
      const parts = makeParts();

      applyChunkToParts(parts, {
        type: "tool-input-start",
        toolCallId: "call_1",
        toolName: "getWeather"
      });
      expect((parts[0] as Record<string, unknown>).state).toBe(
        "input-streaming"
      );

      applyChunkToParts(parts, {
        type: "tool-input-delta",
        toolCallId: "call_1",
        input: { city: "Lon" }
      });

      applyChunkToParts(parts, {
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "getWeather",
        input: { city: "London" }
      });
      expect((parts[0] as Record<string, unknown>).state).toBe(
        "input-available"
      );

      applyChunkToParts(parts, {
        type: "tool-output-available",
        toolCallId: "call_1",
        output: "Sunny, 22C"
      });
      expect((parts[0] as Record<string, unknown>).state).toBe(
        "output-available"
      );
      expect((parts[0] as Record<string, unknown>).output).toBe("Sunny, 22C");
      expect(parts.length).toBe(1);
    });
  });

  describe("tool error handling", () => {
    it("tool-input-error marks tool part as output-error", () => {
      const parts = makeParts();
      applyChunkToParts(parts, {
        type: "tool-input-start",
        toolCallId: "call_1",
        toolName: "getWeather"
      });
      applyChunkToParts(parts, {
        type: "tool-input-error",
        toolCallId: "call_1",
        toolName: "getWeather",
        input: '{"city": "Lond',
        errorText: "Unexpected end of JSON input"
      });
      const part = parts[0] as Record<string, unknown>;
      expect(part.state).toBe("output-error");
      expect(part.errorText).toBe("Unexpected end of JSON input");
    });

    it("tool-input-error creates a new part if no tool-input-start", () => {
      const parts = makeParts();
      applyChunkToParts(parts, {
        type: "tool-input-error",
        toolCallId: "call_1",
        toolName: "getWeather",
        errorText: "Schema validation failed"
      });
      expect(parts.length).toBe(1);
      expect((parts[0] as Record<string, unknown>).state).toBe("output-error");
    });

    it("tool-output-error marks tool part as output-error", () => {
      const parts = makeParts();
      applyChunkToParts(parts, {
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "getWeather",
        input: { city: "London" }
      });
      applyChunkToParts(parts, {
        type: "tool-output-error",
        toolCallId: "call_1",
        errorText: "API rate limit exceeded"
      });
      const part = parts[0] as Record<string, unknown>;
      expect(part.state).toBe("output-error");
      expect(part.errorText).toBe("API rate limit exceeded");
    });

    it("tool-output-error is a no-op if tool part not found", () => {
      const parts = makeParts();
      applyChunkToParts(parts, {
        type: "tool-output-error",
        toolCallId: "nonexistent",
        errorText: "error"
      });
      expect(parts.length).toBe(0);
    });
  });

  describe("preliminary tool output", () => {
    it("tool-output-available with preliminary=true marks output as preliminary", () => {
      const parts = makeParts();
      applyChunkToParts(parts, {
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "streamingTool",
        input: {}
      });
      applyChunkToParts(parts, {
        type: "tool-output-available",
        toolCallId: "call_1",
        output: { partial: true, data: "chunk1" },
        preliminary: true
      });
      const part = parts[0] as Record<string, unknown>;
      expect(part.state).toBe("output-available");
      expect(part.preliminary).toBe(true);
      expect(part.output).toEqual({ partial: true, data: "chunk1" });
    });

    it("subsequent tool-output-available with preliminary=false finalizes", () => {
      const parts = makeParts();
      applyChunkToParts(parts, {
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "streamingTool",
        input: {}
      });
      applyChunkToParts(parts, {
        type: "tool-output-available",
        toolCallId: "call_1",
        output: "partial",
        preliminary: true
      });
      expect((parts[0] as Record<string, unknown>).preliminary).toBe(true);

      applyChunkToParts(parts, {
        type: "tool-output-available",
        toolCallId: "call_1",
        output: "complete result",
        preliminary: false
      });
      const part = parts[0] as Record<string, unknown>;
      expect(part.preliminary).toBe(false);
      expect(part.output).toBe("complete result");
    });

    it("tool-output-available without preliminary does not set the flag", () => {
      const parts = makeParts();
      applyChunkToParts(parts, {
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "getWeather",
        input: { city: "London" }
      });
      applyChunkToParts(parts, {
        type: "tool-output-available",
        toolCallId: "call_1",
        output: "Sunny"
      });
      const part = parts[0] as Record<string, unknown>;
      expect(part.preliminary).toBeUndefined();
    });
  });

  describe("metadata and message-level chunks", () => {
    it("returns false for 'start' chunk (caller handles metadata)", () => {
      const parts = makeParts();
      const handled = applyChunkToParts(parts, {
        type: "start",
        messageId: "msg-1",
        messageMetadata: { model: "gpt-4o" }
      } as StreamChunkData);
      expect(handled).toBe(false);
      // Should not add any parts
      expect(parts.length).toBe(0);
    });

    it("returns false for 'finish' chunk (caller handles metadata)", () => {
      const parts = makeParts();
      const handled = applyChunkToParts(parts, {
        type: "finish",
        messageMetadata: { totalTokens: 100 }
      } as StreamChunkData);
      expect(handled).toBe(false);
      expect(parts.length).toBe(0);
    });

    it("returns false for 'message-metadata' chunk (caller handles metadata)", () => {
      const parts = makeParts();
      const handled = applyChunkToParts(parts, {
        type: "message-metadata",
        messageMetadata: { createdAt: 1234567890 }
      } as StreamChunkData);
      expect(handled).toBe(false);
      expect(parts.length).toBe(0);
    });

    it("returns false for 'finish-step' chunk", () => {
      const parts = makeParts();
      const handled = applyChunkToParts(parts, {
        type: "finish-step"
      } as StreamChunkData);
      expect(handled).toBe(false);
      expect(parts.length).toBe(0);
    });
  });
});
