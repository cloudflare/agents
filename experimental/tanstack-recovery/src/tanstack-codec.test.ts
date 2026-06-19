/**
 * Unit tests for {@link TanStackRecoveryCodec}: the AG-UI half of the codec seam.
 * Pure (no Workers runtime) — runs in plain node vitest.
 */
import { EventType, type StreamChunk } from "@tanstack/ai/client";
import { partialHasSettledToolResults } from "agents/chat";
import { describe, expect, it } from "vitest";
import { TanStackRecoveryCodec } from "./tanstack-codec";

const codec = new TanStackRecoveryCodec();

function body(chunk: StreamChunk): string {
  return JSON.stringify(chunk);
}

function content(messageId: string, delta: string): string {
  return body({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId,
    delta
  } as StreamChunk);
}

function toolStart(toolCallId: string, toolCallName: string): string {
  return body({
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName
  } as unknown as StreamChunk);
}

function toolArgs(toolCallId: string, delta: string): string {
  return body({
    type: EventType.TOOL_CALL_ARGS,
    toolCallId,
    delta
  } as unknown as StreamChunk);
}

function toolEnd(toolCallId: string): string {
  return body({
    type: EventType.TOOL_CALL_END,
    toolCallId
  } as unknown as StreamChunk);
}

function toolResult(toolCallId: string, content: unknown): string {
  return body({
    type: EventType.TOOL_CALL_RESULT,
    messageId: "m",
    toolCallId,
    content
  } as unknown as StreamChunk);
}

describe("TanStackRecoveryCodec.toRecoveryPartial", () => {
  it("concatenates TEXT_MESSAGE_CONTENT deltas in order, byte-exact", () => {
    const bodies = [
      body({
        type: EventType.RUN_STARTED,
        threadId: "t",
        runId: "r"
      } as StreamChunk),
      body({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m",
        role: "assistant"
      } as StreamChunk),
      content("m", "Hello, "),
      content("m", "world"),
      content("m", "!"),
      body({ type: EventType.TEXT_MESSAGE_END, messageId: "m" } as StreamChunk),
      body({
        type: EventType.RUN_FINISHED,
        threadId: "t",
        runId: "r"
      } as StreamChunk)
    ];
    expect(codec.toRecoveryPartial(bodies)).toEqual({
      text: "Hello, world!",
      parts: []
    });
  });

  it("ignores non-content lifecycle chunks", () => {
    const bodies = [
      body({
        type: EventType.RUN_STARTED,
        threadId: "t",
        runId: "r"
      } as StreamChunk),
      content("m", "only this")
    ];
    expect(codec.toRecoveryPartial(bodies).text).toBe("only this");
  });

  it("stops at a torn final write, preserving the survived prefix", () => {
    const bodies = [content("m", "kept prefix "), '{"type":"TEXT_MESSAGE_CONT'];
    expect(codec.toRecoveryPartial(bodies)).toEqual({
      text: "kept prefix ",
      parts: []
    });
  });

  it("returns an empty partial for no bodies (crash before first delta)", () => {
    expect(codec.toRecoveryPartial([])).toEqual({ text: "", parts: [] });
  });
});

describe("TanStackRecoveryCodec tool-part reconstruction", () => {
  it("rebuilds a settled tool part from START → ARGS → END → RESULT", () => {
    const bodies = [
      content("m", "looking up "),
      toolStart("call-1", "get_weather"),
      toolArgs("call-1", '{"city":'),
      toolArgs("call-1", '"Lisbon"}'),
      toolEnd("call-1"),
      toolResult("call-1", "sunny, 24C"),
      content("m", "the weather")
    ];
    const partial = codec.toRecoveryPartial(bodies);
    expect(partial.text).toBe("looking up the weather");
    expect(partial.parts).toEqual([
      {
        type: "tool-get_weather",
        toolCallId: "call-1",
        toolName: "get_weather",
        state: "output-available",
        input: { city: "Lisbon" },
        output: "sunny, 24C"
      }
    ]);
  });

  it("leaves a tool torn before its RESULT unsettled (no output)", () => {
    const bodies = [
      toolStart("call-1", "get_weather"),
      toolArgs("call-1", '{"city":"Lisbon"}'),
      toolEnd("call-1")
      // crash before TOOL_CALL_RESULT flushed
    ];
    const partial = codec.toRecoveryPartial(bodies);
    expect(partial.parts).toEqual([
      {
        type: "tool-get_weather",
        toolCallId: "call-1",
        toolName: "get_weather",
        state: "input-available",
        input: { city: "Lisbon" }
      }
    ]);
  });

  it("stops at a torn final write, preserving an already-settled tool part", () => {
    const bodies = [
      toolStart("call-1", "get_weather"),
      toolArgs("call-1", '{"city":"Lisbon"}'),
      toolEnd("call-1"),
      toolResult("call-1", "sunny"),
      '{"type":"TEXT_MESSAGE_CONT' // torn
    ];
    const partial = codec.toRecoveryPartial(bodies);
    expect(partial.parts).toHaveLength(1);
    expect(
      (partial.parts[0] as { state: string; output: unknown }).output
    ).toBe("sunny");
  });
});

// The whole point of reconstructing `parts`: the SHARED engine gate keyed off
// them (`partialHasSettledToolResults`) preserves a foreign tool's completed
// work under `{ persist: false }`. These assert the gate reads AG-UI-derived
// parts exactly as it reads AI-SDK ones.
describe("partialHasSettledToolResults over AG-UI-reconstructed parts", () => {
  it("is TRUE once a TOOL_CALL_RESULT settled the tool", () => {
    const partial = codec.toRecoveryPartial([
      toolStart("call-1", "get_weather"),
      toolArgs("call-1", "{}"),
      toolEnd("call-1"),
      toolResult("call-1", "sunny")
    ]);
    expect(partialHasSettledToolResults(partial.parts)).toBe(true);
  });

  it("is FALSE for a tool torn before its result", () => {
    const partial = codec.toRecoveryPartial([
      toolStart("call-1", "get_weather"),
      toolArgs("call-1", "{}"),
      toolEnd("call-1")
    ]);
    expect(partialHasSettledToolResults(partial.parts)).toBe(false);
  });

  it("is FALSE for a text-only partial", () => {
    const partial = codec.toRecoveryPartial([content("m", "no tools here")]);
    expect(partialHasSettledToolResults(partial.parts)).toBe(false);
  });
});

describe("TanStackRecoveryCodec.isProgressChunk", () => {
  const PROGRESS = [
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_RESULT
  ];
  for (const type of PROGRESS) {
    it(`credits "${type}" as progress`, () => {
      expect(codec.isProgressChunk(type)).toBe(true);
    });
  }

  const NON_PROGRESS = [
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_END,
    EventType.RUN_FINISHED,
    EventType.RUN_ERROR,
    undefined,
    "SOMETHING_ELSE"
  ];
  for (const type of NON_PROGRESS) {
    it(`does not credit "${String(type)}"`, () => {
      expect(codec.isProgressChunk(type)).toBe(false);
    });
  }
});
