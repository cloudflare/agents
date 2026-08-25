import { toolDefinition } from "@tanstack/ai";
import type { ChannelRouter } from "./router";
import type { ChannelMessageSurface } from "./surface";
import { channelMessageJsonSchema, parseChannelMessage } from "./tool-schema";

export type CreateSendMessageToolOptions = {
  /** TanStack AI tools carry their name in the definition. */
  name: string;
  description?: string;
  needsApproval?: boolean;
  metadata?: Record<string, unknown>;
};

/** Adapt one Router-resolved surface to a TanStack AI server tool. */
export function createSendMessageTool(
  router: ChannelRouter,
  surface: ChannelMessageSurface,
  options: CreateSendMessageToolOptions
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
    router.deliver(surface, parseChannelMessage(value))
  );
}
