import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ChatRecoveryTestAgent } from "./worker";

/**
 * R3-identity's upgrade contract for the agent-tool child rows a released
 * version kept (CLOSEOUT 1b). Today the rows stay in their tables, so this is
 * `it.fails`; R3-identity, which carries them onto the child's turn runs and
 * drops the tables, turns it into `it`.
 */
describe("agent-tool child rows a released version left", () => {
  it("inspect as they did, and the released tables are gone", async () => {
    const agent = await getAgentByName(
      env.ChatRecoveryTestAgent as unknown as DurableObjectNamespace<ChatRecoveryTestAgent>,
      `child-upgrade-${crypto.randomUUID()}`
    );
    await agent.seedReleasedAgentToolChildRowsForTest();
    expect(await agent.upgradedAgentToolChildRowsForTest()).toEqual({
      runs: {
        "released-done": expect.objectContaining({
          status: "completed",
          summary: "done",
          output: "the answer",
          milestones: ["found"]
        }),
        "released-failed": expect.objectContaining({
          status: "error",
          error: "boom"
        }),
        "released-stopped": expect.objectContaining({ status: "aborted" })
      },
      tablesLeft: []
    });
  });

  it("carry on when one was in flight: its cut-off turn runs as the run's turn", async () => {
    const agent = await getAgentByName(
      env.ChatRecoveryTestAgent as unknown as DurableObjectNamespace<ChatRecoveryTestAgent>,
      `child-upgrade-live-${crypto.randomUUID()}`
    );
    const result = await agent.inFlightAgentToolRunAcrossUpgradeForTest();
    expect(result.keptForItsTurn).toBe(true);
    expect(result.beforeItsTurn).toBe("running");
    expect(result.status).toBe("completed");
    expect(result.summary).toBeTruthy();
    expect(result.tablesLeft).toEqual([]);
    // Its reply's stream is kept for the parent, as any agent-tool run's.
    expect(result.chunks).toBeGreaterThan(0);
  });

  it("end, not stay running, when the app declines to recover its turn", async () => {
    const agent = await getAgentByName(
      env.ChatRecoveryTestAgent as unknown as DurableObjectNamespace<ChatRecoveryTestAgent>,
      `child-upgrade-declined-${crypto.randomUUID()}`
    );
    const result = await agent.inFlightAgentToolRunAcrossUpgradeForTest(true);
    expect(result.status).toBe("error");
    expect(result.tablesLeft).toEqual([]);
  });
});
