import type {
  Channel,
  ChannelMessage,
  ChannelParticipant,
  ChannelRoute
} from "../channel";
import type { ChannelIdentity } from "../identity";
import type { ChannelMessageSurface } from "../surface";
import {
  matchesPath,
  type ChannelApprovalResponseInput,
  type ChannelEventContextInput,
  type ChannelInboundMessageInput,
  type ChannelIngress,
  type ChannelIngressEventInput
} from "../ingress";
import { emptyIngressResponse } from "../internal";

export type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  [key: string]: unknown;
};

export type TelegramChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  [key: string]: unknown;
};

export type TelegramMessage = {
  message_id: number;
  date: number;
  chat: TelegramChat;
  message_thread_id?: number;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  text?: string;
  edit_date?: number;
  reply_to_message?: TelegramMessage;
  [key: string]: unknown;
};

/** Authenticated JSON body delivered by a Telegram webhook. */
export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  [key: string]: unknown;
};

export type TelegramMessageSurface = ChannelMessageSurface<
  string,
  {
    chatId: string;
    botUserId?: number;
    messageThreadId?: number;
    replyToMessageId?: number;
  }
>;

/** Configuration for a Telegram Channel. */
export type TelegramChannelOptions = {
  /** Bot token issued by BotFather. */
  botToken: string;
  /** Telegram Bot API origin. @default "https://api.telegram.org" */
  apiBaseUrl?: string;
  /** Maximum text length accepted by this route. @default 4096 */
  maxLength?: number;
  /** Project the canonical message into Telegram text. */
  toText?: (message: ChannelMessage) => string;
  /** Parse mode for caller-formatted delivery text. */
  parseMode?: "HTML" | "MarkdownV2";
  /**
   * Smallest gap between `sendMessageDraft` previews. Snapshots produced
   * inside one interval are replaced rather than sent. @default 500
   */
  streamIntervalMs?: number;
  /**
   * Who sent a verified Telegram update, such as your user linked to
   * `event.actor`. Return null to drop the update. Required with `webhook`.
   */
  participant?: ChannelParticipant<TelegramUpdate>;
  /**
   * Pick the agent object an update reaches. Default: a room of the
   * participant's own, so a group chat is not shared by accident.
   */
  route?: ChannelRoute<TelegramUpdate>;
  /** Add secret-verified Telegram webhook ingress to the returned Channel. */
  webhook?: {
    secretToken: string;
    /** Exact webhook pathname accepted by this ingress. @default "/webhooks/telegram" */
    path?: string;
  };
  /** Override fetch for testing or custom network routing. */
  fetch?: typeof globalThis.fetch;
};

const DEFAULT_TELEGRAM_WEBHOOK_PATH = "/webhooks/telegram";
const INTERACTION_FOOTER =
  /\n\nReply YES to approve or NO to reject\.\n\n\[channel-interaction:v1:([A-Za-z0-9_-]+)\]$/;

function channelIdentity(chatId: number): string {
  return `telegram:chat:${chatId}`;
}

function userIdentity(userId: number): string {
  return `telegram:user:${userId}`;
}

function messageIdentity(chatId: number, messageId: number): string {
  return `${channelIdentity(chatId)}:message:${messageId}`;
}

function updateIdentity(chatId: number, updateId: number): string {
  return `${channelIdentity(chatId)}:update:${updateId}`;
}

function decodeApprovalId(value: string): string | undefined {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(base64 + padding);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0)
    );
    const approvalId = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return approvalId || undefined;
  } catch {
    return undefined;
  }
}

export type TelegramWebhookOptions = {
  /** Telegram webhook secret configured through setWebhook. */
  secretToken: string;
  /** Exact webhook pathname accepted by this ingress. @default "/webhooks/telegram" */
  path?: string;
  /**
   * Numeric user id of this bot, used to prove that an approval reply answers
   * a message this bot sent. Without it, marker replies stay ordinary
   * messages because their provenance cannot be established.
   */
  botUserId?: number;
};

function asTelegramMessage(value: unknown): TelegramMessage | undefined {
  return value !== null && typeof value === "object"
    ? (value as TelegramMessage)
    : undefined;
}

function telegramActor(message: TelegramMessage) {
  const sender = message.from;
  if (sender) {
    const fullName = [sender.first_name, sender.last_name]
      .filter(Boolean)
      .join(" ");
    return {
      id: userIdentity(sender.id),
      identity: {
        subject: `user:${sender.id}`
      },
      ...(sender.username && { username: sender.username }),
      ...(fullName && { fullName }),
      isBot: sender.is_bot
    };
  }

  const senderChat = message.sender_chat;
  if (!senderChat) return undefined;
  const fullName =
    senderChat.title ??
    [senderChat.first_name, senderChat.last_name].filter(Boolean).join(" ");
  return {
    id: channelIdentity(senderChat.id),
    identity: {
      subject: `chat:${senderChat.id}`
    },
    ...(senderChat.username && { username: senderChat.username }),
    ...(fullName && { fullName }),
    isBot: "unknown" as const
  };
}

function chatLabel(chat: TelegramChat): string {
  const name =
    chat.title ??
    (chat.username ? `@${chat.username}` : undefined) ??
    [chat.first_name, chat.last_name].filter(Boolean).join(" ") ??
    String(chat.id);
  return `Telegram · ${name || chat.id}`;
}

function eventContext(
  message: TelegramMessage,
  eventId: string,
  botUserId: number | undefined
): ChannelEventContextInput {
  const actor = telegramActor(message);
  const channelId = channelIdentity(message.chat.id);
  const threadId =
    typeof message.message_thread_id === "number"
      ? `${channelId}:topic:${message.message_thread_id}`
      : channelId;
  const isDirectMessage =
    message.chat.type === "private"
      ? true
      : message.chat.type === "group" ||
          message.chat.type === "supergroup" ||
          message.chat.type === "channel"
        ? false
        : ("unknown" as const);
  return {
    eventId,
    thread: { id: threadId, isDirectMessage },
    replySurface: {
      version: 1,
      address: {
        chatId: String(message.chat.id),
        ...(botUserId && { botUserId }),
        ...(typeof message.message_thread_id === "number" && {
          messageThreadId: message.message_thread_id
        }),
        replyToMessageId: message.message_id
      },
      label: chatLabel(message.chat)
    },
    ...(actor && { actor })
  };
}

function telegramTimestamp(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function normalizedMessage(
  message: TelegramMessage,
  eventId: string,
  edited: boolean,
  botUserId: number | undefined
): ChannelInboundMessageInput {
  const reply = asTelegramMessage(message.reply_to_message);
  const sentAt = telegramTimestamp(message.date);
  const editedAt = telegramTimestamp(message.edit_date);

  return {
    type: "message",
    ...eventContext(message, eventId, botUserId),
    message: {
      id: messageIdentity(message.chat.id, message.message_id),
      text: message.text as string,
      ...(typeof reply?.message_id === "number" && {
        reply: {
          id: messageIdentity(message.chat.id, reply.message_id),
          ...(typeof reply.text === "string" && { text: reply.text })
        }
      }),
      ...((sentAt || edited || editedAt) && {
        metadata: {
          ...(sentAt && { sentAt }),
          ...(edited && { edited: true }),
          ...(editedAt && { editedAt })
        }
      })
    }
  };
}

function approvalResponse(
  message: TelegramMessage,
  eventId: string,
  botUserId: number | undefined
): ChannelApprovalResponseInput | undefined {
  if (botUserId === undefined) return undefined;
  if (message.text !== "YES" && message.text !== "NO") return undefined;

  const reply = asTelegramMessage(message.reply_to_message);
  if (typeof reply?.message_id !== "number") return undefined;

  // An interaction marker only authorizes a decision when this bot authored
  // the replied-to message; otherwise any chat member could forge one.
  const author = reply.from;
  if (author?.is_bot !== true || author.id !== botUserId) return undefined;

  const encodedApprovalId =
    typeof reply.text === "string"
      ? reply.text.match(INTERACTION_FOOTER)?.[1]
      : undefined;
  const approvalId = encodedApprovalId
    ? decodeApprovalId(encodedApprovalId)
    : undefined;
  if (!approvalId) return undefined;

  return {
    type: "approval-response",
    ...eventContext(message, eventId, botUserId),
    approvalId,
    decision: message.text === "YES" ? "approve" : "reject",
    reference: messageIdentity(message.chat.id, message.message_id)
  };
}

function inboundEvent(
  update: TelegramUpdate,
  botUserId: number | undefined
): ChannelIngressEventInput | undefined {
  const edited = update.edited_message !== undefined;
  const message = asTelegramMessage(
    edited ? update.edited_message : update.message
  );
  if (
    typeof update.update_id !== "number" ||
    typeof message?.message_id !== "number" ||
    typeof message.text !== "string" ||
    typeof message.chat?.id !== "number"
  ) {
    return undefined;
  }

  const eventId = updateIdentity(message.chat.id, update.update_id);
  return (
    approvalResponse(message, eventId, botUserId) ??
    normalizedMessage(message, eventId, edited, botUserId)
  );
}

/** Recover this bot's numeric user id from its BotFather token prefix. */
function telegramBotUserId(botToken: string): number | undefined {
  const prefix = botToken.match(/^(\d+):/)?.[1];
  if (!prefix) return undefined;
  const botUserId = Number(prefix);
  return Number.isSafeInteger(botUserId) && botUserId > 0
    ? botUserId
    : undefined;
}

/** Create dependency-free Telegram webhook ingress for a destination chat. */
export function telegramWebhook(
  options: TelegramWebhookOptions
): ChannelIngress<TelegramUpdate> {
  if (!options.secretToken.trim()) {
    throw new Error(
      "secretToken is required to create Telegram webhook ingress"
    );
  }
  if (
    options.botUserId !== undefined &&
    (!Number.isSafeInteger(options.botUserId) || options.botUserId <= 0)
  ) {
    throw new Error("botUserId must be a positive Telegram user id");
  }

  const botUserId = options.botUserId;
  const path = options.path ?? DEFAULT_TELEGRAM_WEBHOOK_PATH;
  return {
    async receive(request) {
      if (!matchesPath(request, path)) return null;
      if (request.method !== "POST") return emptyIngressResponse(405);
      if (
        request.headers.get("x-telegram-bot-api-secret-token") !==
        options.secretToken
      ) {
        return emptyIngressResponse(401);
      }

      let update: unknown;
      try {
        update = await request.json();
      } catch {
        return emptyIngressResponse(400);
      }
      if (update === null || typeof update !== "object") {
        return emptyIngressResponse(400);
      }

      const raw = update as TelegramUpdate;
      const event = inboundEvent(raw, botUserId);
      return {
        events: event ? [{ event, raw }] : [],
        response: new Response(null, { status: 200 })
      };
    }
  };
}

/** Create a configured Telegram ingress Channel. */
export function telegram(
  options: TelegramChannelOptions
): Channel<TelegramUpdate> {
  if (!options.botToken.trim()) {
    throw new Error("botToken is required to create a Telegram channel");
  }
  if (options.webhook && !options.participant) {
    throw new Error("participant is required with a Telegram webhook");
  }
  const botUserId = telegramBotUserId(options.botToken);
  const ingress = options.webhook
    ? telegramWebhook({ ...options.webhook, botUserId })
    : undefined;

  return {
    ...(options.participant && { participant: options.participant }),
    ...(options.route && { route: options.route }),
    ...(ingress && { ingress }),
    contactSurface(identity: ChannelIdentity) {
      if ((identity.scope ?? "default") !== "default") return null;
      const match = identity.subject.match(/^(user|chat):(-?\d+)$/);
      if (!match) return null;
      return {
        version: 1,
        address: {
          chatId: match[2],
          ...(botUserId && { botUserId })
        },
        label: `Telegram · ${match[1]} ${match[2]}`
      };
    }
  };
}
