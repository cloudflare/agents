import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
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

    const res = await exports.default.fetch(
      `http://example.com/agents/test-chat-agent/${room}/get-messages`
    );

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

    const res = await exports.default.fetch(
      `http://example.com/agents/test-chat-agent/${room}/get-messages`
    );

    expect(res.status).toBe(200);
    const returned = (await res.json()) as ChatMessage[];
    expect(returned.length).toBe(3);
    expect(returned.map((m) => m.id)).toEqual([
      "msg-get-1",
      "msg-get-2",
      "msg-get-3"
    ]);
  });

  it("streams a transcript with offloaded payloads as the same JSON array", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // One row large enough that Sessions offloads its payload, so the
    // streamed response has to reconstruct across batch boundaries.
    const hugeOutput = "Q".repeat(1_900_000);
    const messages: ChatMessage[] = [
      {
        id: "stream-get-1",
        role: "user",
        parts: [{ type: "text", text: "run it" }]
      },
      {
        id: "stream-get-2",
        role: "assistant",
        parts: [
          {
            type: "tool-bigTool",
            toolCallId: "call_stream",
            state: "output-available",
            input: {},
            output: hugeOutput
          }
        ] as ChatMessage["parts"]
      },
      {
        id: "stream-get-3",
        role: "user",
        parts: [{ type: "text", text: "thanks" }]
      }
    ];

    await agentStub.persistMessages(messages);
    ws.close(1000);

    const res = await exports.default.fetch(
      `http://example.com/agents/test-chat-agent/${room}/get-messages`
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const returned = (await res.json()) as ChatMessage[];
    expect(returned.map((m) => m.id)).toEqual([
      "stream-get-1",
      "stream-get-2",
      "stream-get-3"
    ]);
    // Byte-for-byte identical to a materialized read of the same transcript.
    expect(returned).toEqual(
      (await agentStub.reconstructedMessagesForTest()) as ChatMessage[]
    );
    expect((returned[1].parts[0] as { output: unknown }).output).toBe(
      hugeOutput
    );
  });

  it("returns 404 for non-existent routes", async () => {
    const res = await exports.default.fetch(
      "http://example.com/agents/test-chat-agent/foo/bar"
    );

    // The worker returns 404 for unknown routes
    expect(res.status).toBe(404);
  });
});

describe("onRequest override patterns", () => {
  it("/get-messages works when user overrides onRequest and calls super", async () => {
    const room = crypto.randomUUID();

    const { ws } = await connectChatWS(`/agents/agent-with-super-call/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.AgentWithSuperCall, room);
    const messages: ChatMessage[] = [
      { id: "test-1", role: "user", parts: [{ type: "text", text: "Hello" }] }
    ];
    await agentStub.persistMessages(messages);
    ws.close(1000);

    const res = await exports.default.fetch(
      `http://example.com/agents/agent-with-super-call/${room}/get-messages`
    );

    expect(res.status).toBe(200);
    const returned = (await res.json()) as ChatMessage[];
    expect(returned.length).toBe(1);
    expect(returned[0].id).toBe("test-1");
  });

  it("/get-messages works when user overrides onRequest WITHOUT calling super", async () => {
    const room = crypto.randomUUID();

    const { ws } = await connectChatWS(
      `/agents/agent-without-super-call/${room}`
    );
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.AgentWithoutSuperCall, room);
    const messages: ChatMessage[] = [
      {
        id: "test-no-super-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      }
    ];
    await agentStub.persistMessages(messages);
    ws.close(1000);

    const res = await exports.default.fetch(
      `http://example.com/agents/agent-without-super-call/${room}/get-messages`
    );

    expect(res.status).toBe(200);
    const returned = (await res.json()) as ChatMessage[];
    expect(returned.length).toBe(1);
    expect(returned[0].id).toBe("test-no-super-1");
  });

  it("non-get-messages routes still delegate to user onRequest override", async () => {
    const room = crypto.randomUUID();

    const { ws } = await connectChatWS(
      `/agents/agent-without-super-call/${room}`
    );
    await new Promise((r) => setTimeout(r, 50));
    ws.close(1000);

    const res = await exports.default.fetch(
      `http://example.com/agents/agent-without-super-call/${room}/other-route`
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("custom only");
  });
});
