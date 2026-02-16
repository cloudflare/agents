/**
 * @experimental Workers AI adapter — unstable, may change without notice.
 *
 * Converts WorkingContext messages into the format expected by
 * Cloudflare Workers AI chat completions API.
 */

import type { ContextMessage, ModelFormatAdapter } from "../types";

/**
 * Message shape expected by Workers AI `env.AI.run()` for chat models.
 */
export interface WorkersAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface WorkersAIChatInput {
  messages: WorkersAIChatMessage[];
}

function toWorkersAIMessage(msg: ContextMessage): WorkersAIChatMessage {
  const result: WorkersAIChatMessage = {
    role: msg.role,
    content: msg.content,
  };

  if (msg.name) {
    result.name = msg.name;
  }

  if (msg.toolCallId) {
    result.tool_call_id = msg.toolCallId;
  }

  if (msg.toolCalls && msg.toolCalls.length > 0) {
    result.tool_calls = msg.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      },
    }));
  }

  return result;
}

/**
 * @experimental
 * Adapter for Cloudflare Workers AI chat completions format.
 */
export const workersAIAdapter: ModelFormatAdapter<WorkersAIChatInput> = {
  name: "workers-ai",

  toModelMessages(
    systemInstructions: string[],
    messages: ContextMessage[]
  ): WorkersAIChatInput {
    const result: WorkersAIChatMessage[] = [];

    // Combine system instructions into a single system message at the top
    if (systemInstructions.length > 0) {
      result.push({
        role: "system",
        content: systemInstructions.join("\n\n"),
      });
    }

    for (const msg of messages) {
      result.push(toWorkersAIMessage(msg));
    }

    return { messages: result };
  },
};
