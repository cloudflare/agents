import { env } from "cloudflare:workers";
import type { UIMessage as ChatMessage } from "ai";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { MessageType } from "../types";
import { connectChatWS } from "./test-utils";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendChatRequest(
  ws: WebSocket,
  requestId: string,
  messages: ChatMessage[],
  extraBody?: Record<string, unknown>
) {
  ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
      id: requestId,
      init: {
        method: "POST",
        body: JSON.stringify({ messages, ...extraBody })
      }
    })
  );
}

const firstUserMessage: ChatMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "Hello" }]
};

describe("AIChatAgent pending interaction helpers", () => {
  it("detects pending tool interactions on the latest assistant message", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.TestChatAgent, room);

    expect(await agentStub.hasPendingInteractionForTest()).toBe(false);

    await agentStub.testPersistToolCall("assistant-input", "chooseOption");
    expect(await agentStub.hasPendingInteractionForTest()).toBe(true);

    await agentStub.testPersistToolResult(
      "assistant-input",
      "chooseOption",
      "resolved"
    );
    expect(await agentStub.hasPendingInteractionForTest()).toBe(false);

    await agentStub.testPersistApprovalRequest(
      "assistant-approval",
      "chooseOption"
    );
    expect(await agentStub.hasPendingInteractionForTest()).toBe(true);
  });

  it("treats older pending assistant messages as unresolved interactions", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const pendingAssistant: ChatMessage = {
      id: "assistant-older",
      role: "assistant",
      parts: [
        {
          type: "tool-chooseOption",
          toolCallId: "call_older",
          state: "approval-requested",
          input: { choice: "A" },
          approval: { id: "approval_older" }
        }
      ] as ChatMessage["parts"]
    };

    const resolvedAssistant: ChatMessage = {
      id: "assistant-newer",
      role: "assistant",
      parts: [
        {
          type: "tool-chooseOption",
          toolCallId: "call_newer",
          state: "output-available",
          input: { choice: "B" },
          output: "done"
        }
      ] as ChatMessage["parts"]
    };

    await agentStub.persistMessages([pendingAssistant, resolvedAssistant]);

    expect(await agentStub.hasPendingInteractionForTest()).toBe(true);
  });

  it("returns false when pending interaction does not resolve before timeout", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.TestChatAgent, room);

    await agentStub.testPersistToolCall("assistant-timeout", "chooseOption");

    await expect(
      agentStub.waitUntilStableForTest({ timeout: 100 })
    ).resolves.toBe(false);

    expect(await agentStub.hasPendingInteractionForTest()).toBe(true);
  });

  it("resolves immediately when nothing is pending", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.TestChatAgent, room);

    await expect(
      agentStub.waitUntilStableForTest({ timeout: 500 })
    ).resolves.toBe(true);
  });

  it("resolves after a tool result is applied via WebSocket", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await delay(50);

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Persist a tool call in input-available state
    const toolCallId = "call_pending_ws_test";
    await agentStub.persistMessages([
      {
        id: "assistant-pending-ws",
        role: "assistant",
        parts: [
          {
            type: "tool-chooseOption",
            toolCallId,
            state: "input-available",
            input: { choice: "A" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    expect(await agentStub.hasPendingInteractionForTest()).toBe(true);

    // Send tool result over WS — sets _pendingInteractionPromise
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId,
        toolName: "chooseOption",
        output: { choice: "A" },
        autoContinue: false
      })
    );

    // Wait for resolution — drains the apply promise and any continuation
    await expect(
      agentStub.waitUntilStableForTest({ timeout: 2000 })
    ).resolves.toBe(true);

    // Message state should now show tool output applied
    expect(await agentStub.hasPendingInteractionForTest()).toBe(false);

    ws.close(1000);
  });

  it("waits for an auto-continued turn to finish before resolving", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/slow-stream-agent/${room}`);
    await delay(50);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    sendChatRequest(ws, "req-prime-continuation", [firstUserMessage], {
      format: "plaintext",
      chunkCount: 10,
      chunkDelayMs: 40
    });

    await agentStub.waitForIdleForTest();

    await agentStub.persistToolCallMessage(
      "assistant-continuation",
      "call_continuation",
      "testTool"
    );

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId: "call_continuation",
        toolName: "testTool",
        output: { result: "ok" },
        autoContinue: true
      })
    );

    await delay(20);

    const waitPromise = agentStub.waitUntilStableForTest({
      timeout: 2000
    });

    await expect(
      Promise.race([
        waitPromise.then(() => "resolved"),
        delay(100).then(() => "pending")
      ])
    ).resolves.toBe("pending");

    await expect(waitPromise).resolves.toBe(true);
    expect(await agentStub.getStartedRequestIds()).toEqual([
      "req-prime-continuation",
      expect.any(String)
    ]);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(false);

    ws.close(1000);
  });

  it("resolves after a tool approval is applied via WebSocket", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await delay(50);

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    await agentStub.testPersistApprovalRequest(
      "assistant-approval-ws",
      "chooseOption"
    );

    expect(await agentStub.hasPendingInteractionForTest()).toBe(true);

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_APPROVAL,
        toolCallId: "call_assistant-approval-ws",
        approved: true,
        autoContinue: false
      })
    );

    await expect(
      agentStub.waitUntilStableForTest({ timeout: 2000 })
    ).resolves.toBe(true);

    expect(await agentStub.hasPendingInteractionForTest()).toBe(false);

    ws.close(1000);
  });

  it("returns false when an active turn does not finish before timeout", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/slow-stream-agent/${room}`);
    await delay(50);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    sendChatRequest(ws, "req-timeout-turn", [firstUserMessage], {
      format: "plaintext",
      useAbortSignal: true,
      chunkCount: 20,
      chunkDelayMs: 40
    });

    await delay(80);

    await expect(
      agentStub.waitUntilStableForTest({ timeout: 50 })
    ).resolves.toBe(false);

    agentStub.resetTurnStateForTest();
    await agentStub.waitForIdleForTest();

    ws.close(1000);
  });

  it("resetTurnState aborts the active turn and skips queued continuations", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/slow-stream-agent/${room}`);
    await delay(50);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    sendChatRequest(ws, "req-reset-turn", [firstUserMessage], {
      format: "plaintext",
      useAbortSignal: true,
      chunkCount: 12,
      chunkDelayMs: 40
    });

    await delay(80);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(true);

    await agentStub.persistToolCallMessage(
      "assistant-reset-tool",
      "call_reset_tool",
      "testTool"
    );

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId: "call_reset_tool",
        toolName: "testTool",
        output: { result: "ok" },
        autoContinue: true
      })
    );

    await delay(20);
    agentStub.resetTurnStateForTest();
    await agentStub.waitForIdleForTest();

    expect(await agentStub.getAbortControllerCount()).toBe(0);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(false);
    expect(await agentStub.getStartedRequestIds()).toEqual(["req-reset-turn"]);

    ws.close(1000);
  });
});
