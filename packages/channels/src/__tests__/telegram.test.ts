import { describe, expect, it, vi } from "vitest";
import { fallback, telegram, telegramWebhook, type Channel } from "..";

const BOT_TOKEN = "secret-bot-token";

function createChannel(fetch: typeof globalThis.fetch) {
  return telegram({
    botToken: BOT_TOKEN,
    chatId: "123456",
    fetch
  });
}

describe("experimental Telegram channel", () => {
  it("sends a destination-bound message and returns its Telegram message id", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ok: true, result: { message_id: 42 } })
    );
    const channel = createChannel(fetch);

    await expect(
      channel.deliver({ title: "Build blocked", markdown: "Please **help**" })
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

  it("supports caller-formatted Telegram HTML", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ok: true, result: { message_id: 42 } })
    );
    const channel = telegram({
      botToken: BOT_TOKEN,
      chatId: "123456",
      fetch,
      parseMode: "HTML",
      toText: () => "<b>Approval required</b>"
    });

    await channel.deliver({ markdown: "Approval required" });

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
      channel.requestApproval?.({
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
            "[channel-interaction:actpause_123]"
        })
      })
    );
  });

  it("returns one Channel carrying configured webhook ingress", () => {
    const channel = telegram({
      botToken: BOT_TOKEN,
      chatId: "123456",
      webhook: {
        secretToken: "webhook-secret",
        path: "/telegram-approval"
      }
    });

    expect(channel.ingress?.path).toBe("/telegram-approval");
    expect(channel.requestApproval).toBeTypeOf("function");
    expect(channel.deliver).toBeTypeOf("function");
  });

  it("rejects messages over Telegram's limit before attempting delivery", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const channel = createChannel(fetch);

    await expect(
      channel.deliver({ markdown: "x".repeat(4097) })
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
      chatId: "123456",
      fetch,
      maxLength: 256
    });

    await expect(
      channel.deliver({ markdown: "x".repeat(257) })
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
      expect(() =>
        telegram({ botToken: BOT_TOKEN, chatId: "123456", maxLength })
      ).toThrow("maxLength must be an integer between 1 and 4096");
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
      createChannel(fetch).deliver({ markdown: "Help" })
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
      createChannel(fetch).deliver({ markdown: "Help" })
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
    const email: Channel = {
      deliver: vi.fn(async () => ({
        status: "delivered" as const,
        reference: "email-1"
      }))
    };
    const channel = fallback([createChannel(fetch), email]);
    const message = { markdown: "Help" };

    await expect(channel.deliver(message)).resolves.toEqual({
      status: "delivered",
      reference: "email-1"
    });
    expect(email.deliver).toHaveBeenCalledWith(message, undefined);
  });

  it("treats an unconfirmed request as uncertain without exposing the bot token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError(
        `fetch failed for https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`
      );
    });

    const result = await createChannel(fetch).deliver({ markdown: "Help" });

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
      createChannel(fetch).deliver({ markdown: "Help" })
    ).resolves.toEqual({
      status: "uncertain",
      error: {
        code: "TELEGRAM_DELIVERY_ERROR",
        message: "Telegram returned an invalid delivery response"
      }
    });
  });
});

describe("experimental Telegram webhook ingress", () => {
  const webhook = telegramWebhook({
    chatId: "123456",
    secretToken: "webhook-secret"
  });

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

  it("parses an exact YES and recovers its approval interaction", async () => {
    const result = await webhook.receive(
      request({
        update_id: 1,
        message: {
          message_id: 43,
          text: "YES",
          chat: { id: 123456 },
          from: { id: 987654321, username: "approval_tester" },
          reply_to_message: {
            message_id: 42,
            text:
              "Approval required\n\nReply YES to approve or NO to reject.\n\n" +
              "[channel-interaction:actpause_123]"
          }
        }
      })
    );

    expect(result.response.status).toBe(200);
    expect(result.events).toEqual([
      {
        type: "approval-response",
        decision: "approve",
        reference: "43",
        interactionId: "actpause_123",
        replyToReference: "42",
        sender: { id: "987654321", username: "approval_tester" }
      }
    ]);
  });

  it("keeps an unthreaded exact NO as a normalized message", async () => {
    const result = await webhook.receive(
      request({
        update_id: 2,
        message: {
          message_id: 44,
          text: "NO",
          chat: { id: 123456 }
        }
      })
    );

    expect(result.events).toEqual([
      {
        type: "message",
        text: "NO",
        reference: "44"
      }
    ]);
  });

  it("keeps non-exact decisions as normalized messages", async () => {
    const result = await webhook.receive(
      request({
        update_id: 3,
        message: {
          message_id: 45,
          text: " yes ",
          chat: { id: 123456 },
          from: { id: 987654321, username: "approval_tester" },
          reply_to_message: {
            message_id: 42,
            text: "Approval required"
          }
        }
      })
    );

    expect(result.events).toEqual([
      {
        type: "message",
        text: " yes ",
        reference: "45",
        replyTo: { reference: "42", text: "Approval required" },
        sender: { id: "987654321", username: "approval_tester" }
      }
    ]);
  });

  it("ignores messages from another destination", async () => {
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
    expect(result.events).toEqual([]);
  });

  it("rejects a username alias because webhook updates carry numeric chat ids", () => {
    expect(() =>
      telegramWebhook({
        chatId: "@approval_group",
        secretToken: "webhook-secret"
      })
    ).toThrow("chatId must be a numeric Telegram chat id for webhook ingress");
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
