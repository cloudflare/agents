import { createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "./worker";
import type { UIMessage as ChatMessage } from "ai";
import { getAgentByName } from "agents";

describe("Message Structural Validation", () => {
  async function setupAgent(room: string) {
    const ctx = createExecutionContext();
    const req = new Request(
      `http://example.com/agents/test-chat-agent/${room}`,
      { headers: { Upgrade: "websocket" } }
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    ws.accept();
    await ctx.waitUntil(Promise.resolve());

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    return { ws, agentStub };
  }

  /**
   * Fetch messages via the /get-messages HTTP endpoint, which goes through
   * _loadMessagesFromDb() and applies structural validation.
   */
  async function getValidatedMessages(room: string): Promise<ChatMessage[]> {
    const getMessagesReq = new Request(
      `http://example.com/agents/test-chat-agent/${room}/get-messages`
    );
    const getMessagesRes = await worker.fetch(
      getMessagesReq,
      env,
      createExecutionContext()
    );
    expect(getMessagesRes.status).toBe(200);
    return (await getMessagesRes.json()) as ChatMessage[];
  }

  it("loads valid messages without filtering", async () => {
    const room = crypto.randomUUID();
    const { ws, agentStub } = await setupAgent(room);

    const messages: ChatMessage[] = [
      { id: "msg1", role: "user", parts: [{ type: "text", text: "Hello" }] },
      {
        id: "msg2",
        role: "assistant",
        parts: [{ type: "text", text: "Hi!" }]
      }
    ];

    await agentStub.persistMessages(messages);

    const persisted = await getValidatedMessages(room);
    expect(persisted.length).toBe(2);
    expect(persisted[0].id).toBe("msg1");
    expect(persisted[1].id).toBe("msg2");

    ws.close(1000);
  });

  it("filters out messages with missing id", async () => {
    const room = crypto.randomUUID();
    const { ws, agentStub } = await setupAgent(room);

    await agentStub.persistMessages([
      { id: "valid1", role: "user", parts: [{ type: "text", text: "Hello" }] }
    ]);

    // Manually insert a malformed message (no id field)
    agentStub.insertRawMessage(
      "bad-no-id",
      JSON.stringify({
        role: "user",
        parts: [{ type: "text", text: "bad" }]
      })
    );

    const persisted = await getValidatedMessages(room);
    expect(persisted.length).toBe(1);
    expect(persisted[0].id).toBe("valid1");

    ws.close(1000);
  });

  it("filters out messages with invalid role", async () => {
    const room = crypto.randomUUID();
    const { ws, agentStub } = await setupAgent(room);

    await agentStub.persistMessages([
      { id: "valid1", role: "user", parts: [{ type: "text", text: "Hello" }] }
    ]);

    agentStub.insertRawMessage(
      "bad-role",
      JSON.stringify({
        id: "bad-role",
        role: "invalid-role",
        parts: [{ type: "text", text: "bad" }]
      })
    );

    const persisted = await getValidatedMessages(room);
    expect(persisted.length).toBe(1);
    expect(persisted[0].id).toBe("valid1");

    ws.close(1000);
  });

  it("filters out messages with non-array parts", async () => {
    const room = crypto.randomUUID();
    const { ws, agentStub } = await setupAgent(room);

    await agentStub.persistMessages([
      { id: "valid1", role: "user", parts: [{ type: "text", text: "Hello" }] }
    ]);

    agentStub.insertRawMessage(
      "bad-parts",
      JSON.stringify({
        id: "bad-parts",
        role: "user",
        parts: "not an array"
      })
    );

    const persisted = await getValidatedMessages(room);
    expect(persisted.length).toBe(1);
    expect(persisted[0].id).toBe("valid1");

    ws.close(1000);
  });

  it("filters out messages with empty id", async () => {
    const room = crypto.randomUUID();
    const { ws, agentStub } = await setupAgent(room);

    await agentStub.persistMessages([
      { id: "valid1", role: "user", parts: [{ type: "text", text: "Hello" }] }
    ]);

    agentStub.insertRawMessage(
      "bad-empty-id",
      JSON.stringify({
        id: "",
        role: "user",
        parts: [{ type: "text", text: "bad" }]
      })
    );

    const persisted = await getValidatedMessages(room);
    expect(persisted.length).toBe(1);
    expect(persisted[0].id).toBe("valid1");

    ws.close(1000);
  });

  it("keeps messages with empty parts array (lenient)", async () => {
    const room = crypto.randomUUID();
    const { ws, agentStub } = await setupAgent(room);

    await agentStub.persistMessages([
      { id: "empty-parts", role: "assistant", parts: [] }
    ]);

    const persisted = await getValidatedMessages(room);
    expect(persisted.length).toBe(1);
    expect(persisted[0].id).toBe("empty-parts");
    expect(persisted[0].parts).toEqual([]);

    ws.close(1000);
  });

  it("filters out non-object values stored as messages", async () => {
    const room = crypto.randomUUID();
    const { ws, agentStub } = await setupAgent(room);

    await agentStub.persistMessages([
      { id: "valid1", role: "user", parts: [{ type: "text", text: "Hello" }] }
    ]);

    // Raw string value (not a JSON object)
    agentStub.insertRawMessage("bad-string", JSON.stringify("just a string"));

    // null value
    agentStub.insertRawMessage("bad-null", "null");

    const persisted = await getValidatedMessages(room);
    expect(persisted.length).toBe(1);
    expect(persisted[0].id).toBe("valid1");

    ws.close(1000);
  });

  it("preserves messages with metadata", async () => {
    const room = crypto.randomUUID();
    const { ws, agentStub } = await setupAgent(room);

    const messageWithMeta: ChatMessage = {
      id: "meta1",
      role: "assistant",
      parts: [{ type: "text", text: "Response" }],
      metadata: { model: "gpt-4o", totalTokens: 150 }
    };

    await agentStub.persistMessages([messageWithMeta]);

    const persisted = await getValidatedMessages(room);
    expect(persisted.length).toBe(1);
    expect(persisted[0].id).toBe("meta1");
    expect(persisted[0].metadata).toEqual({
      model: "gpt-4o",
      totalTokens: 150
    });

    ws.close(1000);
  });

  it("filters out completely unparseable JSON", async () => {
    const room = crypto.randomUUID();
    const { ws, agentStub } = await setupAgent(room);

    await agentStub.persistMessages([
      { id: "valid1", role: "user", parts: [{ type: "text", text: "Hello" }] }
    ]);

    // Insert raw broken JSON that will fail JSON.parse
    agentStub.insertRawMessage("bad-json", "{broken json!!!");

    const persisted = await getValidatedMessages(room);
    expect(persisted.length).toBe(1);
    expect(persisted[0].id).toBe("valid1");

    ws.close(1000);
  });

  it("accepts all valid roles: user, assistant, system", async () => {
    const room = crypto.randomUUID();
    const { ws, agentStub } = await setupAgent(room);

    const messages: ChatMessage[] = [
      {
        id: "sys1",
        role: "system",
        parts: [{ type: "text", text: "You are helpful" }]
      },
      { id: "usr1", role: "user", parts: [{ type: "text", text: "Hello" }] },
      {
        id: "ast1",
        role: "assistant",
        parts: [{ type: "text", text: "Hi!" }]
      }
    ];

    await agentStub.persistMessages(messages);

    const persisted = await getValidatedMessages(room);
    expect(persisted.length).toBe(3);
    expect(persisted.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant"
    ]);

    ws.close(1000);
  });
});
