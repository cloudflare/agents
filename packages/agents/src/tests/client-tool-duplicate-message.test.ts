import { createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { type Env } from "./worker";
import type { UIMessage as ChatMessage } from "ai";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

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
});
