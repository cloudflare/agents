/**
 * Bug Reproduction: Duplicate messages with needsApproval
 *
 * This server uses a mock AI response that always returns a tool call
 * requiring approval. This allows us to test the addToolApprovalResponse
 * flow without needing an actual AI API.
 */

import { callable, routeAgentRequest } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";

export class ApprovalBugAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    // Generate a unique tool call ID
    const toolCallId = crypto.randomUUID().slice(0, 16);

    // Create a mock stream that simulates an AI calling a tool with needsApproval
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        // Simulate AI thinking
        writer.write({ type: "text-start", id: "text-1" });
        writer.write({
          type: "text-delta",
          id: "text-1",
          delta: "I'll check the weather for you. "
        });
        writer.write({ type: "text-end", id: "text-1" });

        // Simulate tool call that requires approval
        // This mimics what happens when AI SDK encounters needsApproval: true
        writer.write({
          type: "tool-input-start",
          toolCallId,
          toolName: "getWeather"
        });
        writer.write({
          type: "tool-input-delta",
          toolCallId,
          inputTextDelta: '{"city":"Paris"}'
        });
        writer.write({
          type: "tool-input-available",
          toolCallId,
          toolName: "getWeather",
          input: { city: "Paris" }
        });

        // CRITICAL: Emit tool-approval-request to transition to "approval-requested" state
        // This is what AI SDK does when a tool has needsApproval: true
        // The approvalId is used by addToolApprovalResponse to identify which approval to respond to
        const approvalId = crypto.randomUUID();
        writer.write({
          type: "tool-approval-request",
          approvalId,
          toolCallId
        });

        // Note: We don't write tool-output because needsApproval pauses here
        // The tool is now in "approval-requested" state waiting for user approval
      }
    });

    return createUIMessageStreamResponse({ stream });
  }

  /**
   * Debug endpoint to get raw persisted messages from SQLite
   */
  @callable()
  getDebugMessages() {
    const rows =
      this
        .sql`SELECT id, message, created_at FROM cf_ai_chat_agent_messages ORDER BY created_at` ||
      [];

    const messages = rows.map((row) => ({
      dbId: row.id,
      createdAt: row.created_at,
      message: JSON.parse(row.message as string)
    }));

    // Find duplicates by toolCallId
    const toolCallIds = new Map<
      string,
      Array<{ messageId: string; state: string }>
    >();

    for (const { message } of messages) {
      if (message.role === "assistant") {
        for (const part of message.parts || []) {
          if (part.toolCallId) {
            const existing = toolCallIds.get(part.toolCallId) || [];
            existing.push({ messageId: message.id, state: part.state });
            toolCallIds.set(part.toolCallId, existing);
          }
        }
      }
    }

    const duplicates = Array.from(toolCallIds.entries())
      .filter(([, msgs]) => msgs.length > 1)
      .map(([toolCallId, msgs]) => ({ toolCallId, messages: msgs }));

    return {
      totalMessages: messages.length,
      messages,
      duplicates,
      hasDuplicates: duplicates.length > 0
    };
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
