import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import {
  persistRepairedTranscript,
  repairInterruptedToolParts,
  settleInterruptedReply,
  settleReplyBeforeRecovery,
  streamChunksFinished,
  toolPartHasSettledResult,
  unsettledToolCallIds,
  type RepairedTranscriptSink
} from "../repair-transcript";

type ChatMessage = UIMessage;

function flipToError(
  part: UIMessage["parts"][number]
): UIMessage["parts"][number] {
  return {
    ...part,
    state: "output-error",
    errorText: "The tool call was interrupted before a result was recorded."
  } as UIMessage["parts"][number];
}

function repair(messages: ChatMessage[]) {
  return repairInterruptedToolParts(messages, { repairPart: flipToError });
}

function toolMsg(
  id: string,
  part: Record<string, unknown>,
  role: "assistant" | "user" = "assistant"
): ChatMessage {
  return {
    id,
    role,
    parts: [part as unknown as ChatMessage["parts"][number]]
  } as ChatMessage;
}

describe("toolPartHasSettledResult", () => {
  it("treats output/result fields and terminal states as settled", () => {
    expect(toolPartHasSettledResult({ output: 1 })).toBe(true);
    expect(toolPartHasSettledResult({ result: 1 })).toBe(true);
    expect(toolPartHasSettledResult({ state: "output-available" })).toBe(true);
    expect(toolPartHasSettledResult({ state: "output-error" })).toBe(true);
    expect(toolPartHasSettledResult({ state: "output-denied" })).toBe(true);
  });

  it("treats in-flight states as unsettled", () => {
    expect(toolPartHasSettledResult({ state: "input-available" })).toBe(false);
    expect(toolPartHasSettledResult({ state: "input-streaming" })).toBe(false);
    expect(toolPartHasSettledResult({})).toBe(false);
  });
});

describe("repairInterruptedToolParts", () => {
  it("flips an interrupted (input-available) tool call to the repaired shape", () => {
    const messages = [
      toolMsg("a1", {
        type: "tool-search",
        toolCallId: "tc1",
        toolName: "search",
        state: "input-available",
        input: { q: "cats" }
      })
    ];
    const result = repair(messages);
    expect(result.removedToolCalls).toBe(1);
    expect(result.toolCallIds).toEqual(["tc1"]);
    const part = result.messages[0].parts[0] as Record<string, unknown>;
    expect(part.state).toBe("output-error");
    expect(part.errorText).toContain("interrupted");
    // Input preserved (already a valid object).
    expect(part.input).toEqual({ q: "cats" });
  });

  it("leaves settled tool calls untouched and returns the original reference", () => {
    const messages = [
      toolMsg("a1", {
        type: "tool-search",
        toolCallId: "tc1",
        toolName: "search",
        state: "output-available",
        input: { q: "cats" },
        output: { hits: 1 }
      })
    ];
    const result = repair(messages);
    expect(result.removedToolCalls).toBe(0);
    expect(result.normalizedInputs).toBe(0);
    // Unchanged message keeps its identity for cheap persist diffing.
    expect(result.messages[0]).toBe(messages[0]);
  });

  it("preserves an approval-responded tool call verbatim", () => {
    const messages = [
      toolMsg("a1", {
        type: "tool-deploy",
        toolCallId: "tc1",
        toolName: "deploy",
        state: "approval-responded",
        input: { env: "prod" }
      })
    ];
    const result = repair(messages);
    expect(result.removedToolCalls).toBe(0);
    expect(result.messages[0]).toBe(messages[0]);
    const part = result.messages[0].parts[0] as Record<string, unknown>;
    expect(part.state).toBe("approval-responded");
  });

  describe("repairApprovalResponded (#2382)", () => {
    function approvalMsg(approved: boolean): ChatMessage {
      return toolMsg("a1", {
        type: "tool-deploy",
        toolCallId: "tc1",
        toolName: "deploy",
        state: "approval-responded",
        input: { env: "prod" },
        approval: { id: "ap1", approved }
      });
    }
    const thanks = {
      id: "u2",
      role: "user",
      parts: [{ type: "text", text: "thanks" }]
    } as ChatMessage;

    function repairApprovals(messages: ChatMessage[]) {
      return repairInterruptedToolParts(messages, {
        repairPart: flipToError,
        repairApprovalResponded: true
      });
    }

    it("repairs an approved call a later message moved past", () => {
      const result = repairApprovals([approvalMsg(true), thanks]);
      expect(result.removedToolCalls).toBe(1);
      expect(result.toolCallIds).toEqual(["tc1"]);
      const part = result.messages[0].parts[0] as Record<string, unknown>;
      expect(part.state).toBe("output-error");
      expect(part.input).toEqual({ env: "prod" });
      expect(result.messages[1]).toBe(thanks);
    });

    it("settles a denied call as output-denied instead of an error", () => {
      const result = repairApprovals([approvalMsg(false), thanks]);
      const part = result.messages[0].parts[0] as Record<string, unknown>;
      expect(part.state).toBe("output-denied");
      expect(part.approval).toEqual({ id: "ap1", approved: false });
      expect(part.errorText).toBeUndefined();
    });

    it("keeps an approval in the last message, which the next inference executes", () => {
      const messages = [approvalMsg(true)];
      const result = repairApprovals(messages);
      expect(result.removedToolCalls).toBe(0);
      expect(result.messages[0]).toBe(messages[0]);
    });

    it("keeps approvals when the option is off", () => {
      const messages = [approvalMsg(true), thanks];
      const result = repair(messages);
      expect(result.removedToolCalls).toBe(0);
      expect(result.messages[0]).toBe(messages[0]);
    });

    it("still respects shouldRepair for an approved call", () => {
      const result = repairInterruptedToolParts([approvalMsg(true), thanks], {
        repairPart: flipToError,
        repairApprovalResponded: true,
        shouldRepair: () => false
      });
      expect(result.removedToolCalls).toBe(0);
    });
  });

  it("normalizes a malformed input on a settled tool call without re-erroring it", () => {
    const messages = [
      toolMsg("a1", {
        type: "tool-search",
        toolCallId: "tc1",
        toolName: "search",
        state: "output-available",
        input: '{"q":"cats"}',
        output: { hits: 1 }
      })
    ];
    const result = repair(messages);
    expect(result.removedToolCalls).toBe(0);
    expect(result.normalizedInputs).toBe(1);
    const part = result.messages[0].parts[0] as Record<string, unknown>;
    expect(part.state).toBe("output-available");
    expect(part.input).toEqual({ q: "cats" });
  });

  it("normalizes a non-object input on an interrupted tool call before repairing", () => {
    const messages = [
      toolMsg("a1", {
        type: "tool-search",
        toolCallId: "tc1",
        toolName: "search",
        state: "input-available",
        input: ""
      })
    ];
    const result = repair(messages);
    expect(result.removedToolCalls).toBe(1);
    expect(result.normalizedInputs).toBe(1);
    const part = result.messages[0].parts[0] as Record<string, unknown>;
    expect(part.state).toBe("output-error");
    expect(part.input).toEqual({});
  });

  it("handles dynamic-tool parts", () => {
    const messages = [
      toolMsg("a1", {
        type: "dynamic-tool",
        toolCallId: "tc1",
        toolName: "whatever",
        state: "input-available",
        input: {}
      })
    ];
    const result = repair(messages);
    expect(result.removedToolCalls).toBe(1);
    const part = result.messages[0].parts[0] as Record<string, unknown>;
    expect(part.state).toBe("output-error");
  });

  it("leaves non-tool parts untouched", () => {
    const messages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "hello" },
          {
            type: "tool-search",
            toolCallId: "tc1",
            toolName: "search",
            state: "input-available",
            input: {}
          }
        ]
      } as unknown as ChatMessage
    ];
    const result = repair(messages);
    const parts = result.messages[0].parts as Record<string, unknown>[];
    expect(parts[0]).toEqual({ type: "text", text: "hello" });
    expect(parts[1].state).toBe("output-error");
  });

  it("supports a custom repairPart hook (e.g. converting to a text part)", () => {
    const messages = [
      toolMsg("a1", {
        type: "tool-ask_user",
        toolCallId: "tc1",
        toolName: "ask_user",
        state: "input-available",
        input: { question: "Which file?" }
      })
    ];
    const result = repairInterruptedToolParts(messages, {
      repairPart: (part) => {
        const record = part as Record<string, unknown>;
        const input = record.input as { question?: string };
        return {
          type: "text",
          text: input.question ?? ""
        } as unknown as UIMessage["parts"][number];
      }
    });
    expect(result.removedToolCalls).toBe(1);
    const part = result.messages[0].parts[0] as Record<string, unknown>;
    expect(part.type).toBe("text");
    expect(part.text).toBe("Which file?");
  });

  it("skips an interrupted part when shouldRepair returns false (left verbatim)", () => {
    const messages = [
      toolMsg("a1", {
        type: "tool-chooseOption",
        toolCallId: "client-1",
        toolName: "chooseOption",
        state: "input-available",
        input: {}
      }),
      toolMsg("a2", {
        type: "tool-previewTool",
        toolCallId: "server-1",
        toolName: "previewTool",
        state: "input-available",
        input: {}
      })
    ];
    const result = repairInterruptedToolParts(messages, {
      repairPart: flipToError,
      // Skip the client tool; repair only the server one.
      shouldRepair: (part) =>
        (part as Record<string, unknown>).toolName !== "chooseOption"
    });
    expect(result.removedToolCalls).toBe(1);
    expect(result.toolCallIds).toEqual(["server-1"]);
    // Skipped client part kept verbatim (message identity preserved).
    expect(result.messages[0]).toBe(messages[0]);
    expect((result.messages[0].parts[0] as Record<string, unknown>).state).toBe(
      "input-available"
    );
    // Server part repaired.
    expect((result.messages[1].parts[0] as Record<string, unknown>).state).toBe(
      "output-error"
    );
  });

  it("repairs across multiple messages and reports all ids", () => {
    const messages = [
      toolMsg("a1", {
        type: "tool-a",
        toolCallId: "tc1",
        toolName: "a",
        state: "input-available",
        input: {}
      }),
      toolMsg("a2", {
        type: "tool-b",
        toolCallId: "tc2",
        toolName: "b",
        state: "output-available",
        input: {},
        output: {}
      }),
      toolMsg("a3", {
        type: "tool-c",
        toolCallId: "tc3",
        toolName: "c",
        state: "input-streaming",
        input: {}
      })
    ];
    const result = repair(messages);
    expect(result.removedToolCalls).toBe(2);
    expect(result.toolCallIds).toEqual(["tc1", "tc3"]);
    // The settled one keeps identity; repaired ones are new objects.
    expect(result.messages[1]).toBe(messages[1]);
  });
});

describe("settleInterruptedReply", () => {
  const repairPart = (part: UIMessage["parts"][number]) =>
    ({
      ...part,
      state: "output-error",
      errorText: "interrupted"
    }) as UIMessage["parts"][number];
  const reply = (parts: unknown[]): UIMessage =>
    ({ id: "a1", role: "assistant", parts }) as UIMessage;
  const call = (name: string, state: string, extra: object = {}) => ({
    type: `tool-${name}`,
    toolCallId: `call-${name}`,
    state,
    input: {},
    ...extra
  });

  it("errors a call no client is known to own", () => {
    const settled = settleInterruptedReply(
      reply([
        { type: "text", text: "working" },
        call("search", "input-available")
      ]),
      { repairPart, clientToolNames: new Set() }
    );
    expect(settled.parts[1]).toMatchObject({
      state: "output-error",
      errorText: "interrupted"
    });
  });

  it("keeps a known client tool's call, approvals and settled results", () => {
    const message = reply([
      call("pick", "input-available"),
      call("pay", "approval-requested"),
      call("send", "approval-responded", { approval: { approved: true } }),
      call("done", "output-available", { output: 1 })
    ]);
    expect(
      settleInterruptedReply(message, {
        repairPart,
        clientToolNames: new Set(["pick"])
      })
    ).toBe(message);
  });

  it("errors a call whose input never finished streaming", () => {
    const settled = settleInterruptedReply(
      reply([call("search", "input-streaming")]),
      { repairPart, clientToolNames: new Set(["search"]) }
    );
    expect(settled.parts[0]).toMatchObject({ state: "output-error" });
  });
});

describe("streamChunksFinished", () => {
  it("finds the finish chunk of a stream that ended", () => {
    expect(
      streamChunksFinished([
        { body: JSON.stringify({ type: "start" }) },
        { body: JSON.stringify({ type: "finish" }) }
      ])
    ).toBe(true);
    expect(
      streamChunksFinished([
        { body: JSON.stringify({ type: "start" }) },
        { body: "not json" }
      ])
    ).toBe(false);
  });
});

/** A sink that records what it was asked to store and report. */
function recordingSink() {
  const persisted: Array<{ changed: string[]; repaired: string[] }> = [];
  const events: Array<Parameters<RepairedTranscriptSink["emitRepaired"]>[0]> =
    [];
  const sink: RepairedTranscriptSink = {
    persist: async (changed, repaired) => {
      persisted.push({
        changed: changed.map((m) => m.id),
        repaired: repaired.map((m) => m.id)
      });
    },
    emitRepaired: (event) => void events.push(event)
  };
  return { sink, persisted, events };
}

const pendingCall = (id: string, tool = "search") =>
  toolMsg(id, {
    type: `tool-${tool}`,
    toolCallId: `call-${id}`,
    state: "input-available",
    input: {}
  });
const textMsg = (id: string, role: "assistant" | "user" = "user") =>
  ({ id, role, parts: [{ type: "text", text: id }] }) as ChatMessage;

describe("persistRepairedTranscript", () => {
  it("stores the changed messages and reports the repair once", async () => {
    const messages = [textMsg("u1"), pendingCall("a1"), textMsg("u2")];
    const { sink, persisted, events } = recordingSink();

    await persistRepairedTranscript(messages, repair(messages), sink);

    expect(persisted).toEqual([
      { changed: ["a1"], repaired: ["u1", "a1", "u2"] }
    ]);
    expect(events).toEqual([
      { removedToolCalls: 1, normalizedInputs: 0, toolCallIds: ["call-a1"] }
    ]);
  });

  it("does nothing when the repair changed nothing", async () => {
    const messages = [textMsg("u1"), textMsg("a1", "assistant")];
    const { sink, persisted, events } = recordingSink();

    await persistRepairedTranscript(messages, repair(messages), sink);

    expect(persisted).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("settleReplyBeforeRecovery", () => {
  const options = {
    repairPart: flipToError,
    clientToolNames: new Set(["pick"])
  };

  it("settles the reply a recovery continues, stores it and reports it", async () => {
    const messages = [textMsg("u1"), pendingCall("a1")];
    const { sink, persisted, events } = recordingSink();

    await settleReplyBeforeRecovery(messages, "a1", options, sink);

    expect(persisted).toEqual([{ changed: ["a1"], repaired: ["u1", "a1"] }]);
    expect(events).toEqual([
      { removedToolCalls: 1, normalizedInputs: 0, toolCallIds: ["call-a1"] }
    ]);
  });

  it("keeps a call a client is known to own", async () => {
    const messages = [textMsg("u1"), pendingCall("a1", "pick")];
    const { sink, persisted, events } = recordingSink();

    await settleReplyBeforeRecovery(messages, "a1", options, sink);

    expect(persisted).toEqual([]);
    expect(events).toEqual([]);
  });

  it("leaves the transcript alone when the reply is not the latest message", async () => {
    const { sink, persisted } = recordingSink();

    await settleReplyBeforeRecovery(
      [textMsg("u1"), pendingCall("a1"), textMsg("u2")],
      "a1",
      options,
      sink
    );
    await settleReplyBeforeRecovery(
      [textMsg("u1"), pendingCall("a1")],
      "another-reply",
      options,
      sink
    );

    expect(persisted).toEqual([]);
  });
});

describe("unsettledToolCallIds", () => {
  it("lists calls with no result, and not an approved call waiting to run", () => {
    const messages = [
      pendingCall("a1"),
      toolMsg("a2", {
        type: "dynamic-tool",
        toolName: "x",
        toolCallId: "requested",
        state: "approval-requested"
      }),
      toolMsg("a3", {
        type: "tool-search",
        toolCallId: "approved",
        state: "approval-responded"
      }),
      toolMsg("a4", {
        type: "tool-search",
        toolCallId: "done",
        state: "output-available",
        output: 1
      }),
      textMsg("u1")
    ];
    expect(unsettledToolCallIds(messages)).toEqual(["call-a1", "requested"]);
  });
});
