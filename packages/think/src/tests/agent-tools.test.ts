import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ThinkTestAgent } from "./agents";

type AgentToolInspection = Awaited<
  ReturnType<ThinkTestAgent["inspectAgentToolRun"]>
>;

type ThinkAgentToolTestStub = {
  inspectAgentToolRun(runId: string): Promise<AgentToolInspection>;
  seedAgentToolLastErrorForTest(runId: string, error: string): Promise<void>;
  startAgentToolRun(
    input: unknown,
    options: { runId: string }
  ): ReturnType<ThinkTestAgent["startAgentToolRun"]>;
  getAgentToolCleanupMapSizesForTest(): Promise<{
    lastErrors: number;
    preTurnAssistantIds: number;
  }>;
};

async function freshAgent(
  name = crypto.randomUUID()
): Promise<ThinkAgentToolTestStub> {
  return getAgentByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    name
  ) as unknown as Promise<ThinkAgentToolTestStub>;
}

async function waitForAgentToolRun(
  agent: ThinkAgentToolTestStub,
  runId: string
): Promise<AgentToolInspection> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const inspection = await agent.inspectAgentToolRun(runId);
    if (
      inspection?.status === "completed" ||
      inspection?.status === "error" ||
      inspection?.status === "aborted"
    ) {
      return inspection;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return agent.inspectAgentToolRun(runId);
}

describe("Think agent tools", () => {
  it("cleans in-memory agent-tool bookkeeping after a run completes", async () => {
    const agent = await freshAgent();
    const runId = crypto.randomUUID();

    await agent.seedAgentToolLastErrorForTest(runId, "seeded stream error");
    await agent.startAgentToolRun("cleanup probe", { runId });
    const inspection = await waitForAgentToolRun(agent, runId);

    expect(inspection?.status).toBe("error");
    expect(await agent.getAgentToolCleanupMapSizesForTest()).toEqual({
      lastErrors: 0,
      preTurnAssistantIds: 0
    });
  });
});
