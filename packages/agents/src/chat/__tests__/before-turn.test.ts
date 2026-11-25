import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import {
  continuationWaitsOnClient,
  replyToContinueIsEmpty,
  interruptedToolPartAsError,
  INTERRUPTED_TOOL_ERROR_TEXT,
  repairTranscriptBeforeTurn
} from "../before-turn";

type Part = UIMessage["parts"][number];

function flipToError(part: Part): Part {
  return { ...part, state: "output-error", errorText: "interrupted" } as Part;
}

const user = (id: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: id }]
});

function reply(
  id: string,
  ...parts: Array<Record<string, unknown>>
): UIMessage {
  return { id, role: "assistant", parts: parts as unknown as Part[] };
}

const call = (
  tool: string,
  toolCallId: string,
  state: string,
  extra: Record<string, unknown> = {}
) => ({ type: `tool-${tool}`, toolCallId, state, input: {}, ...extra });

const clientToolNames = new Set(["pick"]);

function repair(messages: UIMessage[], mode: { continuation: boolean }) {
  return repairTranscriptBeforeTurn(messages, {
    ...mode,
    clientToolNames,
    repairPart: flipToError
  });
}

function states(messages: UIMessage[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const message of messages) {
    for (const part of message.parts) {
      const record = part as { toolCallId?: string; state?: string };
      if (record.toolCallId) out[record.toolCallId] = record.state ?? "";
    }
  }
  return out;
}

const newReply = { continuation: false };
const continuation = { continuation: true };

describe("repairTranscriptBeforeTurn", () => {
  // A reply the conversation moved past: a later message follows it.
  const movedPast = [
    user("u1"),
    reply(
      "a1",
      call("pick", "client", "input-available"),
      call("search", "server", "input-available"),
      call("deploy", "approval", "approval-requested"),
      call("search", "streaming", "input-streaming"),
      call("search", "done", "output-available", { output: 1 })
    ),
    user("u2")
  ];

  it("settles every unanswered call in a reply the conversation moved past, whoever owns it", () => {
    const result = repair(movedPast, newReply);
    expect(states(result.messages)).toEqual({
      client: "output-error",
      server: "output-error",
      approval: "output-error",
      streaming: "output-error",
      done: "output-available"
    });
    expect(result.toolCallIds).toEqual([
      "client",
      "server",
      "approval",
      "streaming"
    ]);
  });

  it("settles them for a continuation turn too", () => {
    const messages = [
      ...movedPast,
      reply("a2", call("search", "leaf", "output-available", { output: 1 }))
    ];
    expect(states(repair(messages, continuation).messages)).toMatchObject({
      client: "output-error",
      server: "output-error",
      approval: "output-error"
    });
  });

  it("a turn that starts a new reply settles the last message the same way", () => {
    const messages = [
      user("u1"),
      reply(
        "a1",
        call("pick", "client", "input-available"),
        call("deploy", "approval", "approval-requested")
      )
    ];
    expect(states(repair(messages, newReply).messages)).toEqual({
      client: "output-error",
      approval: "output-error"
    });
  });

  it("a continuation turn keeps what a client still answers in the message it continues", () => {
    const messages = [
      user("u1"),
      reply(
        "a1",
        call("pick", "client", "input-available"),
        call("deploy", "approval", "approval-requested"),
        call("search", "server", "input-available")
      )
    ];
    const result = repair(messages, continuation);
    // The known client's call and the approval request stay. The server
    // call is dead: nothing will answer it.
    expect(states(result.messages)).toEqual({
      client: "input-available",
      approval: "approval-requested",
      server: "output-error"
    });
    expect(result.toolCallIds).toEqual(["server"]);
    // The kept calls are reported: the turn must not call the model.
    expect(result.keptToolCallIds).toEqual(["client", "approval"]);
  });

  it("reports no kept call when the turn can call the model", () => {
    expect(repair(movedPast, newReply).keptToolCallIds).toEqual([]);
    expect(repair(movedPast, continuation).keptToolCallIds).toEqual([]);
    const answered = [
      user("u1"),
      reply("a1", call("pick", "client", "output-available", { output: 1 }))
    ];
    expect(repair(answered, continuation).keptToolCallIds).toEqual([]);
  });

  it("a continuation turn keeps the approved call it is about to run", () => {
    const messages = [
      user("u1"),
      reply(
        "a1",
        call("deploy", "approved", "approval-responded", {
          approval: { id: "ap", approved: true }
        })
      )
    ];
    const result = repair(messages, continuation);
    expect(states(result.messages)).toEqual({ approved: "approval-responded" });
    expect(result.removedToolCalls).toBe(0);
    expect(result.keptToolCallIds).toEqual([]);
    // A turn that starts a new reply keeps it too: the AI SDK runs it.
    expect(states(repair(messages, newReply).messages)).toEqual({
      approved: "approval-responded"
    });
  });

  it.each([
    ["a new reply", newReply],
    ["a continuation", continuation]
  ])(
    "%s settles an approved call in a message the conversation moved past",
    (_name, mode) => {
      const messages = [
        user("u1"),
        reply(
          "a1",
          call("deploy", "approved", "approval-responded", {
            approval: { id: "ap", approved: true }
          }),
          call("deploy", "denied", "approval-responded", {
            approval: { id: "ap2", approved: false }
          })
        ),
        user("u2"),
        reply("a2", call("search", "done", "output-available", { output: 1 }))
      ];
      const result = repair(messages, mode);
      expect(states(result.messages)).toMatchObject({
        approved: "output-error",
        denied: "output-denied"
      });
    }
  );

  it("returns the same message objects when nothing changed", () => {
    const messages = [
      user("u1"),
      reply("a1", call("search", "done", "output-available", { output: 1 }))
    ];
    const result = repair(messages, newReply);
    expect(result.removedToolCalls).toBe(0);
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1]).toBe(messages[1]);
  });
});

describe("continuationWaitsOnClient", () => {
  it("is true while the last message holds a call a client still answers", () => {
    const waiting = (part: Record<string, unknown>) =>
      continuationWaitsOnClient(
        [user("u1"), reply("a1", part)],
        clientToolNames
      );

    expect(waiting(call("pick", "client", "input-available"))).toBe(true);
    expect(waiting(call("deploy", "approval", "approval-requested"))).toBe(
      true
    );
    // A server tool's call is dead, an approved call is the turn's to run,
    // and an answered call waits on nobody.
    expect(waiting(call("search", "server", "input-available"))).toBe(false);
    expect(waiting(call("deploy", "approved", "approval-responded"))).toBe(
      false
    );
    expect(
      waiting(call("pick", "done", "output-available", { output: 1 }))
    ).toBe(false);
  });

  it("looks at the last message only", () => {
    expect(
      continuationWaitsOnClient(
        [
          user("u1"),
          reply("a1", call("pick", "client", "input-available")),
          user("u2")
        ],
        clientToolNames
      )
    ).toBe(false);
    expect(continuationWaitsOnClient([], clientToolNames)).toBe(false);
  });

  it("agrees with what the repair keeps", () => {
    const messages = [
      user("u1"),
      reply(
        "a1",
        call("pick", "client", "input-available"),
        call("search", "server", "input-available")
      )
    ];
    expect(continuationWaitsOnClient(messages, clientToolNames)).toBe(
      repair(messages, { continuation: true }).keptToolCallIds.length > 0
    );
  });
});

describe("repairTranscriptBeforeTurn and reasoning", () => {
  const reasoning = { type: "reasoning", text: "Let me think", state: "done" };

  it("removes the reasoning an earlier reply and the last reply end in", () => {
    const messages = [
      user("u1"),
      reply("a1", { type: "step-start" }, reasoning),
      user("u2"),
      reply(
        "a2",
        { type: "step-start" },
        call("search", "done", "output-available", { output: 1 }),
        { type: "step-start" },
        reasoning
      )
    ];
    for (const mode of [{ continuation: false }, { continuation: true }]) {
      const result = repair(messages, mode);
      expect(result.messages[1].parts).toEqual([]);
      expect(result.messages[3].parts.map((part) => part.type)).toEqual([
        "step-start",
        "tool-search"
      ]);
      expect(result.removedReasoningParts).toBe(2);
      expect(result.removedToolCalls).toBe(0);
    }
  });
});

describe("interruptedToolPartAsError", () => {
  it("turns an unanswered call into an errored result", () => {
    expect(
      interruptedToolPartAsError(
        call("search", "server", "input-available") as unknown as Part
      )
    ).toMatchObject({
      toolCallId: "server",
      state: "output-error",
      errorText: INTERRUPTED_TOOL_ERROR_TEXT.interrupted
    });
  });

  it("says so when the call was approved and never ran", () => {
    expect(
      interruptedToolPartAsError(
        call("deploy", "approved", "approval-responded") as unknown as Part
      )
    ).toMatchObject({
      state: "output-error",
      errorText:
        "The tool call was approved but did not run before the next turn started."
    });
  });

  it("says a client's tool may still have run", () => {
    const part = call("pick", "client", "input-available") as unknown as Part;
    expect(interruptedToolPartAsError(part, { clientToolNames })).toMatchObject(
      {
        state: "output-error",
        errorText:
          "The conversation moved on before this tool call was answered. The tool may still have run."
      }
    );
    // Without the client's tool names it is an interrupted call.
    expect(interruptedToolPartAsError(part)).toMatchObject({
      errorText: INTERRUPTED_TOOL_ERROR_TEXT.interrupted
    });
    // A dynamic tool is named by `toolName`.
    expect(
      interruptedToolPartAsError(
        {
          type: "dynamic-tool",
          toolName: "pick",
          toolCallId: "d",
          state: "input-available",
          input: {}
        } as unknown as Part,
        { clientToolNames }
      )
    ).toMatchObject({
      errorText: INTERRUPTED_TOOL_ERROR_TEXT.clientNotAnswered
    });
  });

  it("says an approval the user never gave did not run", () => {
    expect(
      interruptedToolPartAsError(
        call("deploy", "approval", "approval-requested") as unknown as Part,
        { clientToolNames }
      )
    ).toMatchObject({
      state: "output-error",
      errorText:
        "The conversation moved on before this tool call was approved or denied. It did not run."
    });
  });
});

describe("a reply that holds nothing", () => {
  const reasoningOnly = (id: string): UIMessage => ({
    id,
    role: "assistant",
    parts: [{ type: "step-start" }, { type: "reasoning", text: "Let me think" }]
  });

  it("is reported for removal by a turn that starts a new reply", () => {
    const result = repair(
      [user("u1"), reasoningOnly("a1"), user("u2")],
      newReply
    );
    expect(result.emptyReplyIds).toEqual(["a1"]);
  });

  it("is reported when it is the last message of a new reply's turn", () => {
    const result = repair([user("u1"), reasoningOnly("a1")], newReply);
    expect(result.emptyReplyIds).toEqual(["a1"]);
  });

  it("is kept as the last message of a continuation turn, which writes into it", () => {
    const result = repair([user("u1"), reasoningOnly("a1")], continuation);
    expect(result.emptyReplyIds).toEqual([]);
  });

  it("is still reported in an earlier position of a continuation turn", () => {
    const result = repair(
      [
        user("u1"),
        reasoningOnly("a1"),
        user("u2"),
        reply("a2", { type: "text", text: "answer" })
      ],
      continuation
    );
    expect(result.emptyReplyIds).toEqual(["a1"]);
  });

  it("has nothing to continue", () => {
    expect(replyToContinueIsEmpty([user("u1"), reasoningOnly("a1")])).toBe(
      true
    );
    expect(replyToContinueIsEmpty([user("u1")])).toBe(false);
  });
});

describe("interruptedToolPartAsError, which text", () => {
  const textFor = (
    tool: string,
    state: string,
    names: ReadonlySet<string> | undefined = clientToolNames
  ) =>
    (
      interruptedToolPartAsError(call(tool, "c", state) as unknown as Part, {
        clientToolNames: names
      }) as { errorText?: string }
    ).errorText;

  it("tells a server tool cut off mid-run from a client's unanswered call", () => {
    // Same state, different owner.
    expect(textFor("search", "input-available")).toBe(
      INTERRUPTED_TOOL_ERROR_TEXT.interrupted
    );
    expect(textFor("pick", "input-available")).toBe(
      INTERRUPTED_TOOL_ERROR_TEXT.clientNotAnswered
    );
  });

  it("says interrupted for a client's call whose input never finished", () => {
    // The call was never handed to the client, so it was not "not answered".
    expect(textFor("pick", "input-streaming")).toBe(
      INTERRUPTED_TOOL_ERROR_TEXT.interrupted
    );
  });

  it("says a server tool cut off mid-run may still have run", () => {
    expect(INTERRUPTED_TOOL_ERROR_TEXT.interrupted).toBe(
      "The tool call was interrupted before a result was recorded. The tool may still have run."
    );
  });
});
