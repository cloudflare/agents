import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { ChatRecoveryTestAgent } from "./worker";

async function freshRecoveryAgent(name: string) {
  return getServerByName(
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
