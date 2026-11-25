import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

type StopOptions = {
  entry: "saveMessages" | "continueLastTurn" | "abortRequest";
  phase: "before-response" | "stream" | "error-chunk";
  reason: "none" | "string" | "error";
};

type StopResult = {
  status: string;
  responses: string[];
  onErrorCalls: string[];
  errorFrames: number;
};

async function stopTurn(options: StopOptions): Promise<StopResult> {
  const agent = (await getAgentByName(
    env.SlowStreamAgent,
    crypto.randomUUID()
  )) as unknown as {
    stopWithReasonForTest(o: StopOptions): Promise<StopResult>;
  };
  return agent.stopWithReasonForTest(options);
}

// A turn whose own signal aborted ends aborted, whatever the abort's reason
// was and whatever `onChatMessage` or its stream threw because of it.
describe("a stopped turn ends aborted, whatever reason the stop carried", () => {
  const entries = ["saveMessages", "continueLastTurn", "abortRequest"] as const;
  const phases = ["before-response", "stream", "error-chunk"] as const;
  const reasons = ["none", "string", "error"] as const;
  for (const entry of entries) {
    for (const phase of phases) {
      for (const reason of reasons) {
        it(`${entry}, stopped at ${phase}, reason: ${reason}`, async () => {
          const result = await stopTurn({ entry, phase, reason });
          expect(result).toMatchObject({
            status: "aborted",
            onErrorCalls: [],
            errorFrames: 0
          });
          expect(result.responses.filter((s) => s === "error")).toEqual([]);
        });
      }
    }
  }
});
