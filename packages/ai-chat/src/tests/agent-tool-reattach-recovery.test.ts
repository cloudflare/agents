import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";

/** An AIChatAgent agent-tool child whose run's reply is cut off and recovered. */
async function getStub(room: string) {
  return getAgentByName(env.ChatRecoveryTestAgent, room);
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
