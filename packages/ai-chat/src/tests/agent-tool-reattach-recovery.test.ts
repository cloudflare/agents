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
  agentToolRunWithFailingReaderForTest(): Promise<{
    afterCutOff: string | undefined;
    final: string | undefined;
    summary: string | undefined;
    readerCalls: number;
  }>;
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
      "req-reattach-continue"
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
    expect(reboundReqId).not.toBe("req-reattach-continue");
  });

  it("re-binds the child-run request_id on a RETRY recovery so frames stay attributable", async () => {
    const agent = await getStub(`reattach-retry-${crypto.randomUUID()}`);

    await agent.seedAgentToolChildRunForTest("run-retry", "req-reattach-retry");

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
    expect(reboundReqId).not.toBe("req-reattach-retry");
  });
});

describe("an agent-tool run whose reply is cut off in the isolate", () => {
  it("stays open while chat recovery finishes its turn, then ends completed with the continued reply", async () => {
    const agent = await getStub(`cut-off-run-${crypto.randomUUID()}`);
    const result = await agent.agentToolRunWithFailingReaderForTest();
    // Nobody cancelled the run: it is not aborted, and recovery is not
    // skipped as a cancel.
    expect(result.afterCutOff).toBe("running");
    expect(result.final).toBe("completed");
    expect(result.summary).toContain("Continued response.");
    expect(result.readerCalls).toBe(1);
  });

  // The run's input is the stored body only while the run's turn runs.
  for (const recovered of [false, true]) {
    it(`puts the chat's own request body back when the run is over (${recovered ? "recovered" : "live"} reply)`, async () => {
      const agent = await getStub(`body-${crypto.randomUUID()}`);
      const result = await (
        agent as unknown as {
          storedBodyAfterAgentToolRunForTest(recovered: boolean): Promise<{
            status: string | undefined;
            body: Record<string, unknown> | undefined;
          }>;
        }
      ).storedBodyAfterAgentToolRunForTest(recovered);
      expect(result.status).toBe("completed");
      expect(result.body).toEqual({ theme: "dark" });
    });
  }

  // `saveMessages` from `onChatResponse` is supported. The turn it starts
  // is not the run's, whether the run's reply completed live or recovered.
  for (const recovered of [false, true]) {
    it(`does not bind a turn started from onChatResponse to the run (${recovered ? "recovered" : "live"} reply)`, async () => {
      const agent = await getStub(`follow-up-${crypto.randomUUID()}`);
      const result = await (
        agent as unknown as {
          agentToolRunWithFollowUpTurnForTest(recovered: boolean): Promise<{
            status: string | undefined;
            rowIsFollowUp: boolean;
            followUpRan: boolean;
            followUpChunksInRun: number;
          }>;
        }
      ).agentToolRunWithFollowUpTurnForTest(recovered);
      expect(result.status).toBe("completed");
      expect(result.followUpRan).toBe(true);
      expect(result.rowIsFollowUp).toBe(false);
      expect(result.followUpChunksInRun).toBe(0);
    });
  }

  // The stop cancels the turn's recovery, so nothing is left to finish the
  // run: the stop is its outcome, and the parent's tail closes.
  for (const how of ["client-cancel", "abortRequest", "abortAllRequests"]) {
    it(`is settled aborted when its request is stopped (${how})`, async () => {
      const agent = await getStub(`stopped-run-${crypto.randomUUID()}`);
      const result = await (
        agent as unknown as {
          stopLeftOpenAgentToolRunForTest(how: string): Promise<{
            beforeStop: string | undefined;
            status: string | undefined;
            error: string | undefined;
            tailClosed: boolean;
            readerCalls: number;
          }>;
        }
      ).stopLeftOpenAgentToolRunForTest(how);
      expect(result.beforeStop).toBe("running");
      expect(result.status).toBe("aborted");
      expect(result.tailClosed).toBe(true);
      // The reply is not read again for the stopped run.
      expect(result.readerCalls).toBe(0);
      if (how !== "client-cancel") expect(result.error).toBe("stopped");
    });
  }
});
