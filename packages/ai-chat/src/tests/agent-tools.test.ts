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
import {
  AGENT_TOOL_MILESTONE_PART,
  AGENT_TOOL_PROGRESS_PART,
  getAgentByName
} from "agents";
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
    status: string | null;
  }>;
  reattachStuckTailableChildForTest(runId?: string): Promise<{
    events: AgentToolEventMessage[];
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
    elapsedMs: number;
    status: string | null;
  }>;
  reconcileMissingChildForTest(runId?: string): Promise<{
    events: AgentToolEventMessage[];
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
  }>;
  reconcileStuckChildWithTimeoutForTest(runId?: string): Promise<{
    events: AgentToolEventMessage[];
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
    elapsedMs: number;
    status: string | null;
  }>;
  scheduleStuckChildRecoveryForTest(runId?: string): Promise<{
    events: AgentToolEventMessage[];
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
    status: string | null;
  }>;
  scheduleStuckChildRecoveryTwiceForTest(runId?: string): Promise<{
    events: AgentToolEventMessage[];
    finishes: { run: AgentToolRunInfo; result: AgentToolLifecycleResult }[];
    status: string | null;
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
  runChildWithAttachRaceForTest(
    input: {
      prompt: string;
      delayMs?: number;
      chunkDelayMs?: number;
      structured?: boolean;
      streamError?: string;
    },
    raceBody: string,
    runId?: string
  ): Promise<{ result: RunAgentToolResult; events: AgentToolEventMessage[] }>;
  runChildWithProgressInjectionForTest(
    input: {
      prompt: string;
      delayMs?: number;
      chunkDelayMs?: number;
      structured?: boolean;
      streamError?: string;
    },
    progressBody: string,
    milestoneBody: string,
    runId?: string
  ): Promise<{ result: RunAgentToolResult; events: AgentToolEventMessage[] }>;
  coldCounterChildReattachForTest(): Promise<{
    drained: number[];
    liveSequenceAfterDrain: number | undefined;
    postRestart: { sequence: number; body: string } | null;
  }>;
  cancelledTailerStarvationChildForTest(): Promise<{
    siblingBodyAfterCancel: string | null;
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
  runChildWithInjectedUnrelatedError(
    input: {
      prompt: string;
      delayMs?: number;
      chunkDelayMs?: number;
      structured?: boolean;
      streamError?: string;
    },
    injectAfterMs: number,
    runId?: string
  ): Promise<RunAgentToolResult>;
  startChildWithoutTailForTest(
    input: {
      prompt: string;
      delayMs?: number;
      chunkDelayMs?: number;
      structured?: boolean;
      streamError?: string;
    },
    runId?: string
  ): Promise<AgentToolRunInspection>;
  childAgentToolRunsMapSizeForTest(runId: string): Promise<number>;
  childResolveAfterRestartForTest(
    runId: string,
    requestId: string
  ): Promise<{ running: string | null; unknown: string | null }>;
  childReconcileStaleRunViaRecoveryForTest(
    path: "continue" | "retry",
    withAssistantTurn: boolean
  ): Promise<{ before: string | null; after: string | null }>;
  childCancelAgentToolRunAbortsRecoveryForTest(): Promise<{
    abortedBefore: boolean;
    abortedAfter: boolean;
    childStatus: string | null;
  }>;
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

    // Each forwarded chunk must be an individual, unpacked chunk event — never
    // a packed segment array — and sequences must be contiguous per chunk so a
    // tailing parent can switch from stored replay to the live counter without
    // gaps. Guards the chunk-packing storage format (segment rows are unpacked
    // back into per-chunk bodies before forwarding).
    chunks.forEach((chunk, i) => {
      expect(chunk.sequence).toBe(i);
      const parsed = JSON.parse(chunk.body) as unknown;
      expect(Array.isArray(parsed)).toBe(false);
      expect(parsed).toMatchObject({ type: expect.any(String) });
    });

    const laterChunks = await parent.getChildChunks(runId, 0);
    expect(laterChunks.every((chunk) => chunk.sequence > 0)).toBe(true);
    // afterSequence is a per-chunk cursor: everything past sequence 0.
    expect(laterChunks).toEqual(chunks.slice(1));
  });

  it("forwards a chunk that lands in the tail attach window (#1589)", async () => {
    // A sub-agent that proxies a remote `toUIMessageStreamResponse()` streams
    // chunks at network pace, so a chunk routinely lands in the window between
    // the parent draining the stored backlog and attaching its live forwarder.
    // Before the fix that chunk was stored but never forwarded — it vanished
    // from the parent's stream, leaving tool parts stuck at `input-available`.
    const parent = await getParent();
    const runId = crypto.randomUUID();
    const raceBody = JSON.stringify({
      type: "tool-output-available",
      toolCallId: "race-1589",
      output: "race-output-1589"
    });

    const { result, events } = await parent.runChildWithAttachRaceForTest(
      { prompt: "proxy remote tool output", chunkDelayMs: 30 },
      raceBody,
      runId
    );

    expect(result.status).toBe("completed");

    const chunkBodies = events
      .filter((event) => event.event.kind === "chunk")
      .map((event) => (event.event as { kind: "chunk"; body: string }).body);
    expect(chunkBodies).toContain(raceBody);
  });

  it("forwards non-stored progress + milestone frames through the replay→live handoff", async () => {
    // `reportProgress()` progress + milestone frames ride the chat-response
    // wire and are forwarded to a tailing parent, but are NOT durably stored —
    // they carry no `chunk_index`. They therefore rely on the in-memory live
    // sequence counter to be forwarded: that counter is intentionally separate
    // from the resumable store's chunk_index. If forwards were sequenced off the
    // stored chunk count instead, these non-stored frames would collide with the
    // last stored chunk's sequence and the tail's high-water dedupe would
    // silently drop them — live progress/milestones would never reach the
    // parent. This lands both frames in the same drain↔register attach window
    // the #1589 fix addresses and asserts they arrive verbatim.
    const parent = await getParent();
    const runId = crypto.randomUUID();
    const progressBody = JSON.stringify({
      type: AGENT_TOOL_PROGRESS_PART,
      transient: true,
      data: { message: "halfway", fraction: 0.5 }
    });
    const milestoneBody = JSON.stringify({
      type: AGENT_TOOL_MILESTONE_PART,
      data: { name: "phase-1", sequence: 0, at: 1, data: { sources: 2 } }
    });

    const { result, events } =
      await parent.runChildWithProgressInjectionForTest(
        { prompt: "report progress while proxied", chunkDelayMs: 30 },
        progressBody,
        milestoneBody,
        runId
      );

    expect(result.status).toBe("completed");

    const chunkBodies = events
      .filter((event) => event.event.kind === "chunk")
      .map((event) => (event.event as { kind: "chunk"; body: string }).body);
    expect(chunkBodies).toContain(progressBody);
    expect(chunkBodies).toContain(milestoneBody);
  });

  it("realigns the live sequence on a cold-counter re-attach so post-restart chunks forward", async () => {
    // After the CHILD's Durable Object restarts / wakes from hibernation, its
    // in-memory live sequence map is cold while the durable backlog sits at N.
    // Chat-recovery resumes the turn and the parent re-attaches via
    // `tailAgentToolRun` WITHOUT re-running `startAgentToolRun` (which seeds the
    // counter). The tail must realign the live counter to N+1 after draining, so
    // the recovered turn's NEW broadcasts forward at N+1 instead of restarting
    // at 0 and being silently dropped by the high-water dedupe (which would
    // leave the parent stuck with no post-restart chunks).
    const parent = await getParent();

    const { drained, liveSequenceAfterDrain, postRestart } =
      await parent.coldCounterChildReattachForTest();

    // Backlog replayed in order, then the counter realigned to right after it.
    expect(drained).toEqual([0, 1, 2]);
    expect(liveSequenceAfterDrain).toBe(3);
    // The post-restart broadcast forwards at the realigned sequence (3), not 0.
    expect(postRestart).toMatchObject({
      sequence: 3,
      body: JSON.stringify({
        type: "tool-output-available",
        toolCallId: "post-restart",
        output: "ok"
      })
    });
  });

  it("does not starve sibling tailers when one tailer's consumer cancels", async () => {
    // Two parents tail the same run; one consumer cancels its reader. The
    // cancelled tailer must detach (not linger as a zombie forwarder), and the
    // tail's `controller.close()` must be guarded — otherwise the next broadcast
    // throws while emitting to the cancelled stream and that exception escapes
    // `interceptAgentToolBroadcast`'s forward loop, starving every sibling tailer
    // of the chunk. The surviving tailer must still receive the broadcast.
    const parent = await getParent();

    const { siblingBodyAfterCancel } =
      await parent.cancelledTailerStarvationChildForTest();

    expect(siblingBodyAfterCancel).toBe(
      JSON.stringify({
        type: "tool-output-available",
        toolCallId: "sibling",
        output: "ok"
      })
    );
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

  it("re-attaches a still-running recovered child and finalizes it completed (#1630)", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    const { events, finishes, status } =
      await parent.reconcileRunningChildForTest(
        { prompt: "child completes during reattach" },
        runId
      );

    expect(status).toBe("completed");
    expect(finishes).toEqual([
      {
        run: expect.objectContaining({
          runId,
          parentToolCallId: "test-tool-call",
          agentType: "AIChatAgentToolChild",
          status: "completed",
          inputPreview: "child completes during reattach"
        }),
        result: expect.objectContaining({
          status: "completed"
        })
      }
    ]);
    expect(events.map((event) => event.event.kind)).toContain("finished");
    expect(events.at(-1)).toMatchObject({
      parentToolCallId: "test-tool-call",
      event: {
        kind: "finished",
        runId
      }
    });
  });

  it("bounds re-attach when a tail-able child never reaches terminal (#1630)", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    const { finishes, elapsedMs, status } =
      await parent.reattachStuckTailableChildForTest(runId);

    expect(elapsedMs).toBeLessThan(5000);
    expect(status).toBe("interrupted");
    expect(finishes).toEqual([
      {
        run: expect.objectContaining({
          runId,
          parentToolCallId: "test-tool-call",
          agentType: "AIChatAgentToolChild",
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

  it("bounds recovery when child facet startup never completes", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    const { events, finishes, elapsedMs, status } =
      await parent.reconcileStuckChildWithTimeoutForTest(runId);

    expect(elapsedMs).toBeLessThan(1000);
    expect(status).toBe("interrupted");
    expect(finishes).toEqual([
      {
        run: expect.objectContaining({
          runId,
          parentToolCallId: "test-tool-call",
          agentType: "StuckAgentToolChild",
          status: "interrupted",
          inputPreview: "stuck child"
        }),
        result: expect.objectContaining({
          status: "interrupted",
          error: "Agent tool run inspection timed out during parent recovery."
        })
      }
    ]);
    expect(events.at(-1)).toMatchObject({
      parentToolCallId: "test-tool-call",
      event: {
        kind: "interrupted",
        runId,
        error: "Agent tool run inspection timed out during parent recovery."
      }
    });
  });

  it("runs scheduled startup recovery in the background and finalizes stale rows", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    const { events, finishes, status } =
      await parent.scheduleStuckChildRecoveryForTest(runId);

    expect(status).toBe("interrupted");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({
      run: expect.objectContaining({
        runId,
        agentType: "StuckAgentToolChild",
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

  it("keeps scheduled startup recovery single-flight", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    const { events, finishes, status } =
      await parent.scheduleStuckChildRecoveryTwiceForTest(runId);

    expect(status).toBe("interrupted");
    expect(finishes).toHaveLength(1);
    expect(
      events.filter((event) => event.event.kind === "interrupted")
    ).toHaveLength(1);
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

  it("does not contaminate a run's terminal status with an unrelated turn's error frame (#1575)", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    // While the child run streams, an error frame from an UNRELATED turn (a
    // request id that belongs to no run) is broadcast on the child. Before
    // #1575 the error was stamped onto every active forwarder's run and this
    // healthy run finalized as `error`.
    const result = await parent.runChildWithInjectedUnrelatedError(
      { prompt: "stay healthy", chunkDelayMs: 60 },
      100,
      runId
    );

    expect(result).toMatchObject({ runId, status: "completed" });
  });

  it("does not leak request-id cache entries for unrelated turns (#1575)", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    // The injected unrelated-turn error frame negatively-caches a (null)
    // entry in the child's request-id map while the run is in flight.
    const result = await parent.runChildWithInjectedUnrelatedError(
      { prompt: "stay healthy", chunkDelayMs: 60 },
      100,
      runId
    );
    expect(result).toMatchObject({ runId, status: "completed" });

    // Once the run ends and no runs remain in flight, the map must be fully
    // cleared — null entries must not accumulate for the DO's lifetime.
    expect(await parent.childAgentToolRunsMapSizeForTest(runId)).toBe(0);
  });

  it("attributes frames via the persisted request id after a DO restart (#1575)", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();
    const requestId = crypto.randomUUID();

    // The run row persisted request_id at turn start; after a restart the
    // in-memory map is empty, so attribution must fall back to SQL.
    const resolved = await parent.childResolveAfterRestartForTest(
      runId,
      requestId
    );

    expect(resolved.running).toBe(runId);
    expect(resolved.unknown).toBeNull();
  });

  it("marks an in-band stream error as error with no tailer attached (#1575)", async () => {
    const parent = await getParent();
    const runId = crypto.randomUUID();

    // The run is started directly and never tailed — terminal status must
    // come from the child turn's own result, not forwarding side effects.
    const inspection = await parent.startChildWithoutTailForTest(
      { prompt: "fail untailed", streamError: "untailed failure" },
      runId
    );

    expect(inspection).toMatchObject({
      runId,
      status: "error",
      error: "untailed failure"
    });
  });

  it("keeps concurrent child runs' error state isolated (#1575)", async () => {
    const parent = await getParent();
    const runA = crypto.randomUUID();
    const runB = crypto.randomUUID();

    const [a, b] = await Promise.all([
      parent.runChild(
        {
          prompt: "failing run",
          streamError: "run A failed",
          chunkDelayMs: 40
        },
        runA
      ),
      parent.runChild({ prompt: "healthy run", chunkDelayMs: 40 }, runB)
    ]);

    expect(a).toMatchObject({
      runId: runA,
      status: "error",
      error: "run A failed"
    });
    expect(b).toMatchObject({ runId: runB, status: "completed" });
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

  it("finalizes a stranded child run row when its own recovery CONTINUES (#1630)", async () => {
    // A recovered assistant turn → the reconcile in `_chatRecoveryContinue`'s
    // finally seals the stranded row `completed` so a re-attached parent
    // collects immediately instead of waiting out a no-progress window.
    const parent = await getParent();
    const completed = await parent.childReconcileStaleRunViaRecoveryForTest(
      "continue",
      true
    );
    expect(completed.before).toBe("running");
    expect(completed.after).toBe("completed");

    // No recovered assistant turn → the same finally seals it `error`.
    const errored = await (
      await getParent()
    ).childReconcileStaleRunViaRecoveryForTest("continue", false);
    expect(errored.before).toBe("running");
    expect(errored.after).toBe("error");
  });

  it("finalizes a stranded child run row when its own recovery RETRIES a pre-stream turn (#1630)", async () => {
    // The pre-stream-eviction path settles via `_chatRecoveryRetry`, which
    // (like continue) never hits `startAgentToolRun`'s finalizer — so its
    // finally must run the same reconcile. This is the path the earlier review
    // flagged as missing on the AIChatAgent retry branch.
    const completed = await (
      await getParent()
    ).childReconcileStaleRunViaRecoveryForTest("retry", true);
    expect(completed.before).toBe("running");
    expect(completed.after).toBe("completed");

    const errored = await (
      await getParent()
    ).childReconcileStaleRunViaRecoveryForTest("retry", false);
    expect(errored.before).toBe("running");
    expect(errored.after).toBe("error");
  });

  it("cancelAgentToolRun aborts an in-flight recovery turn and seals the child aborted (#1630)", async () => {
    const result = await (
      await getParent()
    ).childCancelAgentToolRunAbortsRecoveryForTest();
    expect(result.abortedBefore).toBe(false);
    expect(result.abortedAfter).toBe(true);
    expect(result.childStatus).toBe("aborted");
  });
});
