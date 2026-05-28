import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ThinkAgentToolParent, ThinkTestAgent } from "./agents";
import type {
  AgentToolEventMessage,
  AgentToolLifecycleResult,
  AgentToolRunInfo,
  RunAgentToolResult
} from "agents";

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
  cancelAgentToolRun(
    runId: string,
    reason?: unknown
  ): ReturnType<ThinkTestAgent["cancelAgentToolRun"]>;
  getAgentToolCleanupMapSizesForTest(): Promise<{
    lastErrors: number;
    preTurnAssistantIds: number;
  }>;
};

type ThinkAgentToolParentStub = DurableObjectStub & {
  runThinkChild(input: string, runId?: string): Promise<RunAgentToolResult>;
  reconcileCompletedThinkChildForTest(
    input: string,
    runId?: string
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
    inspection: NonNullable<AgentToolInspection>;
    status: string | null;
  }>;
  reconcileRunningThinkChildForTest(
    input: string,
    runId?: string
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
    status: string | null;
  }>;
  reconcileStuckThinkChildWithTimeoutForTest(runId?: string): Promise<{
    events: AgentToolEventMessage[];
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
    elapsedMs: number;
    status: string | null;
  }>;
  scheduleStuckThinkChildRecoveryForTest(runId?: string): Promise<{
    events: AgentToolEventMessage[];
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
    status: string | null;
  }>;
  scheduleStuckThinkChildRecoveryTwiceForTest(runId?: string): Promise<{
    events: AgentToolEventMessage[];
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
    status: string | null;
  }>;
  startupDefersStaleThinkRecoveryForTest(runId?: string): Promise<{
    statusesDuringStartup: string[];
    statusAfterStartup: string | null;
    finalStatus: string | null;
    startupElapsedMs: number;
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
    events: AgentToolEventMessage[];
  }>;
  startupRecoveryIgnoresRunsCreatedDuringOnStartForTest(): Promise<{
    staleStatus: string | null;
    onStartRunStatus: string | null;
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
    events: AgentToolEventMessage[];
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

async function freshParent(
  name = crypto.randomUUID()
): Promise<ThinkAgentToolParentStub> {
  return getAgentByName(
    env.ThinkAgentToolParent as unknown as DurableObjectNamespace<ThinkAgentToolParent>,
    name
  ) as unknown as Promise<ThinkAgentToolParentStub>;
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

  it("preserves explicit agent-tool cancellation as aborted", async () => {
    const agent = await freshAgent();
    const runId = crypto.randomUUID();

    await agent.setBeforeStepAsyncDelay(50);
    await agent.startAgentToolRun("cancelled probe", { runId });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await agent.cancelAgentToolRun(runId, "stop");

    const inspection = await waitForAgentToolRun(agent, runId);
    expect(inspection).toMatchObject({
      runId,
      status: "aborted",
      error: "stop"
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(agent.inspectAgentToolRun(runId)).resolves.toMatchObject({
      runId,
      status: "aborted",
      error: "stop"
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

  it("runs a Think child through the parent agent-tool API", async () => {
    const parent = await freshParent();
    const runId = crypto.randomUUID();

    const result = await parent.runThinkChild("parent Think probe", runId);

    expect(result).toMatchObject({
      runId,
      agentType: "ThinkTestAgent",
      status: "completed",
      summary: "Hello from the assistant!"
    });
  });

  it("recovers completed Think child runs into terminal parent rows", async () => {
    const parent = await freshParent();
    const runId = crypto.randomUUID();

    const { events, finishes, inspection, status } =
      await parent.reconcileCompletedThinkChildForTest(
        "recover completed Think child",
        runId
      );

    expect(status).toBe("completed");
    expect(inspection).toMatchObject({
      runId,
      status: "completed",
      summary: "Hello from the assistant!"
    });
    expect(finishes).toEqual([
      {
        run: expect.objectContaining({
          runId,
          parentToolCallId: "think-tool-call",
          agentType: "ThinkTestAgent",
          status: "completed",
          inputPreview: "recover completed Think child"
        }),
        result: expect.objectContaining({
          status: "completed",
          summary: "Hello from the assistant!"
        })
      }
    ]);
    expect(events.at(-1)).toMatchObject({
      parentToolCallId: "think-tool-call",
      event: {
        kind: "finished",
        runId,
        summary: "Hello from the assistant!"
      }
    });
  });

  it("recovers still-running Think child rows as interrupted", async () => {
    const parent = await freshParent();
    const runId = crypto.randomUUID();

    const { events, finishes, status } =
      await parent.reconcileRunningThinkChildForTest(
        "still running Think child",
        runId
      );

    expect(status).toBe("interrupted");
    expect(finishes).toEqual([
      {
        run: expect.objectContaining({
          runId,
          parentToolCallId: "think-tool-call",
          agentType: "ThinkTestAgent",
          status: "interrupted",
          inputPreview: "still running Think child"
        }),
        result: expect.objectContaining({
          status: "interrupted",
          error:
            "Agent tool run was still running, but live-tail reattachment is not supported in this runtime."
        })
      }
    ]);
    expect(events.at(-1)).toMatchObject({
      event: {
        kind: "interrupted",
        runId,
        error:
          "Agent tool run was still running, but live-tail reattachment is not supported in this runtime."
      }
    });
  });

  it("bounds Think recovery when child facet startup never completes", async () => {
    const parent = await freshParent();
    const runId = crypto.randomUUID();

    const { events, finishes, elapsedMs, status } =
      await parent.reconcileStuckThinkChildWithTimeoutForTest(runId);

    expect(elapsedMs).toBeLessThan(1000);
    expect(status).toBe("interrupted");
    expect(finishes).toEqual([
      {
        run: expect.objectContaining({
          runId,
          parentToolCallId: "think-tool-call",
          agentType: "StuckThinkAgentToolChild",
          status: "interrupted",
          inputPreview: "stuck Think child"
        }),
        result: expect.objectContaining({
          status: "interrupted",
          error: "Agent tool run inspection timed out during parent recovery."
        })
      }
    ]);
    expect(events.at(-1)).toMatchObject({
      event: {
        kind: "interrupted",
        runId,
        error: "Agent tool run inspection timed out during parent recovery."
      }
    });
  });

  it("runs scheduled Think startup recovery and finalizes stale rows", async () => {
    const parent = await freshParent();
    const runId = crypto.randomUUID();

    const { events, finishes, status } =
      await parent.scheduleStuckThinkChildRecoveryForTest(runId);

    expect(status).toBe("interrupted");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({
      run: expect.objectContaining({
        runId,
        agentType: "StuckThinkAgentToolChild",
        status: "interrupted"
      }),
      result: expect.objectContaining({
        status: "interrupted",
        error: "Agent tool run inspection timed out during parent recovery."
      })
    });
    expect(events.at(-1)).toMatchObject({
      event: { kind: "interrupted", runId }
    });
  });

  it("keeps scheduled Think startup recovery single-flight", async () => {
    const parent = await freshParent();
    const runId = crypto.randomUUID();

    const { events, finishes, status } =
      await parent.scheduleStuckThinkChildRecoveryTwiceForTest(runId);

    expect(status).toBe("interrupted");
    expect(finishes).toHaveLength(1);
    expect(
      events.filter((event) => event.event.kind === "interrupted")
    ).toHaveLength(1);
  });

  it("lets Think startup return before stale child recovery finalizes", async () => {
    const parent = await freshParent();
    const runId = crypto.randomUUID();

    const {
      statusesDuringStartup,
      statusAfterStartup,
      finalStatus,
      startupElapsedMs,
      finishes,
      events
    } = await parent.startupDefersStaleThinkRecoveryForTest(runId);

    expect(startupElapsedMs).toBeLessThan(1000);
    expect(statusesDuringStartup).toContain("running");
    expect(statusAfterStartup).toBe("running");
    expect(finalStatus).toBe("interrupted");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({
      run: expect.objectContaining({
        runId,
        agentType: "StuckThinkAgentToolChild",
        status: "interrupted"
      }),
      result: expect.objectContaining({
        status: "interrupted",
        error: "Agent tool run inspection timed out during parent recovery."
      })
    });
    expect(events.at(-1)).toMatchObject({
      event: { kind: "interrupted", runId }
    });
  });

  it("only recovers rows that were stale before Think startup began", async () => {
    const parent = await freshParent();

    const { staleStatus, onStartRunStatus, finishes, events } =
      await parent.startupRecoveryIgnoresRunsCreatedDuringOnStartForTest();

    expect(staleStatus).toBe("interrupted");
    expect(onStartRunStatus).toBe("running");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.run.inputPreview).toBe("startup snapshot stale child");
    expect(
      events.filter((event) => event.event.kind === "interrupted")
    ).toHaveLength(1);
  });
});
