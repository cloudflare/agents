import { describe, expect, it } from "vitest";
import {
  applyChunkToParts,
  applyLateToolInput,
  isLateToolInputChunk,
  isReplayChunk,
  lateToolInputForwardChunks,
  type MessagePart,
  type StreamChunkData
} from "../message-builder";

const INPUT = { id: "res-1", data: { approval_flow: "two-step" } };
const INPUT_JSON = JSON.stringify(INPUT);

const start: StreamChunkData = {
  type: "tool-input-start",
  toolCallId: "tc1",
  toolName: "update_thing"
};
const deltas: StreamChunkData[] = [
  {
    type: "tool-input-delta",
    toolCallId: "tc1",
    inputTextDelta: INPUT_JSON.slice(0, 20)
  },
  {
    type: "tool-input-delta",
    toolCallId: "tc1",
    inputTextDelta: INPUT_JSON.slice(20)
  }
];
const inputAvailable: StreamChunkData = {
  type: "tool-input-available",
  toolCallId: "tc1",
  toolName: "update_thing",
  input: INPUT
};
const approvalRequest: StreamChunkData = {
  type: "tool-approval-request",
  toolCallId: "tc1",
  approvalId: "ap1"
};

/** The `_streamSSEReply` pipeline: skip replays, apply everything else. */
function applyStream(chunks: StreamChunkData[]): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const chunk of chunks) {
    if (isReplayChunk(parts, chunk)) {
      applyLateToolInput(parts, chunk);
      continue;
    }
    applyChunkToParts(parts, chunk);
  }
  return parts;
}

function toolPart(parts: MessagePart[]): Record<string, unknown> {
  return parts[0] as Record<string, unknown>;
}

describe("tool input around approval requests (#1872)", () => {
  it("keeps the canonical input in the normal order", () => {
    const part = toolPart(
      applyStream([start, ...deltas, inputAvailable, approvalRequest])
    );
    expect(part.state).toBe("approval-requested");
    expect(part.input).toEqual(INPUT);
  });

  it("recovers the input from deltas when tool-input-available never arrives", () => {
    const part = toolPart(applyStream([start, ...deltas, approvalRequest]));
    expect(part.state).toBe("approval-requested");
    expect(part.input).toEqual(INPUT);
  });

  it("fills the input from a tool-input-available that follows the approval request", () => {
    const part = toolPart(
      applyStream([start, approvalRequest, inputAvailable])
    );
    expect(part.state).toBe("approval-requested");
    expect(part.approval).toEqual({ id: "ap1" });
    expect(part.input).toEqual(INPUT);
  });

  it("lets the canonical input replace one reconstructed from truncated deltas", () => {
    const part = toolPart(
      applyStream([start, deltas[0], approvalRequest, inputAvailable])
    );
    expect(part.input).toEqual(INPUT);
  });

  it("never replaces a complete input once the approval was requested", () => {
    const parts = applyStream([
      start,
      ...deltas,
      inputAvailable,
      approvalRequest
    ]);
    const changed = applyLateToolInput(parts, {
      ...inputAvailable,
      input: { id: "other" }
    });
    expect(changed).toBe(false);
    expect(toolPart(parts).input).toEqual(INPUT);
  });

  it("does not write partial delta text into the part's input", () => {
    const parts = applyStream([start, deltas[0]]);
    expect(toolPart(parts).state).toBe("input-streaming");
    expect(toolPart(parts).input).toBeUndefined();
  });

  it("still accepts a parsed input on delta chunks from older emitters", () => {
    const parts = applyStream([
      start,
      { type: "tool-input-delta", toolCallId: "tc1", input: { id: "res" } }
    ]);
    expect(toolPart(parts).input).toEqual({ id: "res" });
  });

  it("ignores deltas replayed after the input is complete", () => {
    const parts = applyStream([start, ...deltas, inputAvailable, ...deltas]);
    expect(toolPart(parts).state).toBe("input-available");
    expect(toolPart(parts).input).toEqual(INPUT);
  });

  it("classifies only tool-input-available on an approval part as late input", () => {
    const parts = applyStream([start, approvalRequest]);
    expect(isLateToolInputChunk(parts, inputAvailable)).toBe(true);
    expect(isLateToolInputChunk(parts, deltas[0])).toBe(false);
    expect(isLateToolInputChunk([], inputAvailable)).toBe(false);
    const streaming = applyStream([start]);
    expect(isLateToolInputChunk(streaming, inputAvailable)).toBe(false);
  });

  it("keeps the approval state when a late input arrives on a direct apply", () => {
    // Think applies every chunk through the accumulator, without isReplayChunk.
    const parts: MessagePart[] = [];
    for (const chunk of [start, approvalRequest, inputAvailable]) {
      applyChunkToParts(parts, chunk);
    }
    expect(toolPart(parts).state).toBe("approval-requested");
    expect(toolPart(parts).input).toEqual(INPUT);
  });

  it("lets the canonical input replace a partial input from an older emitter's delta", () => {
    const part = toolPart(
      applyStream([
        start,
        { type: "tool-input-delta", toolCallId: "tc1", input: { id: "res" } },
        approvalRequest,
        inputAvailable
      ])
    );
    expect(part.state).toBe("approval-requested");
    expect(part.input).toEqual(INPUT);
  });

  it("forwards the late input followed by the approval request again", () => {
    const parts = applyStream([start, approvalRequest, inputAvailable]);
    expect(lateToolInputForwardChunks(parts, inputAvailable)).toEqual([
      { ...inputAvailable, input: INPUT },
      { type: "tool-approval-request", approvalId: "ap1", toolCallId: "tc1" }
    ]);
    const annotated = { ...approvalRequest, approvalDescriptor: { a: 1 } };
    expect(
      lateToolInputForwardChunks(parts, inputAvailable, annotated)[1]
    ).toBe(annotated);
  });

  it("rebuilds the approval with its input from the forwarded chunks", () => {
    // What stream replay and orphan reconstruction see.
    const live = applyStream([start, approvalRequest, inputAvailable]);
    const stored = [
      start,
      approvalRequest,
      ...lateToolInputForwardChunks(live, inputAvailable)
    ];
    const replayed: MessagePart[] = [];
    for (const chunk of stored) applyChunkToParts(replayed, chunk);
    expect(toolPart(replayed)).toMatchObject({
      state: "approval-requested",
      approval: { id: "ap1" },
      input: INPUT
    });
  });

  it("forwards nothing once the approval has been responded to", () => {
    const parts = applyStream([start, approvalRequest]);
    (parts[0] as Record<string, unknown>).state = "approval-responded";
    expect(lateToolInputForwardChunks(parts, inputAvailable)).toEqual([]);
  });
});
