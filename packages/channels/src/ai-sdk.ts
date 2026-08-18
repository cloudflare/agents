import { jsonSchema, tool, type Tool } from "ai";
import type {
  ChannelDelivery,
  ChannelMessage,
  DeliveryResult
} from "./channel";
import { channelMessageJsonSchema, parseChannelMessage } from "./tool-schema";

type ChannelTool = Tool<ChannelMessage, DeliveryResult>;

/** Model-facing options controlled by the caller creating the tool. */
export type CreateChannelToolOptions = Pick<
  ChannelTool,
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
 * Adapt a configured Channel to an AI SDK tool.
 *
 * The caller chooses the key used in its ToolSet and owns model-facing policy
 * such as the description, examples, metadata, and approval requirement.
 */
export function createChannelTool(
  channel: ChannelDelivery,
  options: CreateChannelToolOptions = {}
): Tool<ChannelMessage, DeliveryResult> {
  return tool({
    ...options,
    inputSchema: channelMessageSchema,
    execute: (message) => channel.deliver(message)
  });
}
