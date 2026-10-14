import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { answerToolCall } from "../answers";

describe("answerToolCall", () => {
  const asked = (state: string, extra: Record<string, unknown> = {}) =>
    ({
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-getLocation",
          toolCallId: "t1",
          input: {},
          state,
          approval: { id: "a1" },
          ...extra
        }
      ]
    }) as unknown as UIMessage;

  it("records a rejected approval as denied", () => {
    const answered = answerToolCall([asked("approval-requested")], {
      type: "approval-response",
      approvalId: "a1",
      approved: false
    });
    expect(answered?.parts[0]).toMatchObject({
      state: "output-denied",
      approval: { id: "a1", approved: false }
    });
  });

  it("records a client tool's result after its approval", () => {
    const answered = answerToolCall(
      [asked("approval-responded", { approval: { id: "a1", approved: true } })],
      {
        type: "tool-result",
        toolCallId: "t1",
        result: { ok: true, output: "here" }
      }
    );
    expect(answered?.parts[0]).toMatchObject({
      state: "output-available",
      output: "here"
    });
  });
});
