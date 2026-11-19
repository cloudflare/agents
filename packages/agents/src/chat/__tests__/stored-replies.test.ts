import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import { keepStoredReplies } from "../stored-replies";

const user: UIMessage = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "Count to five" }]
};

function reply(id: string, ...parts: unknown[]): UIMessage {
  return { id, role: "assistant", parts } as UIMessage;
}

const text = (value: string, state = "streaming") => ({
  type: "text",
  text: value,
  state
});

describe("keepStoredReplies", () => {
  it("keeps the stored reply when the client's copy is a chunk behind it", () => {
    const stored = reply("a1", { type: "step-start" }, text("one two three"));
    const behind = reply("a1", { type: "step-start" }, text("one two", "done"));
    const next: UIMessage = { ...user, id: "u2" };

    expect(keepStoredReplies([user, behind, next], [user, stored])).toEqual([
      user,
      stored,
      next
    ]);
  });

  it("keeps the stored reply when the client's copy misses its last parts", () => {
    const stored = reply(
      "a1",
      { type: "step-start" },
      text("one"),
      { type: "step-start" },
      { type: "reasoning", text: "thinking" }
    );
    const behind = reply("a1", { type: "step-start" }, text("one"));

    expect(keepStoredReplies([user, behind], [user, stored])).toEqual([
      user,
      stored
    ]);
  });

  it("takes the client's copy when it adds something", () => {
    const call = {
      type: "tool-ask",
      toolCallId: "c1",
      state: "input-available",
      input: {}
    };
    const stored = reply("a1", call);
    const answered = reply("a1", {
      ...call,
      state: "output-available",
      output: "yes"
    });
    const longer = reply("a2", text("one two three four"));

    expect(
      keepStoredReplies(
        [user, answered, longer],
        [user, stored, reply("a2", text("one two"))]
      )
    ).toEqual([user, answered, longer]);
  });

  it("takes the client's copy when its text differs, not only ends early", () => {
    const edited = reply("a1", text("one TWO"));
    expect(
      keepStoredReplies([user, edited], [user, reply("a1", text("one two"))])
    ).toEqual([user, edited]);
  });

  it("leaves user messages and replies the server does not have alone", () => {
    const fresh = reply("a9", text("new"));
    const input = [user, fresh];
    expect(keepStoredReplies(input, [user])).toBe(input);
  });
});
