import { env } from "cloudflare:workers";
import type {
  AgentToolEventMessage,
  AgentToolLifecycleResult,
  AgentToolRunInfo,
  AgentToolRunInspection,
  AgentToolStoredChunk,
  RunAgentToolResult
} from "agents";
import type { UIMessage as ChatMessage } from "ai";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";

type ParentStub = DurableObjectStub & {
  runChild(
    input: {
      prompt: string;
      delayMs?: number;
      chunkDelayMs?: number;
      structured?: boolean;
      streamError?: string;
    },
    runId?: string
  ): Promise<RunAgentToolResult>;
  runChildWithDelayedAbort(
    input: {
      prompt: string;
      delayMs?: number;
      chunkDelayMs?: number;
      structured?: boolean;
      streamError?: string;
    },
    abortAfterMs: number,
    runId?: string
  ): Promise<RunAgentToolResult>;
  getEventsForTest(): Promise<AgentToolEventMessage[]>;
  getFinishesForTest(): Promise<
    { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[]
  >;
  reconcileCompletedChildForTest(
    input: {
      prompt: string;
      delayMs?: number;
      chunkDelayMs?: number;
      structured?: boolean;
      streamError?: string;
    },
    runId?: string
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
    inspection: AgentToolRunInspection;
  }>;
  reconcileRunningChildForTest(
    input: {
      prompt: string;
      delayMs?: number;
      chunkDelayMs?: number;
      structured?: boolean;
      streamError?: string;
    },
    runId?: string
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
  }>;
  reconcileMissingChildForTest(runId?: string): Promise<{
    events: AgentToolEventMessage[];
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
  }>;
  reconcileCompletedChildWithDeferredFinishForTest(
    input: {
      prompt: string;
      delayMs?: number;
      chunkDelayMs?: number;
      structured?: boolean;
      streamError?: string;
    },
    runId?: string
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
    finishesBeforeDrain: number;
    lifecycleOrder: string[];
  }>;
  reconcileCompletedChildWithFailedStartupForTest(
    input: {
      prompt: string;
      delayMs?: number;
      chunkDelayMs?: number;
      structured?: boolean;
      streamError?: string;
    },
    runId?: string
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
    deferredHookCount: number;
    lifecycleOrder: string[];
  }>;
  reconcileCompletedChildWithReplayFailureForTest(
    input: {
      prompt: string;
      delayMs?: number;
      chunkDelayMs?: number;
      structured?: boolean;
      streamError?: string;
    },
    runId?: string
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
  }>;
  reconcileTwoCompletedChildrenWithThrowingFinishForTest(): Promise<{
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
    lifecycleOrder: string[];
  }>;
  inspectChild(runId: string): Promise<AgentToolRunInspection | null>;
  getChildChunks(
    runId: string,
    afterSequence?: number
  ): Promise<AgentToolStoredChunk[]>;
  getChildMessages(runId: string): Promise<ChatMessage[]>;
  startAndCancelChild(
    input: {
      prompt: string;
      delayMs?: number;
      chunkDelayMs?: number;
      structured?: boolean;
      streamError?: string;
    },
    runId?: string
  ): Promise<AgentToolRunInspection | null>;
  runChildWithTrackedAbortListener(
    input: {
      prompt: string;
      delayMs?: number;
      chunkDelayMs?: number;
      structured?: boolean;
      streamError?: string;
    },
    runId?: string
  ): Promise<{
    result: RunAgentToolResult;
    abortListenerAdded: number;
    abortListenerRemoved: number;
  }>;
  testPreAbortedForwardStreamReleasesReaderLock(): Promise<boolean>;
  forwardMalformedAgentToolStreamForTest(): Promise<AgentToolEventMessage[]>;
};

function getParent(name = crypto.randomUUID()) {
  return getAgentByName(
    (env as Env).AIChatAgentToolParent,
    name
  ) as Promise<ParentStub>;
}

describe("AIChatAgent as an agent-tool child", () => {
  it("runs an AIChatAgent child and returns summary, output, events, and chunks", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    const result = await parent.runChild({ prompt: "write the report" }, runId);

    expect(result).toMatchObject({
      runId,
      agentType: "AIChatAgentToolChild",
      status: "completed",
      summary: "AIChat child handled: write the report",
      output: "AIChat child handled: write the report"
    });

    const events = await parent.getEventsForTest();
    expect(events.map((event) => event.event.kind)).toEqual([
      "started",
      "chunk",
      "chunk",
      "chunk",
      "chunk",
      "chunk",
      "finished"
    ]);

    const inspection = await parent.inspectChild(runId);
    expect(inspection).toMatchObject({
      runId,
      status: "completed",
      summary: "AIChat child handled: write the report",
      output: "AIChat child handled: write the report"
    });
    expect(inspection?.requestId).toBeTruthy();
    expect(inspection?.streamId).toBeTruthy();

    const chunks = await parent.getChildChunks(runId);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.sequence).toBe(0);
    expect(
      chunks.some((chunk) => chunk.body.includes("write the report"))
    ).toBe(true);

    const laterChunks = await parent.getChildChunks(runId, 0);
    expect(laterChunks.every((chunk) => chunk.sequence > 0)).toBe(true);
  });

  it("finalizes lifecycle hooks and terminal events during parent recovery reconciliation", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    const { events, finishes, inspection } =
      await parent.reconcileCompletedChildForTest(
        { prompt: "recover completed child" },
        runId
      );

    expect(inspection).toMatchObject({
      runId,
      status: "completed",
      summary: "AIChat child handled: recover completed child",
      output: "AIChat child handled: recover completed child"
    });
    expect(finishes).toEqual([
      {
        run: expect.objectContaining({
          runId,
          parentToolCallId: "test-tool-call",
          agentType: "AIChatAgentToolChild",
          status: "completed",
          inputPreview: "recover completed child",
          display: { name: "test child" }
        }),
        result: expect.objectContaining({
          status: "completed",
          summary: "AIChat child handled: recover completed child"
        })
      }
    ]);
    expect(events.map((event) => event.event.kind)).toContain("finished");
    expect(events.at(-1)).toMatchObject({
      parentToolCallId: "test-tool-call",
      event: {
        kind: "finished",
        runId,
        summary: "AIChat child handled: recover completed child"
      }
    });
  });

  it("marks still-running recovered children interrupted and emits lifecycle events", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    const { events, finishes } = await parent.reconcileRunningChildForTest(
      { prompt: "still running child" },
      runId
    );

    expect(finishes).toEqual([
      {
        run: expect.objectContaining({
          runId,
          parentToolCallId: "test-tool-call",
          agentType: "AIChatAgentToolChild",
          status: "interrupted",
          inputPreview: "still running child"
        }),
        result: expect.objectContaining({
          status: "interrupted",
          error:
            "Agent tool run was still running, but live-tail reattachment is not supported in this runtime."
        })
      }
    ]);
    expect(events.at(-1)).toMatchObject({
      parentToolCallId: "test-tool-call",
      event: {
        kind: "interrupted",
        runId,
        error:
          "Agent tool run was still running, but live-tail reattachment is not supported in this runtime."
      }
    });
  });

  it("marks uninspectable recovered children interrupted and emits lifecycle events", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    const { events, finishes } =
      await parent.reconcileMissingChildForTest(runId);

    expect(finishes).toEqual([
      {
        run: expect.objectContaining({
          runId,
          parentToolCallId: "test-tool-call",
          agentType: "MissingAgentToolChild",
          status: "interrupted",
          inputPreview: "missing child"
        }),
        result: expect.objectContaining({
          status: "interrupted",
          error: "Agent tool run could not be inspected during parent recovery."
        })
      }
    ]);
    expect(events.at(-1)).toMatchObject({
      parentToolCallId: "test-tool-call",
      event: {
        kind: "interrupted",
        runId,
        error: "Agent tool run could not be inspected during parent recovery."
      }
    });
  });

  it("defers recovered finish hooks until after startup work", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    const { events, finishes, finishesBeforeDrain, lifecycleOrder } =
      await parent.reconcileCompletedChildWithDeferredFinishForTest(
        { prompt: "deferred finish child" },
        runId
      );

    expect(finishesBeforeDrain).toBe(0);
    expect(events.at(-1)).toMatchObject({
      event: { kind: "finished", runId }
    });
    expect(finishes).toHaveLength(1);
    expect(lifecycleOrder).toEqual(["after-on-start", `finish:${runId}`]);
  });

  it("skips recovered finish hooks when startup fails after internal recovery", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    const { events, finishes, deferredHookCount, lifecycleOrder } =
      await parent.reconcileCompletedChildWithFailedStartupForTest(
        { prompt: "failed startup child" },
        runId
      );

    expect(deferredHookCount).toBe(1);
    expect(finishes).toHaveLength(0);
    expect(lifecycleOrder).toEqual(["on-start-error"]);
    expect(events.at(-1)).toMatchObject({
      event: {
        kind: "finished",
        runId,
        summary: "AIChat child handled: failed startup child"
      }
    });
  });

  it("still finalizes recovery when stored chunk replay fails", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    const { events, finishes } =
      await parent.reconcileCompletedChildWithReplayFailureForTest(
        { prompt: "replay failure child" },
        runId
      );

    expect(finishes).toEqual([
      {
        run: expect.objectContaining({
          runId,
          status: "completed",
          inputPreview: "replay failure child"
        }),
        result: expect.objectContaining({
          status: "completed",
          summary: "AIChat child handled: replay failure child"
        })
      }
    ]);
    expect(events.map((event) => event.event.kind)).toEqual(["finished"]);
    expect(events.at(-1)).toMatchObject({
      event: {
        kind: "finished",
        runId,
        summary: "AIChat child handled: replay failure child"
      }
    });
  });

  it("continues draining recovered finish hooks when one hook throws", async () => {
    const parent = await getParent();

    const { finishes, lifecycleOrder } =
      await parent.reconcileTwoCompletedChildrenWithThrowingFinishForTest();

    expect(finishes).toHaveLength(2);
    expect(lifecycleOrder).toEqual(
      finishes.map(({ run }) => `finish:${run.runId}`)
    );
  });

  it("returns the retained parent registry result without re-running the child", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    const first = await parent.runChild({ prompt: "only once" }, runId);
    const second = await parent.runChild({ prompt: "changed input" }, runId);

    expect(first.status).toBe("completed");
    expect(second).toMatchObject({
      runId,
      status: "completed",
      summary: "AIChat child handled: only once"
    });

    const messages = await parent.getChildMessages(runId);
    expect(messages.filter((message) => message.role === "user")).toHaveLength(
      1
    );
    expect(
      messages
        .filter((message) => message.role === "user")
        .flatMap((message) => message.parts)
        .some((part) => part.type === "text" && part.text === "only once")
    ).toBe(true);
  });

  it("persists structured output for idempotent runId reads", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    const first = await parent.runChild(
      { prompt: "structured output", structured: true },
      runId
    );
    const second = await parent.runChild(
      { prompt: "changed input", structured: true },
      runId
    );

    expect(first).toMatchObject({
      runId,
      status: "completed",
      summary: "structured:structured output",
      output: { handledPrompt: "structured output", messageCount: 2 }
    });
    expect(second).toEqual(first);
  });

  it("marks AIChatAgent stream error chunks as failed agent-tool runs", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    const result = await parent.runChild(
      { prompt: "fail please", streamError: "model stream failed" },
      runId
    );

    expect(result).toMatchObject({
      runId,
      status: "error",
      error: "model stream failed"
    });

    const events = await parent.getEventsForTest();
    expect(events.map((event) => event.event.kind)).toContain("error");
  });

  it("propagates parent abort signals into AIChatAgent agent-tool runs", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    const result = await parent.runChildWithDelayedAbort(
      { prompt: "abort over parent signal", chunkDelayMs: 30 },
      40,
      runId
    );

    expect(result).toMatchObject({
      runId,
      status: "aborted",
      error: "test abort"
    });
  });

  it("removes the parent abort listener after a normal agent-tool run", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    const result = await parent.runChildWithTrackedAbortListener(
      { prompt: "listener cleanup" },
      runId
    );

    expect(result.result).toMatchObject({
      runId,
      status: "completed"
    });
    expect(result.abortListenerAdded).toBeGreaterThan(0);
    expect(result.abortListenerRemoved).toBe(result.abortListenerAdded);
  });

  it("does not leave a reader lock when stream forwarding starts pre-aborted", async () => {
    const parent = await getParent();

    await expect(
      parent.testPreAbortedForwardStreamReleasesReaderLock()
    ).resolves.toBe(true);
  });

  it("skips malformed agent-tool stream frames without failing forwarding", async () => {
    const parent = await getParent();

    const events = await parent.forwardMalformedAgentToolStreamForTest();

    expect(events.map((event) => event.event)).toEqual([
      expect.objectContaining({
        kind: "chunk",
        body: "first good frame"
      }),
      expect.objectContaining({
        kind: "chunk",
        body: "second good frame"
      })
    ]);
  });

  it("cancels a running AIChatAgent child run", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    const inspection = await parent.startAndCancelChild(
      { prompt: "too slow", delayMs: 250 },
      runId
    );

    expect(inspection).toMatchObject({
      runId,
      status: "aborted"
    });
  });
});
