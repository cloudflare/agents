import { describe, it, expect, vi } from "vitest";
import { TelegramMessenger } from "../adapters/telegram";

const BOT_TOKEN = "123456:ABC-DEF";
const SECRET_TOKEN = "my_webhook_secret";

function makeRequest(
  body: string,
  headers: Record<string, string> = {}
): Request {
  return new Request("https://example.com/telegram/webhook", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      ...headers
    }
  });
}

describe("TelegramMessenger.handleWebhook", () => {
  it("returns 401 when secret token does not match", async () => {
    const telegram = new TelegramMessenger({
      botToken: BOT_TOKEN,
      secretToken: SECRET_TOKEN
    });

    const request = makeRequest(JSON.stringify({ update_id: 1 }), {
      "x-telegram-bot-api-secret-token": "wrong"
    });

    const handler = vi.fn();
    const response = await telegram.handleWebhook(request, handler);

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("parses a message and calls the handler", async () => {
    const telegram = new TelegramMessenger({
      botToken: BOT_TOKEN,
      secretToken: SECRET_TOKEN
    });

    const body = JSON.stringify({
      update_id: 12345,
      message: {
        message_id: 100,
        from: { id: 42, is_bot: false, first_name: "Alice", username: "alice" },
        chat: { id: -100123, type: "group" },
        date: 1700000000,
        text: "Hello bot"
      }
    });

    const request = makeRequest(body, {
      "x-telegram-bot-api-secret-token": SECRET_TOKEN
    });

    const handler = vi.fn();
    const response = await telegram.handleWebhook(request, handler);

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();

    const event = handler.mock.calls[0][0];
    expect(event.type).toBe("message");
    if (event.type === "message") {
      expect(event.message.text).toBe("Hello bot");
      expect(event.message.author.name).toBe("alice");
    }
  });

  it("works without a secret token configured", async () => {
    const telegram = new TelegramMessenger({ botToken: BOT_TOKEN });

    const body = JSON.stringify({
      update_id: 12346,
      message: {
        message_id: 101,
        from: { id: 42, is_bot: false, first_name: "Bob" },
        chat: { id: 42, type: "private" },
        date: 1700000001,
        text: "No secret"
      }
    });

    const request = makeRequest(body);
    const handler = vi.fn();
    const response = await telegram.handleWebhook(request, handler);

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("passes callback query as interaction event", async () => {
    const telegram = new TelegramMessenger({ botToken: BOT_TOKEN });

    const body = JSON.stringify({
      update_id: 12347,
      callback_query: {
        id: "cb_123",
        from: { id: 42, is_bot: false, first_name: "Alice" },
        message: {
          message_id: 100,
          from: { id: 99, is_bot: true, first_name: "Bot" },
          chat: { id: -100123, type: "group" },
          date: 1700000000
        },
        data: "approve_request"
      }
    });

    const request = makeRequest(body);
    const handler = vi.fn();
    await telegram.handleWebhook(request, handler);

    const event = handler.mock.calls[0][0];
    expect(event.type).toBe("interaction");
    if (event.type === "interaction") {
      expect(event.interaction.actionId).toBe("approve_request");
      expect(event.interaction.userId).toBe("42");
    }
  });
});
