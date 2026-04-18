import { describe, it, expect } from "vitest";
import {
  renderGoogleChatMessage,
  markdownToGoogleChat
} from "../adapters/google-chat/render";
import type { OutboundMessage } from "../types";

describe("markdownToGoogleChat", () => {
  it("converts bold", () => {
    expect(markdownToGoogleChat("**bold**")).toBe("*bold*");
  });

  it("preserves italic", () => {
    expect(markdownToGoogleChat("_italic_")).toBe("_italic_");
  });

  it("converts strikethrough", () => {
    expect(markdownToGoogleChat("~~deleted~~")).toBe("~deleted~");
  });

  it("converts links", () => {
    expect(markdownToGoogleChat("[Click](https://example.com)")).toBe(
      "<https://example.com|Click>"
    );
  });

  it("handles mixed formatting", () => {
    const input = "**bold** _italic_ [link](https://x.com)";
    expect(markdownToGoogleChat(input)).toBe(
      "*bold* _italic_ <https://x.com|link>"
    );
  });

  it("preserves code blocks", () => {
    const input = "```\ncode\n```";
    expect(markdownToGoogleChat(input)).toBe("```\ncode\n```");
  });
});

describe("renderGoogleChatMessage", () => {
  it("renders a plain string as text", () => {
    const result = renderGoogleChatMessage("Hello world");
    expect(result.text).toBe("Hello world");
    expect(result.cardsV2).toBeUndefined();
  });

  it("renders markdown with conversion", () => {
    const msg: OutboundMessage = { markdown: "**bold** text" };
    const result = renderGoogleChatMessage(msg);
    expect(result.text).toBe("*bold* text");
    expect(result.cardsV2).toBeUndefined();
  });

  describe("block messages", () => {
    it("renders text blocks as textParagraph widgets", () => {
      const msg: OutboundMessage = {
        blocks: [{ type: "text", content: "Hello world" }]
      };
      const result = renderGoogleChatMessage(msg);
      expect(result.cardsV2).toHaveLength(1);
      const card = result.cardsV2![0].card as Record<string, unknown>;
      const sections = card.sections as Array<Record<string, unknown>>;
      const widgets = sections[0].widgets as Array<Record<string, unknown>>;
      expect(widgets[0]).toEqual({
        textParagraph: { text: "Hello world" }
      });
    });

    it("renders code blocks with HTML escaping", () => {
      const msg: OutboundMessage = {
        blocks: [{ type: "code", content: "const x = 1 < 2;" }]
      };
      const result = renderGoogleChatMessage(msg);
      const card = result.cardsV2![0].card as Record<string, unknown>;
      const sections = card.sections as Array<Record<string, unknown>>;
      const widgets = sections[0].widgets as Array<Record<string, unknown>>;
      const para = widgets[0] as { textParagraph: { text: string } };
      expect(para.textParagraph.text).toBe(
        "<pre><code>const x = 1 &lt; 2;</code></pre>"
      );
    });

    it("renders image blocks", () => {
      const msg: OutboundMessage = {
        blocks: [
          { type: "image", url: "https://example.com/img.png", alt: "Cat" }
        ]
      };
      const result = renderGoogleChatMessage(msg);
      const card = result.cardsV2![0].card as Record<string, unknown>;
      const sections = card.sections as Array<Record<string, unknown>>;
      const widgets = sections[0].widgets as Array<Record<string, unknown>>;
      expect(widgets[0]).toEqual({
        image: { imageUrl: "https://example.com/img.png", altText: "Cat" }
      });
    });

    it("renders action buttons with action methods", () => {
      const msg: OutboundMessage = {
        blocks: [
          {
            type: "actions",
            buttons: [
              { id: "approve", label: "Approve", value: "req_42" },
              {
                id: "view",
                label: "View",
                url: "https://dash.example.com"
              }
            ]
          }
        ]
      };
      const result = renderGoogleChatMessage(msg);
      const card = result.cardsV2![0].card as Record<string, unknown>;
      const sections = card.sections as Array<Record<string, unknown>>;
      const widgets = sections[0].widgets as Array<Record<string, unknown>>;
      const buttonList = widgets[0] as {
        buttonList: { buttons: Array<Record<string, unknown>> };
      };

      expect(buttonList.buttonList.buttons).toHaveLength(2);
      expect(buttonList.buttonList.buttons[0]).toMatchObject({
        text: "Approve",
        onClick: {
          action: {
            actionMethodName: "approve",
            parameters: [{ key: "value", value: "req_42" }]
          }
        }
      });
      expect(buttonList.buttonList.buttons[1]).toMatchObject({
        text: "View",
        onClick: { openLink: { url: "https://dash.example.com" } }
      });
    });

    it("renders fields as decoratedText", () => {
      const msg: OutboundMessage = {
        blocks: [
          {
            type: "fields",
            items: [
              { label: "Status", value: "Active" },
              { label: "Region", value: "US" }
            ]
          }
        ]
      };
      const result = renderGoogleChatMessage(msg);
      expect(result.text).toBe("*Status:* Active\n*Region:* US");
    });

    it("renders multiple blocks in one card", () => {
      const msg: OutboundMessage = {
        blocks: [
          { type: "text", content: "Header" },
          { type: "code", content: "x = 1" },
          {
            type: "actions",
            buttons: [{ id: "ok", label: "OK" }]
          }
        ]
      };
      const result = renderGoogleChatMessage(msg);
      expect(result.cardsV2).toHaveLength(1);
      const card = result.cardsV2![0].card as Record<string, unknown>;
      const sections = card.sections as Array<Record<string, unknown>>;
      const widgets = sections[0].widgets as unknown[];
      expect(widgets).toHaveLength(3);
    });

    it("always provides text fallback alongside cards", () => {
      const msg: OutboundMessage = {
        blocks: [
          { type: "text", content: "Important info" },
          { type: "code", content: "console.log()" }
        ]
      };
      const result = renderGoogleChatMessage(msg);
      expect(result.text).toContain("Important info");
      expect(result.text).toContain("console.log()");
    });
  });
});
