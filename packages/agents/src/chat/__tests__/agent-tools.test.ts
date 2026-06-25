import { describe, expect, it, vi } from "vitest";
import {
  applyAgentToolEvent,
  createAgentToolEventState,
  interceptAgentToolBroadcast,
  AgentToolProgressEmitter,
  type AgentToolBroadcastHooks,
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

describe("interceptAgentToolBroadcast", () => {
  const RESPONSE_TYPE = "cf_agent_use_chat_response";

  type Chunk = { sequence: number; body: string };

  function makeHooks(runForRequest: (requestId: string) => string | null) {
    const forwarders = new Map<string, Set<(chunk: Chunk) => void>>();
    const liveSequences = new Map<string, number>();
    const lastErrors = new Map<string, string>();
    const spy = vi.fn(runForRequest);
    const hooks: AgentToolBroadcastHooks = {
      forwarders,
      liveSequences,
      lastErrors,
      responseType: RESPONSE_TYPE,
      runForRequest: spy
    };
    return { hooks, forwarders, liveSequences, lastErrors, runForRequest: spy };
  }

  function frame(fields: Record<string, unknown>): string {
    return JSON.stringify({ type: RESPONSE_TYPE, ...fields });
  }

  it("forwards body chunks to the run's tailers with an incrementing sequence", () => {
    const { hooks, forwarders, liveSequences } = makeHooks(() => "run-1");
    const received: Chunk[] = [];
    forwarders.set("run-1", new Set([(c) => received.push(c)]));

    interceptAgentToolBroadcast(frame({ id: "req-1", body: "hello" }), hooks);
    interceptAgentToolBroadcast(frame({ id: "req-1", body: "world" }), hooks);

    expect(received).toEqual([
      { sequence: 0, body: "hello" },
      { sequence: 1, body: "world" }
    ]);
    expect(liveSequences.get("run-1")).toBe(2);
  });

  it("advances the live sequence even with no tailer attached", () => {
    const { hooks, liveSequences } = makeHooks(() => "run-1");
    // Gate opens via an existing live sequence (run in flight, no tailer yet).
    liveSequences.set("run-1", 0);

    interceptAgentToolBroadcast(frame({ id: "req-1", body: "a" }), hooks);

    expect(liveSequences.get("run-1")).toBe(1);
  });

  it("captures an error body into lastErrors", () => {
    const { hooks, forwarders, lastErrors, liveSequences } = makeHooks(
      () => "run-1"
    );
    forwarders.set("run-1", new Set());

    interceptAgentToolBroadcast(
      frame({ id: "req-1", error: true, body: "boom" }),
      hooks
    );

    expect(lastErrors.get("run-1")).toBe("boom");
    // An error frame is not progress: the live sequence must not advance.
    expect(liveSequences.has("run-1")).toBe(false);
  });

  it("ignores frames whose type is not the response type", () => {
    const { hooks, forwarders } = makeHooks(() => "run-1");
    const received: Chunk[] = [];
    forwarders.set("run-1", new Set([(c) => received.push(c)]));

    interceptAgentToolBroadcast(
      JSON.stringify({ type: "other", id: "req-1", body: "x" }),
      hooks
    );

    expect(received).toEqual([]);
  });

  it("ignores frames with a non-string id", () => {
    const { hooks, forwarders, runForRequest } = makeHooks(() => "run-1");
    forwarders.set("run-1", new Set());

    interceptAgentToolBroadcast(frame({ id: 42, body: "x" }), hooks);

    expect(runForRequest).not.toHaveBeenCalled();
  });

  it("leaves frames alone when the request maps to no run", () => {
    const { hooks, forwarders, liveSequences } = makeHooks(() => null);
    forwarders.set("run-1", new Set());

    interceptAgentToolBroadcast(frame({ id: "req-x", body: "x" }), hooks);

    expect(liveSequences.size).toBe(0);
  });

  it("short-circuits with no forwarders and no live sequences", () => {
    const { hooks, runForRequest } = makeHooks(() => "run-1");

    interceptAgentToolBroadcast(frame({ id: "req-1", body: "x" }), hooks);

    expect(runForRequest).not.toHaveBeenCalled();
  });

  it("passes through non-string frames without throwing", () => {
    const { hooks, forwarders, runForRequest } = makeHooks(() => "run-1");
    forwarders.set("run-1", new Set());

    expect(() =>
      interceptAgentToolBroadcast(new ArrayBuffer(8), hooks)
    ).not.toThrow();
    expect(runForRequest).not.toHaveBeenCalled();
  });

  it("passes through unparseable frames without throwing", () => {
    const { hooks, forwarders } = makeHooks(() => "run-1");
    forwarders.set("run-1", new Set());

    expect(() => interceptAgentToolBroadcast("not json{", hooks)).not.toThrow();
  });

  it("ignores an empty body (no chunk, no sequence advance)", () => {
    const { hooks, forwarders, liveSequences } = makeHooks(() => "run-1");
    const received: Chunk[] = [];
    forwarders.set("run-1", new Set([(c) => received.push(c)]));

    interceptAgentToolBroadcast(frame({ id: "req-1", body: "" }), hooks);

    expect(received).toEqual([]);
    expect(liveSequences.has("run-1")).toBe(false);
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
