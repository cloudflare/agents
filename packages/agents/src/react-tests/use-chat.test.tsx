import { describe, expect, it } from "vitest";
import {
  TOOL_CONFIRMATION,
  type Tool,
  type PendingToolCall
} from "../use-chat";

describe("useChat utilities", () => {
  describe("TOOL_CONFIRMATION", () => {
    it("has correct protocol values", () => {
      expect(TOOL_CONFIRMATION.APPROVED).toBe("Yes, confirmed.");
      expect(TOOL_CONFIRMATION.DENIED).toBe("No, denied.");
    });
  });

  describe("Tool type", () => {
    it("supports client-side tool with execute", () => {
      const tool: Tool<{ query: string }, string> = {
        description: "Search tool",
        execute: async (input) => `Results for ${input.query}`,
        confirm: false
      };
      expect(tool.execute).toBeDefined();
      expect(tool.confirm).toBe(false);
    });

    it("supports server-side tool requiring confirmation", () => {
      const tool: Tool = {
        description: "Dangerous action",
        confirm: true
      };
      expect(tool.execute).toBeUndefined();
      expect(tool.confirm).toBe(true);
    });

    it("supports minimal tool definition", () => {
      const tool: Tool = {};
      expect(tool.description).toBeUndefined();
      expect(tool.execute).toBeUndefined();
      expect(tool.confirm).toBeUndefined();
    });
  });

  describe("PendingToolCall type", () => {
    it("has required fields", () => {
      const pending: PendingToolCall = {
        toolCallId: "call-123",
        toolName: "search",
        input: { query: "test" },
        messageId: "msg-456"
      };
      expect(pending.toolCallId).toBe("call-123");
      expect(pending.toolName).toBe("search");
      expect(pending.input).toEqual({ query: "test" });
      expect(pending.messageId).toBe("msg-456");
    });
  });
});
