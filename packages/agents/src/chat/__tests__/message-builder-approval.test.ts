import { describe, expect, it } from "vitest";
import {
  applyChunkToParts,
  isReplayChunk,
  type MessageParts
} from "../message-builder";

describe("approval input reconstruction (#1872)", () => {
  it("accumulates AI SDK inputTextDelta before an approval request", () => {
    const parts: MessageParts = [];
    applyChunkToParts(parts, {
      type: "tool-input-start",
      toolCallId: "call_1",
      toolName: "deleteUser"
    });
    applyChunkToParts(parts, {
      type: "tool-input-delta",
      toolCallId: "call_1",
      inputTextDelta: '{"userId":"'
    });
    applyChunkToParts(parts, {
      type: "tool-input-delta",
      toolCallId: "call_1",
      inputTextDelta: 'u_42"}'
    });
    applyChunkToParts(parts, {
      type: "tool-approval-request",
      toolCallId: "call_1",
      approvalId: "approval_1"
    });

    expect(parts[0]).toEqual(
      expect.objectContaining({
        state: "approval-requested",
        input: { userId: "u_42" },
        approval: { id: "approval_1" }
      })
    );
  });

  it("fills canonical input without regressing an earlier approval request", () => {
    const parts: MessageParts = [];
    applyChunkToParts(parts, {
      type: "tool-input-start",
      toolCallId: "call_1",
      toolName: "deleteUser"
    });
    applyChunkToParts(parts, {
      type: "tool-approval-request",
      toolCallId: "call_1",
      approvalId: "approval_1"
    });
    const available = {
      type: "tool-input-available",
      toolCallId: "call_1",
      toolName: "deleteUser",
      input: { userId: "u_42" }
    } as const;

    // The chunk remains a client-side replay: broadcasting it would regress
    // the client's approval-requested state. Server reconstruction must still
    // apply it before suppressing the broadcast.
    expect(isReplayChunk(parts, available)).toBe(true);
    applyChunkToParts(parts, available);

    expect(parts[0]).toEqual(
      expect.objectContaining({
        state: "approval-requested",
        input: { userId: "u_42" },
        approval: { id: "approval_1" }
      })
    );
  });

  it("keeps compatibility with parsed partial-input delta emitters", () => {
    const parts: MessageParts = [];
    applyChunkToParts(parts, {
      type: "tool-input-start",
      toolCallId: "call_1",
      toolName: "deleteUser"
    });
    applyChunkToParts(parts, {
      type: "tool-input-delta",
      toolCallId: "call_1",
      input: { userId: "u_42" }
    });
    applyChunkToParts(parts, {
      type: "tool-approval-request",
      toolCallId: "call_1",
      approvalId: "approval_1"
    });

    expect(parts[0]).toEqual(
      expect.objectContaining({ input: { userId: "u_42" } })
    );
  });
});
