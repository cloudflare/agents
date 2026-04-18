/**
 * Slack adapter for the messengers package.
 *
 * Wraps slack-cloudflare-workers for webhook verification and parsing,
 * and slack-web-api-client for outbound API calls.
 */

import { SlackAPIClient } from "slack-cloudflare-workers";
import type { MessengerAdapter } from "../../adapter";
import { splitMessage } from "../../message-splitter";
import { streamLoop } from "../../stream-loop";
import type {
  ChannelRef,
  InboundEvent,
  OutboundMessage,
  PlatformCapabilities,
  SentMessage,
  SlackChannelRef
} from "../../types";
import { verifySlackRequest } from "./verify";
import { parseSlackEvent, getSlackChallenge } from "./parse";
import { renderSlackMessage } from "./render";

export interface SlackMessengerOptions {
  botToken: string;
  signingSecret: string;
}

export class SlackMessenger implements MessengerAdapter {
  readonly platform = "slack" as const;
  readonly capabilities: PlatformCapabilities = {
    streaming: "post-edit",
    maxMessageLength: 40_000,
    richText: "mrkdwn",
    interactiveElements: "full",
    fileUpload: { maxSize: 1_000_000_000 },
    threading: "native",
    typing: false,
    editAfterPost: true,
    reactions: true
  };

  readonly #client: SlackAPIClient;
  readonly #signingSecret: string;

  constructor(options: SlackMessengerOptions) {
    this.#client = new SlackAPIClient(options.botToken);
    this.#signingSecret = options.signingSecret;
  }

  async handleWebhook(
    request: Request,
    handler: (event: InboundEvent) => Promise<void>
  ): Promise<Response> {
    if (!(await this.verifyWebhook(request))) {
      return new Response("Invalid signature", { status: 401 });
    }

    const body = await request.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const challenge = getSlackChallenge(payload);
    if (challenge) {
      return new Response(JSON.stringify({ challenge }), {
        headers: { "content-type": "application/json" }
      });
    }

    const event = parseSlackEvent(payload);
    await handler(event);
    return new Response("OK");
  }

  async verifyWebhook(request: Request): Promise<boolean> {
    return verifySlackRequest(request, this.#signingSecret);
  }

  async parseWebhook(request: Request): Promise<InboundEvent> {
    const body = await request.text();
    const payload = JSON.parse(body);
    return parseSlackEvent(payload);
  }

  async postMessage(
    channel: ChannelRef,
    content: OutboundMessage
  ): Promise<SentMessage> {
    const ref = assertSlackChannel(channel);
    const rendered = renderSlackMessage(content);

    const chunks = splitMessage(rendered.text, {
      maxLength: this.capabilities.maxMessageLength
    });

    let firstResult: SentMessage | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const response = await this.#client.chat.postMessage({
        channel: ref.channelId,
        text: chunks[i],
        ...(ref.threadTs ? { thread_ts: ref.threadTs } : {}),
        // Only attach blocks to the first chunk
        ...(i === 0 && rendered.blocks ? { blocks: rendered.blocks } : {})
      });

      if (!firstResult) {
        firstResult = {
          id: response.ts ?? "",
          platform: "slack",
          channel: ref,
          text: chunks[i]
        };
      }
    }

    return firstResult!;
  }

  async editMessage(
    channel: ChannelRef,
    messageId: string,
    content: OutboundMessage
  ): Promise<void> {
    const ref = assertSlackChannel(channel);
    const rendered = renderSlackMessage(content);

    await this.#client.chat.update({
      channel: ref.channelId,
      ts: messageId,
      text: rendered.text,
      ...(rendered.blocks ? { blocks: rendered.blocks } : {})
    });
  }

  async deleteMessage(channel: ChannelRef, messageId: string): Promise<void> {
    const ref = assertSlackChannel(channel);
    await this.#client.chat.delete({
      channel: ref.channelId,
      ts: messageId
    });
  }

  async addReaction(
    channel: ChannelRef,
    messageId: string,
    emoji: string
  ): Promise<void> {
    const ref = assertSlackChannel(channel);
    const name = emoji.replace(/^:|:$/g, "");
    await this.#client.reactions.add({
      channel: ref.channelId,
      timestamp: messageId,
      name
    });
  }

  async streamMessage(
    channel: ChannelRef,
    stream: AsyncIterable<string>
  ): Promise<SentMessage> {
    const ref = assertSlackChannel(channel);

    const result = await streamLoop(stream, {
      updateIntervalMs: 500,
      postInitial: async () => {
        const r = await this.#client.chat.postMessage({
          channel: ref.channelId,
          text: "...",
          ...(ref.threadTs ? { thread_ts: ref.threadTs } : {})
        });
        return r.ts ?? "";
      },
      editMessage: async (ts, text) => {
        await this.#client.chat.update({
          channel: ref.channelId,
          ts,
          text
        });
      }
    });

    return {
      id: result.id,
      platform: "slack",
      channel: ref,
      text: result.text
    };
  }

  /**
   * Access the underlying SlackAPIClient for operations the
   * adapter interface does not cover (e.g. Block Kit, modals).
   */
  get api(): SlackAPIClient {
    return this.#client;
  }
}

function assertSlackChannel(channel: ChannelRef): SlackChannelRef {
  if (channel.platform !== "slack") {
    throw new Error(
      `SlackMessenger received a ${channel.platform} channel reference`
    );
  }
  return channel as SlackChannelRef;
}

export { verifySlackRequest } from "./verify";
export { parseSlackEvent, getSlackChallenge } from "./parse";
export { renderSlackMessage } from "./render";
