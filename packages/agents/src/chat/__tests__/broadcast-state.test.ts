import { describe, it, expect } from "vitest";
import { transition } from "../broadcast-state";
import type { BroadcastStreamState } from "../broadcast-state";
import type { UIMessage } from "ai";

const idle: BroadcastStreamState = { status: "idle" };

function textChunk(text: string) {
  return { type: "text-delta", textDelta: text };
}

function makeMessages(...texts: string[]): UIMessage[] {
  return texts.map((text, i) => ({
    id: `msg-${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text }]
  })) as UIMessage[];
}

describe("broadcast stream state machine", () => {
  // ── idle + response = observing ──────────────────────────────────

  it("creates an accumulator on first response chunk", () => {
    const result = transition(idle, {
      type: "response",
      streamId: "s1",
      messageId: "m1",
      chunkData: textChunk("hello")
    });

    expect(result.state.status).toBe("observing");
    expect(result.isStreaming).toBe(true);
    expect(result.messagesUpdate).toBeDefined();

    if (result.state.status === "observing") {
      expect(result.state.streamId).toBe("s1");
      expect(result.state.accumulator.messageId).toBe("m1");
    }

    const messages = result.messagesUpdate!([] as UIMessage[]);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
  });

  // ── observing + chunk (same stream) = observing ──────────────────

  it("reuses accumulator for subsequent chunks on same stream", () => {
    const first = transition(idle, {
      type: "response",
      streamId: "s1",
      messageId: "m1",
      chunkData: textChunk("hello ")
    });

    const second = transition(first.state, {
      type: "response",
      streamId: "s1",
      messageId: "m-ignored",
      chunkData: textChunk("world")
    });

    expect(second.state.status).toBe("observing");
    expect(second.isStreaming).toBe(true);
    expect(second.messagesUpdate).toBeDefined();

    if (
      first.state.status === "observing" &&
      second.state.status === "observing"
    ) {
      expect(second.state.accumulator).toBe(first.state.accumulator);
    }
  });

  // ── observing + done = idle ──────────────────────────────────────

  it("transitions to idle on done and produces final merge", () => {
    const first = transition(idle, {
      type: "response",
      streamId: "s1",
      messageId: "m1",
      chunkData: textChunk("hello")
    });

    const done = transition(first.state, {
      type: "response",
      streamId: "s1",
      messageId: "m-ignored",
      done: true
    });

    expect(done.state.status).toBe("idle");
    expect(done.isStreaming).toBe(false);
    expect(done.messagesUpdate).toBeDefined();
  });

  // ── observing + error = idle ─────────────────────────────────────

  it("transitions to idle on error and produces final merge", () => {
    const first = transition(idle, {
      type: "response",
      streamId: "s1",
      messageId: "m1",
      chunkData: textChunk("partial")
    });

    const errResult = transition(first.state, {
      type: "response",
      streamId: "s1",
      messageId: "m-ignored",
      error: true
    });

    expect(errResult.state.status).toBe("idle");
    expect(errResult.isStreaming).toBe(false);
    expect(errResult.messagesUpdate).toBeDefined();
  });

  // ── continuation response ────────────────────────────────────────

  it("creates accumulator with existing parts for continuation", () => {
    const messages = makeMessages("hi", "first response");

    const result = transition(idle, {
      type: "response",
      streamId: "s1",
      messageId: "fallback-id",
      chunkData: textChunk(" continued"),
      continuation: true,
      currentMessages: messages
    });

    expect(result.state.status).toBe("observing");
    if (result.state.status === "observing") {
      expect(result.state.accumulator.messageId).toBe("msg-1");
      expect(result.state.accumulator.parts.length).toBeGreaterThan(0);
    }
  });

  it("uses fallback messageId when no assistant message exists for continuation", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }
    ] as UIMessage[];

    const result = transition(idle, {
      type: "response",
      streamId: "s1",
      messageId: "fallback-id",
      chunkData: textChunk("hello"),
      continuation: true,
      currentMessages: messages
    });

    if (result.state.status === "observing") {
      expect(result.state.accumulator.messageId).toBe("fallback-id");
    }
  });

  // ── different stream replaces accumulator ────────────────────────

  it("creates new accumulator when streamId changes", () => {
    const first = transition(idle, {
      type: "response",
      streamId: "s1",
      messageId: "m1",
      chunkData: textChunk("hello")
    });

    const second = transition(first.state, {
      type: "response",
      streamId: "s2",
      messageId: "m2",
      chunkData: textChunk("world")
    });

    expect(second.state.status).toBe("observing");
    if (
      first.state.status === "observing" &&
      second.state.status === "observing"
    ) {
      expect(second.state.accumulator).not.toBe(first.state.accumulator);
      expect(second.state.streamId).toBe("s2");
      expect(second.state.accumulator.messageId).toBe("m2");
    }
  });

  // ── clear ────────────────────────────────────────────────────────

  it("clear from idle is a no-op", () => {
    const result = transition(idle, { type: "clear" });
    expect(result.state.status).toBe("idle");
    expect(result.isStreaming).toBe(false);
    expect(result.messagesUpdate).toBeUndefined();
  });

  it("clear from observing transitions to idle with no messagesUpdate", () => {
    const first = transition(idle, {
      type: "response",
      streamId: "s1",
      messageId: "m1",
      chunkData: textChunk("hello")
    });

    const cleared = transition(first.state, { type: "clear" });
    expect(cleared.state.status).toBe("idle");
    expect(cleared.isStreaming).toBe(false);
    expect(cleared.messagesUpdate).toBeUndefined();
  });

  // ── replay suppression ───────────────────────────────────────────

  it("replay chunks produce no messagesUpdate", () => {
    const first = transition(idle, {
      type: "response",
      streamId: "s1",
      messageId: "m1",
      chunkData: textChunk("replayed"),
      replay: true
    });

    expect(first.state.status).toBe("observing");
    expect(first.isStreaming).toBe(true);
    expect(first.messagesUpdate).toBeUndefined();
  });

  it("replayComplete produces messagesUpdate", () => {
    const first = transition(idle, {
      type: "response",
      streamId: "s1",
      messageId: "m1",
      chunkData: textChunk("replayed"),
      replay: true
    });

    const complete = transition(first.state, {
      type: "response",
      streamId: "s1",
      messageId: "m-ignored",
      replayComplete: true
    });

    expect(complete.state.status).toBe("observing");
    expect(complete.messagesUpdate).toBeDefined();
  });

  it("done after replay produces messagesUpdate with accumulated content", () => {
    const chunk1 = transition(idle, {
      type: "response",
      streamId: "s1",
      messageId: "m1",
      chunkData: textChunk("replayed"),
      replay: true
    });

    const done = transition(chunk1.state, {
      type: "response",
      streamId: "s1",
      messageId: "m-ignored",
      done: true
    });

    expect(done.state.status).toBe("idle");
    expect(done.messagesUpdate).toBeDefined();

    const messages = done.messagesUpdate!([] as UIMessage[]);
    expect(messages).toHaveLength(1);
  });

  // ── resume-fallback ──────────────────────────────────────────────

  it("resume-fallback creates accumulator and transitions to observing", () => {
    const result = transition(idle, {
      type: "resume-fallback",
      streamId: "s1",
      messageId: "m1"
    });

    expect(result.state.status).toBe("observing");
    expect(result.isStreaming).toBe(true);
    expect(result.messagesUpdate).toBeUndefined();

    if (result.state.status === "observing") {
      expect(result.state.streamId).toBe("s1");
      expect(result.state.accumulator.messageId).toBe("m1");
    }
  });

  // ── empty final message ──────────────────────────────────────────

  it("handles response with no body and done=true", () => {
    const first = transition(idle, {
      type: "response",
      streamId: "s1",
      messageId: "m1",
      chunkData: textChunk("hello")
    });

    const done = transition(first.state, {
      type: "response",
      streamId: "s1",
      messageId: "m-ignored",
      done: true
    });

    expect(done.state.status).toBe("idle");
    expect(done.isStreaming).toBe(false);
    expect(done.messagesUpdate).toBeDefined();
  });

  // ── resume-fallback while already observing ──────────────────────

  it("resume-fallback replaces existing accumulator", () => {
    const first = transition(idle, {
      type: "response",
      streamId: "s1",
      messageId: "m1",
      chunkData: textChunk("hello")
    });

    const resumed = transition(first.state, {
      type: "resume-fallback",
      streamId: "s2",
      messageId: "m2"
    });

    expect(resumed.state.status).toBe("observing");
    expect(resumed.isStreaming).toBe(true);
    if (
      first.state.status === "observing" &&
      resumed.state.status === "observing"
    ) {
      expect(resumed.state.accumulator).not.toBe(first.state.accumulator);
      expect(resumed.state.streamId).toBe("s2");
      expect(resumed.state.accumulator.messageId).toBe("m2");
    }
  });

  // ── resume-fallback then response chunks ─────────────────────────

  it("response chunks reuse accumulator created by resume-fallback", () => {
    const resumed = transition(idle, {
      type: "resume-fallback",
      streamId: "s1",
      messageId: "m1"
    });

    const chunk = transition(resumed.state, {
      type: "response",
      streamId: "s1",
      messageId: "m-ignored",
      chunkData: textChunk("resumed content")
    });

    expect(chunk.state.status).toBe("observing");
    expect(chunk.messagesUpdate).toBeDefined();
    if (
      resumed.state.status === "observing" &&
      chunk.state.status === "observing"
    ) {
      expect(chunk.state.accumulator).toBe(resumed.state.accumulator);
    }

    const done = transition(chunk.state, {
      type: "response",
      streamId: "s1",
      messageId: "m-ignored",
      done: true
    });

    expect(done.state.status).toBe("idle");
    expect(done.isStreaming).toBe(false);
    expect(done.messagesUpdate).toBeDefined();

    const messages = done.messagesUpdate!([] as UIMessage[]);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
  });
});
