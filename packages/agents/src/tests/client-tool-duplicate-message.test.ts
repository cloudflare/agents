import { createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { type Env } from "./worker";
import type { UIMessage as ChatMessage } from "ai";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Helper type for parts with providerMetadata
type PartWithMetadata = ChatMessage["parts"][number] & {
  providerMetadata?: {
    openai?: {
      itemId?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  callProviderMetadata?: {
    openai?: {
      itemId?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};

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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
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

    ws.close();
  });

  it("CF_AGENT_TOOL_RESULT applies tool result to existing message", async () => {
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

    // Send CF_AGENT_TOOL_RESULT via WebSocket
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId,
        toolName: "testTool",
        output: { success: true }
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    // Should have exactly 1 assistant message
    expect(assistantMessages.length).toBe(1);
    expect(assistantMessages[0].id).toBe("assistant-1");

    const toolPart = assistantMessages[0].parts[0] as {
      state: string;
      output?: unknown;
    };
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toEqual({ success: true });

    ws.close();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));

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

    ws.close();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));
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

    ws.close();
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

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));

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

    ws.close();
  });
});
