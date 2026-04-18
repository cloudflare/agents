import { describe, it, expect } from "vitest";
import { renderToMarkdown } from "../adapter";
import type { OutboundMessage } from "../types";

describe("renderToMarkdown", () => {
  it("returns plain strings unchanged", () => {
    expect(renderToMarkdown("Hello world")).toBe("Hello world");
  });

  it("extracts markdown from a markdown message", () => {
    const msg: OutboundMessage = { markdown: "**bold** and _italic_" };
    expect(renderToMarkdown(msg)).toBe("**bold** and _italic_");
  });

  describe("block messages", () => {
    it("renders a text block", () => {
      const msg: OutboundMessage = {
        blocks: [{ type: "text", content: "Hello world" }]
      };
      expect(renderToMarkdown(msg)).toBe("Hello world");
    });

    it("renders a code block with language", () => {
      const msg: OutboundMessage = {
        blocks: [
          { type: "code", content: "const x = 1;", language: "typescript" }
        ]
      };
      expect(renderToMarkdown(msg)).toBe("```typescript\nconst x = 1;\n```");
    });

    it("renders a code block without language", () => {
      const msg: OutboundMessage = {
        blocks: [{ type: "code", content: "hello" }]
      };
      expect(renderToMarkdown(msg)).toBe("```\nhello\n```");
    });

    it("renders an image block", () => {
      const msg: OutboundMessage = {
        blocks: [
          { type: "image", url: "https://example.com/img.png", alt: "A cat" }
        ]
      };
      expect(renderToMarkdown(msg)).toBe(
        "![A cat](https://example.com/img.png)"
      );
    });

    it("renders image block with default alt text", () => {
      const msg: OutboundMessage = {
        blocks: [{ type: "image", url: "https://example.com/img.png" }]
      };
      expect(renderToMarkdown(msg)).toBe(
        "![image](https://example.com/img.png)"
      );
    });

    it("renders action buttons", () => {
      const msg: OutboundMessage = {
        blocks: [
          {
            type: "actions",
            buttons: [
              { id: "approve", label: "Approve" },
              { id: "reject", label: "Reject" }
            ]
          }
        ]
      };
      expect(renderToMarkdown(msg)).toBe("[Approve]  [Reject]");
    });

    it("renders field items", () => {
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
      expect(renderToMarkdown(msg)).toBe(
        "**Status:** Active\n**Region:** US-East"
      );
    });

    it("renders multiple blocks separated by double newlines", () => {
      const msg: OutboundMessage = {
        blocks: [
          { type: "text", content: "Header text" },
          { type: "code", content: "console.log('hi')", language: "js" },
          {
            type: "actions",
            buttons: [{ id: "ok", label: "OK" }]
          }
        ]
      };
      const result = renderToMarkdown(msg);
      expect(result).toBe(
        "Header text\n\n```js\nconsole.log('hi')\n```\n\n[OK]"
      );
    });
  });
});
