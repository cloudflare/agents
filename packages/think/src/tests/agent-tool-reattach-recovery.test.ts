import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { ThinkRecoveryTestAgent } from "./agents/think-session";

async function freshRecoveryAgent(name: string) {
  return getServerByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    name
  );
}

/**
 * Re-attach budget regression (deterministic counterpart to the slow
 * `reattach-budget` e2e): when a facet running as an agent-tool child is
 * interrupted mid-run and recovers, its recovery turn mints a NEW request id.
 * If the `cf_agent_tool_child_runs.request_id` binding is not updated, the
 * parent's re-attach tail can no longer attribute the recovered turn's frames,
 * so a healthy, still-advancing child is abandoned as `interrupted` once the
 * no-progress budget elapses. The fix re-binds the row (and the in-memory
 * attribution map) on both recovery paths.
 */
describe("agent-tool child re-attach: request_id rebinding across recovery", () => {
  it("re-binds the child-run request_id on a CONTINUE recovery so frames stay attributable", async () => {
    const agent = await freshRecoveryAgent(
      `reattach-continue-${crypto.randomUUID()}`
    );

    await agent.seedAgentToolChildRunForTest(
      "run-continue",
      "old-req-continue"
    );

    await agent.persistTestMessage({
      id: "u-reattach-continue",
      role: "user",
      parts: [{ type: "text", text: "do the long job" }]
    });
    await agent.persistTestMessage({
      id: "a-reattach-continue",
      role: "assistant",
      parts: [{ type: "text", text: "Partial answer" }]
    });

    await agent.insertInterruptedStream(
      "stream-reattach-continue",
      "req-reattach-continue",
      [
        {
          body: JSON.stringify({
            type: "start",
            messageId: "a-reattach-continue"
          }),
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
      "__cf_internal_chat_turn:req-reattach-continue",
      {
        __cfThinkChatFiberSnapshot: {
          kind: "think-chat-turn",
          version: 1,
          requestId: "req-reattach-continue",
          continuation: false,
          latestMessageId: "a-reattach-continue",
          latestMessageRole: "assistant",
          latestUserMessageId: "u-reattach-continue",
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

    // The row's request_id moved off the pre-eviction turn to the recovery
    // turn's fresh id, and that id now attributes back to the run.
    const reboundReqId =
      await agent.getAgentToolChildRunRequestIdForTest("run-continue");
    expect(reboundReqId).toBeTruthy();
    expect(reboundReqId).not.toBe("old-req-continue");
    expect(
      await agent.resolveAgentToolRunForRequestForTest(reboundReqId as string)
    ).toBe("run-continue");
  });

  it("re-binds the child-run request_id on a RETRY recovery so frames stay attributable", async () => {
    const agent = await freshRecoveryAgent(
      `reattach-retry-${crypto.randomUUID()}`
    );

    await agent.seedAgentToolChildRunForTest("run-retry", "old-req-retry");

    await agent.persistTestMessage({
      id: "u-reattach-retry",
      role: "user",
      parts: [{ type: "text", text: "do the long job" }]
    });

    await agent.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-reattach-retry",
      {
        __cfThinkChatFiberSnapshot: {
          kind: "think-chat-turn",
          version: 1,
          requestId: "req-reattach-retry",
          continuation: false,
          latestMessageId: "u-reattach-retry",
          latestMessageRole: "user",
          latestUserMessageId: "u-reattach-retry",
          startedAt: Date.now()
        },
        user: null
      }
    );

    await agent.triggerFiberRecovery();
    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryRetry")
    ).toBe(1);
    await agent.runScheduledRecoveryRetryForTest();

    const reboundReqId =
      await agent.getAgentToolChildRunRequestIdForTest("run-retry");
    expect(reboundReqId).toBeTruthy();
    expect(reboundReqId).not.toBe("old-req-retry");
    expect(
      await agent.resolveAgentToolRunForRequestForTest(reboundReqId as string)
    ).toBe("run-retry");
  });
});
