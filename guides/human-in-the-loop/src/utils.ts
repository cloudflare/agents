import { type UIMessage, type ToolSet, convertToModelMessages } from "ai";
type ToolExecutionOptions = {
  messages: ReturnType<typeof convertToModelMessages>;
  toolCallId: string;
};

// Approval string to be shared across frontend and backend
export const APPROVAL = {
  NO: "No, denied.",
  YES: "Yes, confirmed."
} as const;

function isValidToolName<K extends PropertyKey, T extends object>(
  key: K,
  obj: T
): key is K & keyof T {
  return key in obj;
}

/**
 * Processes tool invocations where human input is required, executing tools when authorized.
 *
 * @param options - The function options
 * @param options.tools - Map of tool names to Tool instances that may expose execute functions
 * @param options.dataStream - Data stream for sending results back to the client
 * @param options.messages - Array of messages to process
 * @param executionFunctions - Map of tool names to execute functions
 * @returns Promise resolving to the processed messages
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
    [K in keyof Tools & keyof ExecutableTools]?: (
      args: Record<string, unknown>,
      context: ToolExecutionOptions
    ) => Promise<unknown>;
  }
): Promise<UIMessage[]> {
  const lastMessage = messages[messages.length - 1];
  const parts = lastMessage.parts;
  if (!parts) return messages;

  const processedParts = await Promise.all(
    parts.map(async (part) => {
      // Only process tool invocations parts
      if (part.type !== "tool-invocation") return part;

      // For AI SDK v5, we need to handle the tool invocation structure properly
      // The part structure may vary, so we'll use type assertions for now
      const toolInvocation = part as any;
      const toolName = toolInvocation.toolName;

      // Only continue if we have an execute function for the tool (meaning it requires confirmation) and it's in a 'result' state
      if (!(toolName in executeFunctions) || toolInvocation.state !== "result")
        return part;

      let result: unknown;

      if (toolInvocation.result === APPROVAL.YES) {
        // Get the tool and check if the tool has an execute function.
        if (
          !isValidToolName(toolName, executeFunctions) ||
          toolInvocation.state !== "result"
        ) {
          return part;
        }

        const toolInstance =
          executeFunctions[toolName as keyof typeof executeFunctions];
        if (toolInstance) {
          result = await toolInstance(toolInvocation.args, {
            messages: convertToModelMessages(messages),
            toolCallId: toolInvocation.toolCallId
          });
        } else {
          result = "Error: No execute function found on tool";
        }
      } else if (toolInvocation.result === APPROVAL.NO) {
        result = "Error: User denied access to tool execution";
      } else {
        // For any unhandled responses, return the original part.
        return part;
      }

      // Return updated toolInvocation with the actual result.
      return {
        ...part,
        toolInvocation: {
          ...toolInvocation,
          result
        }
      };
    })
  );

  // Finally return the processed messages
  return [...messages.slice(0, -1), { ...lastMessage, parts: processedParts }];
}

export function getToolsRequiringConfirmation<
  T extends ToolSet
  // E extends {
  //   [K in keyof T as T[K] extends { execute: Function } ? never : K]: T[K];
  // },
>(tools: T): string[] {
  return (Object.keys(tools) as (keyof T)[]).filter((key) => {
    const maybeTool = tools[key];
    return typeof maybeTool.execute !== "function";
  }) as string[];
}
