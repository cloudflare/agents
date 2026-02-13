import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { MessageType } from "../types";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS } from "./test-utils";
import { getAgentByName } from "agents";

describe("Client tools continuation", () => {
  it("should pass client tools to onChatMessage during auto-continuation", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.clearCapturedContext();

    // Step 1: Send initial chat request WITH client tools to store them
    let resolvePromise: (value: boolean) => void;
    let donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    let timeout = setTimeout(() => resolvePromise(false), 2000);

    ws.addEventListener("message", function handler(e: MessageEvent) {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
        ws.removeEventListener("message", handler);
      }
    });

    const userMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    const clientTools = [
      {
        name: "changeBackgroundColor",
        description: "Changes the background color",
        parameters: {
          type: "object",
          properties: { color: { type: "string" } }
        }
      },
      {
        name: "changeTextColor",
        description: "Changes the text color",
        parameters: {
          type: "object",
          properties: { color: { type: "string" } }
        }
      }
    ];

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req1",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMessage], clientTools })
        }
      })
    );

    let done = await donePromise;
    expect(done).toBe(true);

    // Verify initial request received client tools
    await new Promise((resolve) => setTimeout(resolve, 100));
    const initialClientTools = await agentStub.getCapturedClientTools();
    expect(initialClientTools).toBeDefined();
    expect(initialClientTools).toHaveLength(2);

    // Step 2: Persist a tool call in input-available state
    const toolCallId = "call_continuation_test";
    await agentStub.persistMessages([
      userMessage,
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-changeBackgroundColor",
            toolCallId,
            state: "input-available",
            input: { color: "green" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    // Step 3: Clear captured state before continuation
    await agentStub.clearCapturedContext();

    // Step 4: Send tool result with autoContinue to trigger continuation
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId,
        toolName: "changeBackgroundColor",
        output: { success: true },
        autoContinue: true
      })
    );

    // Wait for continuation (500ms stream wait + processing)
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Step 5: Verify continuation received client tools
    const continuationClientTools = await agentStub.getCapturedClientTools();
    expect(continuationClientTools).toBeDefined();
    expect(continuationClientTools).toHaveLength(2);
    expect(continuationClientTools).toEqual(clientTools);

    ws.close(1000);
  });

  it("should clear stored client tools when chat is cleared", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Send initial request with client tools to store them
    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    const timeout = setTimeout(() => resolvePromise(false), 2000);

    ws.addEventListener("message", function handler(e: MessageEvent) {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
        ws.removeEventListener("message", handler);
      }
    });

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req1",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "msg1",
                role: "user",
                parts: [{ type: "text", text: "Hi" }]
              }
            ],
            clientTools: [{ name: "testTool", description: "Test" }]
          })
        }
      })
    );

    const done = await donePromise;
    expect(done).toBe(true);

    // Clear chat
    ws.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Persist a tool call and trigger continuation
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Execute tool" }]
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-testTool",
            toolCallId: "call_after_clear",
            state: "input-available",
            input: {}
          }
        ] as ChatMessage["parts"]
      }
    ]);

    await agentStub.clearCapturedContext();

    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId: "call_after_clear",
        toolName: "testTool",
        output: { success: true },
        autoContinue: true
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Client tools should be undefined after chat clear
    const continuationClientTools = await agentStub.getCapturedClientTools();
    expect(continuationClientTools).toBeUndefined();

    ws.close(1000);
  });

  it("should clear stored client tools when new request has no client tools", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Send first request WITH client tools
    let resolvePromise: (value: boolean) => void;
    let donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });
    let timeout = setTimeout(() => resolvePromise(false), 2000);

    const handler1 = (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
      }
    };
    ws.addEventListener("message", handler1);

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req1",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "msg1",
                role: "user",
                parts: [{ type: "text", text: "Hi" }]
              }
            ],
            clientTools: [{ name: "testTool", description: "Test" }]
          })
        }
      })
    );

    let done = await donePromise;
    expect(done).toBe(true);
    ws.removeEventListener("message", handler1);

    await new Promise((resolve) => setTimeout(resolve, 100));
    let capturedTools = await agentStub.getCapturedClientTools();
    expect(capturedTools).toHaveLength(1);

    // Send second request WITHOUT client tools
    donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });
    timeout = setTimeout(() => resolvePromise(false), 2000);

    const handler2 = (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
      }
    };
    ws.addEventListener("message", handler2);

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req2",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "msg1",
                role: "user",
                parts: [{ type: "text", text: "Hi" }]
              },
              {
                id: "msg2",
                role: "user",
                parts: [{ type: "text", text: "Again" }]
              }
            ]
            // No clientTools
          })
        }
      })
    );

    done = await donePromise;
    expect(done).toBe(true);
    ws.removeEventListener("message", handler2);

    await new Promise((resolve) => setTimeout(resolve, 100));
    capturedTools = await agentStub.getCapturedClientTools();
    expect(capturedTools).toBeUndefined();

    ws.close(1000);
  });
});
