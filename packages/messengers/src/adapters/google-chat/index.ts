/**
 * Google Chat adapter for the messengers package.
 *
 * Uses the Google Chat REST API with service account authentication.
 * Webhook verification supports both JWT verification (RS256) and
 * the simpler static token approach.
 */

import type { MessengerAdapter } from "../../adapter";
import { splitMessage } from "../../message-splitter";
import { streamLoop } from "../../stream-loop";
import type {
  ChannelRef,
  InboundEvent,
  OutboundMessage,
  PlatformCapabilities,
  SentMessage
} from "../../types";
import { verifyGoogleChatToken } from "./verify";
import {
  parseGoogleChatEvent,
  type GoogleChatEvent,
  type GoogleChatChannelRef
} from "./parse";
import { renderGoogleChatMessage } from "./render";
import { GoogleChatAPIClient, type GoogleChatCredentials } from "./api";

export interface GoogleChatMessengerOptions {
  credentials: GoogleChatCredentials;
  /**
   * Static verification token from the Chat API console.
   * Used for simple webhook verification. For JWT verification,
   * use `projectNumber` instead.
   */
  verificationToken?: string;
}

export class GoogleChatMessenger implements MessengerAdapter {
  readonly platform = "google-chat" as const;
  readonly capabilities: PlatformCapabilities = {
    streaming: "post-edit",
    maxMessageLength: 28_000,
    richText: "markdown",
    interactiveElements: "full",
    fileUpload: false,
    threading: "native",
    typing: false,
    editAfterPost: true,
    reactions: true
  };

  readonly #client: GoogleChatAPIClient;
  readonly #verificationToken: string | undefined;

  constructor(options: GoogleChatMessengerOptions) {
    this.#client = new GoogleChatAPIClient(options.credentials);
    this.#verificationToken = options.verificationToken;
  }

  async handleWebhook(
    request: Request,
    handler: (event: InboundEvent) => Promise<void>
  ): Promise<Response> {
    const body = await request.text();
    let payload: GoogleChatEvent;
    try {
      payload = JSON.parse(body) as GoogleChatEvent;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (
      this.#verificationToken &&
      !verifyGoogleChatToken(
        payload as unknown as Record<string, unknown>,
        this.#verificationToken
      )
    ) {
      return new Response("Invalid token", { status: 401 });
    }

    const event = parseGoogleChatEvent(payload);

    // Google Chat supports synchronous responses — the handler
    // runs and we return 200. For async responses, the adapter's
    // postMessage/streamMessage methods are used.
    await handler(event);

    return new Response("OK");
  }

  async verifyWebhook(request: Request): Promise<boolean> {
    if (!this.#verificationToken) return true;

    const body = await request.clone().text();
    const payload = JSON.parse(body);
    return verifyGoogleChatToken(payload, this.#verificationToken);
  }

  async parseWebhook(request: Request): Promise<InboundEvent> {
    const body = await request.json();
    return parseGoogleChatEvent(body as GoogleChatEvent);
  }

  async postMessage(
    channel: ChannelRef,
    content: OutboundMessage
  ): Promise<SentMessage> {
    const ref = assertGoogleChatChannel(channel);
    const rendered = renderGoogleChatMessage(content);

    const textContent = rendered.text ?? "";
    const chunks = splitMessage(textContent, {
      maxLength: this.capabilities.maxMessageLength
    });

    const threadOpts = ref.threadName
      ? { threadKey: ref.threadName.split("/").pop() }
      : undefined;

    let firstResult: SentMessage | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const response = await this.#client.createMessage(
        ref.spaceName,
        {
          text: chunks[i],
          // Only attach cards to the first chunk
          ...(i === 0 && rendered.cardsV2 ? { cardsV2: rendered.cardsV2 } : {})
        },
        threadOpts
      );

      if (!firstResult) {
        firstResult = {
          id: response.name ?? "",
          platform: "google-chat",
          channel: ref,
          text: chunks[i]
        };
      }
    }

    return firstResult!;
  }

  async editMessage(
    _channel: ChannelRef,
    messageId: string,
    content: OutboundMessage
  ): Promise<void> {
    const rendered = renderGoogleChatMessage(content);
    await this.#client.updateMessage(
      messageId,
      {
        text: rendered.text,
        ...(rendered.cardsV2 ? { cardsV2: rendered.cardsV2 } : {})
      },
      "text,cardsV2"
    );
  }

  async deleteMessage(_channel: ChannelRef, messageId: string): Promise<void> {
    await this.#client.deleteMessage(messageId);
  }

  async addReaction(
    _channel: ChannelRef,
    _messageId: string,
    _emoji: string
  ): Promise<void> {
    // Google Chat API does not support adding reactions programmatically
    // as of 2026. This is a no-op.
  }

  async streamMessage(
    channel: ChannelRef,
    stream: AsyncIterable<string>
  ): Promise<SentMessage> {
    const ref = assertGoogleChatChannel(channel);

    const result = await streamLoop(stream, {
      updateIntervalMs: 1000,
      postInitial: async () => {
        const r = await this.#client.createMessage(
          ref.spaceName,
          { text: "..." },
          ref.threadName
            ? { threadKey: ref.threadName.split("/").pop() }
            : undefined
        );
        return r.name ?? "";
      },
      editMessage: async (name, text) => {
        await this.#client.updateMessage(name, { text }, "text");
      }
    });

    return {
      id: result.id,
      platform: "google-chat",
      channel: ref,
      text: result.text
    };
  }

  /**
   * Access the underlying GoogleChatAPIClient for operations the
   * adapter interface does not cover.
   */
  get api(): GoogleChatAPIClient {
    return this.#client;
  }
}

function assertGoogleChatChannel(channel: ChannelRef): GoogleChatChannelRef {
  if (channel.platform !== "google-chat") {
    throw new Error(
      `GoogleChatMessenger received a ${channel.platform} channel reference`
    );
  }
  return channel as GoogleChatChannelRef;
}

export { verifyGoogleChatToken } from "./verify";
export {
  parseGoogleChatEvent,
  type GoogleChatEvent,
  type GoogleChatChannelRef
} from "./parse";
export { renderGoogleChatMessage } from "./render";
export { GoogleChatAPIClient, type GoogleChatCredentials } from "./api";
