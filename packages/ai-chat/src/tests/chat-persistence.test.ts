import { createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "./worker";
import { MessageType } from "../types";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS } from "./test-utils";

// Type helper for tool call parts - extracts ToolUIPart from ChatMessage parts
type TestToolCallPart = Extract<
  ChatMessage["parts"][number],
  { type: `tool-${string}` }
>;

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

  it("persists tool calls and updates them with tool outputs", async () => {
    const room = crypto.randomUUID();

    const ctx = createExecutionContext();
    const req = new Request(
      `http://example.com/agents/test-chat-agent/${room}`,
      {
        headers: { Upgrade: "websocket" }
      }
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    ws.accept();

    await ctx.waitUntil(Promise.resolve());

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));

    await agentStub.testPersistToolCall("msg-tool-1", "getLocalTime");

    const messagesAfterCall =
      (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(messagesAfterCall.length).toBe(1);
    expect(messagesAfterCall[0].id).toBe("msg-tool-1");
    const toolPart1 = messagesAfterCall[0].parts[0] as {
      type: string;
      state: string;
      toolCallId: string;
      input: unknown;
    };
    expect(toolPart1.type).toBe("tool-getLocalTime");
    expect(toolPart1.state).toBe("input-available");
    expect(toolPart1.input).toEqual({ location: "London" });

    await agentStub.testPersistToolResult("msg-tool-1", "getLocalTime", "10am");

    const messagesAfterOutput =
      (await agentStub.getPersistedMessages()) as ChatMessage[];

    // Should still be only 1 message
    expect(messagesAfterOutput.length).toBe(1);
    expect(messagesAfterOutput[0].id).toBe("msg-tool-1");

    const toolPart2 = messagesAfterOutput[0].parts[0] as {
      type: string;
      state: string;
      toolCallId: string;
      input: unknown;
      output: unknown;
    };
    expect(toolPart2.type).toBe("tool-getLocalTime");
    expect(toolPart2.state).toBe("output-available");
    expect(toolPart2.output).toBe("10am");
    expect(toolPart2.input).toEqual({ location: "London" });

    ws.close();
  });

  it("persists multiple messages with tool calls and outputs correctly", async () => {
    const room = crypto.randomUUID();
    const ctx = createExecutionContext();
    const req = new Request(
      `http://example.com/agents/test-chat-agent/${room}`,
      {
        headers: { Upgrade: "websocket" }
      }
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    ws.accept();

    await ctx.waitUntil(Promise.resolve());

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));

    const userMessage: ChatMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "What time is it in London?" }]
    };

    const toolCallPart: TestToolCallPart = {
      type: "tool-getLocalTime",
      toolCallId: "call_456",
      state: "input-available",
      input: { location: "London" }
    };

    const assistantToolCall: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [toolCallPart] as ChatMessage["parts"]
    };

    await agentStub.persistMessages([userMessage, assistantToolCall]);

    const messagesAfterToolCall =
      (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(messagesAfterToolCall.length).toBe(2);
    expect(messagesAfterToolCall.find((m) => m.id === "user-1")).toBeDefined();
    expect(
      messagesAfterToolCall.find((m) => m.id === "assistant-1")
    ).toBeDefined();

    const toolResultPart: TestToolCallPart = {
      type: "tool-getLocalTime",
      toolCallId: "call_456",
      state: "output-available",
      input: { location: "London" },
      output: "3:00 PM"
    };

    const assistantToolOutput: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [toolResultPart] as ChatMessage["parts"]
    };

    const assistantResponse: ChatMessage = {
      id: "assistant-2",
      role: "assistant",
      parts: [{ type: "text", text: "It is 3:00 PM in London." }]
    };

    await agentStub.persistMessages([
      userMessage,
      assistantToolOutput,
      assistantResponse
    ]);

    const persistedMessages =
      (await agentStub.getPersistedMessages()) as ChatMessage[];

    // Should have 3 messages: user-1, assistant-1 (with tool output), assistant-2
    expect(persistedMessages.length).toBe(3);

    const userMsg = persistedMessages.find((m) => m.id === "user-1");
    expect(userMsg).toBeDefined();
    expect(userMsg?.role).toBe("user");

    // Verify assistant message with tool output (should be updated, not duplicated)
    const assistantWithTool = persistedMessages.find(
      (m) => m.id === "assistant-1"
    );
    expect(assistantWithTool).toBeDefined();
    const toolPart = assistantWithTool?.parts[0] as {
      type: string;
      state: string;
      toolCallId: string;
      input: unknown;
      output: unknown;
    };
    expect(toolPart.type).toBe("tool-getLocalTime");
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toBe("3:00 PM");

    const finalResponse = persistedMessages.find((m) => m.id === "assistant-2");
    expect(finalResponse).toBeDefined();
    expect(finalResponse?.parts[0].type).toBe("text");

    ws.close();
  });

  it("maintains chronological order when tool outputs arrive after the final response", async () => {
    const room = crypto.randomUUID();
    const ctx = createExecutionContext();
    const req = new Request(
      `http://example.com/agents/test-chat-agent/${room}`,
      {
        headers: { Upgrade: "websocket" }
      }
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    ws.accept();

    await ctx.waitUntil(Promise.resolve());

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));

    const userMessage: ChatMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "What time is it?" }]
    };

    const toolCallPart: TestToolCallPart = {
      type: "tool-getLocalTime",
      toolCallId: "call_123",
      state: "input-available",
      input: { location: "London" }
    };

    const assistantToolCall: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [toolCallPart] as ChatMessage["parts"]
    };

    const assistantResponse: ChatMessage = {
      id: "assistant-2",
      role: "assistant",
      parts: [{ type: "text", text: "Let me check." }]
    };

    await agentStub.persistMessages([
      userMessage,
      assistantToolCall,
      assistantResponse
    ]);

    const toolResultPart: TestToolCallPart = {
      type: "tool-getLocalTime",
      toolCallId: "call_123",
      state: "output-available",
      input: { location: "London" },
      output: "3:00 PM"
    };

    const assistantToolResult: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [toolResultPart] as ChatMessage["parts"]
    };

    await agentStub.persistMessages([assistantToolResult]);

    const persistedMessages =
      (await agentStub.getPersistedMessages()) as ChatMessage[];

    expect(persistedMessages.map((m) => m.id)).toEqual([
      "user-1",
      "assistant-1",
      "assistant-2"
    ]);

    ws.close();
  });
});
