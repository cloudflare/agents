import { describe, expect, it } from "vitest";
import { workersAIAdapter } from "../adapters/workers-ai";
import type { ContextMessage } from "../types";

describe("workersAIAdapter", () => {
  it("has the correct name", () => {
    expect(workersAIAdapter.name).toBe("workers-ai");
  });

  it("converts system instructions into a single system message", () => {
    const result = workersAIAdapter.toModelMessages(
      ["Be helpful.", "Be concise."],
      []
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      role: "system",
      content: "Be helpful.\n\nBe concise."
    });
  });

  it("omits system message when no instructions provided", () => {
    const messages: ContextMessage[] = [{ role: "user", content: "Hello" }];
    const result = workersAIAdapter.toModelMessages([], messages);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });

  it("converts basic user/assistant conversation", () => {
    const messages: ContextMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" }
    ];
    const result = workersAIAdapter.toModelMessages(
      ["You are helpful."],
      messages
    );

    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]).toEqual({
      role: "system",
      content: "You are helpful."
    });
    expect(result.messages[1]).toEqual({ role: "user", content: "Hello" });
    expect(result.messages[2]).toEqual({
      role: "assistant",
      content: "Hi there"
    });
    expect(result.messages[3]).toEqual({
      role: "user",
      content: "How are you?"
    });
  });

  it("converts tool call messages with structured tool_calls", () => {
    const messages: ContextMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tc1", name: "search", arguments: { q: "weather" } },
          { id: "tc2", name: "calc", arguments: { expr: "2+2" } }
        ]
      }
    ];
    const result = workersAIAdapter.toModelMessages([], messages);

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0];
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("");
    expect(msg.tool_calls).toHaveLength(2);
    expect(msg.tool_calls![0]).toEqual({
      id: "tc1",
      type: "function",
      function: {
        name: "search",
        arguments: JSON.stringify({ q: "weather" })
      }
    });
    expect(msg.tool_calls![1]).toEqual({
      id: "tc2",
      type: "function",
      function: {
        name: "calc",
        arguments: JSON.stringify({ expr: "2+2" })
      }
    });
  });

  it("converts tool result messages with tool_call_id", () => {
    const messages: ContextMessage[] = [
      {
        role: "tool",
        content: "Sunny, 72°F",
        toolCallId: "tc1",
        name: "search"
      }
    ];
    const result = workersAIAdapter.toModelMessages([], messages);

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0];
    expect(msg.role).toBe("tool");
    expect(msg.content).toBe("Sunny, 72°F");
    expect(msg.tool_call_id).toBe("tc1");
    expect(msg.name).toBe("search");
  });

  it("handles a full agentic loop conversation", () => {
    const messages: ContextMessage[] = [
      { role: "user", content: "What's the weather?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tc1", name: "get_weather", arguments: { city: "SF" } }
        ]
      },
      {
        role: "tool",
        content: "Sunny, 72°F",
        toolCallId: "tc1",
        name: "get_weather"
      },
      {
        role: "assistant",
        content: "The weather in SF is sunny and 72°F."
      }
    ];

    const result = workersAIAdapter.toModelMessages(
      ["You are a weather assistant."],
      messages
    );

    expect(result.messages).toHaveLength(5);
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[1].role).toBe("user");
    expect(result.messages[2].role).toBe("assistant");
    expect(result.messages[2].tool_calls).toHaveLength(1);
    expect(result.messages[3].role).toBe("tool");
    expect(result.messages[3].tool_call_id).toBe("tc1");
    expect(result.messages[4].role).toBe("assistant");
    expect(result.messages[4].content).toBe(
      "The weather in SF is sunny and 72°F."
    );
  });

  it("does not include tool_calls or tool_call_id when not present", () => {
    const messages: ContextMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" }
    ];
    const result = workersAIAdapter.toModelMessages([], messages);

    for (const msg of result.messages) {
      expect(msg.tool_calls).toBeUndefined();
      expect(msg.tool_call_id).toBeUndefined();
      expect(msg.name).toBeUndefined();
    }
  });
});
