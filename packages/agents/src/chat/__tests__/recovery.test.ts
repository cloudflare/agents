import { describe, expect, it } from "vitest";
import {
  createChatFiberSnapshot,
  unwrapChatFiberSnapshot,
  wrapChatFiberSnapshot
} from "../recovery";
import type { UIMessage } from "ai";

const messages: UIMessage[] = [
  {
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "text", text: "Hi" }]
  },
  {
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text: "Hello" }]
  }
];

describe("chat recovery snapshots", () => {
  it("captures latest message and request context", () => {
    const snapshot = createChatFiberSnapshot({
      kind: "test-chat-turn",
      requestId: "req-1",
      continuation: false,
      messages,
      lastBody: { mode: "test" },
      lastClientTools: [{ name: "tool", description: "Tool" }]
    });

    expect(snapshot).toMatchObject({
      kind: "test-chat-turn",
      version: 1,
      requestId: "req-1",
      continuation: false,
      latestMessageId: "user-1",
      latestMessageRole: "user",
      latestUserMessageId: "user-1",
      lastBody: { mode: "test" },
      lastClientTools: [{ name: "tool", description: "Tool" }]
    });
    expect(typeof snapshot.startedAt).toBe("number");
  });

  it("wraps and unwraps user recovery data", () => {
    const snapshot = createChatFiberSnapshot({
      kind: "test-chat-turn",
      requestId: "req-1",
      continuation: false,
      messages
    });

    const envelope = wrapChatFiberSnapshot("__testSnapshot", snapshot, {
      providerId: "provider-1"
    });

    expect(
      unwrapChatFiberSnapshot("__testSnapshot", envelope, "test-chat-turn")
    ).toEqual({
      snapshot,
      user: { providerId: "provider-1" }
    });
  });

  it("preserves legacy raw recovery data when no envelope is present", () => {
    const legacy = { providerId: "legacy" };

    expect(
      unwrapChatFiberSnapshot("__testSnapshot", legacy, "test-chat-turn")
    ).toEqual({
      snapshot: null,
      user: legacy
    });
  });

  it("rejects corrupt or future snapshot envelopes without crashing", () => {
    const envelope = {
      __testSnapshot: {
        kind: "test-chat-turn",
        version: 2,
        requestId: "req-1",
        continuation: false
      },
      user: { providerId: "provider-1" }
    };

    expect(
      unwrapChatFiberSnapshot("__testSnapshot", envelope, "test-chat-turn")
    ).toEqual({
      snapshot: null,
      user: envelope
    });
  });

  it("rejects envelopes for the wrong snapshot kind", () => {
    const snapshot = createChatFiberSnapshot({
      kind: "other-chat-turn",
      requestId: "req-1",
      continuation: false,
      messages
    });
    const envelope = wrapChatFiberSnapshot("__testSnapshot", snapshot, null);

    expect(
      unwrapChatFiberSnapshot("__testSnapshot", envelope, "test-chat-turn")
    ).toEqual({
      snapshot: null,
      user: envelope
    });
  });
});
