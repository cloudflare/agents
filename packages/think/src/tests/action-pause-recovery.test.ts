import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

async function freshPauseAgent(name: string) {
  return getAgentByName(env.ThinkToolsTestAgent, name);
}

type PausedOutput = {
  status?: string;
  executionId?: string;
  action?: string;
};

/**
 * action-pause × recovery: a parked durable-pause action (awaiting human
 * approval) and an active chat-recovery incident from a SEPARATE interrupted
 * turn must coexist. A durable pause is a settled `output-available` part, NOT a
 * client interaction, so `hasPendingInteraction()` stays false and recovery
 * proceeds normally without parking-for-interaction — and it must not sweep or
 * disturb the pending approval, which stays approvable once recovery settles.
 *
 * Existing coverage tests pause and recovery SEPARATELY (and the e2e covers a
 * deploy AFTER a park); this covers a pause that is live DURING an active
 * recovery incident.
 */
describe("action-pause during an active recovery incident", () => {
  it("a parked durable-pause is not seen as a pending interaction", async () => {
    const agent = await freshPauseAgent(
      `ap-rec-pending-${crypto.randomUUID()}`
    );
    await agent.useDurablePauseActionForTest();

    expect(await agent.hasPendingInteractionForTest()).toBe(false);
    await agent.parkDurablePauseForTest("world");
    // A durable pause parks as `output-available`, so recovery's
    // pending-interaction gate does NOT trip (it only fires for client tools /
    // `approval-requested`).
    expect(await agent.hasPendingInteractionForTest()).toBe(false);
  });

  it("an active recovery incident does not disturb a parked pause, which stays approvable", async () => {
    const agent = await freshPauseAgent(
      `ap-rec-survive-${crypto.randomUUID()}`
    );
    await agent.useDurablePauseActionForTest();

    // Park a durable-pause action awaiting human approval.
    const parked = (await agent.parkDurablePauseForTest(
      "world"
    )) as PausedOutput;
    expect(parked.status).toBe("paused");
    const executionId = parked.executionId ?? "";
    expect(await agent.listActionPendingForTest()).toHaveLength(1);
    expect(await agent.getDurablePauseExecCount()).toBe(0);

    // Now make an active recovery incident from a SEPARATE interrupted turn: a
    // user message whose turn never produced an assistant reply (pre-stream
    // eviction → retry path).
    await agent.persistTestMessage({
      id: "u-prior-interrupted",
      role: "user",
      parts: [{ type: "text", text: "an earlier unanswered question" }]
    });
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-ap-prior", {
      __cfThinkChatFiberSnapshot: {
        kind: "think-chat-turn",
        version: 1,
        requestId: "req-ap-prior",
        continuation: false,
        latestMessageId: "u-prior-interrupted",
        latestMessageRole: "user",
        latestUserMessageId: "u-prior-interrupted",
        startedAt: Date.now()
      },
      user: null
    });

    await agent.triggerFiberRecovery();
    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryRetry")
    ).toBe(1);
    await agent.runScheduledRecoveryRetryForTest();

    // Recovery ran the interrupted turn to completion (no leaked fiber)...
    expect(await agent.getActiveFibers()).toHaveLength(0);
    // ...without touching the parked pause: still pending, still not executed.
    const pendingAfter = await agent.listActionPendingForTest();
    expect(pendingAfter).toHaveLength(1);
    expect(pendingAfter[0]?.execution_id).toBe(executionId);
    expect(await agent.getDurablePauseExecCount()).toBe(0);

    // The pause is still approvable after recovery — executes exactly once.
    const result = await agent.approveExecutionForTest(executionId);
    expect(result).toBe("paused-exec: world");
    expect(await agent.getDurablePauseExecCount()).toBe(1);
    expect(await agent.listActionPendingForTest()).toHaveLength(0);
  });

  it("a CONTINUE recovery incident also leaves a parked pause approvable", async () => {
    const agent = await freshPauseAgent(
      `ap-rec-continue-${crypto.randomUUID()}`
    );
    await agent.useDurablePauseActionForTest();

    const parked = (await agent.parkDurablePauseForTest(
      "world"
    )) as PausedOutput;
    expect(parked.status).toBe("paused");
    const executionId = parked.executionId ?? "";
    expect(await agent.listActionPendingForTest()).toHaveLength(1);

    // A separate interrupted turn with a PARTIAL assistant reply → the
    // mid-stream `continue` recovery path (the other arm vs the retry test
    // above).
    await agent.persistTestMessage({
      id: "u-ap-continue",
      role: "user",
      parts: [{ type: "text", text: "an earlier partially-answered question" }]
    });
    await agent.persistTestMessage({
      id: "a-ap-continue",
      role: "assistant",
      parts: [{ type: "text", text: "Partial answer" }]
    });
    await agent.insertInterruptedStream(
      "stream-ap-continue",
      "req-ap-continue",
      [
        {
          body: JSON.stringify({ type: "start", messageId: "a-ap-continue" }),
          index: 0
        },
        { body: JSON.stringify({ type: "text-start" }), index: 1 },
        {
          body: JSON.stringify({ type: "text-delta", delta: "Partial answer" }),
          index: 2
        }
      ]
    );
    await agent.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-ap-continue",
      {
        __cfThinkChatFiberSnapshot: {
          kind: "think-chat-turn",
          version: 1,
          requestId: "req-ap-continue",
          continuation: false,
          latestMessageId: "a-ap-continue",
          latestMessageRole: "assistant",
          latestUserMessageId: "u-ap-continue",
          startedAt: Date.now()
        },
        user: null
      }
    );

    await agent.triggerFiberRecovery();
    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryContinue")
    ).toBe(1);
    await agent.runScheduledRecoveryContinueForTest();

    // Recovery settled the interrupted turn without disturbing the pause.
    expect(await agent.getActiveFibers()).toHaveLength(0);
    const pendingAfter = await agent.listActionPendingForTest();
    expect(pendingAfter).toHaveLength(1);
    expect(pendingAfter[0]?.execution_id).toBe(executionId);
    expect(await agent.getDurablePauseExecCount()).toBe(0);

    const result = await agent.approveExecutionForTest(executionId);
    expect(result).toBe("paused-exec: world");
    expect(await agent.getDurablePauseExecCount()).toBe(1);
  });
});
