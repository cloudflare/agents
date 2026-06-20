import { describe, expect, it, vi } from "vitest";
import {
  applyAgentToolEvent,
  createAgentToolEventState,
  interceptAgentToolBroadcast,
  type AgentToolBroadcastHooks,
  type AgentToolEventMessage
} from "../agent-tools";

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
