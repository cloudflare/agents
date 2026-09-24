import { describe, expect, it } from "vitest";
import { projectEvent } from "../../opencode/events";

describe("OpenCode event projection", () => {
  it("projects current text and reasoning delta identifiers", () => {
    expect(
      projectEvent({
        type: "session.text.delta",
        data: {
          sessionID: "session",
          assistantMessageID: "assistant",
          ordinal: 2,
          delta: "hello"
        }
      })
    ).toEqual({
      type: "text_delta",
      messageId: "assistant",
      partId: "2",
      delta: "hello"
    });
    expect(
      projectEvent({
        type: "session.reasoning.delta",
        data: {
          sessionID: "session",
          assistantMessageID: "assistant",
          ordinal: 1,
          delta: "thinking"
        }
      })
    ).toEqual({
      type: "reasoning_delta",
      messageId: "assistant",
      partId: "1",
      delta: "thinking"
    });
  });

  it("projects current tool and permission identifiers", () => {
    expect(
      projectEvent({
        type: "session.tool.called",
        data: {
          sessionID: "session",
          assistantMessageID: "assistant",
          id: "call-1",
          name: "search",
          input: { query: "workers" },
          executed: false
        }
      })
    ).toEqual({
      type: "tool_start",
      toolCallId: "call-1",
      name: "search",
      input: { query: "workers" }
    });
    expect(
      projectEvent({
        type: "permission.replied",
        data: {
          sessionID: "session",
          requestID: "permission-1",
          reply: "once"
        }
      })
    ).toEqual({
      type: "permission_replied",
      permissionId: "permission-1"
    });
  });

  it("projects terminal message and tool errors", () => {
    expect(
      projectEvent({
        type: "session.step.ended",
        data: {
          sessionID: "session",
          assistantMessageID: "assistant"
        }
      })
    ).toEqual({ type: "message_end", messageId: "assistant" });
    expect(
      projectEvent({
        type: "session.tool.failed",
        data: {
          sessionID: "session",
          assistantMessageID: "assistant",
          id: "call-1",
          name: "search",
          error: { type: "tool", message: "failed" },
          executed: false
        }
      })
    ).toEqual({
      type: "tool_end",
      toolCallId: "call-1",
      name: "search",
      error: true,
      output: "failed"
    });
  });
});
