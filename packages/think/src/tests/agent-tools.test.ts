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
  setAgentToolOutputForTest(runId: string, output: unknown): Promise<void>;
  clearAgentToolOutputForTest(runId: string): Promise<void>;
  setStripTextResponseForTest(strip: boolean): Promise<void>;
  setBeforeStepAsyncDelay(ms: number): Promise<void>;
  resetTurnStateForTest(): Promise<void>;
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
  it("uses assistant text as the default agent-tool summary", async () => {
    const agent = await freshAgent();
    const runId = crypto.randomUUID();

    await agent.startAgentToolRun("chat-like probe", { runId });
    const inspection = await waitForAgentToolRun(agent, runId);

    expect(inspection).toMatchObject({
      runId,
      status: "completed",
      summary: "Hello from the assistant!"
    });
    expect(inspection?.error).toBeUndefined();
  });

  it("completes when a non-chat agent-tool run emits no assistant text", async () => {
    const agent = await freshAgent();
    const runId = crypto.randomUUID();

    await agent.setStripTextResponseForTest(true);
    await agent.startAgentToolRun("non-chat probe", { runId });
    const inspection = await waitForAgentToolRun(agent, runId);

    expect(inspection).toMatchObject({
      runId,
      status: "completed",
      summary: ""
    });
    expect(inspection?.error).toBeUndefined();
  });

  it("returns structured output for a non-chat agent-tool run", async () => {
    const agent = await freshAgent();
    const runId = crypto.randomUUID();

    await agent.setStripTextResponseForTest(true);
    await agent.setAgentToolOutputForTest(runId, {
      ok: true,
      value: "workflow-result"
    });
    await agent.startAgentToolRun("structured non-chat probe", { runId });
    const inspection = await waitForAgentToolRun(agent, runId);

    expect(inspection).toMatchObject({
      runId,
      status: "completed",
      output: { ok: true, value: "workflow-result" },
      summary: '{"ok":true,"value":"workflow-result"}'
    });

    await agent.clearAgentToolOutputForTest(runId);
    await expect(agent.inspectAgentToolRun(runId)).resolves.toMatchObject({
      runId,
      status: "completed",
      output: { ok: true, value: "workflow-result" },
      summary: '{"ok":true,"value":"workflow-result"}'
    });
  });

  it("marks skipped agent-tool turns as errors", async () => {
    const agent = await freshAgent();
    const runId = crypto.randomUUID();

    await agent.setBeforeStepAsyncDelay(50);
    await agent.startAgentToolRun("skipped probe", { runId });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await agent.resetTurnStateForTest();

    const inspection = await waitForAgentToolRun(agent, runId);

    expect(inspection).toMatchObject({
      runId,
      status: "error",
      error: "Agent tool run was skipped before the child could finish."
    });
  });

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
