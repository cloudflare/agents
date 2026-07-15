/**
 * Ported from ORIGINAL Think:
 * - packages/think/src/tests/agent-tool-rebind-noop.test.ts
 * - last original change: f6a8bc4a
 * - port date: 2026-07-15
 * Modifications:
 * - Re-pointed `partyserver` import to `./compat.js`.
 * - Re-pointed original fixture type import to `./fixtures/index.js`.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getServerByName } from "./compat.js";
import type { ThinkRecoveryTestAgent } from "./fixtures/index.js";

async function freshRecoveryAgent(name: string) {
  return getServerByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    name
  );
}

describe("agent-tool rebind: no-op safety on non-child recovery", () => {
  it("is a no-op when the facet never ran as an agent-tool child (no table)", async () => {
    const agent = await freshRecoveryAgent(
      `rebind-noop-none-${crypto.randomUUID()}`
    );

    expect(await agent.hasAgentToolChildRunTableForTest()).toBe(false);

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

    await agent.seedAgentToolChildRunForTest("run-old", "old-req", 1_000);
    await agent.seedAgentToolChildRunForTest("run-new", "new-req", 2_000);

    await agent.rebindAgentToolChildRunRequestIdForTest("recovery-req");

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
