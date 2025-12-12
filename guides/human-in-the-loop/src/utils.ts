import type { UIMessage } from "@ai-sdk/react";
import type { ToolSet } from "ai";
import type { z } from "zod";
import { TOOL_CONFIRMATION } from "agents";
import { getToolsRequiringConfirmation } from "agents/react";
import { clientTools } from "./tools";

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

export function hasToolConfirmation(message: UIMessage): boolean {
  if (!message?.parts) return false;

  const confirmationTools = getToolsRequiringConfirmation(clientTools);

  return message.parts.some((part) => {
    if (!part.type?.startsWith("tool-")) return false;
    const toolName = part.type.slice("tool-".length);
    if (!confirmationTools.includes(toolName)) return false;
    return "output" in part;
  });
}

type ExecuteFn = (args: Record<string, unknown>) => Promise<string>;

export async function processToolCalls(
  {
    messages,
    tools
  }: {
    tools: ToolSet;
    messages: UIMessage[];
  },
  executeFunctions: Record<string, ExecuteFn>
): Promise<UIMessage[]> {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage.parts) return messages;

  const processedParts = await Promise.all(
    lastMessage.parts.map(async (part) => {
      if (!isToolConfirmationPart(part) || !part.type.startsWith("tool-")) {
        return part;
      }

      const toolName = part.type.replace("tool-", "");
      const userResponse = part.output;

      if (!(toolName in executeFunctions)) {
        return part;
      }

      let result: string;

      if (userResponse === TOOL_CONFIRMATION.APPROVED) {
        const executeFunc = executeFunctions[toolName];
        const toolDef = tools[toolName];

        if (!executeFunc) {
          result = "Error: No execute function found for tool";
        } else {
          try {
            const toolInput = part.input ?? {};

            // Validate input against schema if available
            if (toolDef && "inputSchema" in toolDef && toolDef.inputSchema) {
              const schema = toolDef.inputSchema as z.ZodType;
              const parsed = schema.safeParse(toolInput);
              if (!parsed.success) {
                result = `Error: Invalid input - ${parsed.error.message}`;
              } else {
                result = await executeFunc(parsed.data);
              }
            } else {
              result = await (
                executeFunc as (args: unknown) => Promise<string>
              )(toolInput);
            }
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      } else if (userResponse === TOOL_CONFIRMATION.DENIED) {
        result = "Tool execution denied by user";
      } else {
        // Custom denial reason (any non-standard response)
        result = `Tool execution denied: ${userResponse}`;
      }

      return { ...part, output: result };
    })
  );

  return [...messages.slice(0, -1), { ...lastMessage, parts: processedParts }];
}

export { getWeatherInformation } from "./tools";
