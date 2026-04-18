/**
 * MessengerAdapter — the interface every platform adapter implements.
 *
 * An adapter is a stateless I/O bridge between an agent and a messaging
 * platform. It verifies inbound webhooks, parses them into normalized
 * events, and converts outbound messages into the platform's native
 * format. It does NOT manage routing, state, or subscriptions — those
 * are the agent's concern.
 */

import type {
  ChannelRef,
  InboundEvent,
  OutboundMessage,
  PlatformCapabilities,
  SentMessage
} from "./types";

export interface MessengerAdapter {
  /** Platform identifier (e.g. "slack", "telegram"). */
  readonly platform: string;

  /** Declares what this platform supports. */
  readonly capabilities: PlatformCapabilities;

  /**
   * Verify + parse a webhook request in one call. Returns a Response
   * that the Worker should send back to the platform.
   *
   * The handler receives the parsed event. If verification fails,
   * a 401 response is returned without calling the handler.
   */
  handleWebhook(
    request: Request,
    handler: (event: InboundEvent) => Promise<void>
  ): Promise<Response>;

  /**
   * Send a message to the platform.
   */
  postMessage(
    channel: ChannelRef,
    content: OutboundMessage
  ): Promise<SentMessage>;

  /**
   * Edit a previously sent message.
   */
  editMessage(
    channel: ChannelRef,
    messageId: string,
    content: OutboundMessage
  ): Promise<void>;

  /**
   * Delete a previously sent message.
   */
  deleteMessage(channel: ChannelRef, messageId: string): Promise<void>;

  /**
   * Add an emoji reaction to a message.
   */
  addReaction(
    channel: ChannelRef,
    messageId: string,
    emoji: string
  ): Promise<void>;

  /**
   * Stream a message by posting and then editing as chunks arrive.
   * The adapter handles the post+edit loop and rate limiting internally.
   */
  streamMessage(
    channel: ChannelRef,
    stream: AsyncIterable<string>
  ): Promise<SentMessage>;
}

/**
 * Render an OutboundMessage to a plain markdown string.
 * Useful as a fallback or for adapters that accept markdown directly.
 */
export function renderToMarkdown(message: OutboundMessage): string {
  if (typeof message === "string") {
    return message;
  }
  if ("markdown" in message) {
    return message.markdown;
  }
  const parts: string[] = [];
  for (const block of message.blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.content);
        break;
      case "code":
        parts.push(
          block.language
            ? `\`\`\`${block.language}\n${block.content}\n\`\`\``
            : `\`\`\`\n${block.content}\n\`\`\``
        );
        break;
      case "image":
        parts.push(`![${block.alt ?? "image"}](${block.url})`);
        break;
      case "actions":
        parts.push(block.buttons.map((b) => `[${b.label}]`).join("  "));
        break;
      case "fields":
        parts.push(
          block.items.map((f) => `**${f.label}:** ${f.value}`).join("\n")
        );
        break;
    }
  }
  return parts.join("\n\n");
}
