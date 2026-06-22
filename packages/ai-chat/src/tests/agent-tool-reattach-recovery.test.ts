import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage as ChatMessage } from "ai";

/**
 * Parity with `@cloudflare/think`'s
 * `agent-tool-reattach-recovery.test.ts`: when an AIChatAgent facet running as
 * an agent-tool child is interrupted mid-run and recovers, its recovery turn
 * mints a NEW request id. If `cf_ai_chat_agent_tool_runs.request_id` is not
 * re-bound, the parent's re-attach tail can no longer attribute the recovered
 * turn's frames, so a healthy long-running child is abandoned as `interrupted`
 * once the no-progress budget elapses. The fix re-binds on both recovery paths.
 */
interface ReattachStub {
  seedAgentToolChildRunForTest(runId: string, requestId: string): Promise<void>;
  getAgentToolChildRunRequestIdForTest(runId: string): Promise<string | null>;
  resolveAgentToolRunForRequestForTest(
    requestId: string
  ): Promise<string | null>;
  persistMessages(messages: unknown[]): Promise<void>;
  insertInterruptedStream(
    streamId: string,
    requestId: string,
    chunks: Array<{ body: string; index: number }>
  ): Promise<void>;
  insertInterruptedFiber(name: string, snapshot?: unknown): Promise<void>;
  triggerFiberRecovery(): Promise<void>;
  runScheduledRecoveryContinueForTest(): Promise<void>;
  runScheduledRecoveryRetryForTest(): Promise<void>;
}

async function getStub(room: string): Promise<ReattachStub> {
  const stub = await getAgentByName(env.ChatRecoveryTestAgent, room);
  return stub as unknown as ReattachStub;
}

describe("agent-tool child re-attach: request_id rebinding across recovery", () => {
  it("re-binds the child-run request_id on a CONTINUE recovery so frames stay attributable", async () => {
    const agent = await getStub(`reattach-continue-${crypto.randomUUID()}`);

    await agent.seedAgentToolChildRunForTest(
      "run-continue",
      "old-req-continue"
    );

    await agent.persistMessages([
      {
        id: "u-reattach-continue",
        role: "user",
        parts: [{ type: "text", text: "do the long job" }]
      },
      {
        id: "a-reattach-continue",
        role: "assistant",
        parts: [{ type: "text", text: "Partial answer" }]
      }
    ] as ChatMessage[]);

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
        { body: JSON.stringify({ type: "text-start", id: "t" }), index: 1 },
        {
          body: JSON.stringify({
            type: "text-delta",
            id: "t",
            delta: "Partial answer"
          }),
          index: 2
        }
      ]
    );
    await agent.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-reattach-continue"
    );

    await agent.triggerFiberRecovery();
    await agent.runScheduledRecoveryContinueForTest();

    const reboundReqId =
      await agent.getAgentToolChildRunRequestIdForTest("run-continue");
    expect(reboundReqId).toBeTruthy();
    expect(reboundReqId).not.toBe("old-req-continue");
    expect(
      await agent.resolveAgentToolRunForRequestForTest(reboundReqId as string)
    ).toBe("run-continue");
  });

  it("re-binds the child-run request_id on a RETRY recovery so frames stay attributable", async () => {
    const agent = await getStub(`reattach-retry-${crypto.randomUUID()}`);

    await agent.seedAgentToolChildRunForTest("run-retry", "old-req-retry");

    await agent.persistMessages([
      {
        id: "u-reattach-retry",
        role: "user",
        parts: [{ type: "text", text: "do the long job" }]
      }
    ] as ChatMessage[]);

    await agent.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-reattach-retry",
      {
        __cfAIChatFiberSnapshot: {
          kind: "ai-chat-turn",
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
