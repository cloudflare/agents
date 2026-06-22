import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import {
  repairInterruptedToolParts,
  toolPartHasSettledResult
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
