import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { keepStoredReplies } from "../stored-replies";

const user = (id: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: "question" }]
});
const reply = (id: string, ...parts: UIMessage["parts"]): UIMessage => ({
  id,
  role: "assistant",
  parts
});
const text = (value: string): UIMessage["parts"][number] => ({
  type: "text",
  text: value
});
const tool = (
  state: "input-available" | "output-available",
  output?: unknown
): UIMessage["parts"][number] =>
  ({
    type: "tool-search",
    toolCallId: "call-1",
    state,
    input: { query: "porto" },
    ...(output !== undefined && { output })
  }) as UIMessage["parts"][number];

describe("keepStoredReplies", () => {
  it("keeps the stored reply when the client's copy is a prefix of it", () => {
    const stored = [user("u1"), reply("a1", text("One, two, three"))];
    const incoming = [user("u1"), reply("a1", text("One, two"))];

    const result = keepStoredReplies(incoming, stored);

    expect(result[1]).toBe(stored[1]);
    expect(result[0]).toBe(incoming[0]);
  });

  it("keeps the stored reply when the client's copy has fewer parts", () => {
    const stored = [
      reply("a1", { type: "step-start" }, text("Hi"), { type: "step-start" })
    ];
    const incoming = [reply("a1", { type: "step-start" }, text("Hi"))];

    expect(keepStoredReplies(incoming, stored)[0]).toBe(stored[0]);
  });

  it("stores a copy with more parts than the stored one", () => {
    const stored = [reply("a1", text("Hi"))];
    const incoming = [reply("a1", text("Hi"), text("more"))];

    expect(keepStoredReplies(incoming, stored)).toBe(incoming);
  });

  it("stores a copy whose tool part the client settled", () => {
    // A tab applied a client tool's output. The stored copy does not have
    // it, so it does not cover the incoming one: the output is kept.
    const stored = [reply("a1", tool("input-available"))];
    const incoming = [reply("a1", tool("output-available", { ok: true }))];

    expect(keepStoredReplies(incoming, stored)).toBe(incoming);
  });

  it("stores a copy that changes any part, not only the last", () => {
    const stored = [reply("a1", text("One"), tool("input-available"))];
    const incoming = [reply("a1", text("One"), tool("output-available", 1))];

    expect(keepStoredReplies(incoming, stored)).toBe(incoming);
    expect(
      keepStoredReplies([reply("a1", text("Uno"))], [reply("a1", text("One"))])
    ).toEqual([reply("a1", text("Uno"))]);
  });

  it("stores a copy whose part has another type at the same place", () => {
    const stored = [reply("a1", text("Hi"))];
    const incoming = [
      reply("a1", {
        type: "reasoning",
        text: "Hi"
      } as UIMessage["parts"][number])
    ];

    expect(keepStoredReplies(incoming, stored)).toBe(incoming);
  });

  it("covers reasoning by prefix, like text", () => {
    const reasoning = (value: string) =>
      ({ type: "reasoning", text: value }) as UIMessage["parts"][number];
    const stored = [reply("a1", reasoning("Thinking it through"))];

    expect(
      keepStoredReplies([reply("a1", reasoning("Thinking"))], stored)[0]
    ).toBe(stored[0]);
    expect(
      keepStoredReplies([reply("a1", reasoning("Other"))], stored)
    ).toHaveLength(1);
    expect(
      keepStoredReplies([reply("a1", reasoning("Other"))], stored)[0]
    ).not.toBe(stored[0]);
  });

  it("does not take a text part with no text in the stored copy as covering", () => {
    const stored = [
      reply("a1", { type: "text" } as unknown as UIMessage["parts"][number])
    ];
    const incoming = [reply("a1", text(""))];

    expect(keepStoredReplies(incoming, stored)).toBe(incoming);
  });

  it("compares other parts by value, whatever their key order", () => {
    const stored = [
      reply("a1", {
        type: "tool-search",
        toolCallId: "call-1",
        state: "output-available",
        input: { b: 2, a: 1 },
        output: [1, { y: null, x: "z" }]
      } as UIMessage["parts"][number])
    ];
    const reordered = [
      reply("a1", {
        output: [1, { x: "z", y: null }],
        input: { a: 1, b: 2 },
        state: "output-available",
        toolCallId: "call-1",
        type: "tool-search",
        providerMetadata: undefined
      } as UIMessage["parts"][number])
    ];

    expect(keepStoredReplies(reordered, stored)[0]).toBe(stored[0]);
  });

  it("compares nested values, not only their keys", () => {
    const part = (output: unknown) =>
      ({
        type: "tool-search",
        toolCallId: "call-1",
        state: "output-available",
        input: {},
        output
      }) as UIMessage["parts"][number];
    const stored = [reply("a1", part({ rows: [1, 2] }))];

    for (const output of [
      { rows: [1, 3] },
      { rows: [1] },
      { rows: "1,2" },
      { rows: [1, 2], more: true },
      null
    ]) {
      expect(
        keepStoredReplies([reply("a1", part(output))], stored)[0]
      ).not.toBe(stored[0]);
    }
  });

  it("leaves user messages and replies with no stored copy alone", () => {
    const stored = [reply("a1", text("stored"))];
    const incoming = [user("a1"), reply("a2", text("new"))];

    expect(keepStoredReplies(incoming, stored)).toBe(incoming);
  });

  it("never replaces a message with a stored message of another role", () => {
    // Ids can collide across roles. A user message is never a reply's copy.
    const storedUser: UIMessage = {
      id: "x",
      role: "user",
      parts: [text("Hello there")]
    };
    expect(
      keepStoredReplies([reply("x", text("Hello"))], [storedUser])[0]
    ).not.toBe(storedUser);

    const storedReply = reply("y", text("question, and more"));
    const incomingUser: UIMessage = {
      id: "y",
      role: "user",
      parts: [text("question")]
    };
    expect(keepStoredReplies([incomingUser], [storedReply])[0]).toBe(
      incomingUser
    );
  });

  it("compares a missing array item as null, as JSON stores it", () => {
    const part = (output: unknown) =>
      ({
        type: "tool-search",
        toolCallId: "call-1",
        state: "output-available",
        input: {},
        output
      }) as UIMessage["parts"][number];
    const stored = [reply("a1", part([null, 1]))];

    expect(
      keepStoredReplies([reply("a1", part([undefined, 1]))], stored)[0]
    ).toBe(stored[0]);
  });

  it("returns the incoming array itself when nothing is stored", () => {
    const incoming = [reply("a1", text("Hi"))];

    expect(keepStoredReplies(incoming, [user("u1")])).toBe(incoming);
  });

  it("replaces each covered reply and keeps the rest", () => {
    const stored = [
      reply("a1", text("first, whole")),
      user("u2"),
      reply("a2", text("second, whole"))
    ];
    const incoming = [
      reply("a1", text("first")),
      user("u2"),
      reply("a2", text("second, edited"))
    ];

    const result = keepStoredReplies(incoming, stored);

    expect(result[0]).toBe(stored[0]);
    expect(result[1]).toBe(incoming[1]);
    expect(result[2]).toBe(incoming[2]);
  });
});
