import { jsonSchema, tool, type Tool } from "ai";
import type {
  ChannelMessage,
  DeliveryResult
} from "../../experimental/channels/channel";
import type { ChannelGateway } from "../../experimental/channels/gateway";
import type { ChannelMessageSurface } from "../../experimental/channels/surface";
import {
  channelMessageJsonSchema,
  parseChannelMessage
} from "../../experimental/channels/tool-schema";

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

// Intent: Channel tools will eventually get a module of their own that
// exports a version per harness (an AI SDK tool, a pi tool, and so on), and
// this one moves there. Until then it lives with the AI SDK harness.

/**
 * Adapt one Host-resolved surface to an AI SDK tool.
 *
 * The caller chooses the key used in its ToolSet and owns model-facing policy
 * such as the description, examples, metadata, and approval requirement.
 */
export function createSendMessageTool(
  gateway: ChannelGateway,
  surface: ChannelMessageSurface,
  options: CreateSendMessageToolOptions = {}
): Tool<ChannelMessage, DeliveryResult> {
  return tool({
    ...options,
    inputSchema: channelMessageSchema,
    execute: (message) => gateway.deliver(surface, message)
  });
}
