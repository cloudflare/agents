import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { getAgentByName } from "agents";

/**
 * Upgrade test for a released row (H11): the owed response hook think@0.24.0
 * kept in storage. Written as the release left it, then started for real.
 */
describe("Think upgraded over the response hook a release owed", () => {
  it("fires it once after a real restart, and drops the key", async () => {
    const name = `owed-${crypto.randomUUID()}`;
    // A reset stub stays broken: each call takes a new one.
    const agent = () => getAgentByName(env.ThinkUpgradeResponseHookAgent, name);
    await (await agent()).leaveReleasedOwedHookForTest();
    await (await agent()).resetIsolateForTest().catch(() => {});

    await vi.waitFor(
      async () => {
        expect(await (await agent()).responsesForTest()).toEqual([
          { requestId: "r-owed", messageId: "a-owed", status: "completed" }
        ]);
      },
      { timeout: 5_000, interval: 50 }
    );
    expect(await (await agent()).owedHookLeftForTest()).toBe(false);

    // Another restart fires nothing more.
    await (await agent()).resetIsolateForTest().catch(() => {});
    expect(await (await agent()).responsesForTest()).toHaveLength(1);
  });
});
