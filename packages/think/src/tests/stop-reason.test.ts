import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ThinkTestAgent } from "./agents";

type StopOptions = {
  entry:
    | "chat"
    | "saveMessages"
    | "continueLastTurn"
    | "abortRequest"
    | "agentTool";
  phase: "hook" | "connect" | "stream";
  reason: "none" | "string" | "error";
};

type StopResult = {
  status: string | null;
  done: boolean;
  error: string | null;
  responses: string[];
  chatErrors: string[];
  agentErrors: string[];
  errorFrames: number;
  failedEvents: number;
  terminalOutcomes: string[];
  run: { status: string | null; error: string | null } | null;
};

async function stopTurn(options: StopOptions): Promise<StopResult> {
  const agent = (await getAgentByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    crypto.randomUUID()
  )) as unknown as {
    stopWithReasonForTest(o: StopOptions): Promise<StopResult>;
  };
  return agent.stopWithReasonForTest(options);
}

// A turn whose own signal aborted ends aborted, whatever the abort's reason
// was and whatever the model call threw because of it.
describe("a stopped turn ends aborted, whatever reason the stop carried", () => {
  const entries = [
    "chat",
    "abortRequest",
    "saveMessages",
    "continueLastTurn",
    "agentTool"
  ] as const;
  const phases = ["hook", "connect", "stream"] as const;
  const reasons = ["none", "string", "error"] as const;
  for (const entry of entries) {
    for (const phase of phases) {
      for (const reason of reasons) {
        it(`${entry}, stopped at ${phase}, reason: ${reason}`, async () => {
          const result = await stopTurn({ entry, phase, reason });
          expect(result).toMatchObject({
            done: false,
            error: null,
            chatErrors: [],
            agentErrors: [],
            errorFrames: 0,
            failedEvents: 0
          });
          if (entry === "saveMessages" || entry === "continueLastTurn") {
            expect(result.status).toBe("aborted");
          }
          if (entry === "agentTool") {
            // The reason is on the run's row as the abort's reason.
            expect(result.run).toEqual({
              status: "aborted",
              error: reason === "none" ? null : "caller-stop"
            });
          }
          expect(result.responses.filter((s) => s === "error")).toEqual([]);
          expect(result.terminalOutcomes.filter((o) => o === "error")).toEqual(
            []
          );
        });
      }
    }
  }
});

describe("a stop right after a stall", () => {
  it("is a stop: the stalled reply is not recovered", async () => {
    const agent = (await getAgentByName(
      env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
      crypto.randomUUID()
    )) as unknown as {
      stopRightAfterStallForTest(
        via?: "chat" | "save",
        inRoute?: boolean
      ): Promise<{
        scheduled: number;
        stepsAfterStop: number;
        done: boolean;
        error: string | null;
        responses: string[];
        activeIncidents: number;
        activeStream: boolean;
        routeOutcomes: string[];
      }>;
    };
    const result = await agent.stopRightAfterStallForTest();
    // The watchdog had already aborted the turn's signal for the stall, so
    // the signal alone cannot say a stop followed.
    expect(result.stepsAfterStop).toBe(0);
    expect(result.activeIncidents).toBe(0);
    expect(result).toMatchObject({ done: false, error: null });
    expect(result.responses.filter((status) => status === "error")).toEqual([]);
    // The stream it was routing is closed: no tab is offered it later.
    expect(result.activeStream).toBe(false);
    const saved = await agent.stopRightAfterStallForTest("save");
    expect(saved.stepsAfterStop).toBe(0);
    expect(saved.activeIncidents).toBe(0);
    expect(saved.activeStream).toBe(false);
    // A stop that lands while the stall is routed, before the incident is
    // written: the route ends `stopped`, and that path closes the stream.
    for (const via of ["chat", "save"] as const) {
      const routed = await agent.stopRightAfterStallForTest(via, true);
      expect(routed.routeOutcomes).toEqual(["stopped"]);
      expect(routed.activeIncidents).toBe(0);
      expect(routed.activeStream).toBe(false);
    }
  });
});
