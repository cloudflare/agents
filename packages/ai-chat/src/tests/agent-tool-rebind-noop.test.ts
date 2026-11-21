import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ChatRecoveryTestAgent } from "./worker";

async function freshRecoveryAgent(name: string) {
  return getAgentByName(
    env.ChatRecoveryTestAgent as unknown as DurableObjectNamespace<ChatRecoveryTestAgent>,
    name
  );
}

/**
 * Parity with the Think `agent-tool-rebind-noop` suite: the re-attach-budget
 * rebind runs on EVERY recovery continuation, so it must be an unambiguous
 * no-op when this recovery is NOT for a live agent-tool child run. (ai-chat
 * always has the `cf_ai_chat_agent_tool_runs` table — created in the
 * constructor — so the "no table" case is Think-only.)
 */
describe("agent-tool rebind: no-op safety on non-child recovery (ai-chat)", () => {
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
