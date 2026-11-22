import { describe, expect, it } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { MessageType, type OutgoingMessage } from "../types";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";

// A replay of a path the resume model (verify-chat ChatResume.tla) found: a
// reconnecting tab acknowledges a resume notice for a stream that already
// finished, while it waits for the replay of the stream that runs now.

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function record(ws: WebSocket): OutgoingMessage[] {
  const seen: OutgoingMessage[] = [];
  ws.addEventListener("message", (event: MessageEvent) => {
    seen.push(JSON.parse(event.data as string) as OutgoingMessage);
  });
  return seen;
}

function sendChatRequest(
  ws: WebSocket,
  id: string,
  messages: ChatMessage[],
  body: Record<string, unknown>
) {
  ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
      id,
      init: { method: "POST", body: JSON.stringify({ messages, ...body }) }
    })
  );
}

const user1: ChatMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "First" }]
};
const user2: ChatMessage = {
  id: "user-2",
  role: "user",
  parts: [{ type: "text", text: "Second" }]
};

const resuming = (seen: OutgoingMessage[], id: string) =>
  seen.some(
    (m) => m.type === MessageType.CF_AGENT_STREAM_RESUMING && m.id === id
  );

const liveChunks = (seen: OutgoingMessage[], id: string) =>
  seen.filter(
    (m) =>
      isUseChatResponseMessage(m) &&
      m.id === id &&
      !!m.body &&
      m.replay !== true
  );

describe("resume ACK races", () => {
  it("an ACK for a finished stream keeps the tab waiting for the active stream's replay", async () => {
    const room = crypto.randomUUID();
    const { ws: owner } = await connectChatWS(
      `/agents/slow-stream-agent/${room}`
    );
    const ownerSeen = record(owner);

    // Reply A streams; reply B queues behind it.
    sendChatRequest(owner, "req-a", [user1], {
      format: "plaintext",
      chunkCount: 4,
      chunkDelayMs: 40
    });
    await waitUntil(() => liveChunks(ownerSeen, "req-a").length > 0);
    sendChatRequest(owner, "req-b", [user1, user2], {
      format: "plaintext",
      chunkCount: 20,
      chunkDelayMs: 40
    });

    // A tab reconnects during reply A and is told to resume it.
    const { ws: tab } = await connectChatWS(
      `/agents/slow-stream-agent/${room}`
    );
    const tabSeen = record(tab);
    await waitUntil(() => resuming(tabSeen, "req-a"));

    // Reply A finishes and reply B starts streaming.
    await waitUntil(() => liveChunks(ownerSeen, "req-b").length > 0);

    // The tab asks to resume and is told to resume reply B.
    tab.send(
      JSON.stringify({ type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST })
    );
    await waitUntil(() => resuming(tabSeen, "req-b"));

    // The tab's ACK for reply A arrives.
    tab.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
        id: "req-a"
      })
    );
    const before = liveChunks(ownerSeen, "req-b").length;
    await waitUntil(() => liveChunks(ownerSeen, "req-b").length >= before + 2);

    // Until it ACKs reply B, the tab gets none of reply B's live chunks: it
    // would show them without the chunks streamed before it.
    const notice = tabSeen.findIndex(
      (m) => m.type === MessageType.CF_AGENT_STREAM_RESUMING && m.id === "req-b"
    );
    expect(liveChunks(tabSeen.slice(notice), "req-b")).toEqual([]);

    owner.close(1000);
    tab.close(1000);
  });
});
