import { createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "./worker";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS } from "./test-utils";
import { getAgentByName } from "agents";

describe("GET /get-messages endpoint", () => {
  it("returns empty array for a new agent with no messages", async () => {
    const room = crypto.randomUUID();

    // First, establish a WebSocket to create the DO instance
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));
    ws.close(1000);

    const req = new Request(
      `http://example.com/agents/test-chat-agent/${room}/get-messages`
    );
    const res = await worker.fetch(req, env, createExecutionContext());

    expect(res.status).toBe(200);
    const messages = (await res.json()) as ChatMessage[];
    expect(messages).toEqual([]);
  });

  it("returns persisted messages in chronological order", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const messages: ChatMessage[] = [
      {
        id: "msg-get-1",
        role: "user",
        parts: [{ type: "text", text: "First" }]
      },
      {
        id: "msg-get-2",
        role: "assistant",
        parts: [{ type: "text", text: "Second" }]
      },
      {
        id: "msg-get-3",
        role: "user",
        parts: [{ type: "text", text: "Third" }]
      }
    ];

    await agentStub.persistMessages(messages);
    ws.close(1000);

    const req = new Request(
      `http://example.com/agents/test-chat-agent/${room}/get-messages`
    );
    const res = await worker.fetch(req, env, createExecutionContext());

    expect(res.status).toBe(200);
    const returned = (await res.json()) as ChatMessage[];
    expect(returned.length).toBe(3);
    expect(returned.map((m) => m.id)).toEqual([
      "msg-get-1",
      "msg-get-2",
      "msg-get-3"
    ]);
  });

  it("returns 404 for non-existent routes", async () => {
    const req = new Request(
      "http://example.com/agents/test-chat-agent/foo/bar"
    );
    const res = await worker.fetch(req, env, createExecutionContext());

    // The worker returns 404 for unknown routes
    expect(res.status).toBe(404);
  });
});
