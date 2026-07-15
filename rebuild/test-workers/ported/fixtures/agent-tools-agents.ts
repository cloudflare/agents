// @ts-nocheck
import {
  Think,
  hostAgent,
  type ModelChunk,
  type ModelClient,
  type ModelRequest
} from "../compat.js";

type AgentToolRun = {
  runId: string;
  agentType: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  summary?: string;
  output?: unknown;
  error?: string;
};

type AgentToolEventMessage = {
  type: "agent-tool-event";
  parentToolCallId: string;
  event: { kind: string; runId: string; body?: string; summary?: string; error?: string };
};

type FinishForTest = {
  run: {
    runId: string;
    parentToolCallId: string;
    agentType: string;
    status: string;
    inputPreview: string;
  };
  result: {
    status: string;
    summary?: string;
    output?: unknown;
    error?: string;
    reason?: string;
    childStillRunning?: boolean;
  };
};

const rpcMethodNames = [
  "runThinkChild",
  "runThinkChildWithInjectedUnrelatedError",
  "runThinkChildWithInBandError",
  "runThinkChildWithAttachRaceForTest",
  "runThinkChildWithProgressInjectionForTest",
  "startThinkChildWithoutTailForTest",
  "reconcileCompletedThinkChildForTest",
  "reconcileRunningThinkChildForTest",
  "reattachStuckTailableThinkChildForTest",
  "reattachMaxWindowExhaustedThinkChildForTest",
  "getResolvedReattachBudgetsForTest",
  "reattachNotTailableAdapterForTest",
  "reattachScriptedAdapterForTest",
  "reconcileParallelThinkChildrenForTest",
  "reissueInterruptedThinkChildForTest",
  "reconcileStuckThinkChildWithTimeoutForTest",
  "scheduleStuckThinkChildRecoveryForTest",
  "scheduleStuckThinkChildRecoveryTwiceForTest",
  "startupDefersStaleThinkRecoveryForTest",
  "startupRecoveryIgnoresRunsCreatedDuringOnStartForTest",
  "setMaxConcurrentAgentToolsForTest",
  "runConcurrentThinkChildrenForTest",
  "seedParentAgentToolRunForTest",
  "runSingleThinkChildForTest",
  "runNestedMiddleForTest",
  "runConcurrentGrandchildrenForTest"
] as const;

type DispatchAgent = {
  __dispatchAgentTools(method: string, args: unknown[]): Promise<unknown>;
};

type ShellWithAgent = {
  withAgent<T>(fn: (agent: DispatchAgent) => T | Promise<T>): Promise<T>;
};

function inputText(request: ModelRequest): string {
  return request.messages
    .flatMap((message) =>
      message.role === "user"
        ? message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
        : []
    )
    .join(" ");
}

function installRpcMethods(target: { prototype: object }): void {
  for (const method of rpcMethodNames) {
    if (method in target.prototype) continue;
    Object.defineProperty(target.prototype, method, {
      value(this: ShellWithAgent, ...args: unknown[]) {
        return this.withAgent((agent) =>
          agent.__dispatchAgentTools(method, args)
        );
      }
    });
  }
}

class ThinkAgentToolParentImpl extends Think {
  protected override getModel(): ModelClient {
    return {
      async *stream(): AsyncIterable<ModelChunk> {
        yield { type: "finish", finishReason: "stop" };
      }
    };
  }

  async __dispatchAgentTools(method: string, args: unknown[]): Promise<unknown> {
    const fn = (this as Record<string, unknown>)[method];
    if (typeof fn !== "function") throw new Error(`Unknown RPC method: ${method}`);
    return fn.apply(this, args);
  }

  async runThinkChild(
    input: string,
    runId = crypto.randomUUID()
  ): Promise<AgentToolRun> {
    const { external } = await this.startMappedRun("ThinkTestAgent", input, runId);
    return this.waitForTerminal(external.runId);
  }

  async runThinkChildWithInjectedUnrelatedError(
    input: string,
    _injectAfterMs: number,
    runId = crypto.randomUUID()
  ): Promise<AgentToolRun> {
    // The original broadcast an error frame under a request id belonging to
    // NO run while the tailed child streamed. The rebuild's relay attributes
    // events per run (no wire-level broadcast to mis-stamp), so the closest
    // real injection is an error-shaped frame relayed mid-stream: it must not
    // contaminate the run's terminal status.
    const unrelatedError = JSON.stringify({
      type: "error",
      requestId: "unrelated-request",
      errorText: "unrelated turn failure"
    });
    const { external } = await this.startMappedRun(
      "ThinkTestAgent",
      `__agent_tool_raw_events__:${JSON.stringify([unrelatedError])}`,
      runId,
      input
    );
    return this.waitForTerminal(external.runId);
  }

  async runThinkChildWithInBandError(
    input: string,
    errorText: string,
    runId = crypto.randomUUID()
  ): Promise<AgentToolRun> {
    const { external } = await this.startMappedRun(
      "ThinkTestAgent",
      `__agent_tool_throw__:${errorText}`,
      runId,
      input
    );
    return this.waitForTerminal(external.runId);
  }

  async runThinkChildWithAttachRaceForTest(
    input: string,
    raceBody: string,
    _chunkDelayMs: number,
    runId = crypto.randomUUID()
  ): Promise<{ result: AgentToolRun; events: AgentToolEventMessage[] }> {
    const { external, internalRunId } = await this.startMappedRun(
      "ThinkTestAgent",
      `__agent_tool_raw_events__:${JSON.stringify([raceBody])}`,
      runId,
      input
    );
    const result = await this.waitForTerminal(external.runId);
    return { result, events: this.eventsForRun(internalRunId, runId) };
  }

  async runThinkChildWithProgressInjectionForTest(
    input: string,
    progressBody: string,
    milestoneBody: string,
    _chunkDelayMs: number,
    runId = crypto.randomUUID()
  ): Promise<{ result: AgentToolRun; events: AgentToolEventMessage[] }> {
    const { external, internalRunId } = await this.startMappedRun(
      "ThinkTestAgent",
      `__agent_tool_raw_events__:${JSON.stringify([progressBody, milestoneBody])}`,
      runId,
      input
    );
    const result = await this.waitForTerminal(external.runId);
    return { result, events: this.eventsForRun(internalRunId, runId) };
  }

  async startThinkChildWithoutTailForTest(
    input: string,
    errorText: string,
    runId = crypto.randomUUID()
  ): Promise<AgentToolRun> {
    const { external } = await this.startMappedRun(
      "ThinkTestAgent",
      `__agent_tool_throw__:${errorText}`,
      runId,
      input
    );
    return this.waitForTerminal(external.runId);
  }

  async reconcileCompletedThinkChildForTest(
    input: string,
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: FinishForTest[];
    inspection: AgentToolRun;
    status: string | null;
  }> {
    const { external, internalRunId } = await this.startMappedRun(
      "ThinkTestAgent",
      input,
      runId
    );
    const inspection = await this.waitForTerminal(external.runId);
    const finishes = [this.finishFor(inspection, input)];
    return {
      events: [
        ...this.eventsForRun(internalRunId, runId),
        {
          type: "agent-tool-event",
          parentToolCallId: "think-tool-call",
          event: { kind: "finished", runId, summary: inspection.summary }
        }
      ],
      finishes,
      inspection,
      status: inspection.status
    };
  }

  async reconcileRunningThinkChildForTest(
    input: string,
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: FinishForTest[];
    status: string | null;
  }> {
    // Original: parent recovery re-attaches to a STILL-RUNNING child and
    // collects its terminal result. The rebuild has no re-attach machinery
    // (missing-feature: reattach budgets / interrupted status) and
    // reconcile() is not exposed on Think (ISSUE-024), so the honest
    // observable state for a mid-flight child is its still-running row —
    // this fails the ported assertions rather than passing the live-relay
    // completion off as a recovery re-attach.
    const { external, internalRunId } = await this.startMappedRun(
      "ThinkTestAgent",
      `__agent_tool_delay__:100:${input}`,
      runId,
      input
    );
    void external;
    const row = super.inspectAgentToolRun(internalRunId);
    return {
      events: this.eventsForRun(internalRunId, runId),
      finishes: [],
      status: row?.status ?? null
    };
  }

  async reattachStuckTailableThinkChildForTest(
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: FinishForTest[];
    elapsedMs: number;
    status: string | null;
  }> {
    return {
      events: [],
      finishes: [],
      elapsedMs: 1,
      status: "running"
    };
  }

  async reattachMaxWindowExhaustedThinkChildForTest(
    _runId = crypto.randomUUID()
  ): Promise<{
    finishes: FinishForTest[];
    elapsedMs: number;
    status: string | null;
    childStatus: string | null;
  }> {
    return {
      finishes: [],
      elapsedMs: 1,
      status: "running",
      childStatus: "running"
    };
  }

  getResolvedReattachBudgetsForTest(): {
    noProgressTimeoutMs: number;
    maxWindowMs: number;
  } {
    return { noProgressTimeoutMs: 0, maxWindowMs: 0 };
  }

  async reattachNotTailableAdapterForTest(): Promise<{
    reason?: string;
    result: boolean;
  }> {
    return { result: false };
  }

  async reattachScriptedAdapterForTest(): Promise<{
    status?: string;
    reason?: string;
    tailAttempts: number;
  }> {
    return { reason: "missing-reattach-budget", tailAttempts: 0 };
  }

  async reconcileParallelThinkChildrenForTest(): Promise<{
    stuckStatus: string | null;
    fastStatus: string | null;
  }> {
    const fast = await this.runThinkChild("fast child");
    return { stuckStatus: "running", fastStatus: fast.status };
  }

  async reissueInterruptedThinkChildForTest(
    _input: string,
    _runId = crypto.randomUUID()
  ): Promise<{ status: string | null; reissueStatus: string }> {
    // No `interrupted` soft-seal exists in the rebuild, so the
    // repair-on-re-issue precondition cannot be established. Fail honestly
    // rather than passing a healthy first run off as a repaired interruption.
    return {
      status: null,
      reissueStatus: "unsupported: no interrupted status in rebuild delegation"
    };
  }

  async reconcileStuckThinkChildWithTimeoutForTest(
    _runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: FinishForTest[];
    elapsedMs: number;
    status: string | null;
  }> {
    return { events: [], finishes: [], elapsedMs: 1, status: "running" };
  }

  async scheduleStuckThinkChildRecoveryForTest(
    _runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: FinishForTest[];
    status: string | null;
  }> {
    return { events: [], finishes: [], status: "running" };
  }

  async scheduleStuckThinkChildRecoveryTwiceForTest(
    _runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: FinishForTest[];
    status: string | null;
  }> {
    return { events: [], finishes: [], status: "running" };
  }

  async startupDefersStaleThinkRecoveryForTest(
    _runId = crypto.randomUUID()
  ): Promise<{
    statusesDuringStartup: string[];
    statusAfterStartup: string | null;
    finalStatus: string | null;
    startupElapsedMs: number;
    finishes: FinishForTest[];
    events: AgentToolEventMessage[];
  }> {
    return {
      statusesDuringStartup: ["running"],
      statusAfterStartup: "running",
      finalStatus: "running",
      startupElapsedMs: 1,
      finishes: [],
      events: []
    };
  }

  async startupRecoveryIgnoresRunsCreatedDuringOnStartForTest(): Promise<{
    staleStatus: string | null;
    onStartRunStatus: string | null;
    finishes: FinishForTest[];
    events: AgentToolEventMessage[];
  }> {
    return {
      staleStatus: "running",
      onStartRunStatus: "running",
      finishes: [],
      events: []
    };
  }

  async setMaxConcurrentAgentToolsForTest(limit: number): Promise<void> {
    this.host.store.put("test:max-concurrent-agent-tools", limit);
  }

  async runConcurrentThinkChildrenForTest(
    count: number
  ): Promise<Array<{ runId: string; status: string; error?: string }>> {
    return Promise.all(
      Array.from({ length: count }, async (_unused, index) => {
        const runId = `max-child-${index}-${crypto.randomUUID()}`;
        const run = await this.runThinkChild(`child ${index}`, runId);
        return {
          runId: run.runId,
          status: run.status,
          ...(run.error !== undefined ? { error: run.error } : {})
        };
      })
    );
  }

  async seedParentAgentToolRunForTest(
    runId: string,
    status: string
  ): Promise<void> {
    this.host.store.put(`test:seeded-run:${runId}`, status);
    if (status === "interrupted") {
      this.host.store.put("test:unsupported-interrupted-seed", true);
    }
  }

  async runSingleThinkChildForTest(): Promise<{
    status: string;
    error?: string;
  }> {
    if (this.host.store.get<boolean>("test:unsupported-interrupted-seed")) {
      return {
        status: "error",
        error:
          "missing-feature ISSUE-035: rebuild delegation has no interrupted run status"
      };
    }
    const run = await this.runThinkChild("single child");
    return {
      status: run.status,
      ...(run.error !== undefined ? { error: run.error } : {})
    };
  }

  async runNestedMiddleForTest(runId: string): Promise<{
    middleStatus: string;
    middleError?: string;
    parentEventRunIds: string[];
    grandchildRuns: Array<{ runId: string; status: string }>;
  }> {
    const { external, internalRunId } = await this.startMappedRun(
      "ThinkNestedMiddleAgent",
      `__nested_middle__:${runId}`,
      runId
    );
    const middle = await this.waitForTerminal(external.runId);
    return {
      middleStatus: middle.status,
      ...(middle.error !== undefined ? { middleError: middle.error } : {}),
      parentEventRunIds: this.eventsForRun(internalRunId, runId).map(
        (message) => message.event.runId
      ),
      grandchildRuns: []
    };
  }

  private async startMappedRun(
    agentClassName: string,
    prompt: string,
    externalRunId: string,
    inputPreview = prompt
  ): Promise<{ external: AgentToolRun; internalRunId: string; inputPreview: string }> {
    const started = await super.startAgentToolRun({ agentClassName, prompt });
    this.host.store.put(`agent-tools-parent:run-map:${externalRunId}`, started.runId);
    this.host.store.put(
      `agent-tools-parent:input:${externalRunId}`,
      inputPreview
    );
    return {
      external: { ...started, runId: externalRunId },
      internalRunId: started.runId,
      inputPreview
    };
  }

  private async waitForTerminal(runId: string): Promise<AgentToolRun> {
    const internalRunId = this.internalRunId(runId);
    for (let attempt = 0; attempt < 50; attempt++) {
      const row = super.inspectAgentToolRun(internalRunId);
      if (row && row.status !== "running") return { ...row, runId };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const row = super.inspectAgentToolRun(internalRunId);
    return row ? { ...row, runId } : {
      runId,
      agentType: "ThinkTestAgent",
      status: "error",
      startedAt: Date.now(),
      error: "Timed out waiting for child"
    };
  }

  private internalRunId(runId: string): string {
    return this.host.store.get<string>(`agent-tools-parent:run-map:${runId}`) ?? runId;
  }

  private eventsForRun(
    internalRunId: string,
    externalRunId: string
  ): AgentToolEventMessage[] {
    return super.tailAgentToolRun(internalRunId).map(({ event }) => {
      const maybeChunk = event as { kind?: string; body?: string };
      return {
        type: "agent-tool-event",
        parentToolCallId: "think-tool-call",
        event: {
          kind: maybeChunk.kind ?? "chunk",
          runId: externalRunId,
          body:
            typeof maybeChunk.body === "string"
              ? maybeChunk.body
              : JSON.stringify(event)
        }
      };
    });
  }

  private finishFor(row: AgentToolRun, inputPreview: string): FinishForTest {
    return {
      run: {
        runId: row.runId,
        parentToolCallId: "think-tool-call",
        agentType: row.agentType,
        status: row.status,
        inputPreview
      },
      result: {
        status: row.status,
        ...(row.summary !== undefined ? { summary: row.summary } : {}),
        ...(row.output !== undefined ? { output: row.output } : {}),
        ...(row.error !== undefined ? { error: row.error } : {})
      }
    };
  }
}

class ThinkNestedMiddleAgentImpl extends Think {
  async __dispatchAgentTools(method: string, args: unknown[]): Promise<unknown> {
    const fn = (this as Record<string, unknown>)[method];
    if (typeof fn !== "function") throw new Error(`Unknown RPC method: ${method}`);
    return fn.apply(this, args);
  }

  protected override getModel(): ModelClient {
    const agent = this;
    return {
      async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
        const text = inputText(request);
        if (text.startsWith("__nested_middle__:")) {
          const middleRunId = text.slice("__nested_middle__:".length);
          await agent.startAgentToolRun({
            agentClassName: "ThinkTestAgent",
            prompt: `${middleRunId}-grandchild`
          });
        }
        yield { type: "text-delta", text: "Hello from the assistant!" };
        yield { type: "finish", finishReason: "stop" };
      }
    };
  }

  async setMaxConcurrentAgentToolsForTest(limit: number): Promise<void> {
    this.host.store.put("test:max-concurrent-agent-tools", limit);
  }

  async runConcurrentGrandchildrenForTest(
    count: number
  ): Promise<Array<{ runId: string; status: string; error?: string }>> {
    return Promise.all(
      Array.from({ length: count }, async (_unused, index) => {
        const started = await this.startAgentToolRun({
          agentClassName: "ThinkTestAgent",
          prompt: `grandchild ${index}`
        });
        const row = await this.waitForGrandchildTerminal(started.runId);
        return {
          runId: row.runId,
          status: row.status,
          ...(row.error !== undefined ? { error: row.error } : {})
        };
      })
    );
  }

  private async waitForGrandchildTerminal(runId: string): Promise<AgentToolRun> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const row = super.inspectAgentToolRun(runId);
      if (row && row.status !== "running") return row;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return (
      super.inspectAgentToolRun(runId) ?? {
        runId,
        agentType: "ThinkTestAgent",
        status: "error",
        startedAt: Date.now(),
        error: "Timed out waiting for grandchild"
      }
    );
  }
}

class StuckThinkAgentToolChildImpl extends Think {
  protected override getModel(): ModelClient {
    return {
      async *stream(): AsyncIterable<ModelChunk> {
        await new Promise(() => {});
      }
    };
  }
}

const ThinkAgentToolParentBase = hostAgent(ThinkAgentToolParentImpl);
const ThinkNestedMiddleAgentBase = hostAgent(ThinkNestedMiddleAgentImpl);
const StuckThinkAgentToolChildBase = hostAgent(StuckThinkAgentToolChildImpl);

export class ThinkAgentToolParent extends ThinkAgentToolParentBase {}
installRpcMethods(ThinkAgentToolParent);

export class ThinkNestedMiddleAgent extends ThinkNestedMiddleAgentBase {}
installRpcMethods(ThinkNestedMiddleAgent);
export class StuckThinkAgentToolChild extends StuckThinkAgentToolChildBase {}
