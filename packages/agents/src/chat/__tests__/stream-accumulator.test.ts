import { describe, it, expect } from "vitest";
import {
  StreamAccumulator,
  type StreamAccumulatorOptions
} from "../stream-accumulator";
import type { StreamChunkData } from "../message-builder";
import type { UIMessage } from "ai";

function acc(opts: Partial<StreamAccumulatorOptions> = {}) {
  return new StreamAccumulator({ messageId: "msg-1", ...opts });
}

describe("StreamAccumulator", () => {
  // ── Basic chunk handling ──────────────────────────────────────────

  describe("text chunks", () => {
    it("text-start creates a streaming text part", () => {
      const a = acc();
      const r = a.applyChunk({ type: "text-start" } as StreamChunkData);
      expect(r.handled).toBe(true);
      expect(r.action).toBeUndefined();
      expect(a.parts).toHaveLength(1);
      expect(a.parts[0]).toMatchObject({
        type: "text",
        text: "",
        state: "streaming"
      });
    });

    it("text-delta appends to the last text part", () => {
      const a = acc();
      a.applyChunk({ type: "text-start" } as StreamChunkData);
      a.applyChunk({ type: "text-delta", delta: "hello " } as StreamChunkData);
      a.applyChunk({ type: "text-delta", delta: "world" } as StreamChunkData);
      expect((a.parts[0] as { text: string }).text).toBe("hello world");
    });

    it("text-delta without prior text-start creates a new part", () => {
      const a = acc();
      a.applyChunk({ type: "text-delta", delta: "resumed" } as StreamChunkData);
      expect(a.parts).toHaveLength(1);
      expect((a.parts[0] as { text: string }).text).toBe("resumed");
    });

    it("text-end sets state to done", () => {
      const a = acc();
      a.applyChunk({ type: "text-start" } as StreamChunkData);
      a.applyChunk({ type: "text-end" } as StreamChunkData);
      expect((a.parts[0] as { state: string }).state).toBe("done");
    });
  });

  describe("reasoning chunks", () => {
    it("reasoning lifecycle: start → delta → end", () => {
      const a = acc();
      a.applyChunk({ type: "reasoning-start" } as StreamChunkData);
      a.applyChunk({
        type: "reasoning-delta",
        delta: "thinking..."
      } as StreamChunkData);
      a.applyChunk({ type: "reasoning-end" } as StreamChunkData);

      expect(a.parts).toHaveLength(1);
      expect(a.parts[0]).toMatchObject({
        type: "reasoning",
        text: "thinking...",
        state: "done"
      });
    });

    it("reasoning-delta without start creates a new part", () => {
      const a = acc();
      a.applyChunk({
        type: "reasoning-delta",
        delta: "resumed"
      } as StreamChunkData);
      expect(a.parts).toHaveLength(1);
      expect((a.parts[0] as { text: string }).text).toBe("resumed");
    });
  });

  describe("file and source chunks", () => {
    it("file chunk appends a file part", () => {
      const a = acc();
      const r = a.applyChunk({
        type: "file",
        mediaType: "image/png",
        url: "https://example.com/img.png"
      } as StreamChunkData);
      expect(r.handled).toBe(true);
      expect(a.parts[0]).toMatchObject({
        type: "file",
        mediaType: "image/png",
        url: "https://example.com/img.png"
      });
    });

    it("source-url chunk appends a source-url part", () => {
      const a = acc();
      a.applyChunk({
        type: "source-url",
        sourceId: "s1",
        url: "https://example.com",
        title: "Example"
      } as StreamChunkData);
      expect(a.parts[0]).toMatchObject({
        type: "source-url",
        sourceId: "s1",
        url: "https://example.com",
        title: "Example"
      });
    });

    it("source-document chunk appends a source-document part", () => {
      const a = acc();
      a.applyChunk({
        type: "source-document",
        sourceId: "s2",
        mediaType: "application/pdf",
        title: "Doc",
        filename: "doc.pdf"
      } as StreamChunkData);
      expect(a.parts[0]).toMatchObject({
        type: "source-document",
        sourceId: "s2",
        title: "Doc"
      });
    });
  });

  describe("step-start", () => {
    it("step-start appends a step-start part", () => {
      const a = acc();
      const r = a.applyChunk({ type: "step-start" } as StreamChunkData);
      expect(r.handled).toBe(true);
      expect(a.parts[0]).toMatchObject({ type: "step-start" });
    });

    it("start-step is aliased to step-start", () => {
      const a = acc();
      a.applyChunk({ type: "start-step" } as StreamChunkData);
      expect(a.parts[0]).toMatchObject({ type: "step-start" });
    });
  });

  describe("data-* chunks", () => {
    it("appends a data-status part", () => {
      const a = acc();
      const r = a.applyChunk({
        type: "data-status",
        id: "d1",
        data: { progress: 50 }
      } as StreamChunkData);
      expect(r.handled).toBe(true);
      const part = a.parts[0] as Record<string, unknown>;
      expect(part.type).toBe("data-status");
      expect(part.data).toEqual({ progress: 50 });
    });

    it("reconciles data parts by type+id", () => {
      const a = acc();
      a.applyChunk({
        type: "data-status",
        id: "d1",
        data: { v: 1 }
      } as StreamChunkData);
      a.applyChunk({
        type: "data-status",
        id: "d1",
        data: { v: 2 }
      } as StreamChunkData);
      expect(a.parts).toHaveLength(1);
      expect((a.parts[0] as Record<string, unknown>).data).toEqual({ v: 2 });
    });

    it("transient data parts are handled but not added to parts", () => {
      const a = acc();
      const r = a.applyChunk({
        type: "data-ephemeral",
        transient: true,
        data: { tmp: true }
      } as StreamChunkData);
      expect(r.handled).toBe(true);
      expect(a.parts).toHaveLength(0);
    });
  });

  // ── Tool lifecycle ────────────────────────────────────────────────

  describe("tool lifecycle", () => {
    it("tool-input-start creates a tool part in input-streaming state", () => {
      const a = acc();
      a.applyChunk({
        type: "tool-input-start",
        toolCallId: "tc1",
        toolName: "getWeather"
      } as StreamChunkData);
      const part = a.parts[0] as Record<string, unknown>;
      expect(part.type).toBe("tool-getWeather");
      expect(part.state).toBe("input-streaming");
      expect(part.toolCallId).toBe("tc1");
    });

    it("tool-input-delta updates the tool input", () => {
      const a = acc();
      a.applyChunk({
        type: "tool-input-start",
        toolCallId: "tc1",
        toolName: "search"
      } as StreamChunkData);
      a.applyChunk({
        type: "tool-input-delta",
        toolCallId: "tc1",
        input: { query: "partial" }
      } as StreamChunkData);
      expect((a.parts[0] as Record<string, unknown>).input).toEqual({
        query: "partial"
      });
    });

    it("tool-input-available finalizes input", () => {
      const a = acc();
      a.applyChunk({
        type: "tool-input-start",
        toolCallId: "tc1",
        toolName: "calc"
      } as StreamChunkData);
      a.applyChunk({
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "calc",
        input: { x: 42 }
      } as StreamChunkData);
      const part = a.parts[0] as Record<string, unknown>;
      expect(part.state).toBe("input-available");
      expect(part.input).toEqual({ x: 42 });
    });

    it("tool-input-available without prior start creates a new part", () => {
      const a = acc();
      a.applyChunk({
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "calc",
        input: { x: 1 }
      } as StreamChunkData);
      expect(a.parts).toHaveLength(1);
      expect((a.parts[0] as Record<string, unknown>).state).toBe(
        "input-available"
      );
    });

    it("tool-input-error marks the tool as output-error", () => {
      const a = acc();
      a.applyChunk({
        type: "tool-input-start",
        toolCallId: "tc1",
        toolName: "calc"
      } as StreamChunkData);
      a.applyChunk({
        type: "tool-input-error",
        toolCallId: "tc1",
        toolName: "calc",
        errorText: "parse failed"
      } as StreamChunkData);
      expect((a.parts[0] as Record<string, unknown>).state).toBe(
        "output-error"
      );
    });

    it("tool-output-available updates an existing tool part", () => {
      const a = acc();
      a.applyChunk({
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "calc",
        input: { x: 1 }
      } as StreamChunkData);
      const r = a.applyChunk({
        type: "tool-output-available",
        toolCallId: "tc1",
        output: { result: 42 }
      } as StreamChunkData);
      expect(r.handled).toBe(true);
      expect(r.action).toBeUndefined();
      const part = a.parts[0] as Record<string, unknown>;
      expect(part.state).toBe("output-available");
      expect(part.output).toEqual({ result: 42 });
    });

    it("tool-output-error updates an existing tool part", () => {
      const a = acc();
      a.applyChunk({
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "calc",
        input: {}
      } as StreamChunkData);
      a.applyChunk({
        type: "tool-output-error",
        toolCallId: "tc1",
        errorText: "timeout"
      } as StreamChunkData);
      expect((a.parts[0] as Record<string, unknown>).state).toBe(
        "output-error"
      );
    });

    it("tool-output-denied marks the tool as denied", () => {
      const a = acc();
      a.applyChunk({
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "rm",
        input: {}
      } as StreamChunkData);
      a.applyChunk({
        type: "tool-output-denied",
        toolCallId: "tc1"
      } as StreamChunkData);
      expect((a.parts[0] as Record<string, unknown>).state).toBe(
        "output-denied"
      );
    });
  });

  describe("tool-approval-request action", () => {
    it("returns tool-approval-request action with toolCallId", () => {
      const a = acc();
      a.applyChunk({
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "danger",
        input: {}
      } as StreamChunkData);
      const r = a.applyChunk({
        type: "tool-approval-request",
        toolCallId: "tc1",
        approvalId: "apr-1"
      } as StreamChunkData);
      expect(r.handled).toBe(true);
      expect(r.action).toEqual({
        type: "tool-approval-request",
        toolCallId: "tc1"
      });
    });
  });

  describe("cross-message tool update", () => {
    it("returns cross-message-tool-update when toolCallId is not in parts", () => {
      const a = acc();
      const r = a.applyChunk({
        type: "tool-output-available",
        toolCallId: "tc-other",
        output: { data: "from previous message" }
      } as StreamChunkData);
      expect(r.handled).toBe(true);
      expect(r.action).toEqual({
        type: "cross-message-tool-update",
        updateType: "output-available",
        toolCallId: "tc-other",
        output: { data: "from previous message" },
        errorText: undefined,
        preliminary: undefined
      });
    });

    it("returns cross-message-tool-update for tool-output-error", () => {
      const a = acc();
      const r = a.applyChunk({
        type: "tool-output-error",
        toolCallId: "tc-other",
        errorText: "failed"
      } as StreamChunkData);
      expect(r.action).toEqual({
        type: "cross-message-tool-update",
        updateType: "output-error",
        toolCallId: "tc-other",
        output: undefined,
        errorText: "failed",
        preliminary: undefined
      });
    });

    it("does not return cross-message action when toolCallId IS in parts", () => {
      const a = acc();
      a.applyChunk({
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "calc",
        input: {}
      } as StreamChunkData);
      const r = a.applyChunk({
        type: "tool-output-available",
        toolCallId: "tc1",
        output: 42
      } as StreamChunkData);
      expect(r.action).toBeUndefined();
    });
  });

  // ── Metadata chunks ───────────────────────────────────────────────

  describe("metadata chunks", () => {
    it("start chunk sets messageId and merges metadata", () => {
      const a = acc();
      const r = a.applyChunk({
        type: "start",
        messageId: "server-id-1",
        messageMetadata: { model: "gpt-4" }
      } as StreamChunkData);
      expect(r.handled).toBe(true);
      expect(r.action).toEqual({
        type: "start",
        messageId: "server-id-1",
        metadata: { model: "gpt-4" }
      });
      expect(a.messageId).toBe("server-id-1");
      expect(a.metadata).toEqual({ model: "gpt-4" });
    });

    it("start chunk merges into existing metadata", () => {
      const a = acc({ messageId: "m1", existingMetadata: { existing: true } });
      a.applyChunk({
        type: "start",
        messageMetadata: { model: "gpt-4" }
      } as StreamChunkData);
      expect(a.metadata).toEqual({ existing: true, model: "gpt-4" });
    });

    it("finish chunk merges metadata and returns finishReason", () => {
      const a = acc();
      const r = a.applyChunk({
        type: "finish",
        finishReason: "stop",
        messageMetadata: { tokens: 100 }
      } as StreamChunkData);
      expect(r.action).toEqual({
        type: "finish",
        finishReason: "stop",
        metadata: { tokens: 100 }
      });
      expect(a.metadata).toEqual({ tokens: 100 });
    });

    it("finish chunk without finishReason returns undefined", () => {
      const a = acc();
      const r = a.applyChunk({ type: "finish" } as StreamChunkData);
      expect(r.action?.type).toBe("finish");
      if (r.action?.type === "finish") {
        expect(r.action.finishReason).toBeUndefined();
      }
    });

    it("message-metadata chunk merges metadata", () => {
      const a = acc();
      a.applyChunk({
        type: "start",
        messageMetadata: { a: 1 }
      } as StreamChunkData);
      const r = a.applyChunk({
        type: "message-metadata",
        messageMetadata: { b: 2 }
      } as StreamChunkData);
      expect(r.action).toEqual({
        type: "message-metadata",
        metadata: { b: 2 }
      });
      expect(a.metadata).toEqual({ a: 1, b: 2 });
    });

    it("finish-step is handled but does not change state", () => {
      const a = acc();
      const r = a.applyChunk({ type: "finish-step" } as StreamChunkData);
      expect(r.handled).toBe(true);
      expect(r.action).toBeUndefined();
      expect(a.parts).toHaveLength(0);
    });

    it("error chunk returns error action", () => {
      const a = acc();
      const r = a.applyChunk({
        type: "error",
        errorText: "LLM failed"
      } as StreamChunkData);
      expect(r.handled).toBe(true);
      expect(r.action).toEqual({ type: "error", error: "LLM failed" });
    });

    it("error chunk without errorText stringifies the chunk", () => {
      const a = acc();
      const r = a.applyChunk({ type: "error" } as StreamChunkData);
      expect(r.action?.type).toBe("error");
      if (r.action?.type === "error") {
        expect(r.action.error).toContain("error");
      }
    });
  });

  // ── Continuation mode ─────────────────────────────────────────────

  describe("continuation mode", () => {
    it("carries forward existing parts", () => {
      const existing: UIMessage["parts"] = [
        { type: "text", text: "previous" } as UIMessage["parts"][number]
      ];
      const a = acc({
        messageId: "m1",
        continuation: true,
        existingParts: existing
      });
      expect(a.parts).toHaveLength(1);
      expect((a.parts[0] as { text: string }).text).toBe("previous");
    });

    it("does not overwrite messageId on start chunk", () => {
      const a = acc({ messageId: "client-id", continuation: true });
      a.applyChunk({
        type: "start",
        messageId: "server-id"
      } as StreamChunkData);
      expect(a.messageId).toBe("client-id");
    });

    it("overwrites messageId on start chunk when NOT continuation", () => {
      const a = acc({ messageId: "client-id" });
      a.applyChunk({
        type: "start",
        messageId: "server-id"
      } as StreamChunkData);
      expect(a.messageId).toBe("server-id");
    });

    it("carries forward existing metadata", () => {
      const a = acc({
        messageId: "m1",
        continuation: true,
        existingMetadata: { model: "gpt-4" }
      });
      expect(a.metadata).toEqual({ model: "gpt-4" });
    });
  });

  // ── toMessage() ───────────────────────────────────────────────────

  describe("toMessage", () => {
    it("returns a UIMessage snapshot with correct fields", () => {
      const a = acc({ messageId: "m1" });
      a.applyChunk({ type: "text-start" } as StreamChunkData);
      a.applyChunk({ type: "text-delta", delta: "hello" } as StreamChunkData);
      a.applyChunk({
        type: "start",
        messageMetadata: { model: "gpt-4" }
      } as StreamChunkData);

      const msg = a.toMessage();
      expect(msg.id).toBe("m1");
      expect(msg.role).toBe("assistant");
      expect(msg.parts).toHaveLength(1);
      expect((msg.parts[0] as { text: string }).text).toBe("hello");
      expect(msg.metadata).toEqual({ model: "gpt-4" });
    });

    it("returns a copy of parts (not the same reference)", () => {
      const a = acc();
      a.applyChunk({ type: "text-start" } as StreamChunkData);
      const msg = a.toMessage();
      expect(msg.parts).not.toBe(a.parts);
      expect(msg.parts).toEqual(a.parts);
    });

    it("omits metadata when not set", () => {
      const a = acc();
      const msg = a.toMessage();
      expect("metadata" in msg).toBe(false);
    });
  });

  // ── mergeInto() ───────────────────────────────────────────────────

  describe("mergeInto", () => {
    const userMsg: UIMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "hello" }]
    } as UIMessage;

    const assistantMsg: UIMessage = {
      id: "asst-1",
      role: "assistant",
      parts: [{ type: "text", text: "hi" }]
    } as UIMessage;

    it("appends when messageId is not found and not continuation", () => {
      const a = acc({ messageId: "new-msg" });
      a.applyChunk({ type: "text-start" } as StreamChunkData);
      const result = a.mergeInto([userMsg]);
      expect(result).toHaveLength(2);
      expect(result[1].id).toBe("new-msg");
      expect(result[1].role).toBe("assistant");
    });

    it("replaces existing message by messageId", () => {
      const a = acc({ messageId: "asst-1" });
      a.applyChunk({ type: "text-start" } as StreamChunkData);
      a.applyChunk({
        type: "text-delta",
        delta: "updated"
      } as StreamChunkData);
      const result = a.mergeInto([userMsg, assistantMsg]);
      expect(result).toHaveLength(2);
      expect((result[1].parts[0] as { text: string }).text).toBe("updated");
    });

    it("continuation falls back to last assistant when messageId not found", () => {
      const a = acc({ messageId: "unknown-id", continuation: true });
      a.applyChunk({ type: "text-start" } as StreamChunkData);
      a.applyChunk({
        type: "text-delta",
        delta: "continued"
      } as StreamChunkData);
      const result = a.mergeInto([userMsg, assistantMsg]);
      expect(result).toHaveLength(2);
      expect(result[1].id).toBe("asst-1");
      expect((result[1].parts[0] as { text: string }).text).toBe("continued");
    });

    it("continuation appends when no assistant exists", () => {
      const a = acc({ messageId: "unknown-id", continuation: true });
      a.applyChunk({ type: "text-start" } as StreamChunkData);
      const result = a.mergeInto([userMsg]);
      expect(result).toHaveLength(2);
      expect(result[1].id).toBe("unknown-id");
    });

    it("preserves other messages in the array", () => {
      const a = acc({ messageId: "asst-1" });
      a.applyChunk({ type: "text-start" } as StreamChunkData);
      const result = a.mergeInto([userMsg, assistantMsg]);
      expect(result[0]).toBe(userMsg);
    });

    it("returns a new array (does not mutate input)", () => {
      const messages = [userMsg, assistantMsg];
      const a = acc({ messageId: "new-msg" });
      a.applyChunk({ type: "text-start" } as StreamChunkData);
      const result = a.mergeInto(messages);
      expect(result).not.toBe(messages);
      expect(messages).toHaveLength(2);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("multiple text segments create separate parts", () => {
      const a = acc();
      a.applyChunk({ type: "text-start" } as StreamChunkData);
      a.applyChunk({ type: "text-delta", delta: "first" } as StreamChunkData);
      a.applyChunk({ type: "text-end" } as StreamChunkData);
      a.applyChunk({ type: "text-start" } as StreamChunkData);
      a.applyChunk({ type: "text-delta", delta: "second" } as StreamChunkData);
      expect(a.parts).toHaveLength(2);
      expect((a.parts[0] as { text: string }).text).toBe("first");
      expect((a.parts[1] as { text: string }).text).toBe("second");
    });

    it("start chunk without messageId does not change messageId", () => {
      const a = acc({ messageId: "original" });
      a.applyChunk({
        type: "start",
        messageMetadata: { k: 1 }
      } as StreamChunkData);
      expect(a.messageId).toBe("original");
      expect(a.metadata).toEqual({ k: 1 });
    });

    it("start chunk without messageMetadata does not set metadata", () => {
      const a = acc();
      a.applyChunk({ type: "start", messageId: "x" } as StreamChunkData);
      expect(a.messageId).toBe("x");
      expect(a.metadata).toBeUndefined();
    });

    it("mergeInto with empty message array appends", () => {
      const a = acc({ messageId: "m1" });
      a.applyChunk({ type: "text-start" } as StreamChunkData);
      const result = a.mergeInto([]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("m1");
    });

    it("continuation prefers exact messageId match over backward walk", () => {
      const first: UIMessage = {
        id: "asst-first",
        role: "assistant",
        parts: [{ type: "text", text: "old" }]
      } as UIMessage;
      const target: UIMessage = {
        id: "target-id",
        role: "assistant",
        parts: [{ type: "text", text: "target" }]
      } as UIMessage;
      const a = acc({ messageId: "target-id", continuation: true });
      a.applyChunk({ type: "text-start" } as StreamChunkData);
      a.applyChunk({
        type: "text-delta",
        delta: "updated"
      } as StreamChunkData);
      const result = a.mergeInto([first, target]);
      expect(result[1].id).toBe("target-id");
      expect((result[1].parts[0] as { text: string }).text).toBe("updated");
      expect(result[0]).toBe(first);
    });

    it("tool-output-available preserves preliminary flag", () => {
      const a = acc();
      a.applyChunk({
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "calc",
        input: {}
      } as StreamChunkData);
      a.applyChunk({
        type: "tool-output-available",
        toolCallId: "tc1",
        output: { partial: true },
        preliminary: true
      } as StreamChunkData);
      const part = a.parts[0] as Record<string, unknown>;
      expect(part.preliminary).toBe(true);
    });

    it("data-* without id always appends (no reconciliation)", () => {
      const a = acc();
      a.applyChunk({
        type: "data-log",
        data: { msg: "first" }
      } as StreamChunkData);
      a.applyChunk({
        type: "data-log",
        data: { msg: "second" }
      } as StreamChunkData);
      expect(a.parts).toHaveLength(2);
    });

    it("tool-approval-request without matching part still returns action", () => {
      const a = acc();
      const r = a.applyChunk({
        type: "tool-approval-request",
        toolCallId: "tc-missing",
        approvalId: "apr-1"
      } as StreamChunkData);
      expect(r.handled).toBe(true);
      expect(r.action).toEqual({
        type: "tool-approval-request",
        toolCallId: "tc-missing"
      });
    });

    it("cross-message tool update with preliminary flag", () => {
      const a = acc();
      const r = a.applyChunk({
        type: "tool-output-available",
        toolCallId: "tc-other",
        output: "partial",
        preliminary: true
      } as StreamChunkData);
      expect(r.action).toEqual({
        type: "cross-message-tool-update",
        updateType: "output-available",
        toolCallId: "tc-other",
        output: "partial",
        errorText: undefined,
        preliminary: true
      });
    });
  });

  // ── Unrecognized chunks ───────────────────────────────────────────

  describe("unrecognized chunks", () => {
    it("returns handled: false for unknown chunk types", () => {
      const a = acc();
      const r = a.applyChunk({ type: "unknown-type" } as StreamChunkData);
      expect(r.handled).toBe(false);
      expect(r.action).toBeUndefined();
      expect(a.parts).toHaveLength(0);
    });
  });
});
