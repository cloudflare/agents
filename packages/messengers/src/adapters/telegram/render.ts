/**
 * Render OutboundMessage into Telegram-compatible format.
 *
 * Telegram supports MarkdownV2 and HTML parse modes. We use MarkdownV2
 * for standard messages and generate inline keyboard markup for buttons.
 */

import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import type { OutboundMessage, MessageBlock } from "../../types";

export interface TelegramRenderedMessage {
  text: string;
  parse_mode?: "MarkdownV2" | "HTML";
  reply_markup?: InlineKeyboardMarkup;
}

export function renderTelegramMessage(
  message: OutboundMessage
): TelegramRenderedMessage {
  if (typeof message === "string") {
    return { text: message };
  }

  if ("markdown" in message) {
    return {
      text: escapeMarkdownV2(message.markdown),
      parse_mode: "MarkdownV2"
    };
  }

  const textParts: string[] = [];
  let inlineKeyboard: InlineKeyboardButton[][] | undefined;

  for (const block of message.blocks) {
    const rendered = renderBlock(block);
    if (rendered.text) {
      textParts.push(rendered.text);
    }
    if (rendered.keyboard) {
      inlineKeyboard = rendered.keyboard;
    }
  }

  const hasFormatting = message.blocks.some(
    (b) => b.type === "code" || b.type === "fields"
  );

  const result: TelegramRenderedMessage = {
    text: textParts.join("\n\n"),
    ...(hasFormatting ? { parse_mode: "MarkdownV2" as const } : {})
  };

  if (inlineKeyboard) {
    result.reply_markup = { inline_keyboard: inlineKeyboard };
  }

  return result;
}

function renderBlock(block: MessageBlock): {
  text?: string;
  keyboard?: InlineKeyboardButton[][];
} {
  switch (block.type) {
    case "text":
      return { text: block.content };

    case "code":
      return {
        text: block.language
          ? `\`\`\`${block.language}\n${block.content}\n\`\`\``
          : `\`\`\`\n${block.content}\n\`\`\``
      };

    case "image":
      return { text: block.alt ? `[${block.alt}](${block.url})` : block.url };

    case "actions":
      return {
        keyboard: [
          block.buttons.map((b): InlineKeyboardButton => {
            if (b.url) {
              return { text: b.label, url: b.url };
            }
            return {
              text: b.label,
              callback_data: b.value ?? b.id
            };
          })
        ]
      };

    case "fields":
      return {
        text: block.items.map((f) => `*${f.label}:* ${f.value}`).join("\n")
      };
  }
}

/**
 * Escape special characters for Telegram MarkdownV2.
 *
 * MarkdownV2 requires escaping: _ * [ ] ( ) ~ ` > # + - = | { } . !
 * But we want to preserve intentional formatting (bold, italic, code,
 * links). This escapes characters that are structural in MarkdownV2
 * but not part of common markdown formatting the user intended.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([.!>#+\-=|{}()\\])/g, "\\$1");
}
