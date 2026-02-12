import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { MessageType } from "../types";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS } from "./test-utils";
import { getAgentByName } from "agents";

describe("Client tools after reconnect", () => {
  it("should use client tools from CF_AGENT_TOOL_RESULT for continuation", async () => {
    const room = crypto.randomUUID();

    // Step 1: Set up a conversation with a pending tool call (simulates state before refresh)
    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const userMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Change the background" }]
    };

    const toolCallId = "call_reconnect_test";
    const assistantMessage: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "tool-changeBackgroundColor",
          toolCallId,
          state: "input-available",
          input: { color: "blue" }
        }
      ] as ChatMessage["parts"]
    };

    // Persist messages directly (simulates state loaded from SQLite after DO restart)
    await agentStub.persistMessages([userMessage, assistantMessage]);

    // Step 2: Connect (simulates reconnect after refresh)
    // Note: We intentionally do NOT send a CF_AGENT_USE_CHAT_REQUEST first,
    // so _lastClientTools is never set — this simulates DO restart.
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    // Wait for connection to be established
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Clear any captured context from connection setup
    await agentStub.clearCapturedContext();

    // Step 3: Send tool result WITH clientTools (simulates client approval after reconnect)
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
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId,
        toolName: "changeBackgroundColor",
        output: { success: true },
        autoContinue: true,
        clientTools
      })
    );

    // Wait for tool result to be applied + 500ms stream wait + continuation
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Step 4: Verify continuation received client tools
    const capturedClientTools = await agentStub.getCapturedClientTools();
    expect(capturedClientTools).toBeDefined();
    expect(capturedClientTools).toHaveLength(2);
    expect(capturedClientTools![0].name).toBe("changeBackgroundColor");
    expect(capturedClientTools![1].name).toBe("changeTextColor");

    ws.close();
  });

  it("should work without clientTools in CF_AGENT_TOOL_RESULT (backwards compat)", async () => {
    const room = crypto.randomUUID();

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Persist a conversation with a pending tool call
    await agentStub.persistMessages([
      {
        id: "msg1",
        role: "user",
        parts: [{ type: "text", text: "Do something" }]
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-testTool",
            toolCallId: "call_compat_test",
            state: "input-available",
            input: {}
          }
        ] as ChatMessage["parts"]
      }
    ]);

    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await agentStub.clearCapturedContext();

    // Send tool result WITHOUT clientTools (old client behavior)
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId: "call_compat_test",
        toolName: "testTool",
        output: { success: true },
        autoContinue: true
        // No clientTools field
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Continuation should still fire, just without client tools
    const capturedClientTools = await agentStub.getCapturedClientTools();
    expect(capturedClientTools).toBeUndefined();

    ws.close();
  });
});
