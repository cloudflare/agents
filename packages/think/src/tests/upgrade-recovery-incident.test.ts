import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { getAgentByName } from "agents";

/**
 * Upgrade test for a released row (H11): the chat recovery incidents
 * think@0.24.0 kept. A record inactive past the TTL goes once a recovery
 * runs; a live one stays for its own turn.
 */
describe("Think upgraded over the recovery incidents a release kept", () => {
  it("drops one past its TTL once a real recovery runs, and keeps a live one", async () => {
    const name = `incidents-${crypto.randomUUID()}`;
    // A reset stub stays broken: each call takes a new one.
    const agent = () =>
      getAgentByName(env.ThinkUpgradeRecoveryIncidentAgent, name);
    await (await agent()).leaveReleasedIncidentsForTest();
    await (await agent()).startHeldTurnForTest();
    await (await agent()).resetIsolateForTest().catch(() => {});

    // The interrupted turn is recovered on the new isolate's start.
    await vi.waitFor(
      async () => {
        expect(await (await agent()).replyTextForTest()).toContain("done");
      },
      { timeout: 8_000, interval: 100 }
    );
    expect(await (await agent()).incidentIdsForTest()).not.toContain("stale");
    expect(await (await agent()).incidentIdsForTest()).toContain("live");
  }, 15_000);
});
