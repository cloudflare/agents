import { describe, it, expect } from "vitest";
import { parseSlackEvent, getSlackChallenge } from "../adapters/slack/parse";

describe("parseSlackEvent", () => {
  describe("url_verification", () => {
    it("returns an unknown event for url_verification", () => {
      const payload = {
        type: "url_verification",
        challenge: "test_challenge_123"
      };
      const event = parseSlackEvent(payload);
      expect(event.type).toBe("unknown");
      expect(event.platform).toBe("slack");
      expect(event.raw).toBe(payload);
    });

    it("extracts the challenge string via getSlackChallenge", () => {
      const payload = {
        type: "url_verification",
        challenge: "test_challenge_123"
      };
      expect(getSlackChallenge(payload)).toBe("test_challenge_123");
    });

    it("returns undefined from getSlackChallenge for non-verification payloads", () => {
      const payload = { type: "event_callback" };
      expect(getSlackChallenge(payload)).toBeUndefined();
    });
  });

  describe("message events", () => {
    it("parses a basic message event", () => {
      const payload = {
        type: "event_callback",
        team_id: "T123",
        event: {
          type: "message",
          text: "Hello world",
          user: "U456",
          ts: "1700000000.000100",
          channel: "C789"
        }
      };

      const event = parseSlackEvent(payload);
      expect(event.type).toBe("message");
      expect(event.platform).toBe("slack");
      expect(event.channel).toEqual({
        platform: "slack",
        channelId: "C789",
        threadTs: undefined,
        teamId: "T123"
      });
      expect(event.message).toBeDefined();
      expect(event.message!.text).toBe("Hello world");
      expect(event.message!.author.id).toBe("U456");
      expect(event.message!.author.isBot).toBe(false);
      expect(event.message!.id).toBe("1700000000.000100");
    });

    it("parses a threaded message", () => {
      const payload = {
        type: "event_callback",
        team_id: "T123",
        event: {
          type: "message",
          text: "Reply in thread",
          user: "U456",
          ts: "1700000001.000200",
          thread_ts: "1700000000.000100",
          channel: "C789"
        }
      };

      const event = parseSlackEvent(payload);
      expect(event.channel.platform).toBe("slack");
      const channel = event.channel as { threadTs?: string };
      expect(channel.threadTs).toBe("1700000000.000100");
      expect(event.message!.replyToMessageId).toBe("1700000000.000100");
    });

    it("parses a bot message", () => {
      const payload = {
        type: "event_callback",
        event: {
          type: "message",
          subtype: "bot_message",
          text: "Bot says hello",
          bot_id: "B123",
          username: "testbot",
          ts: "1700000000.000100",
          channel: "C789"
        }
      };

      const event = parseSlackEvent(payload);
      expect(event.message!.author.isBot).toBe(true);
      expect(event.message!.author.id).toBe("B123");
      expect(event.message!.author.name).toBe("testbot");
    });

    it("detects mentions in app_mention events", () => {
      const payload = {
        type: "event_callback",
        event: {
          type: "app_mention",
          text: "<@U_BOT> help me",
          user: "U456",
          ts: "1700000000.000100",
          channel: "C789"
        }
      };

      const event = parseSlackEvent(payload);
      expect(event.message!.isMention).toBe(true);
    });

    it("detects mentions in regular messages containing <@", () => {
      const payload = {
        type: "event_callback",
        event: {
          type: "message",
          text: "Hey <@U_BOT> can you help?",
          user: "U456",
          ts: "1700000000.000100",
          channel: "C789"
        }
      };

      const event = parseSlackEvent(payload);
      expect(event.message!.isMention).toBe(true);
    });

    it("converts Slack timestamp to milliseconds", () => {
      const payload = {
        type: "event_callback",
        event: {
          type: "message",
          text: "test",
          user: "U456",
          ts: "1700000000.123456",
          channel: "C789"
        }
      };

      const event = parseSlackEvent(payload);
      expect(event.message!.timestamp).toBe(1700000000123);
    });
  });

  describe("reaction events", () => {
    it("parses reaction_added", () => {
      const payload = {
        type: "event_callback",
        event: {
          type: "reaction_added",
          user: "U456",
          reaction: "thumbsup",
          item: {
            type: "message",
            channel: "C789",
            ts: "1700000000.000100"
          }
        }
      };

      const event = parseSlackEvent(payload);
      expect(event.type).toBe("reaction");
      expect(event.reaction).toEqual({
        emoji: "thumbsup",
        added: true,
        userId: "U456",
        messageId: "1700000000.000100"
      });
    });

    it("parses reaction_removed", () => {
      const payload = {
        type: "event_callback",
        event: {
          type: "reaction_removed",
          user: "U456",
          reaction: "thumbsup",
          item: {
            type: "message",
            channel: "C789",
            ts: "1700000000.000100"
          }
        }
      };

      const event = parseSlackEvent(payload);
      expect(event.type).toBe("reaction");
      expect(event.reaction!.added).toBe(false);
    });
  });

  describe("block_actions", () => {
    it("parses a button click", () => {
      const payload = {
        type: "block_actions",
        trigger_id: "trigger_123",
        user: { id: "U456", username: "testuser" },
        channel: { id: "C789" },
        actions: [
          {
            type: "button",
            action_id: "approve_btn",
            value: "request_42"
          }
        ]
      };

      const event = parseSlackEvent(payload);
      expect(event.type).toBe("interaction");
      expect(event.interaction).toEqual({
        actionId: "approve_btn",
        value: "request_42",
        userId: "U456",
        triggerId: "trigger_123"
      });
    });
  });

  describe("slash commands", () => {
    it("parses a slash command", () => {
      const payload = {
        command: "/deploy",
        text: "production v1.2.3",
        user_id: "U456",
        channel_id: "C789",
        team_id: "T123",
        trigger_id: "trigger_456"
      };

      const event = parseSlackEvent(payload);
      expect(event.type).toBe("command");
      expect(event.command).toEqual({
        command: "/deploy",
        text: "production v1.2.3",
        userId: "U456"
      });
    });
  });

  describe("member_joined_channel", () => {
    it("parses member_joined_channel event", () => {
      const payload = {
        type: "event_callback",
        event: {
          type: "member_joined_channel",
          user: "U456",
          channel: "C789"
        }
      };

      const event = parseSlackEvent(payload);
      expect(event.type).toBe("member_joined");
      expect(event.platform).toBe("slack");
    });
  });
});
