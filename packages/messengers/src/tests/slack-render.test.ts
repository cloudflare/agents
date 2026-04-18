import { describe, it, expect } from "vitest";
import { renderSlackMessage, markdownToMrkdwn } from "../adapters/slack/render";
import type { OutboundMessage } from "../types";

describe("markdownToMrkdwn", () => {
  it("converts bold syntax", () => {
    expect(markdownToMrkdwn("**bold text**")).toBe("*bold text*");
  });

  it("preserves italic syntax", () => {
    expect(markdownToMrkdwn("_italic text_")).toBe("_italic text_");
  });

  it("converts strikethrough syntax", () => {
    expect(markdownToMrkdwn("~~deleted~~")).toBe("~deleted~");
  });

  it("converts link syntax", () => {
    expect(markdownToMrkdwn("[Click here](https://example.com)")).toBe(
      "<https://example.com|Click here>"
    );
  });

  it("handles multiple conversions in one string", () => {
    const input = "**bold** and _italic_ with [link](https://example.com)";
    const expected = "*bold* and _italic_ with <https://example.com|link>";
    expect(markdownToMrkdwn(input)).toBe(expected);
  });

  it("preserves code blocks", () => {
    const input = "```\nconst x = 1;\n```";
    expect(markdownToMrkdwn(input)).toBe("```\nconst x = 1;\n```");
  });

  it("preserves inline code", () => {
    expect(markdownToMrkdwn("`some code`")).toBe("`some code`");
  });
});

describe("renderSlackMessage", () => {
  it("renders a plain string as text only", () => {
    const result = renderSlackMessage("Hello world");
    expect(result.text).toBe("Hello world");
    expect(result.blocks).toBeUndefined();
  });

  it("renders a markdown message with mrkdwn conversion", () => {
    const msg: OutboundMessage = {
      markdown: "**bold** [link](https://example.com)"
    };
    const result = renderSlackMessage(msg);
    expect(result.text).toBe("*bold* <https://example.com|link>");
    expect(result.blocks).toBeUndefined();
  });

  describe("block messages", () => {
    it("renders a text block as a section", () => {
      const msg: OutboundMessage = {
        blocks: [{ type: "text", content: "Hello **world**" }]
      };
      const result = renderSlackMessage(msg);
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks![0]).toEqual({
        type: "section",
        text: { type: "mrkdwn", text: "Hello *world*" }
      });
    });

    it("renders a code block", () => {
      const msg: OutboundMessage = {
        blocks: [{ type: "code", content: "const x = 1;" }]
      };
      const result = renderSlackMessage(msg);
      expect(result.blocks![0]).toEqual({
        type: "section",
        text: { type: "mrkdwn", text: "```\nconst x = 1;\n```" }
      });
    });

    it("renders an image block", () => {
      const msg: OutboundMessage = {
        blocks: [
          { type: "image", url: "https://example.com/img.png", alt: "A cat" }
        ]
      };
      const result = renderSlackMessage(msg);
      expect(result.blocks![0]).toEqual({
        type: "image",
        image_url: "https://example.com/img.png",
        alt_text: "A cat"
      });
    });

    it("renders action buttons", () => {
      const msg: OutboundMessage = {
        blocks: [
          {
            type: "actions",
            buttons: [
              { id: "approve", label: "Approve", style: "primary" },
              {
                id: "reject",
                label: "Reject",
                style: "danger",
                value: "req_42"
              }
            ]
          }
        ]
      };
      const result = renderSlackMessage(msg);
      const block = result.blocks![0] as Record<string, unknown>;
      expect(block.type).toBe("actions");
      const elements = block.elements as Array<Record<string, unknown>>;
      expect(elements).toHaveLength(2);
      expect(elements[0]).toEqual({
        type: "button",
        text: { type: "plain_text", text: "Approve", emoji: true },
        action_id: "approve",
        style: "primary"
      });
      expect(elements[1]).toEqual({
        type: "button",
        text: { type: "plain_text", text: "Reject", emoji: true },
        action_id: "reject",
        value: "req_42",
        style: "danger"
      });
    });

    it("renders field items as section fields", () => {
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
      const result = renderSlackMessage(msg);
      const block = result.blocks![0] as Record<string, unknown>;
      expect(block.type).toBe("section");
      expect(block.fields).toEqual([
        { type: "mrkdwn", text: "*Status*\nActive" },
        { type: "mrkdwn", text: "*Region*\nUS-East" }
      ]);
    });

    it("renders multiple blocks and provides text fallback", () => {
      const msg: OutboundMessage = {
        blocks: [
          { type: "text", content: "Header" },
          { type: "code", content: "console.log('hi')" },
          {
            type: "actions",
            buttons: [{ id: "ok", label: "OK" }]
          }
        ]
      };
      const result = renderSlackMessage(msg);
      expect(result.blocks).toHaveLength(3);
      expect(result.text).toContain("Header");
      expect(result.text).toContain("console.log('hi')");
    });

    it("renders a URL button", () => {
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
      const result = renderSlackMessage(msg);
      const block = result.blocks![0] as Record<string, unknown>;
      const elements = block.elements as Array<Record<string, unknown>>;
      expect(elements[0]).toMatchObject({
        url: "https://dash.example.com"
      });
    });
  });
});
