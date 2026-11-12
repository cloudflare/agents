import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import {
  clientRequestContext,
  keptByContinuationRepair,
  repairTranscriptBeforeTurn,
  type BeforeTurnRepairMode
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

function repair(messages: UIMessage[], mode: BeforeTurnRepairMode) {
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

const newReply = { continuation: false, continuationWaiting: false };
const continuation = { continuation: true, continuationWaiting: false };

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
  });

  it("a continuation turn keeps the approved call it is about to run", () => {
    const approved = call("deploy", "approved", "approval-responded", {
      approval: { id: "ap", approved: true }
    });
    const earlier = call("deploy", "earlier", "approval-responded", {
      approval: { id: "ap0", approved: true }
    });
    const messages = [
      user("u0"),
      reply("a0", earlier),
      user("u1"),
      reply("a1", approved)
    ];
    const result = repair(messages, continuation);
    expect(states(result.messages)).toEqual({
      earlier: "approval-responded",
      approved: "approval-responded"
    });
    expect(result.removedToolCalls).toBe(0);
  });

  it("a new reply settles an approved call in an earlier message, unless a continuation waits", () => {
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
      user("u2")
    ];
    expect(states(repair(messages, newReply).messages)).toEqual({
      approved: "output-error",
      denied: "output-denied"
    });
    expect(
      states(
        repair(messages, { continuation: false, continuationWaiting: true })
          .messages
      )
    ).toEqual({
      approved: "approval-responded",
      denied: "approval-responded"
    });
  });

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

describe("keptByContinuationRepair", () => {
  const part = call("pick", "client", "input-available");

  it("is true only for a continuation turn's last message and a call a client owns", () => {
    const base = { continuation: true, isLastMessage: true, clientToolNames };
    expect(keptByContinuationRepair(part, base)).toBe(true);
    expect(
      keptByContinuationRepair(part, { ...base, continuation: false })
    ).toBe(false);
    expect(
      keptByContinuationRepair(part, { ...base, isLastMessage: false })
    ).toBe(false);
    expect(
      keptByContinuationRepair(
        call("search", "server", "input-available"),
        base
      )
    ).toBe(false);
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
