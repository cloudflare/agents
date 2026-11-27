/**
 * Forced Durable Object eviction coverage for AIChatAgent.
 *
 * `evictDurableObject()` explicitly tears down the running test actor and, by
 * default, transfers accepted WebSockets. These tests verify reconstruction
 * from SQLite and that forced WebSocket transfer. They do not assert natural
 * idle hibernation, timer absence, or hibernation eligibility.
 */
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { UIMessage as ChatMessage } from "ai";
import { describe, expect, it } from "vitest";
import { connectChatWS } from "./test-utils";

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function stubFor(room: string) {
  return getAgentByName(env.TestChatAgent, room);
}

describe("AIChatAgent recovery after forced Durable Object eviction", () => {
  it("rebuilds its in-memory message array from SQLite", async () => {
    const stub = await stubFor(crypto.randomUUID());
    const messages: ChatMessage[] = [
      {
        id: "evict-user",
        role: "user",
        parts: [{ type: "text", text: "remember me" }]
      },
      {
        id: "evict-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "I will be restored" }]
      }
    ];

    await stub.persistMessages(messages);
    expect(
      ((await stub.getMessagesForTest()) as ChatMessage[]).map(
        (message) => message.id
      )
    ).toEqual(["evict-user", "evict-assistant"]);

    await evictDurableObject(stub);

    const restored = (await stub.getMessagesForTest()) as ChatMessage[];
    expect(restored).toEqual(messages);
    expect(await stub.getPersistedMessages()).toEqual(restored);
  });

  it('closes live WebSockets with { webSockets: "close" }', async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    try {
      await waitFor(() => ws.readyState === WebSocket.OPEN);
      let sawClose = false;
      ws.addEventListener("close", () => {
        sawClose = true;
      });

      const stub = await stubFor(room);
      await evictDurableObject(stub, { webSockets: "close" });

      await waitFor(() => sawClose || ws.readyState !== WebSocket.OPEN);
      expect(sawClose).toBe(true);
      expect(ws.readyState).not.toBe(WebSocket.OPEN);

      await stub.persistMessages([
        {
          id: "post-close-evict",
          role: "user",
          parts: [{ type: "text", text: "still alive" }]
        }
      ]);
      expect(await stub.getPersistedMessages()).toEqual([
        expect.objectContaining({ id: "post-close-evict" })
      ]);
    } finally {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    }
  });
});

describe("AIChatAgent chat recovery at startup", () => {
  it("continues a reply whose legacy fiber row is recovered before the messages are loaded", async () => {
    const room = crypto.randomUUID();
    const stub = (await getAgentByName(
      env.ChatRecoveryTestAgent,
      room
    )) as unknown as {
      persistMessages(messages: ChatMessage[]): Promise<void>;
      insertLegacyChatFiberForTest(requestId: string): Promise<void>;
      getOnChatMessageCallCount(): Promise<number>;
      getPersistedMessages(): Promise<ChatMessage[]>;
      getChatRecoveryIncidentsForTest(): Promise<
        Array<{ status: string; reason?: string }>
      >;
    };
    await stub.persistMessages([
      { id: "boot-user", role: "user", parts: [{ type: "text", text: "Hi" }] },
      {
        id: "boot-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "Partial" }]
      }
    ]);
    // A chat turn's fiber row an older version left: the startup fiber scan
    // recovers it, before the agent has read its messages into memory.
    await stub.insertLegacyChatFiberForTest("req-boot");

    await evictDurableObject(stub as unknown as DurableObjectStub);
    const fresh = (await getAgentByName(
      env.ChatRecoveryTestAgent,
      room
    )) as unknown as typeof stub;

    // The stored reply is the latest message, so recovery continues it: the
    // continuation is stored on that same reply, after its saved text.
    const replyText = (messages: ChatMessage[]) =>
      messages
        .find((message) => message.id === "boot-assistant")
        ?.parts.filter((part) => part.type === "text")
        .map((part) => (part as { text: string }).text)
        .join("") ?? "";
    await waitFor(async () => {
      const messages = await fresh.getPersistedMessages();
      return (
        messages.at(-1)?.id === "boot-assistant" &&
        replyText(messages).length > "Partial".length
      );
    }, 8000);
    expect(replyText(await fresh.getPersistedMessages())).toMatch(/^Partial/);
    const incidents = await fresh.getChatRecoveryIncidentsForTest();
    expect(
      incidents.some((incident) => incident.reason === "conversation_changed")
    ).toBe(false);
  });
});
