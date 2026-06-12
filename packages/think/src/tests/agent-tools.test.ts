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
  reconcileStaleChildRunViaRecoveryForTest(
    path: "continue" | "retry",
    withAssistantTurn: boolean
  ): Promise<{ before: string | null; after: string | null }>;
  resolveAgentToolRunAfterRestartForTest(
    runId: string,
    requestId: string
  ): Promise<{ running: string | null; unknown: string | null }>;
  getDefaultReattachBudgetsForTest(): Promise<{
    noProgressTimeoutMs: number;
    maxWindowIsFinite: boolean;
  }>;
  cancelAgentToolRunAbortsRecoveryForTest(): Promise<{
    abortedBefore: boolean;
    abortedAfter: boolean;
    childStatus: string | null;
  }>;
};

type ThinkAgentToolParentStub = DurableObjectStub & {
  runThinkChild(input: string, runId?: string): Promise<RunAgentToolResult>;
  runThinkChildWithInjectedUnrelatedError(
    input: string,
    injectAfterMs: number,
    runId?: string
  ): Promise<RunAgentToolResult>;
  runThinkChildWithInBandError(
    input: string,
    errorText: string,
    runId?: string
  ): Promise<RunAgentToolResult>;
  startThinkChildWithoutTailForTest(
    input: string,
    errorText: string,
    runId?: string
  ): Promise<NonNullable<AgentToolInspection>>;
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
  reattachStuckTailableThinkChildForTest(runId?: string): Promise<{
    events: AgentToolEventMessage[];
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
    elapsedMs: number;
    status: string | null;
  }>;
  reattachMaxWindowExhaustedThinkChildForTest(runId?: string): Promise<{
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
    elapsedMs: number;
    status: string | null;
    childStatus: string | null;
  }>;
  getResolvedReattachBudgetsForTest(): Promise<{
    noProgressTimeoutMs: number;
    maxWindowMs: number;
  }>;
  reattachNotTailableAdapterForTest(): Promise<{
    reason?: string;
    result: boolean;
  }>;
  reattachScriptedAdapterForTest(
    scenario:
      | "rearm-then-complete"
      | "idle-after-progress"
      | "infinite-no-progress-ceiling"
  ): Promise<{ status?: string; reason?: string; tailAttempts: number }>;
  reconcileParallelThinkChildrenForTest(): Promise<{
    stuckStatus: string | null;
    fastStatus: string | null;
  }>;
  reissueInterruptedThinkChildForTest(
    input: string,
    runId?: string
  ): Promise<{ status: string | null; reissueStatus: string }>;
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

  it("does not contaminate a run's terminal status with an unrelated turn's error frame (#1575)", async () => {
    const parent = await freshParent();
    const runId = crypto.randomUUID();

    // While the tailed child run streams, an error frame from an UNRELATED
    // turn (a request id that belongs to no run) is broadcast on the child.
    // Before #1575 the error was stamped onto every active forwarder's run
    // and this healthy run finalized as `error`.
    const result = await parent.runThinkChildWithInjectedUnrelatedError(
      "stay healthy probe",
      20,
      runId
    );

    expect(result).toMatchObject({
      runId,
      agentType: "ThinkTestAgent",
      status: "completed"
    });
    expect(result.error).toBeUndefined();
  });

  it("marks an in-band stream error as error with no tailer attached (#1575)", async () => {
    const parent = await freshParent();
    const runId = crypto.randomUUID();

    // The run is started directly and never tailed — terminal status must
    // come from the child turn's own result, not forwarding side effects.
    const inspection = await parent.startThinkChildWithoutTailForTest(
      "fail untailed",
      "untailed failure",
      runId
    );

    expect(inspection.status).toBe("error");
    expect(inspection.error).toContain("untailed failure");
  });

  it("keeps concurrent Think child runs' error state isolated (#1575)", async () => {
    const parent = await freshParent();
    const runA = crypto.randomUUID();
    const runB = crypto.randomUUID();

    const [a, b] = await Promise.all([
      parent.runThinkChildWithInBandError("failing run", "run A failed", runA),
      parent.runThinkChild("healthy run", runB)
    ]);

    expect(a).toMatchObject({ runId: runA, status: "error" });
    expect(a.error).toContain("run A failed");
    expect(b).toMatchObject({ runId: runB, status: "completed" });
    expect(b.error).toBeUndefined();
  });

  it("attributes frames via the persisted request id after a DO restart (#1575)", async () => {
    const agent = await freshAgent();
    const runId = crypto.randomUUID();
    const requestId = crypto.randomUUID();

    // The child-run row persisted request_id at turn start; after a restart
    // the in-memory map is empty, so attribution must fall back to SQL.
    const resolved = await agent.resolveAgentToolRunAfterRestartForTest(
      runId,
      requestId
    );

    expect(resolved.running).toBe(runId);
    expect(resolved.unknown).toBeNull();
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

  it("re-attaches a still-running Think child and finalizes it completed (#1630)", async () => {
    const parent = await freshParent();
    const runId = crypto.randomUUID();

    const { events, finishes, status } =
      await parent.reconcileRunningThinkChildForTest(
        "child completes during reattach",
        runId
      );

    expect(status).toBe("completed");
    expect(finishes).toEqual([
      {
        run: expect.objectContaining({
          runId,
          parentToolCallId: "think-tool-call",
          agentType: "ThinkTestAgent",
          status: "completed",
          inputPreview: "child completes during reattach"
        }),
        result: expect.objectContaining({
          status: "completed"
        })
      }
    ]);
    expect(events.at(-1)).toMatchObject({
      event: {
        kind: "finished",
        runId
      }
    });
  });

  it("bounds re-attach when a tail-able Think child never reaches terminal (#1630)", async () => {
    const parent = await freshParent();
    const runId = crypto.randomUUID();

    const { finishes, elapsedMs, status } =
      await parent.reattachStuckTailableThinkChildForTest(runId);

    // Sealed after the (small) bounded re-attach budget, not immediately and
    // not never: a genuinely hung child can't block recovery forever.
    expect(elapsedMs).toBeLessThan(5000);
    expect(status).toBe("interrupted");
    expect(finishes).toEqual([
      {
        run: expect.objectContaining({
          runId,
          parentToolCallId: "think-tool-call",
          agentType: "ThinkTestAgent",
          status: "interrupted"
        }),
        result: expect.objectContaining({
          status: "interrupted",
          // Typed cause (#1630 follow-up) so callers don't parse the prose: the
          // child made no forward progress within the no-progress budget. This
          // seal is SOFT — the child is NOT torn down (`childStillRunning: true`)
          // so a re-issue can still re-attach and repair it if it self-heals.
          // Only the `window-exceeded` hard ceiling tears the child down.
          reason: "no-progress",
          childStillRunning: true,
          error:
            "Agent tool run was still running but made no forward progress within the re-attach no-progress budget; the parent gave up."
        })
      }
    ]);
  });

  it("tears down a child given up at the window-exceeded ceiling (#1630)", async () => {
    const parent = await freshParent();
    const runId = crypto.randomUUID();

    const { finishes, elapsedMs, status, childStatus } =
      await parent.reattachMaxWindowExhaustedThinkChildForTest(runId);

    // Ceiling (200ms) ends the wait well before the 5s no-progress budget.
    expect(elapsedMs).toBeLessThan(5000);
    expect(status).toBe("interrupted");
    expect(finishes).toEqual([
      {
        run: expect.objectContaining({
          runId,
          agentType: "ThinkTestAgent",
          status: "interrupted"
        }),
        result: expect.objectContaining({
          status: "interrupted",
          // The hard ceiling is the one give-up that TEARS THE CHILD DOWN — the
          // child had its full window and is truly exhausted.
          reason: "window-exceeded",
          childStillRunning: false
        })
      }
    ]);
    // Teardown actually cancelled the child run (not just sealed the parent).
    expect(childStatus).toBe("aborted");
  });

  it("re-arms across a clean mid-flight stream-close and follows an advancing child to completed (#1630)", async () => {
    const parent = await freshParent();

    const { status, reason, tailAttempts } =
      await parent.reattachScriptedAdapterForTest("rearm-then-complete");

    // The child's stream closed once (re-eviction) while still advancing, so
    // re-attach re-armed (a second tail) and collected the real terminal result
    // rather than sealing interrupted.
    expect(status).toBe("completed");
    expect(reason).toBeUndefined();
    expect(tailAttempts).toBe(2);
  });

  it("does not re-arm after a full no-progress window even if the child progressed earlier (#1630)", async () => {
    const parent = await freshParent();

    const { status, reason, tailAttempts } =
      await parent.reattachScriptedAdapterForTest("idle-after-progress");

    // Progress then a full idle window is an honest stall: seal `no-progress`
    // after a SINGLE tail (no bonus window, no per-cycle abandoned reader).
    expect(status).toBeUndefined();
    expect(reason).toBe("no-progress");
    expect(tailAttempts).toBe(1);
  });

  it("an Infinity no-progress budget never seals on silence — only the hard ceiling ends the wait (#1630/#1672)", async () => {
    const parent = await freshParent();

    const { status, reason, tailAttempts } =
      await parent.reattachScriptedAdapterForTest(
        "infinite-no-progress-ceiling"
      );

    // Pre-fix, `Infinity` short-circuited to an immediate `no-progress` seal
    // with ZERO tail attempts. Now it tails the silent child and, because the
    // no-progress idle timer is disabled, only the finite hard ceiling ends the
    // wait — sealing `window-exceeded`, never `no-progress`.
    expect(status).toBeUndefined();
    expect(reason).toBe("window-exceeded");
    expect(reason).not.toBe("no-progress");
    expect(tailAttempts).toBe(1);
  });

  it("re-attach returns not-tailable for an adapter without a live-tail (#1630)", async () => {
    const parent = await freshParent();

    // An adapter missing `tailAgentToolRun` cannot be re-attached: the re-attach
    // returns no terminal result and the typed `not-tailable` cause. (Real RPC
    // children always pass the `typeof` guard, so this defensive branch is
    // exercised via a plain in-process adapter — see the seam doc.)
    const reattach = await parent.reattachNotTailableAdapterForTest();

    expect(reattach.reason).toBe("not-tailable");
    expect(reattach.result).toBe(false);
  });

  it("honors the public AgentStaticOptions re-attach budgets (#1630)", async () => {
    const parent = await freshParent();

    // `ThinkAgentToolParent` sets distinctive static options; this proves they
    // are resolved (and therefore used as the recovery defaults), not just
    // type-checked.
    const budgets = await parent.getResolvedReattachBudgetsForTest();

    expect(budgets).toEqual({
      noProgressTimeoutMs: 4242,
      maxWindowMs: 54_321
    });
  });

  it("re-attaches still-running children in parallel so a hung child can't starve a sibling (#1630)", async () => {
    const parent = await freshParent();

    const { stuckStatus, fastStatus } =
      await parent.reconcileParallelThinkChildrenForTest();

    // The fast child completes during its own re-attach budget even though the
    // (earlier-started) stuck child is still burning its budget in parallel.
    expect(fastStatus).toBe("completed");
    expect(stuckStatus).toBe("interrupted");
  });

  it("repairs an interrupted run by re-attaching on re-issue (#1630)", async () => {
    const parent = await freshParent();
    const runId = crypto.randomUUID();

    const { status, reissueStatus } =
      await parent.reissueInterruptedThinkChildForTest(
        "repair after interrupt",
        runId
      );

    // `interrupted` is soft: a re-issue re-attaches and collects the child's
    // real (completed) result, repairing the parent row instead of returning
    // the stale interrupted.
    expect(reissueStatus).toBe("completed");
    expect(status).toBe("completed");
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

  it("finalizes a stranded child run row when its own recovery CONTINUES (#1630)", async () => {
    // A recovered assistant turn → the reconcile in `_chatRecoveryContinue`'s
    // finally seals the stranded row `completed` so a re-attached parent
    // collects immediately instead of waiting out a no-progress window.
    const completed = await (
      await freshAgent()
    ).reconcileStaleChildRunViaRecoveryForTest("continue", true);
    expect(completed.before).toBe("running");
    expect(completed.after).toBe("completed");

    // No recovered assistant turn → the same finally seals it `error`.
    const errored = await (
      await freshAgent()
    ).reconcileStaleChildRunViaRecoveryForTest("continue", false);
    expect(errored.before).toBe("running");
    expect(errored.after).toBe("error");
  });

  it("finalizes a stranded child run row when its own recovery RETRIES a pre-stream turn (#1630)", async () => {
    // The pre-stream-eviction path settles via `_chatRecoveryRetry`, which
    // (like continue) never hits `startAgentToolRun`'s finalizer — so its
    // finally must run the same reconcile. This is the path the earlier review
    // flagged as missing.
    const completed = await (
      await freshAgent()
    ).reconcileStaleChildRunViaRecoveryForTest("retry", true);
    expect(completed.before).toBe("running");
    expect(completed.after).toBe("completed");

    const errored = await (
      await freshAgent()
    ).reconcileStaleChildRunViaRecoveryForTest("retry", false);
    expect(errored.before).toBe("running");
    expect(errored.after).toBe("error");
  });

  it("defaults the re-attach hard ceiling to uncapped (Infinity) when unset (#1630/#1672)", async () => {
    // No re-attach override on `ThinkTestAgent` ⇒ SDK defaults. The ceiling must
    // stay uncapped so a healthy long-running child is never cut off; a finite
    // default would reintroduce the bug #1672 removed at the child layer.
    const budgets = await (
      await freshAgent()
    ).getDefaultReattachBudgetsForTest();
    expect(budgets.noProgressTimeoutMs).toBe(120_000);
    expect(budgets.maxWindowIsFinite).toBe(false);
  });

  it("cancelAgentToolRun aborts an in-flight recovery turn and seals the child aborted (#1630)", async () => {
    const result = await (
      await freshAgent()
    ).cancelAgentToolRunAbortsRecoveryForTest();
    expect(result.abortedBefore).toBe(false);
    expect(result.abortedAfter).toBe(true);
    expect(result.childStatus).toBe("aborted");
  });
});
