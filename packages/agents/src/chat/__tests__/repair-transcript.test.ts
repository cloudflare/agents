import { describe, it, expect } from "vitest";
import { convertToModelMessages, type UIMessage } from "ai";
import {
  persistRepairedTranscript,
  removeEmptyReplyToContinue,
  repairInterruptedToolParts,
  replyIsEmpty,
  settleInterruptedReply,
  settleReplyBeforeRecovery,
  streamChunksFinished,
  stripTrailingReasoning,
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
  const removed: Array<{ ids: string[]; repaired: string[] }> = [];
  const events: Array<Parameters<RepairedTranscriptSink["emitRepaired"]>[0]> =
    [];
  const sink: RepairedTranscriptSink = {
    persist: async (changed, repaired) => {
      persisted.push({
        changed: changed.map((m) => m.id),
        repaired: repaired.map((m) => m.id)
      });
    },
    remove: async (ids, repaired) => {
      removed.push({ ids, repaired: repaired.map((m) => m.id) });
    },
    emitRepaired: (event) => void events.push(event)
  };
  return { sink, persisted, removed, events };
}

const pendingCall = (id: string, tool = "search") =>
  toolMsg(id, {
    type: `tool-${tool}`,
    toolCallId: `call-${id}`,
    state: "input-available",
    input: {}
  });
const reasoningOnly = (id: string) =>
  ({
    id,
    role: "assistant",
    parts: [
      { type: "step-start" },
      { type: "reasoning", text: "Let me think", state: "streaming" }
    ]
  }) as ChatMessage;
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

  it("removes a reply the repair left empty, and does not store it", async () => {
    const messages = [textMsg("u1"), reasoningOnly("a1"), textMsg("u2")];
    const { sink, persisted, removed, events } = recordingSink();

    const kept = await persistRepairedTranscript(
      messages,
      repair(messages),
      sink
    );

    expect(persisted).toEqual([]);
    expect(removed).toEqual([{ ids: ["a1"], repaired: ["u1", "u2"] }]);
    expect(kept.map((m) => m.id)).toEqual(["u1", "u2"]);
    // The event carries the reply as it was stored, reasoning included, so
    // an app can keep its own copy.
    expect(events).toEqual([
      {
        removedToolCalls: 0,
        normalizedInputs: 0,
        toolCallIds: [],
        removedReasoningParts: 1,
        removedMessages: [messages[1]]
      }
    ]);
  });

  it("removes a reply that was stored with no parts", async () => {
    const empty = { id: "a1", role: "assistant", parts: [] } as ChatMessage;
    const messages = [textMsg("u1"), empty, textMsg("u2")];
    const { sink, persisted, removed, events } = recordingSink();

    await persistRepairedTranscript(messages, repair(messages), sink);

    expect(persisted).toEqual([]);
    expect(removed).toEqual([{ ids: ["a1"], repaired: ["u1", "u2"] }]);
    expect(events).toEqual([
      {
        removedToolCalls: 0,
        normalizedInputs: 0,
        toolCallIds: [],
        removedMessages: [empty]
      }
    ]);
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

describe("settleReplyBeforeRecovery, a reply that holds nothing", () => {
  const options = {
    repairPart: flipToError,
    clientToolNames: new Set<string>()
  };

  it("removes a reply cut off in its reasoning and says so", async () => {
    const messages = [textMsg("u1"), reasoningOnly("a1")];
    const { sink, persisted, removed } = recordingSink();

    const outcome = await settleReplyBeforeRecovery(
      messages,
      "a1",
      options,
      sink
    );

    expect(outcome).toBe("removed");
    expect(persisted).toEqual([]);
    expect(removed).toEqual([{ ids: ["a1"], repaired: ["u1"] }]);
  });

  it("removes a reply stored with no parts", async () => {
    const empty = { id: "a1", role: "assistant", parts: [] } as ChatMessage;
    const { sink, removed } = recordingSink();

    expect(
      await settleReplyBeforeRecovery(
        [textMsg("u1"), empty],
        "a1",
        options,
        sink
      )
    ).toBe("removed");
    expect(removed).toEqual([{ ids: ["a1"], repaired: ["u1"] }]);
  });

  it("keeps a reply that has text", async () => {
    const { sink, removed } = recordingSink();

    expect(
      await settleReplyBeforeRecovery(
        [textMsg("u1"), textMsg("a1", "assistant")],
        "a1",
        options,
        sink
      )
    ).toBeUndefined();
    expect(removed).toEqual([]);
  });
});

describe("settleReplyBeforeRecovery, a reply that is not in the transcript", () => {
  const options = {
    repairPart: flipToError,
    clientToolNames: new Set<string>()
  };

  it("says so when an earlier run of the attempt recorded the removal", async () => {
    const { sink, removed, persisted } = recordingSink();

    expect(
      await settleReplyBeforeRecovery([textMsg("u1")], "a1", options, sink, {
        removedEarlier: true
      })
    ).toBe("removed");
    expect(removed).toEqual([]);
    expect(persisted).toEqual([]);
  });

  it("does not when the incident says no run removed it", async () => {
    // The reply is gone for another reason, and the latest message is a
    // question: the conversation moved.
    const { sink } = recordingSink();
    expect(
      await settleReplyBeforeRecovery([textMsg("u1")], "a1", options, sink, {
        removedEarlier: false
      })
    ).toBeUndefined();
  });

  it("goes by the transcript when there is no incident to ask", async () => {
    const { sink } = recordingSink();
    expect(
      await settleReplyBeforeRecovery([textMsg("u1")], "a1", options, sink)
    ).toBe("removed");
    expect(
      await settleReplyBeforeRecovery([textMsg("u1")], "a1", options, sink, {
        removedEarlier: "unknown",
        originMessageIds: ["u1"]
      })
    ).toBe("removed");
  });

  it("does not when the latest message is a newer question", async () => {
    const { sink } = recordingSink();
    for (const removedEarlier of [true, "unknown"] as const) {
      expect(
        await settleReplyBeforeRecovery(
          [textMsg("u1"), textMsg("u2")],
          "a1",
          options,
          sink,
          { removedEarlier, originMessageIds: ["u1"] }
        )
      ).toBeUndefined();
    }
  });

  it("records the removal before it removes the reply", async () => {
    const order: string[] = [];
    const { sink } = recordingSink();

    await settleReplyBeforeRecovery(
      [textMsg("u1"), reasoningOnly("a1")],
      "a1",
      options,
      {
        ...sink,
        remove: async () => void order.push("remove")
      },
      { beforeRemove: async () => void order.push("record") }
    );

    expect(order).toEqual(["record", "remove"]);
  });

  it("records the question the removed reply answered", async () => {
    const recorded: Array<string | undefined> = [];
    const { sink } = recordingSink();

    await settleReplyBeforeRecovery(
      [
        textMsg("u0"),
        textMsg("a0", "assistant"),
        textMsg("u1"),
        reasoningOnly("a1")
      ],
      "a1",
      options,
      sink,
      { beforeRemove: async (questionId) => void recorded.push(questionId) }
    );

    expect(recorded).toEqual(["u1"]);
  });

  it("does not answer a newer question after a removal, with no origin ids", async () => {
    // Server-started turns schedule payloads without origin ids. The
    // removal recorded the question, and a newer one is latest now.
    const { sink } = recordingSink();
    expect(
      await settleReplyBeforeRecovery(
        [textMsg("u1"), textMsg("u2")],
        "a1",
        options,
        sink,
        { removedEarlier: true, removedFor: "u1" }
      )
    ).toBeUndefined();
    expect(
      await settleReplyBeforeRecovery([textMsg("u1")], "a1", options, sink, {
        removedEarlier: true,
        removedFor: "u1"
      })
    ).toBe("removed");
  });

  it("does not when the reply is there and a newer question follows it", async () => {
    const { sink } = recordingSink();
    expect(
      await settleReplyBeforeRecovery(
        [textMsg("u1"), textMsg("a1", "assistant"), textMsg("u2")],
        "a1",
        options,
        sink
      )
    ).toBeUndefined();
  });

  it("does not when the latest message is another reply", async () => {
    const { sink } = recordingSink();
    expect(
      await settleReplyBeforeRecovery(
        [textMsg("u1"), textMsg("a2", "assistant")],
        "a1",
        options,
        sink
      )
    ).toBeUndefined();
  });
});

describe("removeEmptyReplyToContinue", () => {
  it("removes a last reply that is only reasoning, and reports it as stored", async () => {
    const reply = reasoningOnly("a1");
    const messages = [textMsg("u1"), reply];
    const { sink, removed, events } = recordingSink();

    expect(await removeEmptyReplyToContinue(messages, sink)).toBe(true);

    expect(removed).toEqual([{ ids: ["a1"], repaired: ["u1"] }]);
    expect(events).toEqual([
      {
        removedToolCalls: 0,
        normalizedInputs: 0,
        toolCallIds: [],
        removedReasoningParts: 1,
        removedMessages: [reply]
      }
    ]);
  });

  it("leaves a reply with content, and a transcript that ends in a question", async () => {
    const { sink, removed, events } = recordingSink();

    expect(
      await removeEmptyReplyToContinue(
        [textMsg("u1"), textMsg("a1", "assistant")],
        sink
      )
    ).toBe(false);
    expect(await removeEmptyReplyToContinue([textMsg("u1")], sink)).toBe(false);
    expect(removed).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("settleInterruptedReply, parts left streaming", () => {
  it("closes the text and reasoning parts the cut left streaming", () => {
    const message = {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "Hm", state: "streaming" },
        { type: "text", text: "Partial", state: "streaming" }
      ]
    } as ChatMessage;

    const settled = settleInterruptedReply(message, {
      repairPart: flipToError,
      clientToolNames: new Set()
    });

    expect(settled.parts).toEqual([
      { type: "reasoning", text: "Hm", state: "done" },
      { type: "text", text: "Partial", state: "done" }
    ]);
  });

  it("returns the same message when no part is streaming", () => {
    const message = textMsg("a1", "assistant");
    expect(
      settleInterruptedReply(message, {
        repairPart: flipToError,
        clientToolNames: new Set()
      })
    ).toBe(message);
  });
});

describe("replyIsEmpty", () => {
  const assistant = (...parts: Array<Record<string, unknown>>) => ({
    role: "assistant",
    parts
  });

  it("is true for a reply with nothing to show and nothing to send", () => {
    expect(replyIsEmpty(assistant())).toBe(true);
    expect(replyIsEmpty(assistant({ type: "step-start" }))).toBe(true);
    expect(
      replyIsEmpty(
        assistant({ type: "step-start" }, { type: "text", text: "" })
      )
    ).toBe(true);
    expect(replyIsEmpty(assistant({ type: "reasoning", text: "" }))).toBe(true);
  });

  it("is false for anything a client shows or a request carries", () => {
    expect(replyIsEmpty(assistant({ type: "text", text: "a" }))).toBe(false);
    expect(replyIsEmpty(assistant({ type: "reasoning", text: "hm" }))).toBe(
      false
    );
    expect(
      replyIsEmpty(
        assistant({
          type: "tool-pick",
          toolCallId: "c",
          state: "input-available"
        })
      )
    ).toBe(false);
    expect(replyIsEmpty(assistant({ type: "data-progress", data: 1 }))).toBe(
      false
    );
    expect(replyIsEmpty(assistant({ type: "source-url", url: "x" }))).toBe(
      false
    );
    expect(replyIsEmpty(assistant({ type: "file", url: "x" }))).toBe(false);
  });

  it("is false for a user message", () => {
    expect(replyIsEmpty({ role: "user", parts: [] })).toBe(false);
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

describe("stripTrailingReasoning", () => {
  const step = { type: "step-start" };
  const reasoning = (text = "Let me think") => ({
    type: "reasoning",
    text,
    state: "done",
    providerMetadata: { anthropic: { signature: "sig" } }
  });
  const text = (value = "Answer") => ({ type: "text", text: value });
  const tool = {
    type: "tool-pick",
    toolCallId: "call-1",
    state: "output-available",
    input: {},
    output: 1
  };
  const assistant = (...parts: Array<Record<string, unknown>>) =>
    ({
      id: "a1",
      role: "assistant",
      parts: parts as unknown as ChatMessage["parts"]
    }) as ChatMessage;
  const types = (message: ChatMessage) => message.parts.map((p) => p.type);

  /**
   * The last block the provider is sent for this reply. The Anthropic
   * provider joins consecutive assistant messages, so this is the last part
   * of the last assistant message `convertToModelMessages` makes.
   */
  async function finalAssistantBlock(message: ChatMessage) {
    const model = await convertToModelMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "q" }] },
      message,
      { id: "u2", role: "user", parts: [{ type: "text", text: "next" }] }
    ]);
    const last = model.filter((m) => m.role === "assistant").at(-1);
    return Array.isArray(last?.content) ? last.content.at(-1)?.type : undefined;
  }

  it("removes an empty text part with the reasoning in front of it", () => {
    // Cut off between `text-start` and the first delta. A continuation
    // would write its answer into the empty part, in front of its own
    // reasoning.
    const emptyText = { type: "text", text: "", state: "streaming" };
    expect(
      types(stripTrailingReasoning(assistant(step, reasoning(), emptyText)))
    ).toEqual([]);
    expect(
      types(
        stripTrailingReasoning(
          assistant(step, tool, step, reasoning(), emptyText)
        )
      )
    ).toEqual(["step-start", "tool-pick"]);
  });

  it("leaves a reply cut off in its reasoning with no parts", () => {
    const stripped = stripTrailingReasoning(assistant(step, reasoning()));
    expect(stripped.parts).toEqual([]);
    expect(replyIsEmpty(stripped)).toBe(true);
  });

  it("removes a last step that holds only reasoning", async () => {
    const message = assistant(step, tool, step, reasoning());
    // As stored, the request's last assistant block is the reasoning.
    expect(await finalAssistantBlock(message)).toBe("reasoning");

    const stripped = stripTrailingReasoning(message);
    expect(types(stripped)).toEqual(["step-start", "tool-pick"]);
    expect(await finalAssistantBlock(stripped)).toBe("tool-call");
  });

  it("leaves a reply of reasoning alone with no parts, which sends nothing", async () => {
    const stripped = stripTrailingReasoning(assistant(step, reasoning()));
    expect(stripped.parts).toEqual([]);
    expect(await finalAssistantBlock(stripped)).toBeUndefined();
  });

  it("removes reasoning that follows the text of the last step", async () => {
    const message = assistant(step, text(), reasoning());
    expect(await finalAssistantBlock(message)).toBe("reasoning");
    const stripped = stripTrailingReasoning(message);
    expect(types(stripped)).toEqual(["step-start", "text"]);
  });

  it("removes several trailing reasoning-only steps", () => {
    expect(
      types(
        stripTrailingReasoning(
          assistant(step, text(), step, reasoning("a"), step, reasoning("b"))
        )
      )
    ).toEqual(["step-start", "text"]);
  });

  it("keeps reasoning that content follows, in the same step or a later one", async () => {
    const sameStep = assistant(step, reasoning(), tool);
    const laterStep = assistant(step, tool, step, reasoning(), step, text());
    const before = assistant(step, reasoning(), text());
    for (const message of [sameStep, laterStep, before]) {
      expect(stripTrailingReasoning(message)).toBe(message);
      expect(await finalAssistantBlock(message)).not.toBe("reasoning");
    }
  });

  it("keeps parts a client shows, and removes empty text with the reasoning", () => {
    const source = { type: "source-url", sourceId: "s", url: "https://x.y" };
    expect(
      types(
        stripTrailingReasoning(
          assistant(step, text(), step, reasoning(), text(""), source)
        )
      )
    ).toEqual(["step-start", "text", "step-start", "source-url"]);
  });

  it("leaves user messages and replies without trailing reasoning alone", () => {
    const user = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "hi" }]
    } as ChatMessage;
    const reply = assistant(step, text());
    expect(stripTrailingReasoning(user)).toBe(user);
    expect(stripTrailingReasoning(reply)).toBe(reply);
  });

  it("is applied when a cut-off reply is settled", () => {
    const settled = settleInterruptedReply(
      assistant(
        step,
        {
          type: "tool-search",
          toolCallId: "dead",
          state: "input-available",
          input: {}
        },
        step,
        reasoning()
      ),
      { repairPart: flipToError, clientToolNames: new Set() }
    );
    expect(types(settled)).toEqual(["step-start", "tool-search"]);
    expect(settled.parts[1]).toMatchObject({ state: "output-error" });
  });

  it("is reported with the repair, and stored like any other change", async () => {
    const messages = [
      textMsg("u1"),
      assistant(step, text(), step, reasoning())
    ];
    const result = repair(messages);
    expect(result.removedReasoningParts).toBe(1);
    expect(result.removedToolCalls).toBe(0);

    const { sink, persisted, events } = recordingSink();
    await persistRepairedTranscript(messages, result, sink);
    expect(persisted).toEqual([{ changed: ["a1"], repaired: ["u1", "a1"] }]);
    expect(events).toEqual([
      {
        removedToolCalls: 0,
        normalizedInputs: 0,
        toolCallIds: [],
        removedReasoningParts: 1
      }
    ]);
  });
});

describe("what counts as a tool call", () => {
  const dead = (part: Record<string, unknown>) =>
    repair([toolMsg("a1", { state: "input-available", input: {}, ...part })]);

  it("repairs a static and a dynamic tool part", () => {
    expect(dead({ type: "tool-search", toolCallId: "c1" }).toolCallIds).toEqual(
      ["c1"]
    );
    expect(
      dead({ type: "dynamic-tool", toolName: "search", toolCallId: "c2" })
        .toolCallIds
    ).toEqual(["c2"]);
  });

  it("leaves a part that is not a tool part, whatever fields it has", () => {
    // A data part that carries a tool call id is not a call.
    const data = dead({ type: "data-progress", toolCallId: "c1" });
    expect(data.removedToolCalls).toBe(0);
    expect(data.messages[0].parts[0]).toMatchObject({ type: "data-progress" });
    // Nor is a part with no type at all.
    expect(dead({ toolCallId: "c1" }).removedToolCalls).toBe(0);
    expect(dead({ type: 7, toolCallId: "c1" }).removedToolCalls).toBe(0);
  });

  it("leaves a tool part with no usable call id", () => {
    expect(dead({ type: "tool-search" }).removedToolCalls).toBe(0);
    expect(dead({ type: "tool-search", toolCallId: "" }).removedToolCalls).toBe(
      0
    );
    expect(dead({ type: "tool-search", toolCallId: 7 }).removedToolCalls).toBe(
      0
    );
  });
});

describe("stripTrailingReasoning, edges", () => {
  const assistant = (...parts: Array<Record<string, unknown>>) =>
    ({
      id: "a1",
      role: "assistant",
      parts: parts as unknown as ChatMessage["parts"]
    }) as ChatMessage;
  const reasoning = { type: "reasoning", text: "Hm", state: "done" };
  const text = { type: "text", text: "Answer" };
  const types = (message: ChatMessage) => message.parts.map((p) => p.type);

  it("leaves a user message alone, even one that ends in a reasoning part", () => {
    const user = {
      id: "u1",
      role: "user",
      parts: [text, reasoning]
    } as unknown as ChatMessage;
    expect(stripTrailingReasoning(user)).toBe(user);
  });

  it("returns the same message when what follows the content is not reasoning", () => {
    const withSource = assistant(text, { type: "source-url", url: "x" });
    const withStep = assistant(text, { type: "step-start" });
    expect(stripTrailingReasoning(withSource)).toBe(withSource);
    expect(stripTrailingReasoning(withStep)).toBe(withStep);
  });

  it("counts a file as content: reasoning in front of it stays", () => {
    const message = assistant(reasoning, {
      type: "file",
      mediaType: "image/png",
      url: "data:x"
    });
    expect(stripTrailingReasoning(message)).toBe(message);
    // And reasoning after a file is trailing.
    expect(
      types(
        stripTrailingReasoning(
          assistant(
            { type: "file", mediaType: "image/png", url: "x" },
            reasoning
          )
        )
      )
    ).toEqual(["file"]);
  });

  it("treats a text part with no text field as empty, without throwing", () => {
    expect(
      types(stripTrailingReasoning(assistant(reasoning, { type: "text" })))
    ).toEqual([]);
    expect(replyIsEmpty(assistant({ type: "text" }))).toBe(true);
    expect(replyIsEmpty(assistant({ type: "reasoning" }))).toBe(true);
  });

  it("counts the reasoning parts it removed, not the ones it kept", () => {
    const messages = [
      textMsg("u1"),
      assistant(reasoning, text, { type: "step-start" }, reasoning, reasoning)
    ];
    const result = repair(messages);
    // The reasoning in front of the text stays.
    expect(types(result.messages[1])).toEqual(["reasoning", "text"]);
    expect(result.removedReasoningParts).toBe(2);
  });
});

describe("persistRepairedTranscript, what it returns and in what order", () => {
  it("returns the repair's own list when nothing was removed", async () => {
    const messages = [textMsg("u1"), pendingCall("a1"), textMsg("u2")];
    const result = repair(messages);
    const { sink } = recordingSink();

    expect(await persistRepairedTranscript(messages, result, sink)).toBe(
      result.messages
    );
  });

  it("stores what changed before it removes what is empty", async () => {
    // The removal's broadcast carries the whole list. A tab must not get it
    // while the changed message is still unstored.
    const messages = [
      textMsg("u1"),
      pendingCall("a1"),
      textMsg("u2"),
      reasoningOnly("a2"),
      textMsg("u3")
    ];
    const order: string[] = [];
    await persistRepairedTranscript(messages, repair(messages), {
      persist: async () => void order.push("persist"),
      remove: async () => void order.push("remove"),
      emitRepaired: () => void order.push("event")
    });

    expect(order).toEqual(["persist", "remove", "event"]);
  });

  it("reports a repair that only normalized a tool input", async () => {
    const messages = [
      toolMsg("a1", {
        type: "tool-search",
        toolCallId: "c1",
        state: "output-available",
        input: "not an object",
        output: 1
      })
    ];
    const result = repair(messages);
    expect(result.normalizedInputs).toBe(1);
    const { sink, persisted, events } = recordingSink();

    await persistRepairedTranscript(messages, result, sink);

    expect(persisted).toEqual([{ changed: ["a1"], repaired: ["a1"] }]);
    expect(events).toEqual([
      { removedToolCalls: 0, normalizedInputs: 1, toolCallIds: [] }
    ]);
  });
});

describe("settleInterruptedReply, an approved call that has not run", () => {
  it("keeps it: the continuation or the next turn still runs it", () => {
    const message = toolMsg("a1", {
      type: "tool-deploy",
      toolCallId: "c1",
      state: "approval-responded",
      input: {},
      approval: { id: "ap1", approved: true }
    });

    expect(
      settleInterruptedReply(message, {
        repairPart: flipToError,
        clientToolNames: new Set()
      })
    ).toBe(message);
  });
});

describe("streamChunksFinished, a log of one chunk", () => {
  it("finds a finish chunk that is the first and only chunk", () => {
    expect(
      streamChunksFinished([{ body: JSON.stringify({ type: "finish" }) }])
    ).toBe(true);
    expect(streamChunksFinished([])).toBe(false);
  });
});
