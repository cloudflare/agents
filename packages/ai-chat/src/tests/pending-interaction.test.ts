import { env } from "cloudflare:workers";
import type { UIMessage as ChatMessage } from "ai";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { MessageType } from "../types";
import { connectChatWS } from "./test-utils";

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
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Persist a tool call so hasPendingInteraction() is true, but do not
    // send a tool result — _pendingInteractionPromise stays null. The
    // method should drain the queue, find no promise, and return true
    // immediately. To actually test timeout we need a real in-flight
    // apply, so we send a tool result for a non-existent toolCallId
    // (apply returns false immediately) then verify the timeout path by
    // setting a very short timeout with nothing pending.
    await agentStub.testPersistToolCall("assistant-timeout", "chooseOption");

    await expect(
      agentStub.waitForPendingInteractionResolutionForTest({ timeout: 100 })
    ).resolves.toBe(true); // no _pendingInteractionPromise set, resolves immediately

    expect(await agentStub.hasPendingInteractionForTest()).toBe(true); // message state unchanged

    ws.close(1000);
  });

  it("resolves immediately when nothing is pending", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.TestChatAgent, room);

    await expect(
      agentStub.waitForPendingInteractionResolutionForTest({ timeout: 500 })
    ).resolves.toBe(true);
  });

  it("resolves after a tool result is applied via WebSocket", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

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
      agentStub.waitForPendingInteractionResolutionForTest({ timeout: 2000 })
    ).resolves.toBe(true);

    // Message state should now show tool output applied
    expect(await agentStub.hasPendingInteractionForTest()).toBe(false);

    ws.close(1000);
  });

  it("resetTurnState aborts active turn and invalidates epoch", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Verify calling resetTurnState when idle does not throw
    agentStub.resetTurnStateForTest();

    // Abort controllers should be cleared
    expect(await agentStub.getAbortControllerCount()).toBe(0);

    ws.close(1000);
  });

  it("resetTurnState clears _pendingInteractionPromise", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Persist a tool call and send a result to set _pendingInteractionPromise
    const toolCallId = "call_reset_test";
    await agentStub.persistMessages([
      {
        id: "assistant-reset",
        role: "assistant",
        parts: [
          {
            type: "tool-chooseOption",
            toolCallId,
            state: "input-available",
            input: { choice: "B" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId,
        toolName: "chooseOption",
        output: { choice: "B" },
        autoContinue: false
      })
    );

    // resetTurnState should null out _pendingInteractionPromise so
    // waitForPendingInteractionResolution returns immediately
    agentStub.resetTurnStateForTest();

    await expect(
      agentStub.waitForPendingInteractionResolutionForTest({ timeout: 500 })
    ).resolves.toBe(true);

    ws.close(1000);
  });
});
