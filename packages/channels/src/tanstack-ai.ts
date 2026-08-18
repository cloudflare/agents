import { toolDefinition } from "@tanstack/ai";
import type { ChannelDelivery } from "./channel";
import { channelMessageJsonSchema, parseChannelMessage } from "./tool-schema";

export type CreateChannelToolOptions = {
  /** TanStack AI tools carry their name in the definition. */
  name: string;
  description?: string;
  needsApproval?: boolean;
  metadata?: Record<string, unknown>;
};

/** Adapt a configured Channel to a TanStack AI server tool. */
export function createChannelTool(
  channel: ChannelDelivery,
  options: CreateChannelToolOptions
) {
  const definition = toolDefinition({
    name: options.name,
    description:
      options.description ?? "Deliver a message through this Channel",
    inputSchema: channelMessageJsonSchema,
    ...(options.needsApproval && { needsApproval: true }),
    metadata: options.metadata
  });

  return definition.server(async (value) =>
    channel.deliver(parseChannelMessage(value))
  );
}
