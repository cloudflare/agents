import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  ChannelRouter,
  fallback,
  telegram,
  telegramWebhook,
  type TelegramUpdate
} from "..";

const BOT_TOKEN = "secret-bot-token";
const TELEGRAM_SURFACE = {
  channelKey: "telegram",
  version: 1,
  address: { chatId: "123456" },
  label: "Telegram · chat 123456"
} as const;

function createChannel(fetch: typeof globalThis.fetch) {
  return telegram({
    botToken: BOT_TOKEN,
    fetch
  });
}

function deliver(
  channel: ReturnType<typeof createChannel>,
  message: { title?: string; markdown: string }
) {
  return channel.deliver(TELEGRAM_SURFACE, message);
}

describe("experimental Telegram channel", () => {
  it("sends a destination-bound message and returns its Telegram message id", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ok: true, result: { message_id: 42 } })
    );
    const channel = createChannel(fetch);

    await expect(
      channel.deliver(TELEGRAM_SURFACE, {
        title: "Build blocked",
        markdown: "Please **help**"
      })
    ).resolves.toEqual({ status: "delivered", reference: "42" });

    expect(fetch).toHaveBeenCalledWith(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        body: JSON.stringify({
          chat_id: "123456",
          text: "Build blocked\n\nPlease **help**"
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }
    );
  });

  it("derives contact surfaces and delivers with persisted reply context", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ok: true, result: { message_id: 42 } })
    );
    const channel = createChannel(fetch);
    const contact = channel.contactSurface?.({
      channelKey: "telegram",
      subject: "user:987654321"
    });
    expect(contact).toMatchObject({
      address: { chatId: "987654321" },
      label: "Telegram · user 987654321"
    });

    const replySurface = {
      channelKey: "telegram",
      version: 1,
      address: {
        chatId: "123456",
        messageThreadId: 77,
        replyToMessageId: 43
      },
      label: "Telegram · chat 123456"
    } as const;
    await channel.deliver(JSON.parse(JSON.stringify(replySurface)), {
      markdown: "Following up"
    });

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      chat_id: "123456",
      text: "Following up",
      message_thread_id: 77,
      reply_parameters: { message_id: 43 }
    });
  });

  it("rejects malformed and wrong-bot surfaces before delivery", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const channel = telegram({
      botToken: "424242:secret",
      fetch
    });

    await expect(
      channel.deliver(
        {
          channelKey: "telegram",
          version: 1,
          address: { chatId: "987654321", botUserId: 999999 },
          label: "Telegram · user 987654321"
        },
        { markdown: "Hello" }
      )
    ).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "TELEGRAM_SURFACE_INVALID",
        message: 'Telegram cannot parse the address for Channel "telegram"'
      }
    });
    await expect(
      channel.deliver(
        {
          channelKey: "telegram",
          version: 1,
          address: null,
          label: "Telegram · invalid"
        },
        { markdown: "Hello" }
      )
    ).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "TELEGRAM_SURFACE_INVALID",
        message: 'Telegram cannot parse the address for Channel "telegram"'
      }
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("supports caller-formatted Telegram HTML", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ok: true, result: { message_id: 42 } })
    );
    const channel = telegram({
      botToken: BOT_TOKEN,
      fetch,
      parseMode: "HTML",
      toText: () => "<b>Approval required</b>"
    });

    await channel.deliver(TELEGRAM_SURFACE, { markdown: "Approval required" });

    expect(fetch).toHaveBeenCalledWith(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123456",
          text: "<b>Approval required</b>",
          parse_mode: "HTML"
        })
      })
    );
  });

  it("renders a typed approval request with provider recovery data", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ok: true, result: { message_id: 42 } })
    );
    const channel = createChannel(fetch);

    await expect(
      channel.requestApproval?.(TELEGRAM_SURFACE, {
        interactionId: "actpause_123",
        request: {
          title: "Approval required",
          summary: "Deploy the release?",
          input: { environment: "production" }
        }
      })
    ).resolves.toEqual({ status: "delivered", reference: "42" });

    expect(fetch).toHaveBeenCalledWith(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123456",
          text:
            "Approval required\n\nDeploy the release?\n\n" +
            'Input:\n{\n  "environment": "production"\n}\n\n' +
            "Reply YES to approve or NO to reject.\n\n" +
            "[channel-interaction:v1:YWN0cGF1c2VfMTIz]"
        })
      })
    );
  });

  it("rejects an empty approval interaction id before delivery", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const channel = telegram({
      botToken: BOT_TOKEN,
      fetch
    });

    await expect(
      channel.requestApproval?.(TELEGRAM_SURFACE, {
        interactionId: "",
        request: { summary: "Deploy?", input: {} }
      })
    ).resolves.toEqual({
      status: "failed",
      retryable: false,
      error: {
        code: "TELEGRAM_INTERACTION_ID_REQUIRED",
        message: "Telegram approval requests require a non-empty interaction id"
      }
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("exposes its typed route without evaluating it", async () => {
    const route = vi.fn((_event, raw: TelegramUpdate) => {
      expectTypeOf(raw).toEqualTypeOf<TelegramUpdate>();
      return `telegram:${raw.update_id}`;
    });
    const channel = telegram({
      botToken: BOT_TOKEN,
      route,
      webhook: {
        secretToken: "webhook-secret",
        path: "/telegram-approval"
      }
    });

    expect(channel.route).toBe(route);
    expect(route).not.toHaveBeenCalled();
    await expect(
      channel.ingress?.receive(
        new Request("https://example.com/prefix/telegram-approval", {
          method: "POST"
        })
      )
    ).resolves.toBeNull();
    await expect(
      channel.ingress?.receive(
        new Request("https://example.com/telegram-approval", {
          method: "POST"
        })
      )
    ).resolves.toMatchObject({ response: { status: 401 } });
    expect(channel.requestApproval).toBeTypeOf("function");
    expect(channel.deliver).toBeTypeOf("function");
  });

  it("rejects messages over Telegram's limit before attempting delivery", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const channel = createChannel(fetch);

    await expect(
      channel.deliver(TELEGRAM_SURFACE, { markdown: "x".repeat(4097) })
    ).resolves.toEqual({
      status: "failed",
      retryable: false,
      error: {
        code: "TELEGRAM_MESSAGE_TOO_LONG",
        message: "Telegram message exceeds the configured 4096-character limit"
      }
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("supports a lower application limit", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const channel = telegram({
      botToken: BOT_TOKEN,
      fetch,
      maxLength: 256
    });

    await expect(
      channel.deliver(TELEGRAM_SURFACE, { markdown: "x".repeat(257) })
    ).resolves.toEqual({
      status: "failed",
      retryable: false,
      error: {
        code: "TELEGRAM_MESSAGE_TOO_LONG",
        message: "Telegram message exceeds the configured 256-character limit"
      }
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([0, 4097, 1.5])(
    "rejects an invalid maximum length: %s",
    (maxLength) => {
      expect(() => telegram({ botToken: BOT_TOKEN, maxLength })).toThrow(
        "maxLength must be an integer between 1 and 4096"
      );
    }
  );

  it("classifies an explicit Telegram rate limit as retryable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 30"
        },
        { status: 429 }
      )
    );

    await expect(
      deliver(createChannel(fetch), { markdown: "Help" })
    ).resolves.toEqual({
      status: "failed",
      retryable: true,
      error: {
        code: "TELEGRAM_API_ERROR_429",
        message: "Too Many Requests: retry after 30"
      }
    });
  });

  it("classifies an explicit invalid destination as non-retryable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: chat not found"
        },
        { status: 400 }
      )
    );

    await expect(
      deliver(createChannel(fetch), { markdown: "Help" })
    ).resolves.toEqual({
      status: "failed",
      retryable: false,
      error: {
        code: "TELEGRAM_API_ERROR_400",
        message: "Bad Request: chat not found"
      }
    });
  });

  it("falls through to another channel after Telegram rejects the bot token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        { ok: false, error_code: 401, description: "Unauthorized" },
        { status: 401 }
      )
    );
    const emailSurface = {
      channelKey: "email",
      version: 1,
      address: null,
      label: "Email · support@example.com"
    } as const;
    const emailDeliver = vi.fn(async () => ({
      status: "delivered" as const,
      reference: "email-1"
    }));
    const router = new ChannelRouter({
      channels: {
        telegram: createChannel(fetch),
        email: { deliver: emailDeliver }
      },
      onMessage() {}
    });
    const message = { markdown: "Help" };

    await expect(
      router.deliver(fallback([TELEGRAM_SURFACE, emailSurface]), message)
    ).resolves.toEqual({ status: "delivered", reference: "email-1" });
    expect(emailDeliver).toHaveBeenCalledWith(emailSurface, message, undefined);
  });

  it("treats an unconfirmed request as uncertain without exposing the bot token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError(
        `fetch failed for https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`
      );
    });

    const result = await deliver(createChannel(fetch), { markdown: "Help" });

    expect(result).toEqual({
      status: "uncertain",
      error: {
        code: "TELEGRAM_DELIVERY_ERROR",
        message: "Telegram delivery failed with an unknown outcome"
      }
    });
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
  });

  it("treats a malformed success response as uncertain", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ok: true, result: {} })
    );

    await expect(
      deliver(createChannel(fetch), { markdown: "Help" })
    ).resolves.toEqual({
      status: "uncertain",
      error: {
        code: "TELEGRAM_DELIVERY_ERROR",
        message: "Telegram returned an invalid delivery response"
      }
    });
  });

  it("treats an explicit internal Telegram failure as uncertain", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          ok: false,
          error_code: 500,
          description: "Internal Server Error"
        },
        { status: 500 }
      )
    );

    await expect(
      deliver(createChannel(fetch), { markdown: "Help" })
    ).resolves.toEqual({
      status: "uncertain",
      error: {
        code: "TELEGRAM_API_ERROR_500",
        message: "Internal Server Error"
      }
    });
  });
});

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

  it("uses only the structurally final generated marker", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ok: true, result: { message_id: 42 } })
    );
    const channel = telegram({
      botToken: "424242:AAHfake-token",
      fetch,
      webhook: { secretToken: "webhook-secret" }
    });
    const interactionId = "actual-interaction";

    await channel.requestApproval?.(TELEGRAM_SURFACE, {
      interactionId,
      request: {
        summary: "[channel-interaction:v1:Zm9yZ2VkLWludGVyYWN0aW9u]",
        input: "[channel-interaction:forged-input]"
      }
    });
    const outbound = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as {
      text: string;
    };
    const result = await channel.ingress?.receive(
      request({
        update_id: 12,
        message: {
          message_id: 43,
          date: 1_723_456_789,
          text: "YES",
          chat: { id: 123456, type: "private" },
          from: { id: 987654321, is_bot: false, first_name: "Approval" },
          reply_to_message: {
            message_id: 42,
            from: botAuthor,
            text: outbound.text
          }
        }
      })
    );

    expect(result?.events[0]?.event).toMatchObject({
      type: "approval-response",
      interactionId
    });
  });

  it("round-trips delimiter, newline, and Unicode interaction ids", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ok: true, result: { message_id: 42 } })
    );
    const channel = telegram({
      botToken: "424242:AAHfake-token",
      fetch,
      webhook: { secretToken: "webhook-secret" }
    });
    const interactionId = "deploy:]\n雪🚀";

    await channel.requestApproval?.(TELEGRAM_SURFACE, {
      interactionId,
      request: { summary: "Deploy?", input: {} }
    });
    const outbound = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as {
      text: string;
    };
    const result = await channel.ingress?.receive(
      request({
        update_id: 13,
        message: {
          message_id: 43,
          date: 1_723_456_789,
          text: "NO",
          chat: { id: 123456, type: "private" },
          from: { id: 987654321, is_bot: false, first_name: "Approval" },
          reply_to_message: {
            message_id: 42,
            from: botAuthor,
            text: outbound.text
          }
        }
      })
    );

    expect(result?.events[0]?.event).toMatchObject({
      type: "approval-response",
      interactionId,
      decision: "reject"
    });
  });

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
      interactionId: "actpause_123"
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
      webhook: { secretToken: "webhook-secret" }
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
      interactionId: "actpause_123",
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
