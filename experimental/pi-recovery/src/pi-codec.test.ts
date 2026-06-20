/**
 * Unit tests for {@link PiRecoveryCodec}: the pi (non-AI-SDK) half of the codec
 * seam. Pure (no Workers runtime) — runs in plain node vitest. Mirrors
 * `tanstack-recovery`'s `tanstack-codec.test.ts`, the other vocabulary proof.
 *
 * Pi is a TEXT-only vocabulary here: the engine only ever consumes the
 * `{ text, parts: [], hasSettledToolResults: false }` partial, never the wire
 * event shape — which is the whole point of the codec seam.
 */
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { PiRecoveryCodec, renderAssistantText } from "./pi-codec";

const codec = new PiRecoveryCodec();

/** Minimal assistant message carrying a single text block (or none if empty). */
function assistantMsg(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : []
  } as AssistantMessage;
}

function body(event: AgentEvent): string {
  return JSON.stringify(event);
}

/** `message_update` carrying an incremental `text_delta`. */
function delta(deltaText: string, partialText: string): AgentEvent {
  return {
    type: "message_update",
    message: assistantMsg(partialText),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: deltaText,
      partial: assistantMsg(partialText)
    }
  } as unknown as AgentEvent;
}

/** `message_update` carrying a `text_end` (authoritative for its block). */
function textEnd(content: string): AgentEvent {
  return {
    type: "message_update",
    message: assistantMsg(content),
    assistantMessageEvent: {
      type: "text_end",
      contentIndex: 0,
      content,
      partial: assistantMsg(content)
    }
  } as unknown as AgentEvent;
}

/** `message_update` carrying the inner `done` (final message). */
function done(text: string): AgentEvent {
  return {
    type: "message_update",
    message: assistantMsg(text),
    assistantMessageEvent: {
      type: "done",
      reason: "stop",
      message: assistantMsg(text)
    }
  } as unknown as AgentEvent;
}

/** Authoritative `message_end` carrying the final assistant message. */
function messageEnd(text: string): AgentEvent {
  return {
    type: "message_end",
    message: assistantMsg(text)
  } as unknown as AgentEvent;
}

describe("PiRecoveryCodec.toRecoveryPartial", () => {
  it("concatenates text_delta deltas in order, byte-exact", () => {
    const bodies = [
      body(delta("Hello, ", "Hello, ")),
      body(delta("world", "Hello, world")),
      body(delta("!", "Hello, world!"))
    ];
    expect(codec.toRecoveryPartial(bodies)).toEqual({
      text: "Hello, world!",
      parts: [],
      hasSettledToolResults: false
    });
  });

  it("lets a text_end replace the accumulated deltas with its rendered block", () => {
    const bodies = [body(delta("Hel", "Hel")), body(textEnd("Hello"))];
    expect(codec.toRecoveryPartial(bodies).text).toBe("Hello");
  });

  it("lets an inner `done` replace the text with the final message", () => {
    const bodies = [body(delta("Hel", "Hel")), body(done("Hello, world!"))];
    expect(codec.toRecoveryPartial(bodies).text).toBe("Hello, world!");
  });

  it("treats message_end as authoritative over accumulated deltas", () => {
    const bodies = [
      body(delta("partial", "partial")),
      body(messageEnd("Final answer"))
    ];
    expect(codec.toRecoveryPartial(bodies).text).toBe("Final answer");
  });

  it("stops at a torn final write, preserving the survived prefix", () => {
    const bodies = [
      body(delta("kept prefix ", "kept prefix ")),
      '{"type":"message_upda' // crash tore the final body mid-write
    ];
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

  it("is always text-only: empty parts + unsettled even after a full turn", () => {
    const partial = codec.toRecoveryPartial([body(done("complete"))]);
    expect(partial.parts).toEqual([]);
    expect(partial.hasSettledToolResults).toBe(false);
  });
});

describe("PiRecoveryCodec.decodePartial", () => {
  it("surfaces the partial assistant message alongside the text", () => {
    const { text, message } = codec.decodePartial([body(done("Hi there"))]);
    expect(text).toBe("Hi there");
    expect(message?.role).toBe("assistant");
    expect(renderAssistantText(message!)).toBe("Hi there");
  });

  it("leaves the message null when the first body is torn", () => {
    expect(codec.decodePartial(['{"type":"message_upda'])).toEqual({
      text: "",
      message: null
    });
  });
});

describe("PiRecoveryCodec.encodeEvent", () => {
  it("buffers a message_update as its JSON body", () => {
    const event = delta("x", "x");
    expect(codec.encodeEvent(event)).toBe(JSON.stringify(event));
  });

  it("buffers a message_end as its JSON body", () => {
    const event = messageEnd("done");
    expect(codec.encodeEvent(event)).toBe(JSON.stringify(event));
  });

  const SKIPPED = [
    { type: "turn_start" },
    { type: "message_start", message: assistantMsg("x") },
    { type: "tool_execution_start", toolCallId: "t", toolName: "x", args: {} }
  ];
  for (const event of SKIPPED) {
    it(`skips the non-streaming "${event.type}" event`, () => {
      expect(codec.encodeEvent(event as unknown as AgentEvent)).toBeNull();
    });
  }
});

describe("PiRecoveryCodec.decodeEvent", () => {
  it("round-trips a buffered message_update", () => {
    const event = delta("x", "x");
    expect(codec.decodeEvent(JSON.stringify(event))).toEqual(event);
  });

  it("returns null for a non-buffered event body", () => {
    const body = JSON.stringify({
      type: "message_start",
      message: assistantMsg("x")
    });
    expect(codec.decodeEvent(body)).toBeNull();
  });

  it("returns null for a torn/invalid JSON body", () => {
    expect(codec.decodeEvent('{"type":"message_upda')).toBeNull();
  });
});

describe("PiRecoveryCodec.isProgressChunk", () => {
  it('credits "message_end" as the milestone', () => {
    expect(codec.isProgressChunk("message_end")).toBe(true);
  });

  const NON_PROGRESS = [
    "message_update",
    "message_start",
    "turn_start",
    "turn_end",
    "text_delta",
    undefined,
    "SOMETHING_ELSE"
  ];
  for (const type of NON_PROGRESS) {
    it(`does not treat "${String(type)}" as a milestone`, () => {
      expect(codec.isProgressChunk(type)).toBe(false);
    });
  }
});

describe("PiRecoveryCodec.isStreamingContentChunk", () => {
  it('classifies "message_update" as streaming content', () => {
    expect(codec.isStreamingContentChunk("message_update")).toBe(true);
  });

  it("keeps the streaming and milestone predicates disjoint", () => {
    expect(codec.isProgressChunk("message_update")).toBe(false);
    expect(codec.isStreamingContentChunk("message_end")).toBe(false);
  });

  const NON_STREAMING = [
    "message_end",
    "turn_start",
    undefined,
    "SOMETHING_ELSE"
  ];
  for (const type of NON_STREAMING) {
    it(`does not classify "${String(type)}" as streaming content`, () => {
      expect(codec.isStreamingContentChunk(type)).toBe(false);
    });
  }
});

describe("renderAssistantText", () => {
  it("joins text blocks and filters out non-text content", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "a" },
        { type: "thinking", thinking: "ignored" },
        { type: "text", text: "b" }
      ]
    } as unknown as AssistantMessage;
    expect(renderAssistantText(message)).toBe("ab");
  });
});
