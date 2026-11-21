import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ThinkRecoveryTestAgent } from "./agents/think-session";

async function freshRecoveryAgent(name: string) {
  return getAgentByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    name
  );
}

/**
 * Safety net for `AgentToolRuns.rebind` (the re-attach budget fix):
 * it runs on EVERY recovery continuation, so it must be an unambiguous no-op
 * whenever this recovery is NOT for a live agent-tool child run. These lock the
 * three no-op cases the docstring promises, plus the defensive newest-row
 * selection for the (architecturally precluded) multi-row case.
 */
describe("agent-tool rebind: no-op safety on non-child recovery", () => {
  it("is a no-op when the facet never ran as an agent-tool child (no table)", async () => {
    const agent = await freshRecoveryAgent(
      `rebind-noop-none-${crypto.randomUUID()}`
    );

    // A pristine recovery facet has no child-run table at all.
    expect(await agent.hasAgentToolChildRunTableForTest()).toBe(false);

    // The guarded SELECT throws on the missing table and is swallowed → the
    // call does not throw and creates nothing.
    await expect(
      agent.rebindAgentToolChildRunRequestIdForTest(
        "normal-turn-req",
        "some-earlier-req"
      )
    ).resolves.toBeUndefined();
    expect(await agent.hasAgentToolChildRunTableForTest()).toBe(false);
  });

  it("does not rewrite a SETTLED child-run row during an unrelated recovery", async () => {
    const agent = await freshRecoveryAgent(
      `rebind-noop-settled-${crypto.randomUUID()}`
    );

    await agent.seedSettledAgentToolChildRunForTest(
      "run-settled",
      "old-settled-req"
    );

    await agent.rebindAgentToolChildRunRequestIdForTest(
      "normal-turn-req",
      "old-settled-req"
    );

    // The settled row keeps its original request id; the new turn's id is not
    // mis-attributed to the finished run.
    expect(
      await agent.getAgentToolChildRunRequestIdForTest("run-settled")
    ).toBe("old-settled-req");
    expect(
      await agent.resolveAgentToolRunForRequestForTest("normal-turn-req")
    ).toBeNull();
  });

  it("rebinds only the run whose row names the recovered turn", async () => {
    const agent = await freshRecoveryAgent(
      `rebind-noop-multi-${crypto.randomUUID()}`
    );

    await agent.seedAgentToolChildRunForTest("run-old", "old-req", 1_000);
    await agent.seedAgentToolChildRunForTest("run-new", "new-req", 2_000);

    // Another turn recovered on the same agent: no run row names it, so no
    // run is bound to it, open or not.
    await agent.rebindAgentToolChildRunRequestIdForTest(
      "users-recovery-req",
      "users-req"
    );
    expect(await agent.getAgentToolChildRunRequestIdForTest("run-new")).toBe(
      "new-req"
    );
    expect(
      await agent.resolveAgentToolRunForRequestForTest("users-recovery-req")
    ).toBeNull();

    // The recovery of run-new's own turn.
    await agent.rebindAgentToolChildRunRequestIdForTest(
      "recovery-req",
      "new-req"
    );

    // Its row was rebound; the other run's is left untouched.
    expect(await agent.getAgentToolChildRunRequestIdForTest("run-new")).toBe(
      "recovery-req"
    );
    expect(await agent.getAgentToolChildRunRequestIdForTest("run-old")).toBe(
      "old-req"
    );
    expect(
      await agent.resolveAgentToolRunForRequestForTest("recovery-req")
    ).toBe("run-new");
  });

  it("migrates a pre-upgrade child-run table before rebinding (fresh isolate)", async () => {
    const agent = await freshRecoveryAgent(
      `rebind-legacy-table-${crypto.randomUUID()}`
    );

    // Created by an older release: no `event_delivery` column, and this
    // isolate has not run the child-run ensure yet.
    await agent.seedLegacyAgentToolChildRunForTest("run-legacy", "old-req");

    await agent.rebindAgentToolChildRunRequestIdForTest(
      "recovery-req",
      "old-req"
    );

    expect(await agent.getAgentToolChildRunRequestIdForTest("run-legacy")).toBe(
      "recovery-req"
    );
  });

  it("drops a terminal-only run from suppression once its recovered turn settles", async () => {
    const agent = await freshRecoveryAgent(
      `rebind-terminal-only-${crypto.randomUUID()}`
    );

    const result = await agent.terminalOnlyRunAfterRecoveredTurnForTest(
      "run-terminal",
      "recovery-req"
    );

    expect(result).toEqual({ afterRebind: true, afterFinalize: false });
  });
});

describe("chat-turn recovery evidence", () => {
  it("does not treat a settled chat-turn fiber row as recoverable (#2363)", async () => {
    const agent = await freshRecoveryAgent(
      `settled-fiber-evidence-${crypto.randomUUID()}`
    );

    // A settled fiber whose row delete failed keeps `completed_at`.
    expect(
      await agent.chatTurnFiberEvidenceForTest("settled-req", true)
    ).toEqual({ recoverable: false, freshEvidence: false });
    expect(await agent.chatTurnFiberEvidenceForTest("live-req", false)).toEqual(
      { recoverable: true, freshEvidence: true }
    );
  });
});
