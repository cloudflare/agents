import { describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import {
  mergeQueuedUserMessages,
  mergeUserMessages
} from "../merge-user-messages";

function user(id: string, ...parts: UIMessage["parts"]): UIMessage {
  return { id, role: "user", parts };
}

const text = (t: string) => ({ type: "text" as const, text: t });

describe("mergeUserMessages", () => {
  it("joins text with a blank line and keeps the last message's id", () => {
    const merged = mergeUserMessages([
      user("a", text("one")),
      user("b", text("two"))
    ]);
    expect(merged).toEqual(user("b", text("one\n\ntwo")));
  });

  it("keeps non-text parts in order between text runs", () => {
    const file = {
      type: "file" as const,
      mediaType: "image/png",
      url: "data:x"
    };
    const merged = mergeUserMessages([
      user("a", text("look")),
      user("b", file, text("at this"))
    ]);
    expect(merged.parts).toEqual([text("look\n\n"), file, text("at this")]);
  });

  it("does not change its inputs", () => {
    const a = user("a", text("one"));
    const b = user("b", text("two"));
    mergeUserMessages([a, b]);
    expect(a.parts).toEqual([text("one")]);
    expect(b.parts).toEqual([text("two")]);
  });

  it("throws on an empty list", () => {
    expect(() => mergeUserMessages([])).toThrow();
  });
});

describe("mergeQueuedUserMessages", () => {
  const assistant: UIMessage = {
    id: "r",
    role: "assistant",
    parts: [text("reply")]
  };

  it("merges the run of user messages that starts at the index", () => {
    const merged = mergeQueuedUserMessages(
      [
        user("q", text("q")),
        assistant,
        user("a", text("1")),
        user("b", text("2"))
      ],
      2
    );
    expect(merged).toEqual([
      user("q", text("q")),
      assistant,
      user("b", text("1\n\n2"))
    ]);
  });

  it("returns null for fewer than two queued messages", () => {
    expect(mergeQueuedUserMessages([assistant, user("a")], 1)).toBeNull();
  });

  it("warns and returns null when the index is not a user message", () => {
    const warn = vi.fn();
    expect(mergeQueuedUserMessages([assistant], 0, warn)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});
