import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";

/**
 * Upgrade tests for a released row (H11): the system prompt think@0.24.0
 * froze, written as the release left it, then started for real.
 */
const FROZEN =
  "You are the prompt think@0.24.0 froze.\n\nIt holds what the release rendered then.";

describe("Think upgraded over the prompt a release froze", () => {
  it("opens the first request after a restart with it, byte for byte", async () => {
    const name = `frozen-${crypto.randomUUID()}`;
    // A reset stub stays broken: each call takes a new one.
    const agent = () => getAgentByName(env.ThinkUpgradeFrozenPromptAgent, name);
    await (await agent()).leaveReleasedFrozenPromptForTest(FROZEN);
    await (await agent()).resetIsolateForTest().catch(() => {});

    const system = await (
      await agent()
    ).systemOfNextTurnForTest("after the upgrade");
    expect(system?.startsWith(FROZEN)).toBe(true);
  });

  it("does not send it once the transcript is cleared after the restart", async () => {
    const name = `frozen-cleared-${crypto.randomUUID()}`;
    const agent = () => getAgentByName(env.ThinkUpgradeFrozenPromptAgent, name);
    await (await agent()).leaveReleasedFrozenPromptForTest(FROZEN);
    await (await agent()).resetIsolateForTest().catch(() => {});

    const system = await (
      await agent()
    ).systemOfNextTurnForTest("after the clear", true);
    // A request was sent, with a system prompt, and it is not the frozen one.
    expect(system).toBeDefined();
    expect(system).not.toContain("think@0.24.0 froze");
  });
});
