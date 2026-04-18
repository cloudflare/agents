/**
 * Telegram adapter for the messengers package.
 *
 * Wraps grammY for webhook parsing and uses the Telegram Bot API
 * directly via grammY's Api class for outbound messages.
 */

import { Api } from "grammy";
import type { ReactionTypeEmoji } from "grammy/types";
import type { MessengerAdapter } from "../../adapter";
import { splitMessage } from "../../message-splitter";
import { streamLoop } from "../../stream-loop";
import type {
  ChannelRef,
  InboundEvent,
  OutboundMessage,
  PlatformCapabilities,
  SentMessage,
  TelegramChannelRef
} from "../../types";
import { verifyTelegramRequest } from "./verify";
import { parseTelegramUpdate, type TelegramUpdate } from "./parse";
import { renderTelegramMessage } from "./render";

export interface TelegramMessengerOptions {
  botToken: string;
  /** Secret token for webhook verification (set via setWebhook API). */
  secretToken?: string;
}

export class TelegramMessenger implements MessengerAdapter {
  readonly platform = "telegram" as const;
  readonly capabilities: PlatformCapabilities = {
    streaming: "post-edit",
    maxMessageLength: 4096,
    richText: "markdown",
    interactiveElements: "buttons",
    fileUpload: { maxSize: 50_000_000 },
    threading: "reply-to",
    typing: true,
    editAfterPost: true,
    reactions: true
  };

  readonly #api: Api;
  readonly #secretToken: string | undefined;

  constructor(options: TelegramMessengerOptions) {
    this.#api = new Api(options.botToken);
    this.#secretToken = options.secretToken;
  }

  async handleWebhook(
    request: Request,
    handler: (event: InboundEvent) => Promise<void>
  ): Promise<Response> {
    if (!(await this.verifyWebhook(request))) {
      return new Response("Unauthorized", { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const event = parseTelegramUpdate(body as TelegramUpdate);
    await handler(event);
    return new Response("OK");
  }

  async verifyWebhook(request: Request): Promise<boolean> {
    return verifyTelegramRequest(request, this.#secretToken);
  }

  async parseWebhook(request: Request): Promise<InboundEvent> {
    const body = await request.json();
    return parseTelegramUpdate(body as TelegramUpdate);
  }

  async postMessage(
    channel: ChannelRef,
    content: OutboundMessage
  ): Promise<SentMessage> {
    const ref = assertTelegramChannel(channel);
    const rendered = renderTelegramMessage(content);

    const chunks = splitMessage(rendered.text, {
      maxLength: this.capabilities.maxMessageLength
    });

    let firstResult: SentMessage | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;

      const result = await this.#api.sendMessage(ref.chatId, chunks[i], {
        parse_mode: rendered.parse_mode,
        ...(ref.messageThreadId
          ? { message_thread_id: ref.messageThreadId }
          : {}),
        // Only attach inline keyboard to the last chunk
        ...(isLast && rendered.reply_markup
          ? { reply_markup: rendered.reply_markup }
          : {})
      });

      if (!firstResult) {
        firstResult = {
          id: String(result.message_id),
          platform: "telegram",
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
    const ref = assertTelegramChannel(channel);
    const rendered = renderTelegramMessage(content);

    await this.#api.editMessageText(
      ref.chatId,
      Number(messageId),
      rendered.text,
      {
        parse_mode: rendered.parse_mode,
        ...(rendered.reply_markup
          ? { reply_markup: rendered.reply_markup }
          : {})
      }
    );
  }

  async deleteMessage(channel: ChannelRef, messageId: string): Promise<void> {
    const ref = assertTelegramChannel(channel);
    await this.#api.deleteMessage(ref.chatId, Number(messageId));
  }

  async addReaction(
    channel: ChannelRef,
    messageId: string,
    emoji: string
  ): Promise<void> {
    const ref = assertTelegramChannel(channel);
    // Telegram restricts reaction emojis to a specific set. We cast
    // because our adapter interface uses generic strings — callers
    // should pass valid Telegram emoji (e.g. "👍", "❤", "🔥").
    const reaction: ReactionTypeEmoji = {
      type: "emoji",
      emoji: emoji as ReactionTypeEmoji["emoji"]
    };
    await this.#api.setMessageReaction(ref.chatId, Number(messageId), [
      reaction
    ]);
  }

  async streamMessage(
    channel: ChannelRef,
    stream: AsyncIterable<string>
  ): Promise<SentMessage> {
    const ref = assertTelegramChannel(channel);
    await this.#api.sendChatAction(ref.chatId, "typing");

    const result = await streamLoop(stream, {
      updateIntervalMs: 1000,
      postInitial: async () => {
        const r = await this.#api.sendMessage(ref.chatId, "...", {
          ...(ref.messageThreadId
            ? { message_thread_id: ref.messageThreadId }
            : {})
        });
        return String(r.message_id);
      },
      editMessage: async (id, text) => {
        await this.#api.editMessageText(ref.chatId, Number(id), text);
      }
    });

    return {
      id: result.id,
      platform: "telegram",
      channel: ref,
      text: result.text
    };
  }

  /** Send a typing indicator. */
  async sendTyping(channel: ChannelRef): Promise<void> {
    const ref = assertTelegramChannel(channel);
    await this.#api.sendChatAction(ref.chatId, "typing");
  }

  /**
   * Access the underlying grammY Api instance for operations the
   * adapter interface does not cover (e.g. sending photos, stickers).
   */
  get api(): Api {
    return this.#api;
  }
}

function assertTelegramChannel(channel: ChannelRef): TelegramChannelRef {
  if (channel.platform !== "telegram") {
    throw new Error(
      `TelegramMessenger received a ${channel.platform} channel reference`
    );
  }
  return channel as TelegramChannelRef;
}

export { verifyTelegramRequest } from "./verify";
export { parseTelegramUpdate, type TelegramUpdate } from "./parse";
export { renderTelegramMessage } from "./render";
