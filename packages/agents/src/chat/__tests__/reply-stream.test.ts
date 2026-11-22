import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { OrphanPersistStore } from "../orphan-store";
import { ReplyStreams } from "../reply-stream";
import type { ResumableStream } from "../resumable-stream";

/** The reads `persistOrphan` makes of an orphaned stream. */
function orphanedStream(
  bodies: Array<Record<string, unknown>>,
  meta: { messageId: string; basePartCount: number | null }
): ResumableStream {
  return {
    flushBuffer() {},
    getStreamChunks: () => bodies.map((b) => ({ body: JSON.stringify(b) })),
    getStreamMessageId: () => meta.messageId,
    getStreamBasePartCount: () => meta.basePartCount,
    getStreamParentMessageId: () => null,
    getStreamIsContinuation: () => false
  } as unknown as ResumableStream;
}

function memoryStore(initial: UIMessage[]) {
  const messages = new Map(initial.map((m) => [m.id, m]));
  const store: OrphanPersistStore = {
    getMessage: (id) => messages.get(id) ?? null,
    appendMessage: (m) => void messages.set(m.id, m),
    updateMessage: (m) => void messages.set(m.id, m)
  };
  return { store, messages };
}

describe("ReplyStreams.persistOrphan", () => {
  it("keeps an approval given after the first rebuild when it rebuilds again", async () => {
    const stream = orphanedStream(
      [
        { type: "tool-input-start", toolCallId: "c1", toolName: "t" },
        {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "t",
          input: {}
        },
        { type: "tool-approval-request", toolCallId: "c1", approvalId: "a1" }
      ],
      { messageId: "reply", basePartCount: 1 }
    );
    const streams = new ReplyStreams({
      resumable: () => stream,
      streamStarted() {},
      streamEnded() {},
      originMessageIds: () => undefined,
      transaction: (fn) => fn()
    });
    const { store, messages } = memoryStore([
      {
        id: "reply",
        role: "assistant",
        parts: [{ type: "text", text: "Before", state: "done" }]
      }
    ]);
    const options = { store, settle: (m: UIMessage) => m };

    await streams.persistOrphan("s", options);
    // The user approves: the decision is written to the stored message.
    const first = messages.get("reply")!;
    messages.set("reply", {
      ...first,
      parts: first.parts.map((p) =>
        "toolCallId" in p
          ? ({
              ...p,
              state: "approval-responded",
              approval: { id: "a1", approved: true }
            } as UIMessage["parts"][number])
          : p
      )
    });
    await streams.persistOrphan("s", options);

    expect(messages.get("reply")?.parts).toMatchObject([
      { type: "text", text: "Before" },
      { toolCallId: "c1", state: "approval-responded" }
    ]);
  });

  const approve = (message: UIMessage): UIMessage => ({
    ...message,
    parts: message.parts.map((p) =>
      "toolCallId" in p
        ? ({
            ...p,
            state: "approval-responded",
            approval: { id: "a1", approved: true }
          } as UIMessage["parts"][number])
        : p
    )
  });

  it("rebuilds a reply of its own once, and keeps an approval given between rebuilds", async () => {
    const stream = orphanedStream(
      [
        { type: "start", messageId: "reply" },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "Let me check." },
        { type: "text-end", id: "t" },
        { type: "tool-input-start", toolCallId: "c1", toolName: "t" },
        {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "t",
          input: {}
        },
        { type: "tool-approval-request", toolCallId: "c1", approvalId: "a1" },
        { type: "finish" }
      ],
      { messageId: "reply", basePartCount: null }
    );
    const streams = new ReplyStreams({
      resumable: () => stream,
      streamStarted() {},
      streamEnded() {},
      originMessageIds: () => undefined,
      transaction: (fn) => fn()
    });
    const { store, messages } = memoryStore([]);
    const options = { store, settle: (m: UIMessage) => m };

    await streams.persistOrphan("s", options);
    messages.set("reply", approve(messages.get("reply")!));
    await streams.persistOrphan("s", options);

    expect(messages.get("reply")?.parts).toMatchObject([
      { type: "text", text: "Let me check." },
      { toolCallId: "c1", state: "approval-responded" }
    ]);
    expect(messages.get("reply")?.parts).toHaveLength(2);
  });

  it("keeps the stored result when both copies settled the call", async () => {
    const stream = orphanedStream(
      [
        { type: "tool-input-start", toolCallId: "c1", toolName: "t" },
        {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "t",
          input: {}
        },
        { type: "tool-output-available", toolCallId: "c1", output: "stream" }
      ],
      { messageId: "reply", basePartCount: null }
    );
    const streams = new ReplyStreams({
      resumable: () => stream,
      streamStarted() {},
      streamEnded() {},
      originMessageIds: () => undefined,
      transaction: (fn) => fn()
    });
    const { store, messages } = memoryStore([
      {
        id: "reply",
        role: "assistant",
        parts: [
          {
            type: "tool-t",
            toolCallId: "c1",
            state: "output-available",
            input: {},
            output: "stored"
          } as unknown as UIMessage["parts"][number]
        ]
      }
    ]);
    await streams.persistOrphan("s", { store, settle: (m) => m });
    expect(messages.get("reply")?.parts[0]).toMatchObject({
      output: "stored"
    });
  });

  it("merges an imported continuation that holds only its own parts", async () => {
    // An `AIChatAgent` 0.8.4 continuation: the id of the message it
    // continued, no continuation flag, no base part count.
    const stream = orphanedStream(
      [
        { type: "text-start", id: "t2" },
        { type: "text-delta", id: "t2", delta: "The first is cheaper." }
      ],
      { messageId: "reply", basePartCount: null }
    );
    const streams = new ReplyStreams({
      resumable: () => stream,
      streamStarted() {},
      streamEnded() {},
      originMessageIds: () => undefined,
      transaction: (fn) => fn()
    });
    const { store, messages } = memoryStore([
      {
        id: "reply",
        role: "assistant",
        parts: [{ type: "text", text: "I found two options.", state: "done" }]
      }
    ]);
    await streams.persistOrphan("s", {
      store,
      settle: (m) => m,
      mergeLegacy: (existing, incoming) => ({
        ...incoming,
        parts: [...existing.parts, ...incoming.parts]
      })
    });
    expect(
      messages.get("reply")?.parts.map((p) => (p as { text?: string }).text)
    ).toEqual(["I found two options.", "The first is cheaper."]);
  });

  it("replaces a stored copy that lacks the rebuild's empty parts", async () => {
    // A store dropped the empty reasoning part the stream opened with.
    const stream = orphanedStream(
      [
        { type: "start", messageId: "reply" },
        { type: "reasoning-start", id: "r" },
        { type: "reasoning-end", id: "r" },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "Shall I?" },
        { type: "text-end", id: "t" }
      ],
      { messageId: "reply", basePartCount: null }
    );
    const streams = new ReplyStreams({
      resumable: () => stream,
      streamStarted() {},
      streamEnded() {},
      originMessageIds: () => undefined,
      transaction: (fn) => fn()
    });
    const { store, messages } = memoryStore([
      {
        id: "reply",
        role: "assistant",
        parts: [{ type: "text", text: "Shall I?", state: "done" }]
      }
    ]);
    await streams.persistOrphan("s", {
      store,
      settle: (m) => m,
      mergeLegacy: (existing, incoming) => ({
        ...incoming,
        parts: [...existing.parts, ...incoming.parts]
      })
    });
    const texts = messages
      .get("reply")
      ?.parts.filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text);
    expect(texts).toEqual(["Shall I?"]);
  });

  it("merges an imported continuation when the stored reply holds redacted reasoning", async () => {
    const stream = orphanedStream(
      [
        { type: "text-start", id: "t2" },
        { type: "text-delta", id: "t2", delta: "I found two options. More." }
      ],
      { messageId: "reply", basePartCount: null }
    );
    const streams = new ReplyStreams({
      resumable: () => stream,
      streamStarted() {},
      streamEnded() {},
      originMessageIds: () => undefined,
      transaction: (fn) => fn()
    });
    const { store, messages } = memoryStore([
      {
        id: "reply",
        role: "assistant",
        parts: [
          {
            type: "reasoning",
            text: "",
            state: "done",
            providerMetadata: { anthropic: { redactedData: "x" } }
          },
          { type: "text", text: "I found two options.", state: "done" }
        ]
      } as UIMessage
    ]);
    await streams.persistOrphan("s", {
      store,
      settle: (m) => m,
      mergeLegacy: (existing, incoming) => ({
        ...incoming,
        parts: [...existing.parts, ...incoming.parts]
      })
    });
    expect(messages.get("reply")?.parts.map((p) => p.type)).toEqual([
      "reasoning",
      "text",
      "text"
    ]);
  });
});
