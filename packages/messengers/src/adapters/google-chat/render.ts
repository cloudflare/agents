/**
 * Render OutboundMessage into Google Chat format.
 *
 * Google Chat supports:
 *   - Plain text messages
 *   - Cards v2 (structured cards with sections, widgets, buttons)
 *   - Basic text formatting (bold, italic, strikethrough, monospace, links)
 *
 * Text formatting uses a subset of markdown-like syntax:
 *   *bold*  _italic_  ~strikethrough~  `monospace`  ```code block```
 *   <https://url|link text>
 */

import type { OutboundMessage, MessageBlock, Button } from "../../types";

export interface GoogleChatRenderedMessage {
  text?: string;
  cardsV2?: Array<{
    cardId: string;
    card: unknown;
  }>;
}

export function renderGoogleChatMessage(
  message: OutboundMessage
): GoogleChatRenderedMessage {
  if (typeof message === "string") {
    return { text: message };
  }

  if ("markdown" in message) {
    return { text: markdownToGoogleChat(message.markdown) };
  }

  const textParts: string[] = [];
  const widgets: unknown[] = [];

  for (const block of message.blocks) {
    const rendered = renderBlock(block);
    if (rendered.text) {
      textParts.push(rendered.text);
    }
    if (rendered.widget) {
      widgets.push(rendered.widget);
    }
  }

  if (widgets.length > 0) {
    return {
      text: textParts.join("\n\n"),
      cardsV2: [
        {
          cardId: "msg_card",
          card: {
            sections: [{ widgets }]
          }
        }
      ]
    };
  }

  return { text: textParts.join("\n\n") };
}

function renderBlock(block: MessageBlock): {
  text?: string;
  widget?: unknown;
} {
  switch (block.type) {
    case "text":
      return {
        text: block.content,
        widget: {
          textParagraph: { text: block.content }
        }
      };

    case "code":
      return {
        text: `\`\`\`\n${block.content}\n\`\`\``,
        widget: {
          textParagraph: {
            text: `<pre><code>${escapeHtml(block.content)}</code></pre>`
          }
        }
      };

    case "image":
      return {
        text: block.alt ?? block.url,
        widget: {
          image: {
            imageUrl: block.url,
            altText: block.alt
          }
        }
      };

    case "actions":
      return {
        widget: {
          buttonList: {
            buttons: block.buttons.map(renderButton)
          }
        }
      };

    case "fields":
      return {
        text: block.items.map((f) => `*${f.label}:* ${f.value}`).join("\n"),
        widget: {
          decoratedText: {
            topLabel: block.items.map((f) => f.label).join(" / "),
            text: block.items.map((f) => f.value).join(" / ")
          }
        }
      };
  }
}

function renderButton(button: Button): unknown {
  const btn: Record<string, unknown> = {
    text: button.label
  };

  if (button.url) {
    btn.onClick = {
      openLink: { url: button.url }
    };
  } else {
    btn.onClick = {
      action: {
        actionMethodName: button.id,
        parameters: button.value ? [{ key: "value", value: button.value }] : []
      }
    };
  }

  if (button.style === "primary") {
    btn.color = { red: 0.2, green: 0.6, blue: 1.0, alpha: 1.0 };
  } else if (button.style === "danger") {
    btn.color = { red: 0.9, green: 0.2, blue: 0.2, alpha: 1.0 };
  }

  return btn;
}

/**
 * Convert standard markdown to Google Chat text formatting.
 *
 * Differences from standard markdown:
 *   - Bold: **text** → *text*
 *   - Links: [text](url) → <url|text>
 *   - Strikethrough: ~~text~~ → ~text~
 *   - Italic: _text_ stays _text_ (same)
 */
export function markdownToGoogleChat(md: string): string {
  let result = md;

  // Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Bold: **text** → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  return result;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
