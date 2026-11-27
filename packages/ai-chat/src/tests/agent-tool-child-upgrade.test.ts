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
});
