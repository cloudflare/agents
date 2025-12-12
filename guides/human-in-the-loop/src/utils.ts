/**
 * Server-side utilities for processing tool confirmations.
 *
 * When a user approves/denies a tool call via the useChat hook,
 * these utilities process that confirmation on the server side.
 */

import type { UIMessage } from "@ai-sdk/react";
import type { ToolSet } from "ai";
import type { z } from "zod";
import { TOOL_CONFIRMATION } from "agents/react";
import { toolsRequiringConfirmation } from "./tools";

// Re-export for backwards compatibility
// @deprecated Use TOOL_CONFIRMATION from "agents/react" instead
export const APPROVAL = {
  YES: TOOL_CONFIRMATION.APPROVED,
  NO: TOOL_CONFIRMATION.DENIED
} as const;

// =============================================================================
// TYPE HELPERS
// =============================================================================

/** Infers the input type from a tool's Zod schema */
type InferToolArgs<T> = T extends { inputSchema: infer S }
  ? S extends z.ZodType
    ? z.infer<S>
    : never
  : never;

/** Type guard for tool confirmation message parts */
function isToolConfirmationPart(part: unknown): part is {
  type: string;
  output: string;
  input?: Record<string, unknown>;
} {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    "output" in part &&
    typeof (part as { type: unknown }).type === "string" &&
    typeof (part as { output: unknown }).output === "string"
  );
}

// =============================================================================
// CONFIRMATION DETECTION
// =============================================================================

/**
 * Checks if a message contains tool confirmation responses.
 *
 * Called by AIChatAgent.onChatMessage() to determine if the incoming
 * message is a user responding to a tool confirmation prompt.
 *
 * @param message - The latest user message
 * @returns true if message contains tool confirmation(s)
 */
export function hasToolConfirmation(message: UIMessage): boolean {
  if (!message?.parts) return false;

  return message.parts.some((part) => {
    // Tool parts have type like "tool-getWeatherInformation"
    if (!part.type?.startsWith("tool-")) return false;

    const toolName = part.type.slice("tool-".length);

    // Only check tools that require confirmation
    if (!toolsRequiringConfirmation.includes(toolName)) return false;

    // Must have an output (the user's response)
    return "output" in part;
  });
}

// =============================================================================
// TOOL EXECUTION
// =============================================================================

/**
 * Processes tool confirmations and executes approved tools.
 *
 * When a user approves a tool:
 * 1. Finds the tool confirmation in the message
 * 2. Executes the tool with the original input
 * 3. Replaces the confirmation signal with the actual result
 *
 * @param context - Messages and tool definitions
 * @param executeFunctions - Server-side tool implementations
 * @returns Updated messages with tool results
 *
 * @example
 * ```ts
 * // In AIChatAgent.onChatMessage():
 * if (hasToolConfirmation(lastMessage)) {
 *   const updatedMessages = await processToolCalls(
 *     { messages: this.messages, tools },
 *     { getWeatherInformation }  // Server-side implementations
 *   );
 *   this.messages = updatedMessages;
 * }
 * ```
 */
export async function processToolCalls<
  Tools extends ToolSet,
  ExecutableTools extends {
    [Tool in keyof Tools as Tools[Tool] extends { execute: Function }
      ? never
      : Tool]: Tools[Tool];
  }
>(
  {
    messages,
    tools: _tools
  }: {
    tools: Tools;
    messages: UIMessage[];
  },
  executeFunctions: {
    [K in keyof ExecutableTools as ExecutableTools[K] extends {
      inputSchema: z.ZodType;
    }
      ? K
      : never]?: (args: InferToolArgs<ExecutableTools[K]>) => Promise<string>;
  }
): Promise<UIMessage[]> {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage.parts) return messages;

  const processedParts = await Promise.all(
    lastMessage.parts.map(async (part) => {
      // Skip non-tool parts
      if (!isToolConfirmationPart(part) || !part.type.startsWith("tool-")) {
        return part;
      }

      const toolName = part.type.replace("tool-", "");
      const userResponse = part.output;

      // Skip if we don't have an execute function for this tool
      if (!(toolName in executeFunctions)) {
        return part;
      }

      let result: string;

      if (userResponse === TOOL_CONFIRMATION.APPROVED) {
        // User approved - execute the tool
        const executeFunc =
          executeFunctions[toolName as keyof typeof executeFunctions];

        if (executeFunc) {
          const toolInput = part.input ?? {};
          result = await (
            executeFunc as (args: typeof toolInput) => Promise<string>
          )(toolInput);
        } else {
          result = "Error: No execute function found for tool";
        }
      } else if (userResponse === TOOL_CONFIRMATION.DENIED) {
        // User denied
        result = "Tool execution denied by user";
      } else {
        // Custom denial reason or unexpected response
        result = `Tool execution denied: ${userResponse}`;
      }

      // Return part with actual tool result (not the confirmation signal)
      return { ...part, output: result };
    })
  );

  return [...messages.slice(0, -1), { ...lastMessage, parts: processedParts }];
}

// Re-export getWeatherInformation for server.ts
export { getWeatherInformation } from "./tools";
