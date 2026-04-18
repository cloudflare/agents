import { describe, it, expect } from "vitest";
import { parseTelegramUpdate } from "../adapters/telegram/parse";
import type { TelegramUpdate } from "../adapters/telegram/parse";

describe("parseTelegramUpdate", () => {
  describe("text messages", () => {
    it("parses a basic text message", () => {
      const update: TelegramUpdate = {
        update_id: 12345,
        message: {
          message_id: 100,
          from: {
            id: 42,
            is_bot: false,
            first_name: "Alice",
            username: "alice42"
          },
          chat: { id: -100123, type: "group", title: "Test Group" },
          date: 1700000000,
          text: "Hello everyone"
        }
      };

      const event = parseTelegramUpdate(update);
      expect(event.type).toBe("message");
      expect(event.platform).toBe("telegram");
      expect(event.channel).toEqual({
        platform: "telegram",
        chatId: -100123,
        messageThreadId: undefined
      });
      expect(event.message!.id).toBe("100");
      expect(event.message!.text).toBe("Hello everyone");
      expect(event.message!.author).toEqual({
        id: "42",
        name: "alice42",
        isBot: false
      });
      expect(event.message!.timestamp).toBe(1700000000000);
    });

    it("parses a private message", () => {
      const update: TelegramUpdate = {
        update_id: 12345,
        message: {
          message_id: 101,
          from: {
            id: 42,
            is_bot: false,
            first_name: "Bob",
            last_name: "Smith"
          },
          chat: { id: 42, type: "private" },
          date: 1700000001,
          text: "DM me"
        }
      };

      const event = parseTelegramUpdate(update);
      expect(event.message!.author.name).toBe("Bob Smith");
    });

    it("parses a bot message", () => {
      const update: TelegramUpdate = {
        update_id: 12346,
        message: {
          message_id: 102,
          from: {
            id: 99,
            is_bot: true,
            first_name: "MyBot",
            username: "mybot"
          },
          chat: { id: -100123, type: "group" },
          date: 1700000002,
          text: "Automated response"
        }
      };

      const event = parseTelegramUpdate(update);
      expect(event.message!.author.isBot).toBe(true);
    });

    it("handles message with caption instead of text", () => {
      const update: TelegramUpdate = {
        update_id: 12347,
        message: {
          message_id: 103,
          from: { id: 42, is_bot: false, first_name: "Alice" },
          chat: { id: -100123, type: "group" },
          date: 1700000003,
          caption: "Check this photo",
          photo: [
            { file_id: "small_id", file_size: 1000 },
            { file_id: "large_id", file_size: 50000 }
          ]
        }
      };

      const event = parseTelegramUpdate(update);
      expect(event.message!.text).toBe("Check this photo");
      expect(event.message!.attachments).toHaveLength(1);
      expect(event.message!.attachments![0].type).toBe("image");
      expect(event.message!.attachments![0].filename).toBe("large_id");
    });
  });

  describe("reply messages", () => {
    it("extracts reply_to_message_id", () => {
      const update: TelegramUpdate = {
        update_id: 12348,
        message: {
          message_id: 104,
          from: { id: 42, is_bot: false, first_name: "Alice" },
          chat: { id: -100123, type: "group" },
          date: 1700000004,
          text: "This is a reply",
          reply_to_message: {
            message_id: 100,
            from: { id: 43, is_bot: false, first_name: "Bob" },
            chat: { id: -100123, type: "group" },
            date: 1700000000,
            text: "Original message"
          }
        }
      };

      const event = parseTelegramUpdate(update);
      expect(event.message!.replyToMessageId).toBe("100");
    });
  });

  describe("threaded messages", () => {
    it("preserves message_thread_id in forum/topic groups", () => {
      const update: TelegramUpdate = {
        update_id: 12349,
        message: {
          message_id: 105,
          from: { id: 42, is_bot: false, first_name: "Alice" },
          chat: { id: -100123, type: "supergroup" },
          date: 1700000005,
          text: "In a topic",
          message_thread_id: 999
        }
      };

      const event = parseTelegramUpdate(update);
      const channel = event.channel as { messageThreadId?: number };
      expect(channel.messageThreadId).toBe(999);
    });
  });

  describe("mentions", () => {
    it("detects @mention entities", () => {
      const update: TelegramUpdate = {
        update_id: 12350,
        message: {
          message_id: 106,
          from: { id: 42, is_bot: false, first_name: "Alice" },
          chat: { id: -100123, type: "group" },
          date: 1700000006,
          text: "@mybot help me",
          entities: [{ type: "mention", offset: 0, length: 6 }]
        }
      };

      const event = parseTelegramUpdate(update);
      expect(event.message!.isMention).toBe(true);
    });

    it("returns false when no mention entities", () => {
      const update: TelegramUpdate = {
        update_id: 12351,
        message: {
          message_id: 107,
          from: { id: 42, is_bot: false, first_name: "Alice" },
          chat: { id: -100123, type: "group" },
          date: 1700000007,
          text: "No mention here"
        }
      };

      const event = parseTelegramUpdate(update);
      expect(event.message!.isMention).toBe(false);
    });
  });

  describe("document attachments", () => {
    it("parses a document attachment", () => {
      const update: TelegramUpdate = {
        update_id: 12352,
        message: {
          message_id: 108,
          from: { id: 42, is_bot: false, first_name: "Alice" },
          chat: { id: -100123, type: "group" },
          date: 1700000008,
          document: {
            file_id: "doc_file_id",
            file_name: "report.pdf",
            mime_type: "application/pdf",
            file_size: 123456
          }
        }
      };

      const event = parseTelegramUpdate(update);
      expect(event.message!.attachments).toHaveLength(1);
      expect(event.message!.attachments![0]).toEqual({
        type: "file",
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 123456
      });
    });
  });

  describe("callback queries (button clicks)", () => {
    it("parses a callback query as an interaction", () => {
      const update: TelegramUpdate = {
        update_id: 12353,
        callback_query: {
          id: "callback_123",
          from: { id: 42, is_bot: false, first_name: "Alice" },
          message: {
            message_id: 100,
            from: { id: 99, is_bot: true, first_name: "MyBot" },
            chat: { id: -100123, type: "group" },
            date: 1700000000
          },
          data: "approve_42"
        }
      };

      const event = parseTelegramUpdate(update);
      expect(event.type).toBe("interaction");
      expect(event.interaction).toEqual({
        actionId: "approve_42",
        value: "approve_42",
        userId: "42"
      });
      const channel = event.channel as { chatId: number };
      expect(channel.chatId).toBe(-100123);
    });
  });

  describe("edited messages", () => {
    it("parses an edited message the same as a regular message", () => {
      const update: TelegramUpdate = {
        update_id: 12354,
        edited_message: {
          message_id: 109,
          from: { id: 42, is_bot: false, first_name: "Alice" },
          chat: { id: -100123, type: "group" },
          date: 1700000009,
          text: "Edited content"
        }
      };

      const event = parseTelegramUpdate(update);
      expect(event.type).toBe("message");
      expect(event.message!.text).toBe("Edited content");
    });
  });

  describe("unknown updates", () => {
    it("returns an unknown event for unrecognized update types", () => {
      const update: TelegramUpdate = {
        update_id: 99999,
        my_chat_member: { status: "member" }
      };

      const event = parseTelegramUpdate(update);
      expect(event.type).toBe("unknown");
      expect(event.platform).toBe("telegram");
      expect(event.raw).toBe(update);
    });
  });
});
