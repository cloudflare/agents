/**
 * Unit tests for {@link TanStackRecoveryCodec}: the AG-UI half of the codec seam.
 * Pure (no Workers runtime) — runs in plain node vitest.
 */
import { EventType, type StreamChunk } from "@tanstack/ai/client";
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
      parts: [],
      hasSettledToolResults: false
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
      parts: [],
      hasSettledToolResults: false
    });
  });

  it("returns an empty partial for no bodies (crash before first delta)", () => {
    expect(codec.toRecoveryPartial([])).toEqual({
      text: "",
      parts: [],
      hasSettledToolResults: false
    });
  });
});

// The codec reconstructs tool parts in its OWN AG-UI-native shape (NOT AI SDK
// `UIMessage` parts) and decides `hasSettledToolResults` itself. The shape below
// is the harness's `TanStackToolPart`; the engine never inspects it.
describe("TanStackRecoveryCodec tool-part reconstruction (AG-UI-native)", () => {
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
        toolCallId: "call-1",
        toolName: "get_weather",
        argsBuffer: '{"city":"Lisbon"}',
        input: { city: "Lisbon" },
        hasOutput: true,
        output: "sunny, 24C"
      }
    ]);
    expect(partial.hasSettledToolResults).toBe(true);
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
        toolCallId: "call-1",
        toolName: "get_weather",
        argsBuffer: '{"city":"Lisbon"}',
        input: { city: "Lisbon" },
        hasOutput: false,
        output: undefined
      }
    ]);
    expect(partial.hasSettledToolResults).toBe(false);
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
    expect(partial.hasSettledToolResults).toBe(true);
  });
});

// The whole point of computing `hasSettledToolResults` in the codec: the SHARED
// engine persist gate consumes that boolean (NOT an AI-SDK part shape) to
// preserve a foreign tool's completed work under `{ persist: false }`. The codec
// owns the determination for its own vocabulary.
describe("TanStackRecoveryCodec.hasSettledToolResults", () => {
  it("is TRUE once a TOOL_CALL_RESULT settled the tool", () => {
    const partial = codec.toRecoveryPartial([
      toolStart("call-1", "get_weather"),
      toolArgs("call-1", "{}"),
      toolEnd("call-1"),
      toolResult("call-1", "sunny")
    ]);
    expect(partial.hasSettledToolResults).toBe(true);
  });

  it("is FALSE for a tool torn before its result", () => {
    const partial = codec.toRecoveryPartial([
      toolStart("call-1", "get_weather"),
      toolArgs("call-1", "{}"),
      toolEnd("call-1")
    ]);
    expect(partial.hasSettledToolResults).toBe(false);
  });

  it("is FALSE for a text-only partial", () => {
    const partial = codec.toRecoveryPartial([content("m", "no tools here")]);
    expect(partial.hasSettledToolResults).toBe(false);
  });
});

describe("TanStackRecoveryCodec.isProgressChunk", () => {
  // Milestones only — started segment / settled tool start+result. Deltas
  // (TEXT_MESSAGE_CONTENT, TOOL_CALL_ARGS) are NOT milestones; they go through
  // isStreamingContentChunk + the host throttle.
  const PROGRESS = [
    EventType.TEXT_MESSAGE_START,
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_RESULT
  ];
  for (const type of PROGRESS) {
    it(`credits "${type}" as a milestone`, () => {
      expect(codec.isProgressChunk(type)).toBe(true);
    });
  }

  const NON_PROGRESS = [
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TOOL_CALL_ARGS,
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_END,
    EventType.RUN_FINISHED,
    EventType.RUN_ERROR,
    undefined,
    "SOMETHING_ELSE"
  ];
  for (const type of NON_PROGRESS) {
    it(`does not treat "${String(type)}" as a milestone`, () => {
      expect(codec.isProgressChunk(type)).toBe(false);
    });
  }
});

describe("TanStackRecoveryCodec.isStreamingContentChunk", () => {
  const STREAMING = [EventType.TEXT_MESSAGE_CONTENT, EventType.TOOL_CALL_ARGS];
  for (const type of STREAMING) {
    it(`classifies "${type}" as streaming content`, () => {
      expect(codec.isStreamingContentChunk(type)).toBe(true);
    });
    it(`does not also treat "${type}" as a milestone`, () => {
      expect(codec.isProgressChunk(type)).toBe(false);
    });
  }

  const NON_STREAMING = [
    EventType.TEXT_MESSAGE_START,
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_RESULT,
    EventType.RUN_FINISHED,
    undefined,
    "SOMETHING_ELSE"
  ];
  for (const type of NON_STREAMING) {
    it(`does not classify "${String(type)}" as streaming content`, () => {
      expect(codec.isStreamingContentChunk(type)).toBe(false);
    });
  }
});
