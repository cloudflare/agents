import type { UIMessage } from "@ai-sdk/react";
import { type UIMessageStreamWriter, type ToolSet } from "ai";
import type { z } from "zod";


export const APPROVAL = {
  NO: "No, denied.",
  YES: "Yes, confirmed."
} as const;

/**
 * Check if a message contains tool confirmations
 */
export function hasToolConfirmation(message: UIMessage): boolean {
  return message?.parts?.some(part => 
    part.type?.startsWith('tool-') && 'output' in part
  ) || false;
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
<<<<<<< HEAD
    dataStream,
    messages
=======
    writer,
    messages,
>>>>>>> 869706b (fixed human in the loop)
  }: {
    tools: Tools; // used for type inference
    writer: UIMessageStreamWriter;
    messages: UIMessage[];
  },
  executeFunctions: {
    [K in keyof Tools & keyof ExecutableTools]?: (
      args: z.infer<ExecutableTools[K]["inputSchema"]>
    ) => Promise<any>;
  }
): Promise<UIMessage[]> {
  const lastMessage = messages[messages.length - 1];
  const parts = lastMessage.parts;
  if (!parts) return messages;

  const processedParts = await Promise.all(
    parts.map(async (part) => {
      // Look for tool parts with output (confirmations) - v5 format
      if (part.type?.startsWith('tool-') && 'output' in part) {
        const toolName = part.type.replace('tool-', '');
        const output = (part as any).output;
        
        // Only process if we have an execute function for this tool
        if (!(toolName in executeFunctions)) {
          return part;
        }

<<<<<<< HEAD
        const toolInstance = executeFunctions[toolName];
        if (toolInstance) {
          result = await toolInstance(toolInvocation.args, {
            messages: convertToCoreMessages(messages),
            toolCallId: toolInvocation.toolCallId
          });
        } else {
          result = "Error: No execute function found on tool";
=======
        let result: any;

        if (output === APPROVAL.YES) {
          const toolInstance = executeFunctions[toolName as keyof typeof executeFunctions];
          if (toolInstance) {
            const toolInput = 'input' in part ? (part as any).input : {};
            result = await toolInstance(toolInput);
            
            // Stream the result directly using writer
            const messageId = crypto.randomUUID();
            const textStream = new ReadableStream({
              start(controller) {
                controller.enqueue({
                  type: 'text-start',
                  id: messageId,
                });
                controller.enqueue({
                  type: 'text-delta', 
                  id: messageId,
                  delta: result,
                });
                controller.enqueue({
                  type: 'text-end',
                  id: messageId,
                });
                controller.close();
              }
            });
            
            writer.merge(textStream);
          } else {
            result = "Error: No execute function found on tool";
          }
        } else if (output === APPROVAL.NO) {
          result = "Error: User denied access to tool execution";
>>>>>>> 869706b (fixed human in the loop)
        }

        return part; // Return the original part
      }

<<<<<<< HEAD
      // Forward updated tool result to the client.
      dataStream.write(
        formatDataStreamPart("tool_result", {
          result,
          toolCallId: toolInvocation.toolCallId
        })
      );

      // Return updated toolInvocation with the actual result.
      return {
        ...part,
        toolInvocation: {
          ...toolInvocation,
          result
        }
      };
=======
      return part;
>>>>>>> 869706b (fixed human in the loop)
    })
  );

  return [...messages.slice(0, -1), { ...lastMessage, parts: processedParts }];
}
<<<<<<< HEAD

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
=======
>>>>>>> 869706b (fixed human in the loop)
