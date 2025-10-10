// @ts-expect-error TODO: fix this
import { createExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker, { type Env } from "./worker";
import {
  createThreadId,
  waitForProcessing,
  invokeThread,
  fetchThreadState,
  fetchThreadEvents
} from "./test-utils";

// @ts-expect-error TODO: fix this
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/**
 * Integration test that reproduces the bug where tool_calls are not persisted
 * in the assistant message, causing OpenAI API errors.
 *
 * Bug reproduction steps:
 * 1. Model returns assistant message with tool_calls
 * 2. worker.ts extracts tool_calls to meta.pendingToolCalls
 * 3. But doesn't write them back to the assistant message in messages array
 * 4. Tool executes and adds tool message
 * 5. Next model call fails: "tool message must follow assistant with tool_calls"
 */
describe("V2 Tool Call Persistence Bug", () => {
  let threadId: string;
  let ctx: ExecutionContext;

  beforeEach(() => {
    threadId = createThreadId();
    ctx = createExecutionContext();
  });

  it("reproduces the bug: tool_calls not persisted in assistant message", async () => {
    // Step 1: Invoke with a request that will trigger tool calls
    const invokeRes = await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Please create a todo list" }],
      ctx
    );
    expect(invokeRes.status).toBe(202);

    // Wait for processing
    await waitForProcessing(2000);

    // Step 2: Get the state and examine the messages
    const { state, run } = await fetchThreadState(worker, threadId, ctx);

    console.log("=== Current State ===");
    console.log("Run status:", run?.status);
    console.log("Messages:", JSON.stringify(state.messages, null, 2));
    console.log("Meta pending:", state.meta?.pendingToolCalls);

    // Step 3: Get events to see what happened
    // biome-ignore lint/suspicious/noExplicitAny: events are dynamic from worker
    const { events } = (await fetchThreadEvents(worker, threadId, ctx)) as any;

    console.log("\n=== Events ===");
    // biome-ignore lint/suspicious/noExplicitAny: event structure is dynamic
    events.forEach((evt: any) => {
      console.log(`${evt.type}:`, JSON.stringify(evt.data, null, 2));
    });

    // Step 4: Check if there's an error about tool messages
    // biome-ignore lint/suspicious/noExplicitAny: event structure is dynamic
    const errorEvent = events.find((e: any) => e.type === "agent.error");
    if (errorEvent) {
      console.log("\n=== ERROR FOUND ===");
      console.log(errorEvent.data.error);

      // This is the bug we're looking for
      expect(errorEvent.data.error).toContain(
        "messages with role 'tool' must be a response to a preceeding message with 'tool_calls'"
      );
    }

    // Step 5: Verify the assistant message structure
    const assistantMessages = state.messages.filter(
      // biome-ignore lint/suspicious/noExplicitAny: messages are dynamic from worker
      (m: any) => m.role === "assistant"
    );
    const toolMessages = state.messages.filter(
      // biome-ignore lint/suspicious/noExplicitAny: messages are dynamic from worker
      (m: any) => m.role === "tool"
    );

    if (toolMessages.length > 0) {
      console.log("\n=== Message Analysis ===");
      console.log("Assistant messages:", assistantMessages.length);
      console.log("Tool messages:", toolMessages.length);

      // Find the assistant message that should have tool_calls
      const assistantBeforeTool = state.messages
        .slice(0, state.messages.indexOf(toolMessages[0]))
        .reverse()
        .find(
          // biome-ignore lint/suspicious/noExplicitAny: messages are dynamic from worker
          (m: any) => m.role === "assistant"
        );

      console.log(
        "Assistant message before first tool:",
        JSON.stringify(assistantBeforeTool, null, 2)
      );

      // BUG: This assertion will fail because tool_calls is missing
      expect(assistantBeforeTool).toBeDefined();
      if (assistantBeforeTool) {
        expect(assistantBeforeTool).toHaveProperty("tool_calls");
        // biome-ignore lint/suspicious/noExplicitAny: testing dynamic message structure
        expect((assistantBeforeTool as any).tool_calls).toBeDefined();
        // biome-ignore lint/suspicious/noExplicitAny: testing dynamic message structure
        expect(Array.isArray((assistantBeforeTool as any).tool_calls)).toBe(
          true
        );
        // biome-ignore lint/suspicious/noExplicitAny: testing dynamic message structure
        expect((assistantBeforeTool as any).tool_calls.length).toBeGreaterThan(
          0
        );
      }
    }
  });

  it("shows the correct structure with tool_calls in assistant message", () => {
    // This shows what the structure SHOULD look like
    const correctStructure = {
      messages: [
        { role: "user", content: "Create a todo list" },
        {
          role: "assistant",
          // ✅ tool_calls MUST be here
          tool_calls: [
            {
              id: "call_0",
              name: "write_todos",
              args: { todos: [] }
            }
          ]
        },
        {
          role: "tool",
          content: "Updated todo list",
          tool_call_id: "call_0" // References the id from tool_calls above
        },
        {
          role: "assistant",
          content: "I've created your todo list."
        }
      ],
      meta: {
        // It's fine to also have them here for tracking
        // but they MUST be in the messages array too
        pendingToolCalls: []
      }
    };

    // Validate this structure
    for (let i = 0; i < correctStructure.messages.length; i++) {
      const msg = correctStructure.messages[i];
      if (msg.role === "tool") {
        // Find preceding assistant
        let foundAssistantWithCalls = false;
        for (let j = i - 1; j >= 0; j--) {
          const prev = correctStructure.messages[j];
          if (prev.role === "assistant") {
            if ("tool_calls" in prev && Array.isArray(prev.tool_calls)) {
              foundAssistantWithCalls = true;
            }
            break;
          }
        }
        expect(foundAssistantWithCalls).toBe(true);
      }
    }
  });

  it("demonstrates the fix: writing tool_calls back to assistant message", async () => {
    // This test shows what the fix in worker.ts should do
    // biome-ignore lint/suspicious/noExplicitAny: simulating dynamic messages array
    const messages: any[] = [
      { role: "user", content: "Test" },
      {
        role: "assistant",
        tool_calls: [
          { name: "test_tool", args: {} }
          // Note: no id yet
        ]
      }
    ];

    // Simulate the fix in worker.ts lines 482-501
    const last = messages[messages.length - 1];
    if (
      last?.role === "assistant" &&
      "tool_calls" in last &&
      Array.isArray(last.tool_calls)
    ) {
      // Add stable IDs
      const withIds = last.tool_calls.map(
        // biome-ignore lint/suspicious/noExplicitAny: simulating dynamic tool calls
        (c: any, i: number) => ({
          ...c,
          id: c.id ?? `call_${i}`
        })
      );

      // 🔧 FIX: Write back to the assistant message
      messages[messages.length - 1] = {
        role: "assistant",
        tool_calls: withIds
      };

      // Now add tool result
      messages.push({
        role: "tool",
        content: "Tool output",
        tool_call_id: withIds[0].id
      });

      // Verify the structure is valid
      const assistantMsg = messages[messages.length - 2];
      expect(assistantMsg.role).toBe("assistant");
      expect(assistantMsg).toHaveProperty("tool_calls");
      expect(assistantMsg.tool_calls[0]).toHaveProperty("id");
      expect(assistantMsg.tool_calls[0].id).toBe("call_0");

      const toolMsg = messages[messages.length - 1];
      expect(toolMsg.role).toBe("tool");
      expect(toolMsg.tool_call_id).toBe(assistantMsg.tool_calls[0].id);
    }
  });
});
