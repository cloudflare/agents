/**
 * Parse Telegram Update objects into normalized InboundEvent format.
 *
 * Telegram sends Updates with various fields depending on the type:
 *   - message: a new message
 *   - edited_message: an edited message
 *   - callback_query: a button click (inline keyboard)
 *   - my_chat_member: bot added/removed from a group
 */

import type {
  InboundEvent,
  NormalizedMessage,
  TelegramChannelRef,
  Attachment
} from "../../types";

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  my_chat_member?: unknown;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
  message_thread_id?: number;
  photo?: Array<{ file_id: string; file_size?: number }>;
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  entities?: Array<{
    type: string;
    offset: number;
    length: number;
  }>;
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export function parseTelegramUpdate(update: TelegramUpdate): InboundEvent {
  if (update.callback_query) {
    return parseCallbackQuery(update.callback_query, update);
  }

  const msg = update.message ?? update.edited_message;
  if (msg) {
    return parseMessage(msg, update);
  }

  return {
    type: "unknown",
    platform: "telegram",
    channel: { platform: "telegram", chatId: 0 },
    raw: update
  };
}

function parseMessage(
  msg: TelegramMessage,
  update: TelegramUpdate
): InboundEvent {
  const channel: TelegramChannelRef = {
    platform: "telegram",
    chatId: msg.chat.id,
    messageThreadId: msg.message_thread_id
  };

  const text = msg.text ?? msg.caption ?? "";
  const isMention = hasBotMention(msg);

  const attachments: Attachment[] = [];
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    attachments.push({
      type: "image",
      filename: largest.file_id,
      size: largest.file_size
    });
  }
  if (msg.document) {
    attachments.push({
      type: "file",
      filename: msg.document.file_name,
      mimeType: msg.document.mime_type,
      size: msg.document.file_size
    });
  }

  const message: NormalizedMessage = {
    id: String(msg.message_id),
    text,
    author: {
      id: String(msg.from?.id ?? 0),
      name:
        msg.from?.username ??
        [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") ??
        "unknown",
      isBot: msg.from?.is_bot ?? false
    },
    timestamp: msg.date * 1000,
    isMention,
    replyToMessageId: msg.reply_to_message
      ? String(msg.reply_to_message.message_id)
      : undefined,
    attachments: attachments.length > 0 ? attachments : undefined
  };

  return {
    type: "message",
    platform: "telegram",
    channel,
    message,
    raw: update
  };
}

function parseCallbackQuery(
  query: TelegramCallbackQuery,
  update: TelegramUpdate
): InboundEvent {
  const chatId = query.message?.chat.id ?? 0;

  return {
    type: "interaction",
    platform: "telegram",
    channel: {
      platform: "telegram",
      chatId
    },
    interaction: {
      actionId: query.data ?? "",
      value: query.data,
      userId: String(query.from.id)
    },
    raw: update
  };
}

function hasBotMention(msg: TelegramMessage): boolean {
  if (!msg.entities) return false;
  return msg.entities.some(
    (e) => e.type === "mention" || e.type === "text_mention"
  );
}
