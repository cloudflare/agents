import { env } from "cloudflare:workers";
import type { UIMessage as ChatMessage } from "ai";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";

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

  it("waits for pending interaction resolution", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.TestChatAgent, room);

    await agentStub.testPersistApprovalRequest(
      "assistant-pending",
      "chooseOption"
    );

    const waitPromise = agentStub.waitForPendingInteractionResolutionForTest({
      timeout: 1000,
      pollInterval: 25
    });

    setTimeout(() => {
      void agentStub.testPersistToolResult(
        "assistant-pending",
        "chooseOption",
        "approved"
      );
    }, 100);

    await expect(waitPromise).resolves.toBe(true);
    expect(await agentStub.hasPendingInteractionForTest()).toBe(false);
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
      agentStub.waitForPendingInteractionResolutionForTest({
        timeout: 100,
        pollInterval: 25
      })
    ).resolves.toBe(false);

    expect(await agentStub.hasPendingInteractionForTest()).toBe(true);
  });
});
