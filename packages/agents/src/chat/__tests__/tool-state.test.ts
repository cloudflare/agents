import { describe, it, expect } from "vitest";
import {
  applyToolPartUpdate,
  applyToolUpdate,
  toolResultUpdate,
  crossMessageToolResultUpdate,
  toolApprovalUpdate,
  pausedExecutionUpdate,
  hasPendingToolInteraction,
  unexecutedToolNames
} from "../tool-state";

function makePart(
  toolCallId: string,
  state: string,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return { type: "tool-invocation", toolCallId, state, ...extra };
}

describe("toolResultUpdate", () => {
  it("builds an update for output-available", () => {
    const update = toolResultUpdate("tc1", { result: 42 });
    expect(update.toolCallId).toBe("tc1");
    expect(update.matchStates).toEqual([
      "input-available",
      "approval-requested",
      "approval-responded",
      "output-available",
      "output-error",
      "output-denied"
    ]);

    const applied = update.apply({
      toolCallId: "tc1",
      state: "input-available"
    });
    expect(applied.state).toBe("output-available");
    expect(applied.output).toEqual({ result: 42 });
    expect(applied.preliminary).toBe(false);
  });

  it("builds an update for output-error", () => {
    const update = toolResultUpdate("tc1", null, "output-error", "denied");
    const applied = update.apply({
      toolCallId: "tc1",
      state: "input-available"
    });
    expect(applied.state).toBe("output-error");
    expect(applied.errorText).toBe("denied");
  });

  it("uses default errorText when not provided", () => {
    const update = toolResultUpdate("tc1", null, "output-error");
    const applied = update.apply({
      toolCallId: "tc1",
      state: "input-available"
    });
    expect(applied.errorText).toBe("Tool execution denied by user");
  });

  it("leaves a settled part as it is: the first result wins", () => {
    const update = toolResultUpdate("tc1", { result: "second" });
    for (const state of ["output-available", "output-error", "output-denied"]) {
      const part = makePart("tc1", state, { output: { result: "first" } });
      expect(update.apply(part)).toBe(part);
    }
  });
});

describe("applyToolPartUpdate", () => {
  type Message = { id: string; role: string; parts: unknown[] };

  function setup(options: { inFlight?: Message; stored?: Message[] }) {
    const writes: Message[] = [];
    const broadcasts: Message[] = [];
    let inFlightChanged = 0;
    const stored = new Map(
      (options.stored ?? []).map((message) => [message.id, message])
    );
    const inFlight = options.inFlight;
    const target = {
      inFlight: inFlight
        ? {
            id: inFlight.id,
            parts: inFlight.parts as Array<Record<string, unknown>>,
            snapshot: () => ({ ...inFlight, parts: [...inFlight.parts] }),
            changed: () => {
              inFlightChanged += 1;
            }
          }
        : null,
      storedOwner: async (toolCallId: string) => {
        for (const message of stored.values()) {
          if (
            message.parts.some(
              (part) =>
                (part as { toolCallId?: string }).toolCallId === toolCallId
            )
          ) {
            return message;
          }
        }
        return null;
      },
      write: async (message: Message) => {
        writes.push(message);
        stored.set(message.id, message);
        return message;
      },
      broadcast: (message: Message) => {
        broadcasts.push(message);
      }
    };
    return {
      target,
      writes,
      broadcasts,
      stored,
      inFlightChanged: () => inFlightChanged
    };
  }

  it("settles a part in the reply in flight, in place", async () => {
    const reply = {
      id: "a1",
      role: "assistant",
      parts: [makePart("tc1", "input-available")]
    };
    const env = setup({ inFlight: reply });
    const outcome = await applyToolPartUpdate(
      toolResultUpdate("tc1", "ok"),
      env.target
    );
    expect(outcome).toEqual({ status: "changed", messageId: "a1" });
    expect(reply.parts[0]).toMatchObject({
      state: "output-available",
      output: "ok"
    });
    expect(env.inFlightChanged()).toBe(1);
    expect(env.writes).toEqual([]);
    expect(env.broadcasts).toHaveLength(1);
  });

  it("settles a stored part and writes it once", async () => {
    const env = setup({
      stored: [
        {
          id: "a1",
          role: "assistant",
          parts: [makePart("tc1", "input-available")]
        }
      ]
    });
    const outcome = await applyToolPartUpdate(
      toolResultUpdate("tc1", "ok"),
      env.target
    );
    expect(outcome).toEqual({ status: "changed", messageId: "a1" });
    expect(env.writes).toHaveLength(1);
    expect(env.writes[0].parts[0]).toMatchObject({ state: "output-available" });
    expect(env.broadcasts).toHaveLength(1);
  });

  it("writes both copies when the reply in flight was partly stored (#1649)", async () => {
    const reply = {
      id: "a1",
      role: "assistant",
      parts: [makePart("tc1", "input-available")]
    };
    const env = setup({
      inFlight: reply,
      stored: [
        {
          id: "a1",
          role: "assistant",
          parts: [makePart("tc1", "input-available")]
        }
      ]
    });
    const outcome = await applyToolPartUpdate(
      toolResultUpdate("tc1", "ok"),
      env.target
    );
    expect(outcome).toEqual({ status: "changed", messageId: "a1" });
    expect(reply.parts[0]).toMatchObject({ state: "output-available" });
    expect(env.stored.get("a1")?.parts[0]).toMatchObject({
      state: "output-available"
    });
  });

  it("broadcasts the reply in flight, not its older stored copy, when both change", async () => {
    const reply = {
      id: "a1",
      role: "assistant",
      parts: [
        makePart("tc1", "input-available"),
        { type: "text", text: "streamed after the stored copy" }
      ]
    };
    const env = setup({
      inFlight: reply,
      stored: [
        {
          id: "a1",
          role: "assistant",
          parts: [makePart("tc1", "input-available")]
        }
      ]
    });
    await applyToolPartUpdate(toolResultUpdate("tc1", "ok"), env.target);
    expect(env.broadcasts).toHaveLength(1);
    expect(env.broadcasts[0].parts).toHaveLength(2);
  });

  it("changes a part of the reply in flight in place", async () => {
    const part = makePart("tc1", "input-available");
    const env = setup({
      inFlight: { id: "a1", role: "assistant", parts: [part] }
    });
    await applyToolPartUpdate(toolResultUpdate("tc1", "ok"), env.target);
    expect(part).toMatchObject({ state: "output-available", output: "ok" });
  });

  it("answers unchanged for a repeat, with no write and no broadcast", async () => {
    const env = setup({
      stored: [
        {
          id: "a1",
          role: "assistant",
          parts: [makePart("tc1", "output-available", { output: "first" })]
        }
      ]
    });
    const outcome = await applyToolPartUpdate(
      toolResultUpdate("tc1", "second"),
      env.target
    );
    expect(outcome).toEqual({ status: "unchanged" });
    expect(env.writes).toEqual([]);
    expect(env.broadcasts).toEqual([]);
    expect(env.stored.get("a1")?.parts[0]).toMatchObject({ output: "first" });
  });

  it("answers missing when no part holds the call", async () => {
    const env = setup({});
    expect(
      await applyToolPartUpdate(toolResultUpdate("tc1", "ok"), env.target)
    ).toEqual({ status: "missing" });
  });
});

describe("crossMessageToolResultUpdate", () => {
  it("matches the broad set of pre-terminal and terminal states", () => {
    const update = crossMessageToolResultUpdate("tc1", "output-available", 1);
    expect(update.matchStates).toEqual([
      "input-streaming",
      "input-available",
      "approval-requested",
      "approval-responded",
      "output-available",
      "output-error",
      "output-denied"
    ]);
  });

  it("resolves an approved tool part to output-available", () => {
    const update = crossMessageToolResultUpdate("tc1", "output-available", {
      enabled: true
    });
    const applied = update.apply(makePart("tc1", "approval-responded"));
    expect(applied.state).toBe("output-available");
    expect(applied.output).toEqual({ enabled: true });
    // A final result is marked non-preliminary so settled detection works.
    expect(applied.preliminary).toBe(false);
  });

  it("preserves a streamed preliminary flag when present", () => {
    const update = crossMessageToolResultUpdate(
      "tc1",
      "output-available",
      "partial",
      undefined,
      true
    );
    const applied = update.apply(makePart("tc1", "approval-responded"));
    expect(applied.state).toBe("output-available");
    expect(applied.output).toBe("partial");
    expect(applied.preliminary).toBe(true);
  });

  it("resolves to output-error with the provided errorText", () => {
    const update = crossMessageToolResultUpdate(
      "tc1",
      "output-error",
      undefined,
      "Trigger update failed"
    );
    const applied = update.apply(makePart("tc1", "approval-responded"));
    expect(applied.state).toBe("output-error");
    expect(applied.errorText).toBe("Trigger update failed");
  });

  it("uses a default errorText when none is provided", () => {
    const update = crossMessageToolResultUpdate("tc1", "output-error");
    const applied = update.apply(makePart("tc1", "approval-responded"));
    expect(applied.errorText).toBe("Tool execution failed");
  });

  it("is first-write-wins: returns the same reference for a settled part", () => {
    const update = crossMessageToolResultUpdate(
      "tc1",
      "output-available",
      "replayed-output"
    );

    for (const state of ["output-available", "output-error", "output-denied"]) {
      const part = makePart("tc1", state, { output: "original" });
      const applied = update.apply(part);
      // Same reference signals an idempotent no-op so callers skip the
      // durable write + broadcast — and the original output is never lost.
      expect(applied).toBe(part);
      expect(applied.output).toBe("original");
    }
  });

  it("does not overwrite an errored tool on replay", () => {
    const update = crossMessageToolResultUpdate(
      "tc1",
      "output-available",
      "late-success"
    );
    const part = makePart("tc1", "output-error", { errorText: "boom" });
    const applied = update.apply(part);
    expect(applied).toBe(part);
    expect(applied.state).toBe("output-error");
    expect(applied.errorText).toBe("boom");
  });

  it("matches a terminal part via applyToolUpdate but yields an unchanged reference", () => {
    // The cross-message builder matches a terminal part so a replay still
    // resolves to it, but apply leaves it untouched.
    const parts = [makePart("tc1", "output-available", { output: "done" })];
    const result = applyToolUpdate(
      parts,
      crossMessageToolResultUpdate("tc1", "output-available", "done-again")
    );
    expect(result).toEqual({ parts, changed: false });
  });

  it("transitions a fresh approval-responded part via applyToolUpdate", () => {
    const parts = [
      makePart("tc1", "approval-responded", { approval: { approved: true } })
    ];
    const result = applyToolUpdate(
      parts,
      crossMessageToolResultUpdate("tc1", "output-available", { ok: 1 })
    );
    expect(result).not.toBeNull();
    expect(result!.parts[0]).not.toBe(parts[0]);
    expect(result!.parts[0]).toEqual(
      expect.objectContaining({ state: "output-available", output: { ok: 1 } })
    );
  });
});

describe("pausedExecutionUpdate", () => {
  const pausedPart = (executionId: string) =>
    makePart("tc1", "output-available", {
      output: { status: "paused", executionId, pending: [] }
    });

  it("replaces a paused output with the new outcome", () => {
    const update = pausedExecutionUpdate("tc1", "exec_1", {
      status: "completed",
      executionId: "exec_1",
      result: 42
    });
    expect(update.matchStates).toEqual(["output-available"]);

    const applied = update.apply(pausedPart("exec_1"));
    expect(applied.output).toEqual({
      status: "completed",
      executionId: "exec_1",
      result: 42
    });
    expect(applied.preliminary).toBe(false);
  });

  it("no-ops (same reference) for a different execution id", () => {
    const part = pausedPart("exec_other");
    const update = pausedExecutionUpdate("tc1", "exec_1", {
      status: "completed"
    });
    expect(update.apply(part)).toBe(part);
  });

  it("no-ops (same reference) when the output is no longer paused", () => {
    const part = makePart("tc1", "output-available", {
      output: { status: "completed", executionId: "exec_1", result: 1 }
    });
    const update = pausedExecutionUpdate("tc1", "exec_1", {
      status: "rejected"
    });
    expect(update.apply(part)).toBe(part);
  });

  it("no-ops (same reference) for a non-object output", () => {
    const part = makePart("tc1", "output-available", { output: "plain text" });
    const update = pausedExecutionUpdate("tc1", "exec_1", {
      status: "completed"
    });
    expect(update.apply(part)).toBe(part);
  });

  it("applies via applyToolUpdate only to the matching paused part", () => {
    const parts = [
      makePart("tc0", "output-available", {
        output: { status: "paused", executionId: "exec_0" }
      }),
      pausedPart("exec_1")
    ];
    const outcome = { status: "completed", executionId: "exec_1", result: 7 };
    const result = applyToolUpdate(
      parts,
      pausedExecutionUpdate("tc1", "exec_1", outcome)
    );
    expect(result).not.toBeNull();
    expect((result!.parts[1] as Record<string, unknown>).output).toEqual(
      outcome
    );
    // The other paused execution is untouched.
    expect(result!.parts[0]).toBe(parts[0]);
  });
});

describe("toolApprovalUpdate", () => {
  it("builds an update for approval-responded", () => {
    const update = toolApprovalUpdate("tc1", true);
    expect(update.matchStates).toEqual([
      "input-available",
      "approval-requested"
    ]);

    const applied = update.apply({
      toolCallId: "tc1",
      state: "approval-requested",
      approval: { id: "a1" }
    });
    expect(applied.state).toBe("approval-responded");
    expect(applied.approval).toEqual({ id: "a1", approved: true });
  });

  it("builds an update for output-denied", () => {
    const update = toolApprovalUpdate("tc1", false);
    const applied = update.apply({
      toolCallId: "tc1",
      state: "approval-requested",
      approval: { id: "a1" }
    });
    expect(applied.state).toBe("output-denied");
    expect(applied.approval).toEqual({ id: "a1", approved: false });
  });

  it("synthesizes an approval id when an older transcript is missing one", () => {
    const update = toolApprovalUpdate("tc-missing-id", true);
    const applied = update.apply({
      toolCallId: "tc-missing-id",
      state: "approval-requested"
    });

    expect(applied.state).toBe("approval-responded");
    expect(applied.approval).toEqual({
      id: "tc-missing-id",
      approved: true
    });
  });
});

describe("applyToolUpdate", () => {
  it("applies update to the matching part", () => {
    const parts = [
      makePart("tc1", "input-available"),
      { type: "text", text: "hello" },
      makePart("tc2", "input-available")
    ];

    const result = applyToolUpdate(
      parts,
      toolResultUpdate("tc2", "output-value")
    );

    expect(result).not.toBeNull();
    expect(result!.changed).toBe(true);
    expect(result!.parts[2]).toEqual(
      expect.objectContaining({
        state: "output-available",
        output: "output-value"
      })
    );
    expect(result!.parts[0]).toBe(parts[0]);
    expect(result!.parts[1]).toBe(parts[1]);
  });

  it("returns null when no part matches the toolCallId", () => {
    const parts = [makePart("tc1", "input-available")];
    const result = applyToolUpdate(
      parts,
      toolResultUpdate("tc-unknown", "value")
    );
    expect(result).toBeNull();
  });

  it("returns null when part is in wrong state", () => {
    const parts = [makePart("tc1", "input-streaming")];
    const result = applyToolUpdate(parts, toolResultUpdate("tc1", "new-value"));
    expect(result).toBeNull();
  });

  it("matches a settled part without changing it", () => {
    const parts = [makePart("tc1", "output-available")];
    const result = applyToolUpdate(parts, toolResultUpdate("tc1", "new-value"));
    expect(result).toEqual({ parts, changed: false });
  });

  it("does not mutate the original parts array", () => {
    const parts = [makePart("tc1", "input-available")];
    const original = [...parts];

    applyToolUpdate(parts, toolResultUpdate("tc1", "value"));

    expect(parts).toEqual(original);
    expect(parts[0]).toBe(original[0]);
  });

  it("matches approval-requested state for tool result", () => {
    const parts = [makePart("tc1", "approval-requested")];
    const result = applyToolUpdate(parts, toolResultUpdate("tc1", "value"));
    expect(result).not.toBeNull();
    expect(result!.parts[0]).toEqual(
      expect.objectContaining({ state: "output-available" })
    );
  });

  it("applies approval update correctly", () => {
    const parts = [
      makePart("tc1", "approval-requested", { approval: { id: "a1" } })
    ];
    const result = applyToolUpdate(parts, toolApprovalUpdate("tc1", true));
    expect(result).not.toBeNull();
    expect(result!.parts[0]).toEqual(
      expect.objectContaining({
        state: "approval-responded",
        approval: { id: "a1", approved: true }
      })
    );
  });

  it("updates every copy of a call a legacy message holds twice", () => {
    const parts = [
      makePart("tc1", "output-available", { output: "first" }),
      makePart("tc1", "input-available")
    ];
    const result = applyToolUpdate(parts, toolResultUpdate("tc1", "value"));
    expect(result!.changed).toBe(true);
    expect(result!.parts[0]).toBe(parts[0]);
    expect(result!.parts[1]).toMatchObject({
      state: "output-available",
      output: "value"
    });
  });
});

describe("hasPendingToolInteraction", () => {
  const user = { id: "user-1", role: "user", parts: [] };
  const call = (toolName: string, state = "input-available") => ({
    type: `tool-${toolName}`,
    toolCallId: `call-${toolName}`,
    state,
    input: {}
  });
  const reply = (id: string, ...parts: unknown[]) => ({
    id,
    role: "assistant",
    parts
  });
  const pending = (input: {
    messages: Array<{ id: string; role: string; parts: unknown[] }>;
    streaming?: { id: string; role: string; parts: unknown[] } | null;
    clientToolNames?: string[];
    clientAnswerableToolNames?: string[] | null;
  }) =>
    hasPendingToolInteraction({
      messages: input.messages,
      streaming: input.streaming ?? null,
      clientToolNames: new Set(input.clientToolNames ?? []),
      ...(input.clientAnswerableToolNames !== undefined && {
        clientAnswerableToolNames:
          input.clientAnswerableToolNames === null
            ? null
            : new Set(input.clientAnswerableToolNames)
      })
    });

  describe("a host that cannot tell which tools are a client's", () => {
    it("counts every unanswered call in the latest reply", () => {
      expect(pending({ messages: [user, reply("a1", call("ask"))] })).toBe(
        true
      );
      expect(
        pending({
          messages: [user, reply("a1", call("ask"))],
          clientAnswerableToolNames: null
        })
      ).toBe(true);
    });

    it("counts only a known client's call in a reply the conversation moved past", () => {
      const moved = [user, reply("a1", call("ask")), { ...user, id: "user-2" }];
      expect(pending({ messages: moved })).toBe(false);
      expect(pending({ messages: moved, clientToolNames: ["ask"] })).toBe(true);
    });
  });

  describe("a host that knows which tools a client may answer", () => {
    it("does not wait on a server tool call an older version stored in the latest reply", () => {
      expect(
        pending({
          messages: [user, reply("a1", call("serverSearch"))],
          clientAnswerableToolNames: []
        })
      ).toBe(false);
    });

    it("waits on a tool the server declares and a client answers", () => {
      expect(
        pending({
          messages: [user, reply("a1", call("askUser"))],
          clientAnswerableToolNames: ["askUser"]
        })
      ).toBe(true);
    });

    it("waits on a tool the client sent a schema for", () => {
      expect(
        pending({
          messages: [user, reply("a1", call("pickFile"))],
          clientToolNames: ["pickFile"],
          clientAnswerableToolNames: ["pickFile"]
        })
      ).toBe(true);
    });

    it("waits on an approval whatever the tool", () => {
      expect(
        pending({
          messages: [
            user,
            reply("a1", call("serverSearch", "approval-requested"))
          ],
          clientAnswerableToolNames: []
        })
      ).toBe(true);
    });

    it("waits on the answerable call when the reply also holds a dead server call", () => {
      expect(
        pending({
          messages: [user, reply("a1", call("serverSearch"), call("askUser"))],
          clientAnswerableToolNames: ["askUser"]
        })
      ).toBe(true);
    });
  });

  it("counts only a known client's call in the reply that is streaming", () => {
    const streaming = reply("a1", call("serverSearch"));
    expect(pending({ messages: [user], streaming })).toBe(false);
    expect(
      pending({
        messages: [user],
        streaming: reply("a1", call("pickFile")),
        clientToolNames: ["pickFile"]
      })
    ).toBe(true);
  });
});

describe("unexecutedToolNames", () => {
  it("names the tools the server does not run, sorted", () => {
    expect(
      unexecutedToolNames({
        zebra: { description: "client answers" },
        run: { execute: () => 1 },
        search: { type: "provider" },
        legacy: { type: "provider-defined" },
        ask: {}
      })
    ).toEqual(["ask", "zebra"]);
  });
});
