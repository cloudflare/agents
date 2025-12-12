import type { UIMessage } from "@ai-sdk/react";
import type { ToolSet } from "ai";
import type { z } from "zod";

// Helper type to infer tool arguments from Zod schema
type InferToolArgs<T> = T extends { inputSchema: infer S }
  ? S extends z.ZodType
    ? z.infer<S>
    : never
  : never;

// Type guard to check if part has required properties
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

export const APPROVAL = {
  NO: "No, denied.",
  YES: "Yes, confirmed."
} as const;

/**
 * Tools that require Human-In-The-Loop
 */
export const toolsRequiringConfirmation = [
  "getLocalTime",
  "getWeatherInformation"
];

/**
 * Check if a message contains tool confirmations
 */
export function hasToolConfirmation(message: UIMessage): boolean {
  return (
    message?.parts?.some(
      (part) =>
        part.type?.startsWith("tool-") &&
        toolsRequiringConfirmation.includes(part.type?.slice("tool-".length)) &&
        "output" in part
    ) || false
  );
}

/**
 * Weather tool implementation
 */
export async function getWeatherInformation(args: unknown): Promise<string> {
  const { city } = args as { city: string };
  const conditions = ["sunny", "cloudy", "rainy", "snowy"];
  return `The weather in ${city} is ${
    conditions[Math.floor(Math.random() * conditions.length)]
  }.`;
}

/**
 * Processes tool invocations where human input is required, executing tools when authorized.
 * using UIMessageStreamWriter
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
    tools: Tools; // used for type inference
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
  const parts = lastMessage.parts;
  if (!parts) return messages;

  const processedParts = await Promise.all(
    parts.map(async (part) => {
      // Look for tool parts with output (confirmations) - v5 format
      if (isToolConfirmationPart(part) && part.type.startsWith("tool-")) {
        const toolName = part.type.replace("tool-", "");
        const output = part.output;
        // Only process if we have an execute function for this tool
        if (!(toolName in executeFunctions)) {
          return part;
        }

        let result: string | undefined;

        if (output === APPROVAL.YES) {
          const toolInstance =
            executeFunctions[toolName as keyof typeof executeFunctions];
          if (toolInstance) {
            // Pass the input data - the tool's Zod schema will validate at runtime
            const toolInput = part.input ?? {};
            // We need to trust that the runtime data matches the expected type
            // The Zod schema in the tool will validate this
            result = await (
              toolInstance as (args: typeof toolInput) => Promise<string>
            )(toolInput);
          } else {
            result = "Error: No execute function found on tool";
          }
        } else if (output === APPROVAL.NO) {
          result = "Error: User denied access to tool execution";
        }

        // Return updated part with actual tool result (not the confirmation)
        if (result !== undefined) {
          return {
            ...part,
            output: result
          };
        }
        return part;
      }
      return part; // Return unprocessed parts
    })
  );

  return [
    ...messages.slice(0, -1),
    { ...lastMessage, parts: processedParts.filter(Boolean) }
  ];
}
