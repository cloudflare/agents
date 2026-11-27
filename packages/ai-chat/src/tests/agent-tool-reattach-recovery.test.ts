import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";

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

describe("an agent-tool run whose reply is cut off in the isolate", () => {
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
});
