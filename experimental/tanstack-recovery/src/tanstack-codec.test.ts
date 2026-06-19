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
