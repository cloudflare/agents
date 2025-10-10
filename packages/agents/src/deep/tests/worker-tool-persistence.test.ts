import { describe, it, expect } from "vitest";
import type { ChatMessage } from "../types";

/**
 * Unit tests for the tool_calls persistence bug in worker.ts
 *
 * The bug is in worker.ts lines 482-501:
 * - Tool calls are extracted from assistant message
 * - IDs are generated and stored in meta.pendingToolCalls
 * - But they're NOT written back to the assistant message in the messages array
 * - This causes OpenAI API errors when tool results are added
 */
describe("Worker Tool Calls Persistence", () => {
  it("demonstrates the bug: tool_calls extracted but not written back", () => {
    // Simulate the state after model returns with tool_calls
    // biome-ignore lint/suspicious/noExplicitAny: testing buggy state without IDs
    const messages: any[] = [
      { role: "user", content: "Please write a todo list" },
      {
        role: "assistant",
        tool_calls: [
          {
            // No id yet - will be added by worker.ts
            name: "write_todos",
            args: { todos: [{ content: "Task 1", status: "pending", id: "1" }] }
          }
        ]
      }
    ];

    // biome-ignore lint/suspicious/noExplicitAny: simulating dynamic meta object
    const meta: any = {};

    // This is the BUGGY logic from worker.ts lines 482-501
    const last = messages[messages.length - 1];
    const calls =
      last?.role === "assistant" &&
      "tool_calls" in last &&
      Array.isArray(last.tool_calls)
        ? last.tool_calls
        : [];

    if (calls.length) {
      // Generate stable IDs
      const withIds = calls.map((c, i) => ({
        ...c,
        id: c.id ?? `call_${i}`
      }));

      // Store in meta for execution (this happens in buggy code)
      meta.pendingToolCalls = withIds;

      // ❌ BUG: The code DOES NOT write back to messages array!
      // The comment says "write back to the assistant message itself"
      // but this doesn't happen
    }

    // Now simulate tool execution adding a tool result
    messages.push({
      role: "tool",
      content: "Updated todo list (1 items).",
      tool_call_id: "call_0"
    });

    // Check the structure - this is what causes the OpenAI error
    const assistantMsg = messages[messages.length - 2];
    console.log("Assistant message:", JSON.stringify(assistantMsg, null, 2));
    console.log(
      "Tool message:",
      JSON.stringify(messages[messages.length - 1], null, 2)
    );

    // The assistant message still has tool_calls without IDs
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg).toHaveProperty("tool_calls");

    // But the IDs are missing or not updated!
    // biome-ignore lint/suspicious/noExplicitAny: testing dynamic message structure
    const assistantToolCalls = (assistantMsg as any).tool_calls;
    expect(assistantToolCalls[0].id).toBeUndefined(); // ❌ This is the bug!

    // The tool message references call_0 but assistant message doesn't have it
    expect(messages[messages.length - 1].tool_call_id).toBe("call_0");
  });

  it("shows the correct fix: write tool_calls back to assistant message", () => {
    // Simulate the state after model returns with tool_calls
    // biome-ignore lint/suspicious/noExplicitAny: testing state without IDs before fix
    const messages: any[] = [
      { role: "user", content: "Please write a todo list" },
      {
        role: "assistant",
        tool_calls: [
          {
            name: "write_todos",
            args: { todos: [{ content: "Task 1", status: "pending", id: "1" }] }
          }
        ]
      }
    ];

    // biome-ignore lint/suspicious/noExplicitAny: simulating dynamic meta object
    const meta: any = {};

    // This is the FIXED logic
    const last = messages[messages.length - 1];
    const calls =
      last?.role === "assistant" &&
      "tool_calls" in last &&
      Array.isArray(last.tool_calls)
        ? last.tool_calls
        : [];

    if (calls.length) {
      // Generate stable IDs
      const withIds = calls.map((c, i) => ({
        ...c,
        id: c.id ?? `call_${i}`
      }));

      // ✅ FIX: Write back to the assistant message
      messages[messages.length - 1] = {
        role: "assistant",
        tool_calls: withIds
      };

      // Store in meta for execution
      meta.pendingToolCalls = withIds;
    }

    // Now simulate tool execution adding a tool result
    messages.push({
      role: "tool",
      content: "Updated todo list (1 items).",
      tool_call_id: "call_0"
    });

    // Check the structure - this is now valid!
    const assistantMsg = messages[messages.length - 2];
    console.log(
      "Fixed assistant message:",
      JSON.stringify(assistantMsg, null, 2)
    );

    // ✅ The assistant message now has tool_calls with IDs
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg).toHaveProperty("tool_calls");

    // biome-ignore lint/suspicious/noExplicitAny: testing dynamic message structure
    const assistantToolCalls = (assistantMsg as any).tool_calls;
    expect(assistantToolCalls[0].id).toBe("call_0"); // ✅ ID is present!

    // The tool message references call_0 which matches assistant message
    expect(messages[messages.length - 1].tool_call_id).toBe("call_0");
  });

  it("validates OpenAI message format after fix", () => {
    // Start with messages after the fix has been applied
    const messages: ChatMessage[] = [
      { role: "user", content: "Test" },
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

    // Validate the format
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === "tool") {
        // Find preceding assistant message
        let foundValid = false;
        for (let j = i - 1; j >= 0; j--) {
          const prev = messages[j];
          if (prev.role === "tool") continue;

          if (prev.role === "assistant") {
            if ("tool_calls" in prev && Array.isArray(prev.tool_calls)) {
              // Verify the tool_call_id exists in the assistant's tool_calls
              const toolCallIds = prev.tool_calls.map((tc) => tc.id);
              foundValid = toolCallIds.includes(msg.tool_call_id);
            }
            break;
          }
          break;
        }

        expect(foundValid).toBe(true);
      }
    }
  });

  it("preserves assistant message content when adding tool_calls", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing state without IDs before fix
    const messages: any[] = [
      { role: "user", content: "Test" },
      {
        role: "assistant",
        content: "I'll help you with that.",
        tool_calls: [{ name: "tool1", args: {} }]
      }
    ];

    // Apply the fix
    const last = messages[messages.length - 1];
    if (
      last?.role === "assistant" &&
      "tool_calls" in last &&
      Array.isArray(last.tool_calls)
    ) {
      const withIds = last.tool_calls.map((c, i) => ({
        ...c,
        id: c.id ?? `call_${i}`
      }));

      // Preserve content if it exists
      messages[messages.length - 1] = {
        role: "assistant",
        ...("content" in last && last.content ? { content: last.content } : {}),
        tool_calls: withIds
      };
    }

    // biome-ignore lint/suspicious/noExplicitAny: testing dynamic message structure
    const updatedMsg = messages[messages.length - 1] as any;
    expect(updatedMsg.content).toBe("I'll help you with that.");
    expect(updatedMsg.tool_calls[0].id).toBe("call_0");
  });

  it("handles multiple tool execution cycles correctly", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing state with dynamic tool calls
    const messages: any[] = [{ role: "user", content: "Do multiple things" }];

    // First model call with tool_calls
    messages.push({
      role: "assistant",
      tool_calls: [{ name: "tool1", args: {} }]
    });

    // Apply fix
    let last = messages[messages.length - 1];
    if (last?.role === "assistant" && "tool_calls" in last) {
      const withIds = last.tool_calls!.map((c, i) => ({
        ...c,
        id: c.id ?? `call_0_${i}`
      }));
      messages[messages.length - 1] = {
        role: "assistant",
        tool_calls: withIds
      };
    }

    // Tool execution
    messages.push({
      role: "tool",
      content: "Result 1",
      tool_call_id: "call_0_0"
    });

    // Second model call with different tool_calls
    messages.push({
      role: "assistant",
      tool_calls: [{ name: "tool2", args: {} }]
    });

    // Apply fix again
    last = messages[messages.length - 1];
    if (last?.role === "assistant" && "tool_calls" in last) {
      const withIds = last.tool_calls!.map((c, i) => ({
        ...c,
        id: c.id ?? `call_1_${i}`
      }));
      messages[messages.length - 1] = {
        role: "assistant",
        tool_calls: withIds
      };
    }

    // Second tool execution
    messages.push({
      role: "tool",
      content: "Result 2",
      tool_call_id: "call_1_0"
    });

    // Verify all tool messages have valid preceding assistant messages
    const toolMessages = messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);

    for (const toolMsg of toolMessages) {
      const idx = messages.indexOf(toolMsg);
      let found = false;

      for (let j = idx - 1; j >= 0; j--) {
        const prev = messages[j];
        if (prev.role === "tool") continue;
        if (prev.role === "assistant" && "tool_calls" in prev) {
          const ids = prev.tool_calls!.map((tc) => tc.id);
          found = ids.includes(toolMsg.tool_call_id);
        }
        break;
      }

      expect(found).toBe(true);
    }
  });
});
