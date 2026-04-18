import { describe, it, expect } from "vitest";
import { parseGoogleChatEvent } from "../adapters/google-chat/parse";
import type { GoogleChatEvent } from "../adapters/google-chat/parse";

describe("parseGoogleChatEvent", () => {
  describe("MESSAGE events", () => {
    it("parses a basic message", () => {
      const event: GoogleChatEvent = {
        type: "MESSAGE",
        user: {
          name: "users/123456",
          displayName: "Alice",
          email: "alice@example.com",
          type: "HUMAN"
        },
        space: {
          name: "spaces/AAA",
          type: "SPACE",
          displayName: "General"
        },
        message: {
          name: "spaces/AAA/messages/msg.123",
          text: "Hello everyone",
          sender: {
            name: "users/123456",
            displayName: "Alice",
            type: "HUMAN"
          },
          createTime: "2026-01-15T10:00:00Z",
          thread: { name: "spaces/AAA/threads/thread.1" }
        }
      };

      const result = parseGoogleChatEvent(event);
      expect(result.type).toBe("message");
      expect(result.platform).toBe("google-chat");

      if (result.type === "message") {
        expect(result.message.id).toBe("spaces/AAA/messages/msg.123");
        expect(result.message.text).toBe("Hello everyone");
        expect(result.message.author.id).toBe("users/123456");
        expect(result.message.author.name).toBe("Alice");
        expect(result.message.author.isBot).toBe(false);
        expect(result.message.timestamp).toBe(
          new Date("2026-01-15T10:00:00Z").getTime()
        );
      }
    });

    it("uses argumentText when available (strips @mentions)", () => {
      const event: GoogleChatEvent = {
        type: "MESSAGE",
        space: { name: "spaces/AAA" },
        message: {
          name: "spaces/AAA/messages/msg.456",
          text: "@MyBot help me with this",
          argumentText: "help me with this",
          sender: { name: "users/789", displayName: "Bob", type: "HUMAN" },
          createTime: "2026-01-15T10:01:00Z",
          annotations: [{ type: "USER_MENTION", startIndex: 0, length: 6 }]
        }
      };

      const result = parseGoogleChatEvent(event);
      if (result.type === "message") {
        expect(result.message.text).toBe("help me with this");
        expect(result.message.isMention).toBe(true);
      }
    });

    it("detects bot messages", () => {
      const event: GoogleChatEvent = {
        type: "MESSAGE",
        space: { name: "spaces/AAA" },
        message: {
          name: "spaces/AAA/messages/msg.789",
          text: "Automated alert",
          sender: {
            name: "users/bot-123",
            displayName: "AlertBot",
            type: "BOT"
          },
          createTime: "2026-01-15T10:02:00Z"
        }
      };

      const result = parseGoogleChatEvent(event);
      if (result.type === "message") {
        expect(result.message.author.isBot).toBe(true);
      }
    });

    it("extracts thread name for threaded messages", () => {
      const event: GoogleChatEvent = {
        type: "MESSAGE",
        space: { name: "spaces/AAA" },
        message: {
          name: "spaces/AAA/messages/msg.101",
          text: "Reply in thread",
          sender: { name: "users/123", displayName: "Alice", type: "HUMAN" },
          createTime: "2026-01-15T10:03:00Z",
          thread: { name: "spaces/AAA/threads/thread.42" }
        }
      };

      const result = parseGoogleChatEvent(event);
      const channel = result.channel as { threadName?: string };
      expect(channel.threadName).toBe("spaces/AAA/threads/thread.42");
    });

    it("sets space name in channel ref", () => {
      const event: GoogleChatEvent = {
        type: "MESSAGE",
        space: { name: "spaces/BBB", type: "DM", singleUserBotDm: true },
        message: {
          name: "spaces/BBB/messages/msg.202",
          text: "DM",
          sender: { name: "users/456", displayName: "Bob", type: "HUMAN" },
          createTime: "2026-01-15T10:04:00Z"
        }
      };

      const result = parseGoogleChatEvent(event);
      const channel = result.channel as { spaceName: string };
      expect(channel.spaceName).toBe("spaces/BBB");
    });
  });

  describe("CARD_CLICKED events", () => {
    it("parses a button click as interaction", () => {
      const event: GoogleChatEvent = {
        type: "CARD_CLICKED",
        user: { name: "users/123", displayName: "Alice" },
        space: { name: "spaces/AAA" },
        action: {
          actionMethodName: "approve_request",
          parameters: [{ key: "requestId", value: "42" }]
        }
      };

      const result = parseGoogleChatEvent(event);
      expect(result.type).toBe("interaction");
      if (result.type === "interaction") {
        expect(result.interaction.actionId).toBe("approve_request");
        expect(result.interaction.value).toBe("42");
        expect(result.interaction.userId).toBe("users/123");
      }
    });

    it("uses invokedFunction from common when action is absent", () => {
      const event: GoogleChatEvent = {
        type: "CARD_CLICKED",
        user: { name: "users/123", displayName: "Alice" },
        space: { name: "spaces/AAA" },
        common: { invokedFunction: "submit_form" }
      };

      const result = parseGoogleChatEvent(event);
      if (result.type === "interaction") {
        expect(result.interaction.actionId).toBe("submit_form");
      }
    });
  });

  describe("ADDED_TO_SPACE events", () => {
    it("parses as member_joined", () => {
      const event: GoogleChatEvent = {
        type: "ADDED_TO_SPACE",
        user: { name: "users/123", displayName: "Alice" },
        space: { name: "spaces/CCC", type: "SPACE", displayName: "New Space" }
      };

      const result = parseGoogleChatEvent(event);
      expect(result.type).toBe("member_joined");
      expect(result.platform).toBe("google-chat");
    });
  });

  describe("REMOVED_FROM_SPACE events", () => {
    it("parses as unknown", () => {
      const event: GoogleChatEvent = {
        type: "REMOVED_FROM_SPACE",
        user: { name: "users/123" },
        space: { name: "spaces/CCC" }
      };

      const result = parseGoogleChatEvent(event);
      expect(result.type).toBe("unknown");
    });
  });

  describe("unknown event types", () => {
    it("returns unknown for unrecognized types", () => {
      const event: GoogleChatEvent = {
        type: "SOME_FUTURE_EVENT",
        space: { name: "spaces/AAA" }
      };

      const result = parseGoogleChatEvent(event);
      expect(result.type).toBe("unknown");
      expect(result.raw).toBe(event);
    });
  });
});
