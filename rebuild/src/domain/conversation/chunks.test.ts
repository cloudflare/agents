import { describe, expect, it } from "vitest";
import { createAccumulator } from "./chunks.js";
import type { UiChunk } from "./chunks.js";
import type { ToolPart } from "../messages/model.js";

describe("createAccumulator", () => {
  it("uses the id from the start chunk", () => {
    const acc = createAccumulator();
    acc.push({ type: "start", messageId: "msg_42" });
    expect(acc.current().id).toBe("msg_42");
  });

  it("falls back to the provided idFallback when no start chunk has arrived", () => {
    const acc = createAccumulator("msg_fallback");
    acc.push({ type: "text-delta", delta: "hi" });
    expect(acc.current().id).toBe("msg_fallback");
  });

  it("generates a stable id when neither a start chunk nor a fallback is given", () => {
    const acc = createAccumulator();
    acc.push({ type: "text-delta", delta: "hi" });
    const id1 = acc.current().id;
    const id2 = acc.current().id;
    expect(typeof id1).toBe("string");
    expect(id1.length).toBeGreaterThan(0);
    expect(id1).toBe(id2);
  });

  it("a later start chunk overrides an idFallback", () => {
    const acc = createAccumulator("msg_fallback");
    acc.push({ type: "start", messageId: "msg_real" });
    expect(acc.current().id).toBe("msg_real");
  });

  it("produces an assistant message", () => {
    const acc = createAccumulator("msg_1");
    expect(acc.current().role).toBe("assistant");
  });

  describe("text and reasoning coalescing", () => {
    it("coalesces consecutive text-delta chunks into a single text part", () => {
      const acc = createAccumulator("msg_1");
      acc.push({ type: "text-delta", delta: "Hello, " });
      acc.push({ type: "text-delta", delta: "world" });
      acc.push({ type: "text-delta", delta: "!" });
      expect(acc.current().parts).toEqual([{ type: "text", text: "Hello, world!" }]);
    });

    it("coalesces consecutive reasoning-delta chunks into a single reasoning part", () => {
      const acc = createAccumulator("msg_1");
      acc.push({ type: "reasoning-delta", delta: "step 1. " });
      acc.push({ type: "reasoning-delta", delta: "step 2." });
      expect(acc.current().parts).toEqual([{ type: "reasoning", text: "step 1. step 2." }]);
    });

    it("starts a new part when the delta kind switches", () => {
      const acc = createAccumulator("msg_1");
      acc.push({ type: "reasoning-delta", delta: "thinking..." });
      acc.push({ type: "text-delta", delta: "answer part 1" });
      acc.push({ type: "text-delta", delta: " and 2" });
      acc.push({ type: "reasoning-delta", delta: "more thinking" });
      expect(acc.current().parts).toEqual([
        { type: "reasoning", text: "thinking..." },
        { type: "text", text: "answer part 1 and 2" },
        { type: "reasoning", text: "more thinking" },
      ]);
    });

    it("starts a new text part after a tool part interrupts the run", () => {
      const acc = createAccumulator("msg_1");
      acc.push({ type: "text-delta", delta: "before " });
      acc.push({ type: "tool-input-available", toolCallId: "call_1", toolName: "search", input: {}, executor: "server" });
      acc.push({ type: "text-delta", delta: "after" });
      const parts = acc.current().parts;
      expect(parts[0]).toEqual({ type: "text", text: "before " });
      expect(parts[2]).toEqual({ type: "text", text: "after" });
    });
  });

  describe("tool lifecycle", () => {
    it("transitions a tool part from input-available to output-available", () => {
      const acc = createAccumulator("msg_1");
      acc.push({
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "search",
        input: { query: "weather" },
        executor: "server",
      });
      let toolPart = acc.current().parts[0] as ToolPart;
      expect(toolPart).toEqual({
        type: "tool-search",
        toolCallId: "call_1",
        state: "input-available",
        input: { query: "weather" },
      });

      acc.push({ type: "tool-output-available", toolCallId: "call_1", output: { temp: 70 } });
      toolPart = acc.current().parts[0] as ToolPart;
      expect(toolPart).toEqual({
        type: "tool-search",
        toolCallId: "call_1",
        state: "output-available",
        input: { query: "weather" },
        output: { temp: 70 },
      });
    });

    it("transitions a tool part from input-available to output-error", () => {
      const acc = createAccumulator("msg_1");
      acc.push({
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "search",
        input: { query: "weather" },
        executor: "server",
      });
      acc.push({ type: "tool-output-available", toolCallId: "call_1", output: "boom", isError: true });
      const toolPart = acc.current().parts[0] as ToolPart;
      expect(toolPart).toEqual({
        type: "tool-search",
        toolCallId: "call_1",
        state: "output-error",
        input: { query: "weather" },
        errorText: "boom",
      });
    });

    it("routes through approval-requested before settling", () => {
      const acc = createAccumulator("msg_1");
      acc.push({
        type: "tool-approval-requested",
        toolCallId: "call_1",
        toolName: "delete-file",
        input: { path: "/tmp/x" },
      });
      let toolPart = acc.current().parts[0] as ToolPart;
      expect(toolPart.state).toBe("approval-requested");
      expect(toolPart.type).toBe("tool-delete-file");

      acc.push({ type: "tool-output-available", toolCallId: "call_1", output: { deleted: true } });
      toolPart = acc.current().parts[0] as ToolPart;
      expect(toolPart.state).toBe("output-available");
      expect(toolPart.output).toEqual({ deleted: true });
    });

    it("preserves multiple concurrent tool calls independently, keyed by toolCallId", () => {
      const acc = createAccumulator("msg_1");
      acc.push({ type: "tool-input-available", toolCallId: "call_1", toolName: "a", input: 1, executor: "server" });
      acc.push({ type: "tool-input-available", toolCallId: "call_2", toolName: "b", input: 2, executor: "client" });
      acc.push({ type: "tool-output-available", toolCallId: "call_2", output: "b-result" });
      const parts = acc.current().parts as ToolPart[];
      expect(parts).toHaveLength(2);
      expect(parts[0]).toMatchObject({ toolCallId: "call_1", state: "input-available" });
      expect(parts[1]).toMatchObject({ toolCallId: "call_2", state: "output-available", output: "b-result" });
    });

    it("ignores a tool-output-available chunk with no matching prior tool part", () => {
      const acc = createAccumulator("msg_1");
      acc.push({ type: "tool-output-available", toolCallId: "call_unknown", output: "x" });
      expect(acc.current().parts).toEqual([]);
    });
  });

  describe("finish / error / finished()", () => {
    it("is not finished before a finish or error chunk", () => {
      const acc = createAccumulator("msg_1");
      acc.push({ type: "text-delta", delta: "hi" });
      expect(acc.finished()).toBe(false);
    });

    it("is finished after a finish chunk", () => {
      const acc = createAccumulator("msg_1");
      acc.push({ type: "text-delta", delta: "hi" });
      acc.push({ type: "finish", finishReason: "stop" });
      expect(acc.finished()).toBe(true);
    });

    it("is finished after an error chunk", () => {
      const acc = createAccumulator("msg_1");
      acc.push({ type: "text-delta", delta: "hi" });
      acc.push({ type: "error", errorText: "network failure" });
      expect(acc.finished()).toBe(true);
    });
  });

  describe("partial snapshot mid-stream", () => {
    it("current() reflects exactly what has been pushed so far, at any point", () => {
      const acc = createAccumulator("msg_1");
      expect(acc.current().parts).toEqual([]);

      acc.push({ type: "text-delta", delta: "Thinking" });
      expect(acc.current().parts).toEqual([{ type: "text", text: "Thinking" }]);

      acc.push({ type: "tool-input-available", toolCallId: "call_1", toolName: "search", input: {}, executor: "server" });
      expect(acc.current().parts).toEqual([
        { type: "text", text: "Thinking" },
        { type: "tool-search", toolCallId: "call_1", state: "input-available", input: {} },
      ]);

      // No finish/error chunk yet: still in progress.
      expect(acc.finished()).toBe(false);
    });

    it("mutating a returned snapshot does not affect the accumulator's internal state", () => {
      const acc = createAccumulator("msg_1");
      acc.push({ type: "text-delta", delta: "hello" });
      const snapshot = acc.current();
      snapshot.parts.push({ type: "text", text: "tampered" });
      expect(acc.current().parts).toEqual([{ type: "text", text: "hello" }]);
    });
  });

  describe("unknown chunk types", () => {
    it("ignores chunks with an unrecognized type", () => {
      const acc = createAccumulator("msg_1");
      acc.push({ type: "text-delta", delta: "hi" });
      const before = acc.current();
      acc.push({ type: "totally-unknown", foo: "bar" } as unknown as UiChunk);
      expect(acc.current()).toEqual(before);
      expect(acc.finished()).toBe(false);
    });
  });
});
