import { createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { type Env } from "./worker";
import { MessageType } from "../ai-types";
import type { UIMessage as ChatMessage } from "ai";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

async function connectChatWS(path: string) {
  const ctx = createExecutionContext();
  const req = new Request(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  const res = await worker.fetch(req, env, ctx);
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws, ctx };
}

describe("Chat Agent Persistence", () => {
  it("persists new messages incrementally without deleting existing ones", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const messages: unknown[] = [];
    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    const timeout = setTimeout(() => resolvePromise(false), 2000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      messages.push(data);

      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
      }
    });

    const firstMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req1",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [firstMessage] })
        }
      })
    );

    const firstDone = await donePromise;
    expect(firstDone).toBe(true);

    const secondMessage: ChatMessage = {
      id: "msg2",
      role: "user",
      parts: [{ type: "text", text: "How are you?" }]
    };

    const secondPromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });
    const timeout2 = setTimeout(() => resolvePromise(false), 2000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout2);
        resolvePromise(true);
      }
    });

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req2",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [firstMessage, secondMessage] })
        }
      })
    );

    const secondDone = await secondPromise;
    expect(secondDone).toBe(true);

    ws.close();

    const getMessagesReq = new Request(
      `http://example.com/agents/test-chat-agent/${room}/get-messages`
    );
    const getMessagesRes = await worker.fetch(
      getMessagesReq,
      env,
      createExecutionContext()
    );
    expect(getMessagesRes.status).toBe(200);

    const persistedMessages = (await getMessagesRes.json()) as ChatMessage[];
    expect(persistedMessages.length).toBeGreaterThanOrEqual(4); // 2 user + 2 assistant

    const userMessages = persistedMessages.filter((m) => m.role === "user");
    expect(userMessages.length).toBe(2);
    expect(userMessages.some((m) => m.id === "msg1")).toBe(true);
    expect(userMessages.some((m) => m.id === "msg2")).toBe(true);

    const assistantMessages = persistedMessages.filter(
      (m) => m.role === "assistant"
    );
    expect(assistantMessages.length).toBeGreaterThanOrEqual(2);

    // check that assistant messages have content
    assistantMessages.forEach((msg) => {
      expect(msg.parts).toBeDefined();
      expect(msg.parts.length).toBeGreaterThan(0);
    });
  });

  it("handles messages incrementally", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const initialMessages: ChatMessage[] = [
      { id: "init1", role: "user", parts: [{ type: "text", text: "First" }] },
      {
        id: "init2",
        role: "assistant",
        parts: [{ type: "text", text: "Response" }]
      }
    ];

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_CHAT_MESSAGES,
        messages: initialMessages
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    const replacementMessages: ChatMessage[] = [
      {
        id: "new1",
        role: "user",
        parts: [{ type: "text", text: "New conversation" }]
      }
    ];

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_CHAT_MESSAGES,
        messages: replacementMessages
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    ws.close();

    const getMessagesReq = new Request(
      `http://example.com/agents/test-chat-agent/${room}/get-messages`
    );
    const getMessagesRes = await worker.fetch(
      getMessagesReq,
      env,
      createExecutionContext()
    );
    expect(getMessagesRes.status).toBe(200);

    const persistedMessages = (await getMessagesRes.json()) as ChatMessage[];
    expect(persistedMessages.length).toBe(3); // init1, init2, new1

    const messageIds = persistedMessages.map((m) => m.id);
    expect(messageIds).toContain("init1");
    expect(messageIds).toContain("init2");
    expect(messageIds).toContain("new1");
  });
});
