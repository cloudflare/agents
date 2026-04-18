import { describe, it, expect } from "vitest";
import {
  renderTelegramMessage,
  escapeMarkdownV2
} from "../adapters/telegram/render";
import type { OutboundMessage } from "../types";

describe("escapeMarkdownV2", () => {
  it("escapes dots", () => {
    expect(escapeMarkdownV2("Hello.")).toBe("Hello\\.");
  });

  it("escapes exclamation marks", () => {
    expect(escapeMarkdownV2("Wow!")).toBe("Wow\\!");
  });

  it("escapes hashes", () => {
    expect(escapeMarkdownV2("## Header")).toBe("\\#\\# Header");
  });

  it("escapes pipes", () => {
    expect(escapeMarkdownV2("a | b")).toBe("a \\| b");
  });

  it("escapes dashes", () => {
    expect(escapeMarkdownV2("- item")).toBe("\\- item");
  });

  it("escapes parentheses", () => {
    expect(escapeMarkdownV2("fn(x)")).toBe("fn\\(x\\)");
  });

  it("escapes backslashes", () => {
    expect(escapeMarkdownV2("a\\b")).toBe("a\\\\b");
  });

  it("preserves bold and italic markers", () => {
    expect(escapeMarkdownV2("**bold** _italic_")).toBe("**bold** _italic_");
  });

  it("preserves backtick code", () => {
    expect(escapeMarkdownV2("`code`")).toBe("`code`");
  });
});

describe("renderTelegramMessage", () => {
  it("renders a plain string without parse mode", () => {
    const result = renderTelegramMessage("Hello world");
    expect(result.text).toBe("Hello world");
    expect(result.parse_mode).toBeUndefined();
  });

  it("renders a markdown message with MarkdownV2 parse mode", () => {
    const msg: OutboundMessage = { markdown: "**bold** text" };
    const result = renderTelegramMessage(msg);
    expect(result.parse_mode).toBe("MarkdownV2");
    expect(result.text).toContain("**bold** text");
  });

  describe("block messages", () => {
    it("renders text blocks as plain text", () => {
      const msg: OutboundMessage = {
        blocks: [{ type: "text", content: "Hello world" }]
      };
      const result = renderTelegramMessage(msg);
      expect(result.text).toBe("Hello world");
    });

    it("renders code blocks with language", () => {
      const msg: OutboundMessage = {
        blocks: [
          { type: "code", content: "const x = 1;", language: "typescript" }
        ]
      };
      const result = renderTelegramMessage(msg);
      expect(result.text).toBe("```typescript\nconst x = 1;\n```");
    });

    it("renders buttons as inline keyboard", () => {
      const msg: OutboundMessage = {
        blocks: [
          {
            type: "actions",
            buttons: [
              { id: "approve", label: "Approve", value: "yes" },
              { id: "reject", label: "Reject", value: "no" }
            ]
          }
        ]
      };
      const result = renderTelegramMessage(msg);
      expect(result.reply_markup).toBeDefined();
      expect(result.reply_markup!.inline_keyboard).toEqual([
        [
          { text: "Approve", callback_data: "yes" },
          { text: "Reject", callback_data: "no" }
        ]
      ]);
    });

    it("renders URL buttons with url field", () => {
      const msg: OutboundMessage = {
        blocks: [
          {
            type: "actions",
            buttons: [
              {
                id: "open",
                label: "Open Dashboard",
                url: "https://dash.example.com"
              }
            ]
          }
        ]
      };
      const result = renderTelegramMessage(msg);
      expect(result.reply_markup!.inline_keyboard[0][0]).toEqual({
        text: "Open Dashboard",
        url: "https://dash.example.com"
      });
    });

    it("uses button id as callback_data when no value", () => {
      const msg: OutboundMessage = {
        blocks: [
          {
            type: "actions",
            buttons: [{ id: "my_action", label: "Click Me" }]
          }
        ]
      };
      const result = renderTelegramMessage(msg);
      expect(result.reply_markup!.inline_keyboard[0][0]).toEqual({
        text: "Click Me",
        callback_data: "my_action"
      });
    });

    it("renders field items as bold label + value", () => {
      const msg: OutboundMessage = {
        blocks: [
          {
            type: "fields",
            items: [
              { label: "Status", value: "Active" },
              { label: "Region", value: "US-East" }
            ]
          }
        ]
      };
      const result = renderTelegramMessage(msg);
      expect(result.text).toBe("*Status:* Active\n*Region:* US-East");
    });

    it("renders multiple blocks separated by double newlines", () => {
      const msg: OutboundMessage = {
        blocks: [
          { type: "text", content: "Header" },
          { type: "code", content: "x = 1" }
        ]
      };
      const result = renderTelegramMessage(msg);
      expect(result.text).toBe("Header\n\n```\nx = 1\n```");
    });

    it("renders image blocks as markdown links", () => {
      const msg: OutboundMessage = {
        blocks: [
          {
            type: "image",
            url: "https://example.com/img.png",
            alt: "A cat"
          }
        ]
      };
      const result = renderTelegramMessage(msg);
      expect(result.text).toBe("[A cat](https://example.com/img.png)");
    });
  });
});
