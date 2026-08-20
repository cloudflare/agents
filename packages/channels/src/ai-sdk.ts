import { jsonSchema, tool, type Tool } from "ai";
import type { ChannelMessage, DeliveryResult } from "./channel";
import type { ChannelHost } from "./host";
import type { ChannelMessageSurface } from "./surface";
import { channelMessageJsonSchema, parseChannelMessage } from "./tool-schema";

type SendMessageTool = Tool<ChannelMessage, DeliveryResult>;

/** Model-facing options controlled by the caller creating the tool. */
export type CreateSendMessageToolOptions = Pick<
  SendMessageTool,
  | "description"
  | "inputExamples"
  | "metadata"
  | "needsApproval"
  | "providerOptions"
  | "strict"
>;

const channelMessageSchema = jsonSchema<ChannelMessage>(
  channelMessageJsonSchema,
  {
    validate(value) {
      try {
        return { success: true, value: parseChannelMessage(value) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error : new Error(String(error))
        };
      }
    }
  }
);

/**
 * Adapt one Host-resolved surface to an AI SDK tool.
 *
 * The caller chooses the key used in its ToolSet and owns model-facing policy
 * such as the description, examples, metadata, and approval requirement.
 */
export function createSendMessageTool(
  host: ChannelHost,
  surface: ChannelMessageSurface,
  options: CreateSendMessageToolOptions = {}
): Tool<ChannelMessage, DeliveryResult> {
  return tool({
    ...options,
    inputSchema: channelMessageSchema,
    execute: (message) => host.deliver(surface, message)
  });
}
