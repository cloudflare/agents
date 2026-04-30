import { describe, expect, it } from "vitest";
import {
  applyAgentToolEvent,
  createAgentToolEventState,
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
});
