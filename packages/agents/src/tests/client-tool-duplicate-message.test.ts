import { createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { type Env } from "./worker";
import type { UIMessage as ChatMessage } from "ai";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/**
 * This test reproduces a bug where client-side tool execution creates two separate
 * assistant messages instead of updating one, causing OpenAI to reject requests
 * with "Duplicate item found" error.
 *
 * The issue: When a client-side tool result comes back, persistMessages creates
 * a new assistant message instead of updating the existing one.
 *
 * Expected behavior:
 * - First request creates assistant message with tool call in "input-available" state
 * - When tool result arrives, the SAME message should be updated to "output-available" state
 *
 * Actual behavior (bug):
 * - First request creates assistant message with "input-available" state
 * - Tool result creates a NEW assistant message with "output-available" state
 * - Both messages contain the same OpenAI reasoning itemId, causing duplicate rejection
 */
describe("Client-side tool execution duplicate message bug", () => {
  it("correctly updates message when using the same message ID (control test)", async () => {
    /**
     * This is a CONTROL test that demonstrates the expected behavior works
     * when the client explicitly provides the SAME message ID.
     *
     * This test PASSES because persistMessages uses "ON CONFLICT DO UPDATE"
     * which correctly updates the message when the ID matches.
     */
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

    // Simulate what happens during client-side tool execution:

    // Step 1: User sends a message
    const userMessage: ChatMessage = {
      id: "user-msg-1",
      role: "user",
      parts: [{ type: "text", text: "What time is it?" }]
    };

    // Step 2: First stream response - assistant message with tool call in "input-available" state
    // This simulates what the AI SDK sends when a client tool is called
    const assistantMsgId = "assistant_1765453133333_jwecuct24"; // Simulated ID from _reply
    const toolCallId = "call_abc123";

    const assistantWithToolInput: ChatMessage = {
      id: assistantMsgId,
      role: "assistant",
      parts: [
        {
          type: "tool-slowOperation",
          toolCallId: toolCallId,
          state: "input-available",
          input: { query: "current time" }
        }
      ] as ChatMessage["parts"],
      // Simulate OpenAI provider metadata that contains the reasoning itemId
      metadata: {
        openai: {
          reasoning: {
            itemId: "rs_0a7581aefb67f54200693aad4e0be88190b95bdba31783082e"
          }
        }
      }
    };

    // Persist the first message (tool call with input-available)
    await agentStub.persistMessages([userMessage, assistantWithToolInput]);

    // Verify initial state
    const messagesAfterToolCall =
      (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(messagesAfterToolCall.length).toBe(2);

    const firstAssistantMsg = messagesAfterToolCall.find(
      (m) => m.role === "assistant"
    );
    expect(firstAssistantMsg).toBeDefined();
    expect(firstAssistantMsg?.id).toBe(assistantMsgId);

    // Step 3: Client executes the tool and sends back the result
    // The bug is here: instead of updating the existing message, a new one is created

    // This is what SHOULD happen - the same message ID with updated state
    const assistantWithToolOutput: ChatMessage = {
      id: assistantMsgId, // Same ID as before - should UPDATE, not INSERT
      role: "assistant",
      parts: [
        {
          type: "tool-slowOperation",
          toolCallId: toolCallId,
          state: "output-available", // State changed from input-available
          input: { query: "current time" },
          output: "3:00 PM"
        }
      ] as ChatMessage["parts"],
      metadata: {
        openai: {
          reasoning: {
            itemId: "rs_0a7581aefb67f54200693aad4e0be88190b95bdba31783082e" // Same itemId
          }
        }
      }
    };

    // Persist the updated message (tool result with output-available)
    await agentStub.persistMessages([
      userMessage,
      assistantWithToolOutput // This should UPDATE the existing message, not create new
    ]);

    // Verify the result
    const finalMessages =
      (await agentStub.getPersistedMessages()) as ChatMessage[];

    // CRITICAL ASSERTION: Should still be exactly 2 messages (1 user + 1 assistant)
    // If this fails, it means we created a duplicate assistant message
    expect(finalMessages.length).toBe(2);

    // Verify we have exactly one user message and one assistant message
    const userMessages = finalMessages.filter((m) => m.role === "user");
    const assistantMessages = finalMessages.filter(
      (m) => m.role === "assistant"
    );

    expect(userMessages.length).toBe(1);
    expect(assistantMessages.length).toBe(1);

    // Verify the assistant message was UPDATED (not duplicated)
    const finalAssistantMsg = assistantMessages[0];
    expect(finalAssistantMsg.id).toBe(assistantMsgId);

    // Verify the tool state was updated to output-available
    const toolPart = finalAssistantMsg.parts[0] as {
      type: string;
      state: string;
      output?: unknown;
    };
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toBe("3:00 PM");

    ws.close();
  });

  it("BUG: creates duplicate messages when tool result has different ID", async () => {
    /**
     * This test reproduces the ACTUAL bug scenario where:
     * 1. First request persists assistant message with ID "assistant_1765453133333_jwecuct24"
     * 2. Second request (tool result) persists NEW message with ID "DBZJDtigkmZFiyha"
     *
     * Both contain the same OpenAI reasoning itemId, causing:
     * APICallError: Duplicate item found with id rs_0a7581aefb67f54200693aad4e0be88190b95bdba31783082e
     *
     * THIS TEST SHOULD FAIL - it demonstrates the bug.
     * Once fixed, this test should pass.
     */
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

    const reasoningItemId =
      "rs_0a7581aefb67f54200693aad4e0be88190b95bdba31783082e";
    const toolCallId = "call_xyz789";

    // User message
    const userMessage: ChatMessage = {
      id: "G1yyXDEwe0MEo8o5",
      role: "user",
      parts: [{ type: "text", text: "Do a slow operation" }]
    };

    // First assistant message - created during first stream
    const firstAssistantMsg: ChatMessage = {
      id: "assistant_1765453133333_jwecuct24", // First message ID
      role: "assistant",
      parts: [
        {
          type: "tool-slowOperation",
          toolCallId: toolCallId,
          state: "input-available",
          input: { duration: 1000 }
        }
      ] as ChatMessage["parts"],
      metadata: {
        openai: {
          reasoning: { itemId: reasoningItemId }
        }
      }
    };

    // Persist first messages
    await agentStub.persistMessages([userMessage, firstAssistantMsg]);

    // Second assistant message - BUG: created with DIFFERENT ID during second request
    const secondAssistantMsg: ChatMessage = {
      id: "DBZJDtigkmZFiyha", // DIFFERENT message ID - THIS IS THE BUG
      role: "assistant",
      parts: [
        {
          type: "tool-slowOperation",
          toolCallId: toolCallId,
          state: "output-available",
          input: { duration: 1000 },
          output: "completed"
        }
      ] as ChatMessage["parts"],
      metadata: {
        openai: {
          reasoning: { itemId: reasoningItemId } // SAME reasoning itemId
        }
      }
    };

    // Persist second messages - this creates the duplicate
    await agentStub.persistMessages([userMessage, secondAssistantMsg]);

    // Get all messages
    const allMessages =
      (await agentStub.getPersistedMessages()) as ChatMessage[];

    // Count assistant messages
    const assistantMessages = allMessages.filter((m) => m.role === "assistant");

    // THIS TEST SHOULD FAIL if the bug exists
    // When it fails, it demonstrates the bug: 2 assistant messages with same reasoning itemId
    //
    // Expected: 1 assistant message (updated)
    // Actual (bug): 2 assistant messages (duplicate)
    expect(assistantMessages.length).toBe(1);

    // If we have 2 assistant messages, both will have the same reasoning itemId
    // This is what causes OpenAI to reject with "Duplicate item found"
    if (assistantMessages.length === 2) {
      const itemIds = assistantMessages
        .map(
          (m) =>
            (m.metadata as { openai?: { reasoning?: { itemId?: string } } })
              ?.openai?.reasoning?.itemId
        )
        .filter(Boolean);

      // This demonstrates the duplicate itemId problem
      console.log(
        "BUG DETECTED: Two assistant messages with reasoning itemIds:",
        itemIds
      );
      console.log(
        "Message IDs:",
        assistantMessages.map((m) => m.id)
      );
    }

    ws.close();
  });

  it("BUG: should merge tool output into existing assistant message by toolCallId", async () => {
    /**
     * This test verifies the expected fix behavior:
     * When persisting messages, if an assistant message contains a tool part
     * with state "output-available", and there's an existing assistant message
     * with the same toolCallId in state "input-available", the existing message
     * should be UPDATED rather than creating a new message.
     *
     * THIS TEST SHOULD FAIL - it demonstrates the bug.
     * Once fixed, this test should pass.
     */
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

    const toolCallId = "call_merge_test";
    const reasoningItemId = "rs_merge_test_12345";

    // Initial user message
    const userMessage: ChatMessage = {
      id: "user-merge-test",
      role: "user",
      parts: [{ type: "text", text: "Test merge" }]
    };

    // First: Assistant message with tool input
    const assistantInput: ChatMessage = {
      id: "assistant-original",
      role: "assistant",
      parts: [
        {
          type: "tool-testTool",
          toolCallId: toolCallId,
          state: "input-available",
          input: { param: "value" }
        }
      ] as ChatMessage["parts"],
      metadata: {
        openai: { reasoning: { itemId: reasoningItemId } }
      }
    };

    await agentStub.persistMessages([userMessage, assistantInput]);

    // Verify initial state
    let messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(messages.length).toBe(2);

    // Second: Assistant message with tool output (from new stream, different ID)
    // The fix should recognize this as an UPDATE to the existing message
    const assistantOutput: ChatMessage = {
      id: "assistant-new-id-from-second-stream", // Different ID from second stream
      role: "assistant",
      parts: [
        {
          type: "tool-testTool",
          toolCallId: toolCallId, // SAME toolCallId
          state: "output-available",
          input: { param: "value" },
          output: "result"
        }
      ] as ChatMessage["parts"],
      metadata: {
        openai: { reasoning: { itemId: reasoningItemId } } // SAME reasoning itemId
      }
    };

    // This is where the fix needs to happen:
    // persistMessages should recognize that assistantOutput is an update
    // to assistantInput (based on matching toolCallId) and merge them
    await agentStub.persistMessages([userMessage, assistantOutput]);

    // Final verification
    messages = (await agentStub.getPersistedMessages()) as ChatMessage[];

    // Should still have only 2 messages
    expect(messages.length).toBe(2);

    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBe(1);

    // The tool part should have output-available state
    const finalAssistant = assistantMessages[0];
    const toolPart = finalAssistant.parts[0] as {
      type: string;
      state: string;
      output?: unknown;
    };
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toBe("result");

    ws.close();
  });

  it("CF_AGENT_TOOL_RESULT: server applies tool result to existing message", async () => {
    /**
     * This test verifies the new server-authoritative tool result flow:
     * 1. Server has an assistant message with tool call in "input-available" state
     * 2. Client sends CF_AGENT_TOOL_RESULT with toolCallId and output
     * 3. Server applies the result to the existing message (no duplicates)
     * 4. Server broadcasts CF_AGENT_MESSAGE_UPDATED to clients
     */
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

    const toolCallId = "call_tool_result_test";

    // User message
    const userMessage: ChatMessage = {
      id: "user-tool-result-test",
      role: "user",
      parts: [{ type: "text", text: "Execute tool" }]
    };

    // Assistant message with tool in input-available state
    const assistantWithTool: ChatMessage = {
      id: "assistant-tool-result-test",
      role: "assistant",
      parts: [
        {
          type: "tool-testTool",
          toolCallId: toolCallId,
          state: "input-available",
          input: { param: "value" }
        }
      ] as ChatMessage["parts"]
    };

    // Persist initial messages
    await agentStub.persistMessages([userMessage, assistantWithTool]);

    // Verify initial state
    let messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(messages.length).toBe(2);

    const initialAssistant = messages.find((m) => m.role === "assistant");
    const initialToolPart = initialAssistant?.parts[0] as {
      state: string;
      output?: unknown;
    };
    expect(initialToolPart.state).toBe("input-available");
    expect(initialToolPart.output).toBeUndefined();

    // Now simulate sending CF_AGENT_TOOL_RESULT via WebSocket
    // This is what the client does when a client-side tool executes
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId: toolCallId,
        toolName: "testTool",
        output: { success: true, data: "tool result" }
      })
    );

    // Wait for the server to process
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify the message was updated, not duplicated
    messages = (await agentStub.getPersistedMessages()) as ChatMessage[];

    // Should still have exactly 2 messages
    expect(messages.length).toBe(2);

    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBe(1);

    // The tool part should now have output-available state
    const finalAssistant = assistantMessages[0];
    expect(finalAssistant.id).toBe("assistant-tool-result-test");

    const finalToolPart = finalAssistant.parts[0] as {
      state: string;
      output?: unknown;
    };
    expect(finalToolPart.state).toBe("output-available");
    expect(finalToolPart.output).toEqual({
      success: true,
      data: "tool result"
    });

    ws.close();
  });
});
