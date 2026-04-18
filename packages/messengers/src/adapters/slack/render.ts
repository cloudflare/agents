/**
 * Render OutboundMessage into Slack-compatible format.
 *
 * Converts markdown to Slack mrkdwn and generates Block Kit blocks
 * for structured messages.
 */

import type { AnyMessageBlock } from "slack-cloudflare-workers";
import type { OutboundMessage, MessageBlock, Button } from "../../types";

export interface SlackRenderedMessage {
  text: string;
  blocks?: AnyMessageBlock[];
}

export function renderSlackMessage(
  message: OutboundMessage
): SlackRenderedMessage {
  if (typeof message === "string") {
    return { text: message };
  }

  if ("markdown" in message) {
    return { text: markdownToMrkdwn(message.markdown) };
  }

  const blocks: unknown[] = [];
  const textParts: string[] = [];

  for (const block of message.blocks) {
    const rendered = renderBlock(block);
    if (rendered.block) {
      blocks.push(rendered.block);
    }
    if (rendered.text) {
      textParts.push(rendered.text);
    }
  }

  return {
    text: textParts.join("\n"),
    blocks: blocks.length > 0 ? (blocks as AnyMessageBlock[]) : undefined
  };
}

function renderBlock(block: MessageBlock): {
  block?: unknown;
  text?: string;
} {
  switch (block.type) {
    case "text":
      return {
        block: {
          type: "section",
          text: { type: "mrkdwn", text: markdownToMrkdwn(block.content) }
        },
        text: block.content
      };

    case "code":
      return {
        block: {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `\`\`\`\n${block.content}\n\`\`\``
          }
        },
        text: `\`\`\`\n${block.content}\n\`\`\``
      };

    case "image":
      return {
        block: {
          type: "image",
          image_url: block.url,
          alt_text: block.alt ?? "image"
        },
        text: block.alt ?? block.url
      };

    case "actions":
      return {
        block: {
          type: "actions",
          elements: block.buttons.map(renderButton)
        },
        text: block.buttons.map((b) => `[${b.label}]`).join(" ")
      };

    case "fields":
      return {
        block: {
          type: "section",
          fields: block.items.map((f) => ({
            type: "mrkdwn",
            text: `*${f.label}*\n${f.value}`
          }))
        },
        text: block.items.map((f) => `*${f.label}:* ${f.value}`).join("\n")
      };
  }
}

function renderButton(button: Button): unknown {
  const base: Record<string, unknown> = {
    type: "button",
    text: { type: "plain_text", text: button.label, emoji: true },
    action_id: button.id
  };

  if (button.value) {
    base.value = button.value;
  }

  if (button.url) {
    base.url = button.url;
  }

  if (button.style === "primary") {
    base.style = "primary";
  } else if (button.style === "danger") {
    base.style = "danger";
  }

  return base;
}

/**
 * Convert standard markdown to Slack's mrkdwn format.
 *
 * Key differences:
 *   - **bold** → *bold*
 *   - _italic_ or *italic* → _italic_
 *   - [text](url) → <url|text>
 *   - ~~strike~~ → ~strike~
 */
export function markdownToMrkdwn(md: string): string {
  let result = md;

  // Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Bold: **text** → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Italic: _text_ stays as _text_ (same in mrkdwn)
  // But *text* (single asterisk italic) needs conversion to _text_
  // This is tricky because * is now bold in mrkdwn.
  // We handle the common case of __text__ → _text_ (already correct)

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  return result;
}
