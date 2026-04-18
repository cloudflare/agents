import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlackMessenger } from "../adapters/slack";

const SIGNING_SECRET = "test_signing_secret";
const BOT_TOKEN = "xoxb-test-token";

async function signBody(
  body: string,
  timestamp: number,
  secret: string
): Promise<string> {
  const sigBase = `v0:${timestamp}:${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(sigBase));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${hex}`;
}

function makeSignedRequest(body: string, timestamp: number, signature: string) {
  return new Request("https://example.com/slack/events", {
    method: "POST",
    body,
    headers: {
      "x-slack-signature": signature,
      "x-slack-request-timestamp": String(timestamp)
    }
  });
}

describe("SlackMessenger.handleWebhook", () => {
  let slack: SlackMessenger;

  beforeEach(() => {
    vi.useFakeTimers();
    slack = new SlackMessenger({
      botToken: BOT_TOKEN,
      signingSecret: SIGNING_SECRET
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 401 for invalid signatures", async () => {
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    const request = makeSignedRequest(
      '{"type":"event_callback"}',
      now,
      "v0=invalid"
    );

    const handler = vi.fn();
    const response = await slack.handleWebhook(request, handler);

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("handles url_verification challenge automatically", async () => {
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    const body = JSON.stringify({
      type: "url_verification",
      challenge: "abc123challenge"
    });
    const signature = await signBody(body, now, SIGNING_SECRET);
    const request = makeSignedRequest(body, now, signature);

    const handler = vi.fn();
    const response = await slack.handleWebhook(request, handler);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ challenge: "abc123challenge" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("parses a message event and calls the handler", async () => {
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event: {
        type: "message",
        text: "Hello bot",
        user: "U456",
        ts: "1700000000.000100",
        channel: "C789"
      }
    });
    const signature = await signBody(body, now, SIGNING_SECRET);
    const request = makeSignedRequest(body, now, signature);

    const handler = vi.fn();
    const response = await slack.handleWebhook(request, handler);

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();

    const event = handler.mock.calls[0][0];
    expect(event.type).toBe("message");
    if (event.type === "message") {
      expect(event.message.text).toBe("Hello bot");
      expect(event.message.author.id).toBe("U456");
    }
  });
});
