import { describe, expect, it } from "vitest";
import {
  hasOpenCodeOperation,
  inspectOperation,
  messageText,
  projectMessages
} from "../messages";

const listed = {
  data: [
    { id: "msg_op-1", type: "user", text: "hi", time: { created: 1 } },
    {
      id: "msg_a1",
      type: "assistant",
      time: { created: 2, completed: 3 },
      content: [
        { type: "reasoning", text: "thinking" },
        {
          type: "tool",
          id: "call-1",
          name: "read",
          state: {
            status: "completed",
            input: { path: "/workspace/a" },
            content: [{ type: "text", text: "file body" }]
          }
        }
      ]
    },
    {
      id: "msg_a2",
      type: "assistant",
      time: { created: 4, completed: 5 },
      content: [{ type: "text", text: "done" }]
    },
    { id: "msg_idle", type: "idle", time: { created: 6 } }
  ],
  cursor: {}
};

describe("hasOpenCodeOperation", () => {
  it("finds the operation's user message", () => {
    expect(hasOpenCodeOperation(listed, "op-1")).toBe(true);
    expect(hasOpenCodeOperation(listed.data, "op-1")).toBe(true);
    expect(hasOpenCodeOperation(listed, "op-2")).toBe(false);
    expect(hasOpenCodeOperation(undefined, "op-1")).toBe(false);
  });
});

describe("projectMessages", () => {
  it("keeps prompts and replies, with text, reasoning, and tool parts", () => {
    expect(projectMessages(listed)).toEqual([
      {
        id: "msg_op-1",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        timestamp: 1
      },
      {
        id: "msg_a1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "thinking" },
          {
            type: "tool",
            id: "call-1",
            name: "read",
            status: "completed",
            input: { path: "/workspace/a" },
            output: "file body",
            error: undefined
          }
        ],
        timestamp: 2
      },
      {
        id: "msg_a2",
        role: "assistant",
        parts: [{ type: "text", text: "done" }],
        timestamp: 4
      }
    ]);
  });
});

describe("inspectOperation over a multi-step turn", () => {
  it("settles on the last step's reply and reads its text", () => {
    const inspected = inspectOperation(listed, "op-1");
    expect(inspected).toMatchObject({
      result: { status: "completed", messageId: "msg_a2" }
    });
    const messageId =
      typeof inspected === "object" ? inspected.result.messageId : undefined;
    expect(messageText(projectMessages(listed), messageId)).toBe("done");
  });
});
