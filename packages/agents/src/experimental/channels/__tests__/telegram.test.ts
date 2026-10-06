import { describe, expect, it } from "vitest";
import { telegram, telegramWebhook } from "../telegram";

describe("experimental Telegram webhook ingress", () => {
  const BOT_USER_ID = 424242;
  const webhook = telegramWebhook({
    secretToken: "webhook-secret",
    botUserId: BOT_USER_ID
  });

  const botAuthor = {
    id: BOT_USER_ID,
    is_bot: true,
    first_name: "Agent"
  };
  const markerText =
    "Approval required\n\nReply YES to approve or NO to reject.\n\n" +
    "[channel-interaction:v1:YWN0cGF1c2VfMTIz]";

  function request(body: unknown, secret = "webhook-secret") {
    return new Request("https://example.com/webhooks/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": secret
      },
      body: JSON.stringify(body)
    });
  }

  it("parses an exact YES replying to this bot and preserves its raw update", async () => {
    const raw = {
      update_id: 1,
      message: {
        message_id: 43,
        date: 1_723_456_789,
        message_thread_id: 77,
        text: "YES",
        chat: { id: 123456, type: "supergroup" },
        from: {
          id: 987654321,
          is_bot: false,
          first_name: "Approval",
          last_name: "Tester",
          username: "approval_tester"
        },
        reply_to_message: {
          message_id: 42,
          from: botAuthor,
          text: markerText
        }
      }
    };
    const result = await webhook.receive(request(raw));

    expect(result.response.status).toBe(200);
    expect(result.events[0]?.raw).toEqual(raw);
    expect(result.events[0]?.event).toEqual({
      type: "approval-response",
      eventId: "telegram:chat:123456:update:1",
      thread: {
        id: "telegram:chat:123456:topic:77",
        isDirectMessage: false
      },
      replySurface: {
        version: 1,
        address: {
          chatId: "123456",
          botUserId: 424242,
          messageThreadId: 77,
          replyToMessageId: 43
        },
        label: "Telegram · 123456"
      },
      actor: {
        id: "telegram:user:987654321",
        identity: {
          subject: "user:987654321"
        },
        username: "approval_tester",
        fullName: "Approval Tester",
        isBot: false
      },
      decision: "approve",
      reference: "telegram:chat:123456:message:43",
      approvalId: "actpause_123"
    });
  });

  it.each([
    {
      name: "a chat member forges the marker",
      author: {
        id: 987654321,
        is_bot: false,
        first_name: "Impostor"
      }
    },
    {
      name: "another bot forges the marker",
      author: { id: 111222333, is_bot: true, first_name: "Other" }
    },
    { name: "the replied-to author is unknown", author: undefined }
  ])("keeps an exact YES as a message when $name", async ({ author }) => {
    const result = await webhook.receive(
      request({
        update_id: 9,
        message: {
          message_id: 43,
          date: 1_723_456_789,
          text: "YES",
          chat: { id: 123456, type: "supergroup" },
          from: { id: 987654321, is_bot: false, first_name: "Impostor" },
          reply_to_message: {
            message_id: 42,
            ...(author && { from: author }),
            text: markerText
          }
        }
      })
    );

    expect(result.events[0]?.event).toMatchObject({
      type: "message",
      eventId: "telegram:chat:123456:update:9",
      message: {
        id: "telegram:chat:123456:message:43",
        text: "YES",
        reply: { id: "telegram:chat:123456:message:42" }
      }
    });
  });

  it.each([
    {
      name: "has trailing text",
      replyText: `${markerText}\nnot-the-final-footer`
    },
    {
      name: "has a trailing newline",
      replyText: `${markerText}\n`
    },
    {
      name: "lacks the generated approval instructions",
      replyText: "[channel-interaction:v1:YWN0cGF1c2VfMTIz]"
    }
  ])(
    "keeps a bot-authored marker as a message when it $name",
    async ({ replyText }) => {
      const result = await webhook.receive(
        request({
          update_id: 14,
          message: {
            message_id: 43,
            date: 1_723_456_789,
            text: "YES",
            chat: { id: 123456, type: "private" },
            from: { id: 987654321, is_bot: false, first_name: "Approval" },
            reply_to_message: {
              message_id: 42,
              from: botAuthor,
              text: replyText
            }
          }
        })
      );

      expect(result.events[0]?.event.type).toBe("message");
    }
  );

  it("keeps marker replies as messages when no bot identity is configured", async () => {
    const anonymous = telegramWebhook({
      secretToken: "webhook-secret"
    });

    const result = await anonymous.receive(
      request({
        update_id: 10,
        message: {
          message_id: 43,
          date: 1_723_456_789,
          text: "YES",
          chat: { id: 123456, type: "supergroup" },
          from: { id: 987654321, is_bot: false, first_name: "Approval" },
          reply_to_message: {
            message_id: 42,
            from: botAuthor,
            text: markerText
          }
        }
      })
    );

    expect(result.events[0]?.event.type).toBe("message");
  });

  it("rejects an invalid bot user id", () => {
    expect(() =>
      telegramWebhook({
        secretToken: "webhook-secret",
        botUserId: 0
      })
    ).toThrow("botUserId must be a positive Telegram user id");
  });

  it("infers this bot's user id from its BotFather token", async () => {
    const channel = telegram({
      botToken: "424242:AAHfake-token",
      webhook: { secretToken: "webhook-secret" },
      participant: (event) => event.actor?.id ?? null
    });

    const result = await channel.ingress?.receive(
      request({
        update_id: 11,
        message: {
          message_id: 43,
          date: 1_723_456_789,
          text: "NO",
          chat: { id: 123456, type: "private" },
          from: { id: 987654321, is_bot: false, first_name: "Approval" },
          reply_to_message: {
            message_id: 42,
            from: botAuthor,
            text: markerText
          }
        }
      })
    );

    expect(result?.events[0]?.event).toMatchObject({
      type: "approval-response",
      eventId: "telegram:chat:123456:update:11",
      approvalId: "actpause_123",
      decision: "reject"
    });
  });

  it("keeps an exact NO without a stable marker as a message", async () => {
    const raw = {
      update_id: 2,
      message: {
        message_id: 44,
        date: 1_723_456_789,
        text: "NO",
        chat: { id: 123456, type: "private" }
      }
    };
    const result = await webhook.receive(request(raw));

    expect(result.events[0]?.raw).toEqual(raw);
    expect(result.events[0]?.event).toEqual({
      type: "message",
      eventId: "telegram:chat:123456:update:2",
      thread: {
        id: "telegram:chat:123456",
        isDirectMessage: true
      },
      replySurface: {
        version: 1,
        address: {
          chatId: "123456",
          botUserId: 424242,
          replyToMessageId: 44
        },
        label: "Telegram · 123456"
      },
      message: {
        id: "telegram:chat:123456:message:44",
        text: "NO",
        metadata: { sentAt: "2024-08-12T09:59:49.000Z" }
      }
    });
  });

  it("keeps non-exact decisions as normalized messages", async () => {
    const result = await webhook.receive(
      request({
        update_id: 3,
        edited_message: {
          message_id: 45,
          date: 1_723_456_789,
          edit_date: 1_723_456_999,
          text: " yes ",
          chat: { id: 123456, type: "group" },
          from: {
            id: 987654321,
            is_bot: false,
            first_name: "Approval",
            username: "approval_tester"
          },
          reply_to_message: {
            message_id: 42,
            from: botAuthor,
            text: "Approval required"
          }
        }
      })
    );

    expect(result.events[0]?.event).toEqual({
      type: "message",
      eventId: "telegram:chat:123456:update:3",
      thread: {
        id: "telegram:chat:123456",
        isDirectMessage: false
      },
      replySurface: {
        version: 1,
        address: {
          chatId: "123456",
          botUserId: 424242,
          replyToMessageId: 45
        },
        label: "Telegram · 123456"
      },
      actor: {
        id: "telegram:user:987654321",
        identity: {
          subject: "user:987654321"
        },
        username: "approval_tester",
        fullName: "Approval",
        isBot: false
      },
      message: {
        id: "telegram:chat:123456:message:45",
        text: " yes ",
        reply: {
          id: "telegram:chat:123456:message:42",
          text: "Approval required"
        },
        metadata: {
          sentAt: "2024-08-12T09:59:49.000Z",
          edited: true,
          editedAt: "2024-08-12T10:03:19.000Z"
        }
      }
    });
  });

  it("accepts messages from any destination for routing to decide", async () => {
    const result = await webhook.receive(
      request({
        update_id: 2,
        message: {
          message_id: 44,
          text: "YES",
          chat: { id: 999999 }
        }
      })
    );

    expect(result.response.status).toBe(200);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.event.replySurface?.address).toMatchObject({
      chatId: "999999"
    });
  });

  it("rejects an invalid webhook secret", async () => {
    const result = await webhook.receive(
      request({ update_id: 3 }, "wrong-secret")
    );

    expect(result.response.status).toBe(401);
    expect(result.events).toEqual([]);
  });

  it("rejects non-POST requests", async () => {
    const result = await webhook.receive(
      new Request("https://example.com/webhooks/telegram")
    );

    expect(result.response.status).toBe(405);
    expect(result.events).toEqual([]);
  });

  it("rejects malformed JSON", async () => {
    const result = await webhook.receive(
      new Request("https://example.com/webhooks/telegram", {
        method: "POST",
        headers: {
          "x-telegram-bot-api-secret-token": "webhook-secret"
        },
        body: "not-json"
      })
    );

    expect(result.response.status).toBe(400);
    expect(result.events).toEqual([]);
  });
});
