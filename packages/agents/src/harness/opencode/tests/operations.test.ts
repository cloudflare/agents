import { describe, expect, it } from "vitest";
import { inboxOperations, inspectOperation, messageIdOf } from "../messages";

/**
 * The boundary logic the lease settles on, tested against plain data.
 *
 * No host, no provider, no workerd: just the message and inbox records
 * OpenCode would have written.
 */

type Msg = {
  id: string;
  type: string;
  time?: { completed?: number };
  error?: { type?: string; message?: string };
  content?: Record<string, unknown>[];
};

function user(operationId: string): Msg {
  return { id: messageIdOf(operationId), type: "user" };
}

function assistant(
  id: string,
  options: {
    completed?: number;
    error?: { type?: string; message?: string };
    content?: Record<string, unknown>[];
  } = {}
): Msg {
  return {
    id,
    type: "assistant",
    ...(options.completed === undefined
      ? {}
      : { time: { completed: options.completed } }),
    ...(options.error === undefined ? {} : { error: options.error }),
    ...(options.content === undefined ? {} : { content: options.content })
  };
}

describe("inspectOperation", () => {
  it("reports an operation OpenCode has never seen as absent", () => {
    expect(inspectOperation([], "op-1")).toBe("absent");
    expect(inspectOperation([user("op-2")], "op-1")).toBe("absent");
  });

  it("reports a prompt with no completed reply as active", () => {
    expect(inspectOperation([user("op-1")], "op-1")).toBe("active");
    // A reply that has started but not completed is still active.
    expect(inspectOperation([user("op-1"), assistant("a-1")], "op-1")).toBe(
      "active"
    );
  });

  it("reads the result from the matching turn boundary", () => {
    // Two queued prompts, each with its own reply: op-1 must read a-1, not
    // a-2. This is what lets delivery: "queue" keep several operations open.
    const messages = [
      user("op-1"),
      assistant("a-1", { completed: 2 }),
      user("op-2"),
      assistant("a-2", { completed: 3 })
    ];

    expect(inspectOperation(messages, "op-1")).toEqual({
      result: {
        operationId: "op-1",
        status: "completed",
        messageId: "a-1",
        error: undefined
      }
    });
    expect(inspectOperation(messages, "op-2")).toEqual({
      result: {
        operationId: "op-2",
        status: "completed",
        messageId: "a-2",
        error: undefined
      }
    });
  });

  it("reports a failed reply with its reason", () => {
    const messages = [
      user("op-1"),
      assistant("a-1", {
        completed: 2,
        error: { type: "provider", message: "failed" }
      })
    ];

    expect(inspectOperation(messages, "op-1")).toEqual({
      result: {
        operationId: "op-1",
        status: "failed",
        messageId: "a-1",
        error: { code: "provider", message: "failed" }
      }
    });
  });

  it("does not read past the next user message", () => {
    // op-1 was interrupted and never answered; op-2's reply is not its own.
    const messages = [
      user("op-1"),
      user("op-2"),
      assistant("a-2", { completed: 3 })
    ];
    expect(inspectOperation(messages, "op-1")).toBe("active");
  });

  it("accepts the shapes the SDK returns", () => {
    const expected = {
      result: {
        operationId: "op-1",
        status: "completed",
        messageId: "a-1",
        error: undefined
      }
    };
    const messages = [user("op-1"), assistant("a-1", { completed: 2 })];
    expect(inspectOperation({ data: messages }, "op-1")).toEqual(expected);
    expect(inspectOperation(messages, "op-1")).toEqual(expected);
  });
});

describe("inboxOperations", () => {
  function item(
    id: string,
    options: { text?: string; created?: number; type?: string } = {}
  ) {
    return {
      id,
      sessionID: "ses_1",
      type: options.type ?? "user",
      payload: { text: options.text ?? "hi" },
      time: { created: options.created ?? 0 },
      delivery: "queue"
    };
  }

  it("returns our queued prompts oldest first, with their text", () => {
    // The text matters: re-sending a prompt needs it, because OpenCode's
    // schema requires `text` even when the id already exists.
    expect(
      inboxOperations([
        item(messageIdOf("op-2"), { text: "second", created: 20 }),
        item(messageIdOf("op-1"), { text: "first", created: 10 })
      ])
    ).toEqual([
      {
        operationId: "op-1",
        inboxId: messageIdOf("op-1"),
        text: "first",
        submittedAt: 10
      },
      {
        operationId: "op-2",
        inboxId: messageIdOf("op-2"),
        text: "second",
        submittedAt: 20
      }
    ]);
  });

  it("ignores items that are not ours", () => {
    // Steering text gets a random id, and compaction/synthetic items are
    // not user prompts. An inboxID with no msg_ prefix is somebody else's.
    expect(
      inboxOperations([
        item("itm_steer", { text: "steer" }),
        item(messageIdOf("op-1"), { type: "compaction" }),
        item(messageIdOf("op-2"), { type: "synthetic" })
      ])
    ).toEqual([]);
  });

  it("accepts the shapes the SDK returns", () => {
    const rows = [item(messageIdOf("op-1"))];
    expect(inboxOperations(rows)).toHaveLength(1);
    expect(inboxOperations({ data: rows })).toHaveLength(1);
    expect(inboxOperations({ items: rows })).toHaveLength(1);
    expect(inboxOperations(undefined)).toEqual([]);
  });
});
