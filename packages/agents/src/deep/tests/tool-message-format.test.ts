import { describe, it, expect } from "vitest";
import type { AgentState, ChatMessage } from "../types";

/**
 * Tests for ensuring tool messages are properly formatted
 *
 * OpenAI requires that tool messages must follow assistant messages with tool_calls.
 * This test suite validates that our message handling maintains this invariant.
 */

describe("V2 Tool Message Format", () => {
  it("validates that tool messages have preceding assistant messages with tool_calls", () => {
    // This is the valid format
    const validMessages: ChatMessage[] = [
      { role: "user", content: "Please write a todo list" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_0",
            name: "write_todos",
            args: { todos: [{ content: "Task 1", status: "pending", id: "1" }] }
          }
        ]
      },
      {
        role: "tool",
        content: "Updated todo list (1 items).",
        tool_call_id: "call_0"
      }
    ];

    const isValid = validateMessageFormat(validMessages);
    expect(isValid.valid).toBe(true);
  });

  it("detects tool messages without preceding tool_calls", () => {
    // This is the INVALID format that causes the OpenAI error
    const invalidMessages: ChatMessage[] = [
      { role: "user", content: "Please write a todo list" },
      { role: "assistant", content: "I'll write that todo list" }, // No tool_calls!
      {
        role: "tool",
        content: "Updated todo list (1 items).",
        tool_call_id: "call_0"
      }
    ];

    const isValid = validateMessageFormat(invalidMessages);
    expect(isValid.valid).toBe(false);
    expect(isValid.error).toContain("tool message at index 2");
    expect(isValid.error).toContain(
      "does not follow an assistant message with tool_calls"
    );
  });

  it("detects assistant message without tool_calls before tool message", () => {
    // Assistant message exists but lacks tool_calls field
    const invalidMessages: ChatMessage[] = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        // tool_calls should be here but isn't
        content: "Let me help"
      },
      {
        role: "tool",
        content: "Tool output",
        tool_call_id: "call_0"
      }
    ];

    const isValid = validateMessageFormat(invalidMessages);
    expect(isValid.valid).toBe(false);
  });

  it("handles multiple tool calls and responses correctly", () => {
    const validMessages: ChatMessage[] = [
      { role: "user", content: "Do multiple things" },
      {
        role: "assistant",
        tool_calls: [
          { id: "call_0", name: "tool1", args: {} },
          { id: "call_1", name: "tool2", args: {} }
        ]
      },
      { role: "tool", content: "Result 1", tool_call_id: "call_0" },
      { role: "tool", content: "Result 2", tool_call_id: "call_1" }
    ];

    const isValid = validateMessageFormat(validMessages);
    expect(isValid.valid).toBe(true);
  });

  it("allows assistant messages between user and tool sequences", () => {
    const validMessages: ChatMessage[] = [
      { role: "user", content: "First request" },
      {
        role: "assistant",
        tool_calls: [{ id: "call_0", name: "tool1", args: {} }]
      },
      { role: "tool", content: "Result 1", tool_call_id: "call_0" },
      { role: "assistant", content: "Here's what I found..." },
      { role: "user", content: "Second request" },
      {
        role: "assistant",
        tool_calls: [{ id: "call_1", name: "tool2", args: {} }]
      },
      { role: "tool", content: "Result 2", tool_call_id: "call_1" }
    ];

    const isValid = validateMessageFormat(validMessages);
    expect(isValid.valid).toBe(true);
  });

  it("validates tool_call_id matches exist in preceding assistant message", () => {
    const messagesWithMismatchedId: ChatMessage[] = [
      { role: "user", content: "Test" },
      {
        role: "assistant",
        tool_calls: [{ id: "call_0", name: "tool1", args: {} }]
      },
      {
        role: "tool",
        content: "Result",
        tool_call_id: "call_WRONG" // Doesn't match call_0
      }
    ];

    const isValid = validateMessageFormat(messagesWithMismatchedId);
    // This should still be structurally valid (tool follows assistant with tool_calls)
    // The mismatched ID is a different kind of error
    expect(isValid.valid).toBe(true);
  });

  it("reproduces the actual error from events log", () => {
    // Simulating the state after first model call returns tool_calls,
    // but the tool_calls were extracted to meta and not kept in the message
    const state: AgentState = {
      messages: [
        { role: "user", content: "Compare Linear vs Asana" },
        // This is what happens: assistant message doesn't have tool_calls
        // because they were extracted to meta.pendingToolCalls
        { role: "assistant", content: "" }, // ❌ Missing tool_calls!
        {
          role: "tool",
          content: "Updated todo list (8 items).",
          tool_call_id: "call_0"
        }
      ],
      meta: {
        // The tool_calls are here instead of in the assistant message
        pendingToolCalls: [
          {
            id: "call_0",
            name: "write_todos",
            args: {
              todos: [
                {
                  content: "Research Linear",
                  status: "in_progress",
                  id: "1"
                }
              ]
            }
          }
        ]
      }
    };

    const isValid = validateMessageFormat(state.messages);
    expect(isValid.valid).toBe(false);
    expect(isValid.error).toContain("messages.[2].role");
  });
});

/**
 * Validates that messages follow OpenAI's format rules:
 * - Tool messages must follow assistant messages with tool_calls
 */
function validateMessageFormat(messages: ChatMessage[]): {
  valid: boolean;
  error?: string;
} {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "tool") {
      // Find the most recent assistant message before this tool message
      let foundValidPreceding = false;
      for (let j = i - 1; j >= 0; j--) {
        const prevMsg = messages[j];

        // If we hit another tool message, keep looking back
        if (prevMsg.role === "tool") {
          continue;
        }

        // Found an assistant message - check if it has tool_calls
        if (prevMsg.role === "assistant") {
          if (
            "tool_calls" in prevMsg &&
            Array.isArray(prevMsg.tool_calls) &&
            prevMsg.tool_calls.length > 0
          ) {
            foundValidPreceding = true;
          }
          break; // Stop looking - we found the relevant assistant message
        }

        // If we hit a user message or any other role, stop looking
        break;
      }

      if (!foundValidPreceding) {
        return {
          valid: false,
          error: `Invalid parameter: tool message at index ${i} does not follow an assistant message with tool_calls (messages.[${i}].role)`
        };
      }
    }
  }

  return { valid: true };
}
