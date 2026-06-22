import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { ThinkRecoveryTestAgent } from "./agents/think-session";

async function freshRecoveryAgent(name: string) {
  return getServerByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    name
  );
}

/**
 * Safety net for `_rebindAgentToolChildRunRequestId` (the re-attach budget fix):
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
      agent.rebindAgentToolChildRunRequestIdForTest("normal-turn-req")
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

    await agent.rebindAgentToolChildRunRequestIdForTest("normal-turn-req");

    // The settled row keeps its original request id; the new turn's id is not
    // mis-attributed to the finished run.
    expect(
      await agent.getAgentToolChildRunRequestIdForTest("run-settled")
    ).toBe("old-settled-req");
    expect(
      await agent.resolveAgentToolRunForRequestForTest("normal-turn-req")
    ).toBeNull();
  });

  it("rebinds only the newest active row when several are non-terminal (defensive)", async () => {
    const agent = await freshRecoveryAgent(
      `rebind-noop-multi-${crypto.randomUUID()}`
    );

    // A stale older active row plus the current run's row. (In production a
    // child DO is named by its runId so it owns exactly one row — this asserts
    // the defensive `ORDER BY started_at DESC` selection regardless.)
    await agent.seedAgentToolChildRunForTest("run-old", "old-req", 1_000);
    await agent.seedAgentToolChildRunForTest("run-new", "new-req", 2_000);

    await agent.rebindAgentToolChildRunRequestIdForTest("recovery-req");

    // Newest row was rebound; the older one is left untouched.
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
});
