/**
 * A workflow run keeps its Agent stub across steps. A reset of the Agent
 * (crash, memory-limit breaker, code update) breaks every stub obtained
 * before it, so `this.agent` must renew itself after a failed call.
 */
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";

describe("AgentWorkflow across an Agent reset", () => {
  it("reaches the restarted Agent through this.agent", async () => {
    const agent = await getAgentByName(
      env.TestWorkflowAgent,
      `agent-reset-${crypto.randomUUID()}`
    );
    const workflowId = `agent-reset-wf-${crypto.randomUUID()}`;
    await using instance = await introspectWorkflowInstance(
      env.AGENT_RESET_WORKFLOW,
      workflowId
    );

    await agent.runAgentResetWorkflowTest(workflowId);

    await expect(
      instance.waitForStepResult({ name: "call-across-reset" })
    ).resolves.toBe("after reset");
    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
  });
});
