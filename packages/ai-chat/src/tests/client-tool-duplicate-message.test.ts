import { createExecutionContext, env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, it, expect } from "vitest";
import worker from "./worker";
import type { UIMessage as ChatMessage } from "ai";
import { convertToModelMessages } from "ai";
import {
  applyChunkToParts,
  type MessageParts,
  type StreamChunkData
} from "../message-builder";

describe("Client-side tool duplicate message prevention", () => {
  it("merges tool output into existing message by toolCallId", async () => {
    const room = crypto.randomUUID();
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
    const toolCallId = "call_merge_test";

    // Persist assistant message with tool in input-available state
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Test" }]
      },
      {
        id: "assistant-original",
        role: "assistant",
        parts: [
          {
            type: "tool-testTool",
            toolCallId,
            state: "input-available",
            input: { param: "value" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    // Persist message with different ID but same toolCallId (simulates second stream)
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Test" }]
      },
      {
        id: "assistant-different-id",
        role: "assistant",
        parts: [
          {
            type: "tool-testTool",
            toolCallId,
            state: "output-available",
            input: { param: "value" },
            output: "result"
          }
        ] as ChatMessage["parts"]
      }
    ]);

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    // Should have exactly 1 assistant message (merged, not duplicated)
    expect(assistantMessages.length).toBe(1);
    const toolPart = assistantMessages[0].parts[0] as {
      state: string;
      output?: unknown;
    };
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toBe("result");

    ws.close(1000);
  });

  it("CF_AGENT_TOOL_RESULT applies tool result without auto-continuation by default", async () => {
    const room = crypto.randomUUID();
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
    const toolCallId = "call_tool_result_test";

    // Persist assistant message with tool in input-available state
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
            toolCallId,
            state: "input-available",
            input: { param: "value" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    // Send CF_AGENT_TOOL_RESULT via WebSocket WITHOUT autoContinue flag
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId,
        toolName: "testTool",
        output: { success: true }
        // autoContinue not set - should NOT auto-continue
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    // Should have exactly 1 assistant message (no auto-continuation)
    expect(assistantMessages.length).toBe(1);

    const assistantMsg = assistantMessages[0];
    expect(assistantMsg.id).toBe("assistant-1");

    // Tool result should be applied
    const toolPart = assistantMsg.parts[0] as {
      state: string;
      output?: unknown;
    };
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toEqual({ success: true });

    // No continuation parts (only the original tool part)
    expect(assistantMsg.parts.length).toBe(1);

    ws.close(1000);
  });

  it("CF_AGENT_TOOL_RESULT auto-continues and merges when autoContinue is true", async () => {
    const room = crypto.randomUUID();
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
    const toolCallId = "call_tool_result_auto_continue";

    // Persist assistant message with tool in input-available state
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
            toolCallId,
            state: "input-available",
            input: { param: "value" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    // Send CF_AGENT_TOOL_RESULT with autoContinue: true
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId,
        toolName: "testTool",
        output: { success: true },
        autoContinue: true
      })
    );

    // Wait for tool result to be applied and continuation to happen
    // Note: When there's no active stream, the continuation waits 500ms before proceeding
    await new Promise((resolve) => setTimeout(resolve, 800));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    // Should still have exactly 1 assistant message (continuation merged into it)
    expect(assistantMessages.length).toBe(1);

    const assistantMsg = assistantMessages[0];
    expect(assistantMsg.id).toBe("assistant-1");

    // First part should be the tool with result applied
    const toolPart = assistantMsg.parts[0] as {
      state: string;
      output?: unknown;
    };
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toEqual({ success: true });

    // Continuation parts should be appended (TestChatAgent returns text response)
    expect(assistantMsg.parts.length).toBeGreaterThan(1);

    ws.close(1000);
  });

  it("strips OpenAI itemIds from persisted messages to prevent duplicate errors", async () => {
    const room = crypto.randomUUID();
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

    // Persist message with OpenAI itemId in providerMetadata (simulates OpenAI Responses API)
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "Hello! How can I help?",
            providerMetadata: {
              openai: {
                itemId: "msg_abc123xyz" // This should be stripped
              }
            }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessage = messages.find((m) => m.role === "assistant");

    expect(assistantMessage).toBeDefined();
    const textPart = assistantMessage!.parts[0] as {
      type: string;
      text: string;
      providerMetadata?: {
        openai?: {
          itemId?: string;
        };
      };
    };

    // The itemId should have been stripped during persistence
    expect(textPart.text).toBe("Hello! How can I help?");
    expect(textPart.providerMetadata?.openai?.itemId).toBeUndefined();

    ws.close(1000);
  });

  it("strips OpenAI itemIds from tool parts with callProviderMetadata", async () => {
    const room = crypto.randomUUID();
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
    const toolCallId = "call_openai_strip_test";

    // Persist message with tool that has OpenAI itemId in callProviderMetadata
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "What time is it?" }]
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-getTime",
            toolCallId,
            state: "input-available",
            input: { timezone: "UTC" },
            callProviderMetadata: {
              openai: {
                itemId: "fc_xyz789" // This should be stripped
              }
            }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessage = messages.find((m) => m.role === "assistant");

    expect(assistantMessage).toBeDefined();
    const toolPart = assistantMessage!.parts[0] as {
      type: string;
      toolCallId: string;
      callProviderMetadata?: {
        openai?: {
          itemId?: string;
        };
      };
    };

    // The itemId should have been stripped during persistence
    expect(toolPart.toolCallId).toBe(toolCallId);
    expect(toolPart.callProviderMetadata?.openai?.itemId).toBeUndefined();

    ws.close(1000);
  });

  it("preserves other providerMetadata when stripping itemId", async () => {
    const room = crypto.randomUUID();
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

    // Persist message with other metadata alongside itemId
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "Hello!",
            providerMetadata: {
              openai: {
                itemId: "msg_strip_me", // Should be stripped
                someOtherField: "keep_me" // Should be preserved
              },
              anthropic: {
                someField: "also_keep_me" // Should be preserved
              }
            }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessage = messages.find((m) => m.role === "assistant");

    expect(assistantMessage).toBeDefined();
    const textPart = assistantMessage!.parts[0] as {
      type: string;
      providerMetadata?: {
        openai?: {
          itemId?: string;
          someOtherField?: string;
        };
        anthropic?: {
          someField?: string;
        };
      };
    };

    // itemId should be stripped
    expect(textPart.providerMetadata?.openai?.itemId).toBeUndefined();
    // Other fields should be preserved
    expect(textPart.providerMetadata?.openai?.someOtherField).toBe("keep_me");
    expect(textPart.providerMetadata?.anthropic?.someField).toBe(
      "also_keep_me"
    );

    ws.close(1000);
  });

  it("filters out empty reasoning parts to prevent AI SDK warnings", async () => {
    const room = crypto.randomUUID();
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

    // Persist message with empty reasoning part (simulates OpenAI Responses API)
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Think about this" }]
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "reasoning",
            text: "", // Empty reasoning - should be filtered out
            providerMetadata: {
              openai: {
                reasoningEncryptedContent: null
              }
            }
          },
          {
            type: "text",
            text: "Here is my response"
          }
        ] as ChatMessage["parts"]
      }
    ]);

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessage = messages.find((m) => m.role === "assistant");

    expect(assistantMessage).toBeDefined();
    // Empty reasoning part should have been filtered out
    expect(assistantMessage!.parts.length).toBe(1);
    expect(assistantMessage!.parts[0].type).toBe("text");

    ws.close(1000);
  });

  it("preserves non-empty reasoning parts", async () => {
    const room = crypto.randomUUID();
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

    // Persist message with non-empty reasoning part
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Think about this" }]
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "reasoning",
            text: "Let me think about this carefully...", // Non-empty - should be kept
            providerMetadata: {
              openai: {
                itemId: "reason_123" // But itemId should still be stripped
              }
            }
          },
          {
            type: "text",
            text: "Here is my response"
          }
        ] as ChatMessage["parts"]
      }
    ]);

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessage = messages.find((m) => m.role === "assistant");

    expect(assistantMessage).toBeDefined();
    // Non-empty reasoning part should be preserved
    expect(assistantMessage!.parts.length).toBe(2);
    expect(assistantMessage!.parts[0].type).toBe("reasoning");

    const reasoningPart = assistantMessage!.parts[0] as {
      type: string;
      text: string;
      providerMetadata?: {
        openai?: {
          itemId?: string;
        };
      };
    };
    expect(reasoningPart.text).toBe("Let me think about this carefully...");
    // itemId should still be stripped
    expect(reasoningPart.providerMetadata?.openai?.itemId).toBeUndefined();

    ws.close(1000);
  });
});

describe("Tool approval (needsApproval) duplicate message prevention", () => {
  it("CF_AGENT_TOOL_APPROVAL updates existing message in place", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_approval_test";

    // Persist assistant message with tool in input-available state (needs approval)
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
            toolCallId,
            state: "input-available",
            input: { param: "value" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    // Send CF_AGENT_TOOL_APPROVAL via WebSocket
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId,
        approved: true
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    // Should have exactly 1 assistant message (updated in place, not duplicated)
    expect(assistantMessages.length).toBe(1);

    const assistantMsg = assistantMessages[0];
    // Message ID should be preserved
    expect(assistantMsg.id).toBe("assistant-1");

    // Tool state should be updated to approval-responded
    const toolPart = assistantMsg.parts[0] as {
      state: string;
      approval?: { approved: boolean };
    };
    expect(toolPart.state).toBe("approval-responded");
    expect(toolPart.approval).toEqual({ approved: true });

    ws.close(1000);
  });

  it("CF_AGENT_TOOL_APPROVAL handles rejection (approved: false)", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_rejection_test";

    // Persist assistant message with tool in input-available state
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
            toolCallId,
            state: "input-available",
            input: { param: "value" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    // Send CF_AGENT_TOOL_APPROVAL with approved: false (rejection)
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId,
        approved: false
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    expect(assistantMessages.length).toBe(1);

    const toolPart = assistantMessages[0].parts[0] as {
      state: string;
      approval?: { approved: boolean };
    };
    expect(toolPart.state).toBe("output-denied");
    expect(toolPart.approval).toEqual({ approved: false });

    ws.close(1000);
  });

  it("CF_AGENT_TOOL_APPROVAL updates tool in approval-requested state", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_approval_requested_test";

    // Persist assistant message with tool in approval-requested state
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
            toolCallId,
            state: "approval-requested",
            input: { param: "value" },
            approval: { id: "approval-123" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    // Send CF_AGENT_TOOL_APPROVAL
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId,
        approved: true
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    expect(assistantMessages.length).toBe(1);

    const toolPart = assistantMessages[0].parts[0] as {
      state: string;
      approval?: { approved: boolean };
    };
    expect(toolPart.state).toBe("approval-responded");
    // approval.id is preserved from the approval-requested state
    expect(toolPart.approval).toEqual({ id: "approval-123", approved: true });

    ws.close(1000);
  });

  it("CF_AGENT_TOOL_APPROVAL rejection from approval-requested sets output-denied", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_approval_requested_rejected";

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
            toolCallId,
            state: "approval-requested",
            input: { param: "value" },
            approval: { id: "approval-789" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId,
        approved: false
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    expect(assistantMessages.length).toBe(1);

    const toolPart = assistantMessages[0].parts[0] as {
      state: string;
      approval?: { id: string; approved: boolean };
    };
    expect(toolPart.state).toBe("output-denied");
    expect(toolPart.approval).toEqual({ id: "approval-789", approved: false });

    ws.close(1000);
  });

  it("CF_AGENT_TOOL_APPROVAL with non-existent toolCallId logs warning", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));

    // Persist a message without any tool calls
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Hi there!" }] as ChatMessage["parts"]
      }
    ]);

    // Send CF_AGENT_TOOL_APPROVAL for non-existent tool
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId: "non_existent_tool_call",
        approved: true
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 1200)); // Wait for retries (10 * 100ms + buffer)

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];

    // Messages should remain unchanged (no crash, graceful handling)
    expect(messages.length).toBe(2);
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.parts[0]).toEqual({ type: "text", text: "Hi there!" });

    ws.close(1000);
  });

  it("CF_AGENT_TOOL_APPROVAL does not update tool already in output-available state", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_already_completed";

    // Persist assistant message with tool already in output-available state
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
            toolCallId,
            state: "output-available",
            input: { param: "value" },
            output: { result: "done" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    // Send CF_AGENT_TOOL_APPROVAL for tool that's already completed
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId,
        approved: true
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    expect(assistantMessages.length).toBe(1);

    // State should remain output-available (not changed to approval-responded)
    const toolPart = assistantMessages[0].parts[0] as {
      state: string;
      output?: unknown;
    };
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toEqual({ result: "done" });

    ws.close(1000);
  });
});

describe("Tool approval auto-continuation (needsApproval)", () => {
  it("CF_AGENT_TOOL_APPROVAL without autoContinue does NOT trigger continuation", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_no_auto_continue";

    // Persist assistant message with tool in input-available state
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
            toolCallId,
            state: "input-available",
            input: { param: "value" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    // Send approval WITHOUT autoContinue
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId,
        approved: true
        // no autoContinue
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 800));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    // Should have exactly 1 assistant message (no continuation)
    expect(assistantMessages.length).toBe(1);

    const assistantMsg = assistantMessages[0];
    expect(assistantMsg.id).toBe("assistant-1");

    // Tool state should be approval-responded but no continuation parts
    const toolPart = assistantMsg.parts[0] as {
      state: string;
      approval?: { approved: boolean };
    };
    expect(toolPart.state).toBe("approval-responded");
    expect(toolPart.approval).toEqual({ approved: true });
    expect(assistantMsg.parts.length).toBe(1);

    ws.close(1000);
  });

  it("CF_AGENT_TOOL_APPROVAL with autoContinue triggers continuation", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_auto_continue_approval";

    // Persist assistant message with tool in input-available state
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
            toolCallId,
            state: "input-available",
            input: { param: "value" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    // Send approval WITH autoContinue: true
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId,
        approved: true,
        autoContinue: true
      })
    );

    // Wait for approval + continuation (500ms wait + stream)
    await new Promise((resolve) => setTimeout(resolve, 800));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    // Should still have 1 assistant message (continuation merged into it)
    expect(assistantMessages.length).toBe(1);

    const assistantMsg = assistantMessages[0];
    expect(assistantMsg.id).toBe("assistant-1");

    // First part should be the approved tool
    const toolPart = assistantMsg.parts[0] as {
      state: string;
      approval?: { approved: boolean };
    };
    expect(toolPart.state).toBe("approval-responded");
    expect(toolPart.approval).toEqual({ approved: true });

    // Continuation parts should be appended (TestChatAgent returns text response)
    expect(assistantMsg.parts.length).toBeGreaterThan(1);

    ws.close(1000);
  });

  it("CF_AGENT_TOOL_APPROVAL with approved: false and autoContinue triggers continuation", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_rejected_continue";

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
            toolCallId,
            state: "input-available",
            input: { param: "value" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId,
        approved: false,
        autoContinue: true
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 800));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    expect(assistantMessages.length).toBe(1);

    const assistantMsg = assistantMessages[0];
    const toolPart = assistantMsg.parts[0] as {
      state: string;
      approval?: { approved: boolean };
    };
    expect(toolPart.state).toBe("output-denied");
    expect(toolPart.approval).toEqual({ approved: false });

    // Continuation parts should be appended (LLM sees denial and responds)
    expect(assistantMsg.parts.length).toBeGreaterThan(1);

    ws.close(1000);
  });

  it("CF_AGENT_TOOL_APPROVAL with autoContinue on approval-requested state triggers continuation", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_approval_requested_continue";

    // Persist assistant message with tool in approval-requested state
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
            toolCallId,
            state: "approval-requested",
            input: { param: "value" },
            approval: { id: "approval-456" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    // Send approval with autoContinue
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId,
        approved: true,
        autoContinue: true
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 800));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    expect(assistantMessages.length).toBe(1);

    const assistantMsg = assistantMessages[0];

    // Tool part should be updated
    const toolPart = assistantMsg.parts[0] as {
      state: string;
      approval?: { approved: boolean };
    };
    expect(toolPart.state).toBe("approval-responded");
    expect(toolPart.approval).toEqual({ id: "approval-456", approved: true });

    // Continuation should have appended parts
    expect(assistantMsg.parts.length).toBeGreaterThan(1);

    ws.close(1000);
  });
});

describe("applyChunkToParts: tool-approval-request", () => {
  it("transitions tool part from input-available to approval-requested", () => {
    const parts: MessageParts = [
      {
        type: "tool-calculate",
        toolCallId: "call_123",
        toolName: "calculate",
        state: "input-available",
        input: { a: 5000, b: 3, operator: "*" }
      } as MessageParts[number]
    ];

    const handled = applyChunkToParts(parts, {
      type: "tool-approval-request",
      approvalId: "approval-abc",
      toolCallId: "call_123"
    } as StreamChunkData);

    expect(handled).toBe(true);
    const part = parts[0] as Record<string, unknown>;
    expect(part.state).toBe("approval-requested");
    expect(part.approval).toEqual({ id: "approval-abc" });
    // Input should be preserved
    expect(part.input).toEqual({ a: 5000, b: 3, operator: "*" });
  });

  it("does nothing if tool part not found", () => {
    const parts: MessageParts = [];

    const handled = applyChunkToParts(parts, {
      type: "tool-approval-request",
      approvalId: "approval-abc",
      toolCallId: "call_nonexistent"
    } as StreamChunkData);

    expect(handled).toBe(true);
    expect(parts.length).toBe(0);
  });
});

describe("applyChunkToParts: tool-output-denied", () => {
  it("transitions tool part to output-denied state", () => {
    const parts: MessageParts = [
      {
        type: "tool-calculate",
        toolCallId: "call_456",
        toolName: "calculate",
        state: "approval-requested",
        input: { a: 5000, b: 3, operator: "*" },
        approval: { id: "approval-xyz" }
      } as MessageParts[number]
    ];

    const handled = applyChunkToParts(parts, {
      type: "tool-output-denied",
      toolCallId: "call_456"
    } as StreamChunkData);

    expect(handled).toBe(true);
    const part = parts[0] as Record<string, unknown>;
    expect(part.state).toBe("output-denied");
    // Input and approval should be preserved
    expect(part.input).toEqual({ a: 5000, b: 3, operator: "*" });
    expect(part.approval).toEqual({ id: "approval-xyz" });
  });
});

describe("Tool approval persistence across reconnect", () => {
  it("persisted messages include approval-requested state after approval-request chunk", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_persist_approval_test";

    // Manually persist messages that simulate the state after
    // a tool-approval-request was received and early-persisted.
    // In a real flow, the streaming handler would do this.
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Calculate 5000 * 3" }]
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-calculate",
            toolCallId,
            state: "approval-requested",
            input: { a: 5000, b: 3, operator: "*" },
            approval: { id: "approval-persist-test" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    // Verify the messages were persisted with approval-requested state
    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBe(1);

    const toolPart = assistantMessages[0].parts[0] as Record<string, unknown>;
    expect(toolPart.state).toBe("approval-requested");
    expect(toolPart.approval).toEqual({ id: "approval-persist-test" });

    // Now simulate a client reconnecting and approving the tool.
    // A new client would receive these persisted messages and see the approval UI.
    // When they approve, CF_AGENT_TOOL_APPROVAL is sent.
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId,
        approved: true
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const updatedMessages =
      (await agentStub.getPersistedMessages()) as ChatMessage[];
    const updatedAssistant = updatedMessages.filter(
      (m) => m.role === "assistant"
    );
    expect(updatedAssistant.length).toBe(1);

    const updatedToolPart = updatedAssistant[0].parts[0] as Record<
      string,
      unknown
    >;
    expect(updatedToolPart.state).toBe("approval-responded");
    // approval.id preserved from the approval-requested state
    expect(updatedToolPart.approval).toEqual({
      id: "approval-persist-test",
      approved: true
    });

    ws.close(1000);
  });
});

describe("Tool approval denial produces tool_result via convertToModelMessages", () => {
  it("rejected approval yields tool-result in model messages (required by Anthropic)", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_e2e_denied";

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Run the tool" }]
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-testTool",
            toolCallId,
            state: "approval-requested",
            input: { param: "value" },
            approval: { id: "approval-e2e" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId,
        approved: false
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const modelMessages = await convertToModelMessages(messages);

    const toolMessage = modelMessages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();

    const toolContent = toolMessage!.content as Array<{
      type: string;
      [key: string]: unknown;
    }>;

    const approvalResponse = toolContent.find(
      (c) => c.type === "tool-approval-response"
    );
    expect(approvalResponse).toBeDefined();
    expect(approvalResponse!.approved).toBe(false);

    const toolResult = toolContent.find((c) => c.type === "tool-result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.toolCallId).toBe(toolCallId);
    expect(toolResult!.toolName).toBe("testTool");

    ws.close(1000);
  });
});

describe("CF_AGENT_TOOL_RESULT with approval states and output-error", () => {
  it("applies tool result to a tool in approval-requested state", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_approval_tool_result";

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
            toolCallId,
            state: "approval-requested",
            input: { param: "value" },
            approval: { id: "approval-tr-1" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId,
        toolName: "testTool",
        output: { result: "done" }
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    expect(assistantMessages.length).toBe(1);

    const toolPart = assistantMessages[0].parts[0] as {
      state: string;
      output?: unknown;
    };
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toEqual({ result: "done" });

    ws.close(1000);
  });

  it("sets output-error state with errorText via CF_AGENT_TOOL_RESULT", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_output_error";

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
            toolCallId,
            state: "approval-requested",
            input: { param: "value" },
            approval: { id: "approval-err-1" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId,
        toolName: "testTool",
        output: null,
        state: "output-error",
        errorText: "User declined: not authorized"
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    expect(assistantMessages.length).toBe(1);

    const toolPart = assistantMessages[0].parts[0] as {
      state: string;
      errorText?: string;
    };
    expect(toolPart.state).toBe("output-error");
    expect(toolPart.errorText).toBe("User declined: not authorized");

    ws.close(1000);
  });

  it("output-error produces tool_result with custom errorText in model messages", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_e2e_error";

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Run the tool" }]
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-testTool",
            toolCallId,
            state: "input-available",
            input: { param: "value" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId,
        toolName: "testTool",
        output: null,
        state: "output-error",
        errorText: "Denied: insufficient permissions"
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const modelMessages = await convertToModelMessages(messages);

    const toolMessage = modelMessages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();

    const toolContent = toolMessage!.content as Array<{
      type: string;
      [key: string]: unknown;
    }>;

    const toolResult = toolContent.find((c) => c.type === "tool-result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.toolCallId).toBe(toolCallId);

    const output = toolResult!.output as { type: string; value: string };
    expect(output.type).toBe("error-text");
    expect(output.value).toBe("Denied: insufficient permissions");

    ws.close(1000);
  });

  it("CF_AGENT_TOOL_RESULT does not update tool already in output-denied state", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_already_denied";

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
            toolCallId,
            state: "output-denied",
            input: { param: "value" },
            approval: { id: "approval-denied-guard", approved: false }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId,
        toolName: "testTool",
        output: { result: "override attempt" }
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    expect(assistantMessages.length).toBe(1);

    const toolPart = assistantMessages[0].parts[0] as {
      state: string;
    };
    expect(toolPart.state).toBe("output-denied");

    ws.close(1000);
  });

  it("CF_AGENT_TOOL_RESULT does not update tool already in output-available state", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_already_completed_tr";

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
            toolCallId,
            state: "output-available",
            input: { param: "value" },
            output: { result: "original" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId,
        toolName: "testTool",
        output: { result: "override attempt" }
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    expect(assistantMessages.length).toBe(1);

    const toolPart = assistantMessages[0].parts[0] as {
      state: string;
      output?: unknown;
    };
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toEqual({ result: "original" });

    ws.close(1000);
  });

  it("applies tool result to a tool in approval-responded state", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_responded_tool_result";

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
            toolCallId,
            state: "approval-responded",
            input: { param: "value" },
            approval: { id: "approval-resp-1", approved: true }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId,
        toolName: "testTool",
        output: { result: "custom result" }
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    expect(assistantMessages.length).toBe(1);

    const toolPart = assistantMessages[0].parts[0] as {
      state: string;
      output?: unknown;
    };
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toEqual({ result: "custom result" });

    ws.close(1000);
  });

  it("output-error without errorText uses default message", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_default_error";

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
            toolCallId,
            state: "input-available",
            input: { param: "value" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId,
        toolName: "testTool",
        output: null,
        state: "output-error"
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    expect(assistantMessages.length).toBe(1);

    const toolPart = assistantMessages[0].parts[0] as {
      state: string;
      errorText?: string;
    };
    expect(toolPart.state).toBe("output-error");
    expect(toolPart.errorText).toBe("Tool execution denied by user");

    ws.close(1000);
  });

  it("output-error on approval-responded produces tool_result via convertToModelMessages", async () => {
    const room = crypto.randomUUID();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
    const toolCallId = "call_e2e_responded_error";

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Run the tool" }]
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-testTool",
            toolCallId,
            state: "approval-responded",
            input: { param: "value" },
            approval: { id: "approval-e2e-2", approved: true }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId,
        toolName: "testTool",
        output: null,
        state: "output-error",
        errorText: "Execution failed: timeout"
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const modelMessages = await convertToModelMessages(messages);

    const toolMessage = modelMessages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();

    const toolContent = toolMessage!.content as Array<{
      type: string;
      [key: string]: unknown;
    }>;

    const toolResult = toolContent.find((c) => c.type === "tool-result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.toolCallId).toBe(toolCallId);

    const output = toolResult!.output as { type: string; value: string };
    expect(output.type).toBe("error-text");
    expect(output.value).toBe("Execution failed: timeout");

    ws.close(1000);
  });
});
