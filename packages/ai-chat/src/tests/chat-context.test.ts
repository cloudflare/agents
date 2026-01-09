import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { MessageType } from "../types";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS } from "./test-utils";

describe("AIChatAgent Connection Context - Issue #711", () => {
  it("getCurrentAgent() should return connection in onChatMessage and nested async functions (tool execute)", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    // Get the agent stub to access captured context
    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));

    // Clear any previous captured context
    await agentStub.clearCapturedContext();

    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    const timeout = setTimeout(() => resolvePromise(false), 2000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
      }
    });

    const userMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    // Send a chat message which will trigger onChatMessage
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req1",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMessage] })
        }
      })
    );

    const done = await donePromise;
    expect(done).toBe(true);

    // Wait a bit to ensure context is captured
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Check the captured context from onChatMessage
    const capturedContext = await agentStub.getCapturedContext();

    expect(capturedContext).not.toBeNull();
    // The agent should be available
    expect(capturedContext?.hasAgent).toBe(true);
    // The connection should be available - this is the bug being tested
    // Before the fix, this would be false
    expect(capturedContext?.hasConnection).toBe(true);
    // The connection ID should be defined
    expect(capturedContext?.connectionId).toBeDefined();

    // Check the nested context
    // Tools called from onChatMessage couldn't access connection context
    const nestedContext = await agentStub.getNestedContext();

    expect(nestedContext).not.toBeNull();
    // The agent should be available in nested async functions
    expect(nestedContext?.hasAgent).toBe(true);
    // The connection should ALSO be available in nested async functions (tool execute)
    // Before the fix, this would be false
    expect(nestedContext?.hasConnection).toBe(true);
    // The connection ID should match between onChatMessage and nested function
    expect(nestedContext?.connectionId).toBe(capturedContext?.connectionId);

    ws.close();
  });
});
