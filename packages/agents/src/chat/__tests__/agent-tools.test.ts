import { describe, expect, it } from "vitest";
import {
  applyAgentToolEvent,
  createAgentToolEventState,
  AgentToolProgressEmitter,
  type AgentToolEventMessage
} from "../agent-tools";
import {
  AGENT_TOOL_MILESTONE_PART,
  AGENT_TOOL_PROGRESS_PART
} from "../../agent-tool-types";

function frame(
  sequence: number,
  event: AgentToolEventMessage["event"],
  parentToolCallId = "tool-1"
): AgentToolEventMessage {
  return {
    type: "agent-tool-event",
    parentToolCallId,
    sequence,
    event
  };
}

describe("agent tool event reducer", () => {
  it("groups runs by parent tool call and preserves display order", () => {
    let state = createAgentToolEventState();
    state = applyAgentToolEvent(
      state,
      frame(0, {
        kind: "started",
        runId: "b",
        agentType: "Researcher",
        inputPreview: "second",
        order: 1
      })
    );
    state = applyAgentToolEvent(
      state,
      frame(0, {
        kind: "started",
        runId: "a",
        agentType: "Researcher",
        inputPreview: "first",
        order: 0
      })
    );

    expect(state.runsByToolCallId["tool-1"].map((run) => run.runId)).toEqual([
      "a",
      "b"
    ]);
  });

  it("applies opaque UIMessageChunk bodies to run parts", () => {
    let state = createAgentToolEventState();
    state = applyAgentToolEvent(
      state,
      frame(0, {
        kind: "started",
        runId: "r",
        agentType: "Researcher",
        order: 0
      })
    );
    state = applyAgentToolEvent(
      state,
      frame(1, {
        kind: "chunk",
        runId: "r",
        body: JSON.stringify({ type: "text-delta", delta: "hello" })
      })
    );

    expect(state.runsById.r.parts).toHaveLength(1);
    expect(state.runsById.r.parts[0]).toMatchObject({
      type: "text",
      text: "hello"
    });
  });

  it("is a pure reducer: replaying a text-delta chunk against the same prev does not double text (#1835)", () => {
    let state = createAgentToolEventState();
    state = applyAgentToolEvent(
      state,
      frame(0, {
        kind: "started",
        runId: "r",
        agentType: "Researcher",
        order: 0
      })
    );
    state = applyAgentToolEvent(
      state,
      frame(1, {
        kind: "chunk",
        runId: "r",
        body: JSON.stringify({ type: "text-delta", delta: "hello" })
      })
    );

    const prev = state;
    const deltaFrame = frame(2, {
      kind: "chunk",
      runId: "r",
      body: JSON.stringify({ type: "text-delta", delta: " world" })
    });

    // React StrictMode / dev hydration double-invokes setState updaters with the
    // SAME prev. A pure reducer must produce the same result both times and must
    // never mutate prev — otherwise the second pass appends the delta twice.
    const first = applyAgentToolEvent(prev, deltaFrame);
    const second = applyAgentToolEvent(prev, deltaFrame);

    expect(first.runsById.r.parts[0]).toMatchObject({ text: "hello world" });
    expect(second.runsById.r.parts[0]).toMatchObject({ text: "hello world" });
    // prev must be untouched by either invocation.
    expect(prev.runsById.r.parts[0]).toMatchObject({ text: "hello" });
  });

  it("projects a transient data-agent-progress chunk onto run.progress without persisting a part", () => {
    let state = createAgentToolEventState();
    state = applyAgentToolEvent(
      state,
      frame(0, {
        kind: "started",
        runId: "r",
        agentType: "Researcher",
        order: 0
      })
    );
    state = applyAgentToolEvent(
      state,
      frame(1, {
        kind: "chunk",
        runId: "r",
        body: JSON.stringify({
          type: AGENT_TOOL_PROGRESS_PART,
          transient: true,
          data: { fraction: 0.6, phase: "reading", message: "Reading…" }
        })
      })
    );

    // Transient ⇒ not appended to message parts, but projected onto progress.
    expect(state.runsById.r.parts).toHaveLength(0);
    expect(state.runsById.r.progress).toMatchObject({
      fraction: 0.6,
      phase: "reading",
      message: "Reading…"
    });
    expect(typeof state.runsById.r.progress?.at).toBe("number");

    // Latest-wins on a subsequent signal.
    state = applyAgentToolEvent(
      state,
      frame(2, {
        kind: "chunk",
        runId: "r",
        body: JSON.stringify({
          type: AGENT_TOOL_PROGRESS_PART,
          transient: true,
          data: { fraction: 1, phase: "done" }
        })
      })
    );
    expect(state.runsById.r.progress?.fraction).toBe(1);
    expect(state.runsById.r.progress?.phase).toBe("done");
  });

  it("projects durable data-agent-milestone parts onto run.milestones, deduped by sequence", () => {
    let state = createAgentToolEventState();
    state = applyAgentToolEvent(
      state,
      frame(0, {
        kind: "started",
        runId: "r",
        agentType: "Researcher",
        order: 0
      })
    );
    const milestoneFrame = (seq: number, sequence: number, name: string) =>
      frame(seq, {
        kind: "chunk",
        runId: "r",
        body: JSON.stringify({
          type: AGENT_TOOL_MILESTONE_PART,
          data: { name, sequence, at: 1000 + sequence, phase: name }
        })
      });

    state = applyAgentToolEvent(
      state,
      milestoneFrame(1, 0, "sources-gathered")
    );
    state = applyAgentToolEvent(state, milestoneFrame(2, 1, "synthesized"));
    // A replay of an already-seen milestone (same sequence) must not duplicate.
    state = applyAgentToolEvent(
      state,
      milestoneFrame(3, 0, "sources-gathered")
    );

    expect(state.runsById.r.milestones).toEqual([
      { name: "sources-gathered", sequence: 0, at: 1000 },
      { name: "synthesized", sequence: 1, at: 1001 }
    ]);
    // The milestone also reflects onto the latest progress snapshot.
    expect(state.runsById.r.progress).toMatchObject({
      milestone: "synthesized",
      phase: "synthesized"
    });
  });

  it("tracks unbound imperative runs separately", () => {
    let state = createAgentToolEventState();
    state = applyAgentToolEvent(state, {
      type: "agent-tool-event",
      sequence: 0,
      event: {
        kind: "started",
        runId: "imperative",
        agentType: "Planner",
        order: 0
      }
    });

    expect(state.unboundRuns.map((run) => run.runId)).toEqual(["imperative"]);
    expect(state.runsByToolCallId).toEqual({});
  });

  it("records distinct terminal states", () => {
    let state = createAgentToolEventState();
    state = applyAgentToolEvent(
      state,
      frame(0, {
        kind: "started",
        runId: "r",
        agentType: "Researcher",
        order: 0
      })
    );
    state = applyAgentToolEvent(
      state,
      frame(1, {
        kind: "interrupted",
        runId: "r",
        error: "parent restarted"
      })
    );

    expect(state.runsById.r.status).toBe("interrupted");
    expect(state.runsById.r.error).toBe("parent restarted");
  });

  it("propagates the typed interrupt reason and childStillRunning to run state (#1630)", () => {
    let state = createAgentToolEventState();
    state = applyAgentToolEvent(
      state,
      frame(0, {
        kind: "started",
        runId: "r",
        agentType: "Researcher",
        order: 0
      })
    );
    state = applyAgentToolEvent(
      state,
      frame(1, {
        kind: "interrupted",
        runId: "r",
        error: "the parent gave up while the child kept advancing",
        reason: "no-progress",
        childStillRunning: true
      })
    );

    // A UI must be able to branch on the machine-readable cause and whether the
    // child is still running without parsing the human-readable `error` prose.
    expect(state.runsById.r).toMatchObject({
      status: "interrupted",
      reason: "no-progress",
      childStillRunning: true
    });
  });

  it("propagates a torn-down (window-exceeded) interrupt to run state (#1630)", () => {
    let state = createAgentToolEventState();
    state = applyAgentToolEvent(
      state,
      frame(0, {
        kind: "started",
        runId: "r",
        agentType: "Researcher",
        order: 0
      })
    );
    state = applyAgentToolEvent(
      state,
      frame(1, {
        kind: "interrupted",
        runId: "r",
        error: "the parent gave up at the hard re-attach ceiling",
        reason: "window-exceeded",
        childStillRunning: false
      })
    );

    expect(state.runsById.r).toMatchObject({
      status: "interrupted",
      reason: "window-exceeded",
      childStillRunning: false
    });
  });
});

describe("AgentToolProgressEmitter", () => {
  type Broadcast = { requestId: string; body: string };
  type Persist = { runId: string; snapshot: unknown; at: number };
  type Milestone = { runId: string; name: string; data: unknown; at: number };

  function makeEmitter(
    active: { runId: string; requestId: string } | null = {
      runId: "run-1",
      requestId: "req-1"
    }
  ) {
    const broadcasts: Broadcast[] = [];
    const persists: Persist[] = [];
    const milestones: Milestone[] = [];
    const emitter = new AgentToolProgressEmitter({
      resolveActiveRun: () => active,
      broadcast: (requestId, body) => broadcasts.push({ requestId, body }),
      persistSnapshot: (runId, snapshot, at) =>
        persists.push({ runId, snapshot, at }),
      persistMilestone: (runId, name, data, at) => {
        milestones.push({ runId, name, data, at });
        return milestones.length - 1;
      }
    });
    return { emitter, broadcasts, persists, milestones };
  }

  it("is a no-op (inactive) when not running as an agent tool", () => {
    const { emitter, broadcasts, persists } = makeEmitter(null);
    expect(emitter.report({ fraction: 0.5 })).toBe("inactive");
    expect(broadcasts).toEqual([]);
    expect(persists).toEqual([]);
  });

  it("emits a transient data-agent-progress frame and persists a snapshot", () => {
    const { emitter, broadcasts, persists } = makeEmitter();
    expect(
      emitter.report({ fraction: 0.4, phase: "reading", message: "go" })
    ).toBe("emitted");
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].requestId).toBe("req-1");
    const wire = JSON.parse(broadcasts[0].body);
    expect(wire.type).toBe(AGENT_TOOL_PROGRESS_PART);
    expect(wire.transient).toBe(true);
    expect(wire.data).toMatchObject({
      fraction: 0.4,
      phase: "reading",
      message: "go"
    });
    expect(persists).toHaveLength(1);
    expect(persists[0].runId).toBe("run-1");
  });

  it("persists data only when explicitly opted in, but always sends it live", () => {
    const { emitter, broadcasts, persists } = makeEmitter();
    emitter.report({ fraction: 0.1, data: { url: "u" } });
    expect(JSON.parse(broadcasts[0].body).data.data).toEqual({ url: "u" });
    expect((persists[0].snapshot as { data?: unknown }).data).toBeUndefined();

    emitter.forget("run-1");
    emitter.report({ fraction: 1, data: { url: "u" } }, { persist: true });
    expect((persists[1].snapshot as { data?: unknown }).data).toEqual({
      url: "u"
    });
  });

  it("coalesces bursts but always flushes a fraction>=1 done frame", () => {
    const { emitter, broadcasts } = makeEmitter();
    expect(emitter.report({ fraction: 0.1 })).toBe("emitted");
    // Immediately following emit is within the coalescing window.
    expect(emitter.report({ fraction: 0.2 })).toBe("coalesced");
    // A terminal (done) frame bypasses coalescing so the final state lands.
    expect(emitter.report({ fraction: 1 })).toBe("emitted");
    expect(broadcasts).toHaveLength(2);
    expect(JSON.parse(broadcasts[1].body).data.fraction).toBe(1);
  });

  it("promotes a named milestone to a persisted frame, never coalesced", () => {
    const { emitter, broadcasts, persists, milestones } = makeEmitter();
    // A burst would normally coalesce, but a milestone must always land.
    expect(emitter.report({ fraction: 0.1 })).toBe("emitted");
    expect(
      emitter.report({ milestone: "sources-gathered", data: { sources: 2 } })
    ).toBe("emitted");

    // Persisted as a durable milestone row (not the ephemeral snapshot path).
    expect(milestones).toHaveLength(1);
    expect(milestones[0]).toMatchObject({
      runId: "run-1",
      name: "sources-gathered",
      data: { sources: 2 }
    });
    expect(persists).toHaveLength(1); // only the ephemeral progress persisted

    // Rides the stream as a PERSISTED (non-transient) milestone part carrying
    // its monotonic sequence so replay/live races dedupe.
    const wire = JSON.parse(broadcasts[1].body);
    expect(wire.type).toBe(AGENT_TOOL_MILESTONE_PART);
    expect(wire.transient).toBeUndefined();
    expect(wire.data).toMatchObject({
      name: "sources-gathered",
      sequence: 0,
      data: { sources: 2 }
    });
  });
});
