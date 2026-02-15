import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS } from "./test-utils";
import { getAgentByName } from "agents";

describe("maxPersistedMessages", () => {
  it("does not limit messages when maxPersistedMessages is undefined", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Default: no limit
    const messages: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
      id: `msg-nolimit-${i}`,
      role: "user" as const,
      parts: [{ type: "text" as const, text: `Message ${i}` }]
    }));

    await agentStub.persistMessages(messages);

    const count = await agentStub.getMessageCount();
    expect(count).toBe(20);

    ws.close(1000);
  });

  it("deletes oldest messages when count exceeds limit", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Set limit to 5
    await agentStub.setMaxPersistedMessages(5);

    // Persist 10 messages
    const messages: ChatMessage[] = Array.from({ length: 10 }, (_, i) => ({
      id: `msg-limit-${i}`,
      role: "user" as const,
      parts: [{ type: "text" as const, text: `Message ${i}` }]
    }));

    await agentStub.persistMessages(messages);

    // Should have exactly 5 messages
    const count = await agentStub.getMessageCount();
    expect(count).toBe(5);

    // The kept messages should be the most recent 5
    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(persisted.length).toBe(5);
    expect(persisted[0].id).toBe("msg-limit-5");
    expect(persisted[4].id).toBe("msg-limit-9");

    ws.close(1000);
  });

  it("keeps all messages when count is under the limit", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    await agentStub.setMaxPersistedMessages(100);

    const messages: ChatMessage[] = Array.from({ length: 5 }, (_, i) => ({
      id: `msg-under-${i}`,
      role: "user" as const,
      parts: [{ type: "text" as const, text: `Message ${i}` }]
    }));

    await agentStub.persistMessages(messages);

    const count = await agentStub.getMessageCount();
    expect(count).toBe(5);

    ws.close(1000);
  });

  it("enforces limit across multiple persist calls", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    await agentStub.setMaxPersistedMessages(4);

    // First batch: 3 messages
    await agentStub.persistMessages([
      {
        id: "batch1-1",
        role: "user",
        parts: [{ type: "text", text: "First" }]
      },
      {
        id: "batch1-2",
        role: "assistant",
        parts: [{ type: "text", text: "Response 1" }]
      },
      {
        id: "batch1-3",
        role: "user",
        parts: [{ type: "text", text: "Second" }]
      }
    ]);

    expect(await agentStub.getMessageCount()).toBe(3);

    // Second batch: adds 3 more (total would be 6, limit is 4)
    await agentStub.persistMessages([
      {
        id: "batch1-1",
        role: "user",
        parts: [{ type: "text", text: "First" }]
      },
      {
        id: "batch1-2",
        role: "assistant",
        parts: [{ type: "text", text: "Response 1" }]
      },
      {
        id: "batch1-3",
        role: "user",
        parts: [{ type: "text", text: "Second" }]
      },
      {
        id: "batch2-1",
        role: "assistant",
        parts: [{ type: "text", text: "Response 2" }]
      },
      {
        id: "batch2-2",
        role: "user",
        parts: [{ type: "text", text: "Third" }]
      },
      {
        id: "batch2-3",
        role: "assistant",
        parts: [{ type: "text", text: "Response 3" }]
      }
    ]);

    // Should be capped at 4
    expect(await agentStub.getMessageCount()).toBe(4);

    // The kept messages should be the most recent 4
    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(persisted.map((m) => m.id)).toEqual([
      "batch1-3",
      "batch2-1",
      "batch2-2",
      "batch2-3"
    ]);

    ws.close(1000);
  });

  it("can be disabled by setting to null", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Enable limit
    await agentStub.setMaxPersistedMessages(3);

    await agentStub.persistMessages(
      Array.from({ length: 5 }, (_, i) => ({
        id: `disable-${i}`,
        role: "user" as const,
        parts: [{ type: "text" as const, text: `Msg ${i}` }]
      }))
    );
    expect(await agentStub.getMessageCount()).toBe(3);

    // Disable limit
    await agentStub.setMaxPersistedMessages(null);

    // Add more messages -- should keep all now
    await agentStub.persistMessages(
      Array.from({ length: 8 }, (_, i) => ({
        id: `disable-after-${i}`,
        role: "user" as const,
        parts: [{ type: "text" as const, text: `Msg after ${i}` }]
      }))
    );

    // All 8 new + 3 remaining from before (but IDs overlap detection may differ)
    // The key assertion: count is more than 3 (limit was removed)
    expect(await agentStub.getMessageCount()).toBeGreaterThan(3);

    ws.close(1000);
  });
});
