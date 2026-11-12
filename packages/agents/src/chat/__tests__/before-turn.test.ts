import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import {
  interruptedToolPartAsError,
  repairTranscriptBeforeTurn
} from "../before-turn";
import { clientRequestContext } from "../request-context";

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

describe("interruptedToolPartAsError", () => {
  it("turns an unanswered call into an errored result", () => {
    expect(
      interruptedToolPartAsError(
        call("search", "server", "input-available") as unknown as Part
      )
    ).toMatchObject({
      toolCallId: "server",
      state: "output-error",
      errorText: "The tool call was interrupted before a result was recorded."
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
});

describe("clientRequestContext", () => {
  const tools = [{ name: "pick", description: "Pick one" }];

  it("stores the tools and body the request sent", () => {
    expect(
      clientRequestContext({ clientTools: tools, body: { model: "fast" } })
    ).toEqual({ clientTools: tools, body: { model: "fast" } });
  });

  it("stores no tools for a request that sends none, with or without the key", () => {
    expect(clientRequestContext({ body: {} })).toEqual({
      clientTools: undefined,
      body: undefined
    });
    expect(clientRequestContext({ clientTools: [] }).clientTools).toBe(
      undefined
    );
    expect(clientRequestContext({ clientTools: null }).clientTools).toBe(
      undefined
    );
  });

  it("ignores a clientTools value that is not a list", () => {
    expect(
      clientRequestContext({
        clientTools: "pick" as unknown as []
      }).clientTools
    ).toBe(undefined);
  });
});
