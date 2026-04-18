import { describe, it, expect } from "vitest";
import { verifyTelegramRequest } from "../adapters/telegram/verify";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/telegram/webhook", {
    method: "POST",
    body: '{"update_id":1}',
    headers
  });
}

describe("verifyTelegramRequest", () => {
  it("returns true when no secret token is configured", () => {
    const request = makeRequest();
    expect(verifyTelegramRequest(request, undefined)).toBe(true);
  });

  it("returns true when header matches secret token", () => {
    const secret = "my_webhook_secret_123";
    const request = makeRequest({
      "x-telegram-bot-api-secret-token": secret
    });
    expect(verifyTelegramRequest(request, secret)).toBe(true);
  });

  it("returns false when header does not match", () => {
    const request = makeRequest({
      "x-telegram-bot-api-secret-token": "wrong_secret"
    });
    expect(verifyTelegramRequest(request, "correct_secret")).toBe(false);
  });

  it("returns false when header is missing but secret is configured", () => {
    const request = makeRequest();
    expect(verifyTelegramRequest(request, "my_secret")).toBe(false);
  });

  it("returns false for different-length strings (timing safe)", () => {
    const request = makeRequest({
      "x-telegram-bot-api-secret-token": "short"
    });
    expect(verifyTelegramRequest(request, "much_longer_secret")).toBe(false);
  });
});
