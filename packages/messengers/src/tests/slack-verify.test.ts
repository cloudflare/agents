import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { verifySlackRequest } from "../adapters/slack/verify";

const SIGNING_SECRET = "test_signing_secret_1234";

async function signRequest(
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
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(sigBase)
  );
  const hex = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${hex}`;
}

function makeRequest(body: string, headers: Record<string, string>): Request {
  return new Request("https://example.com/slack/events", {
    method: "POST",
    body,
    headers
  });
}

describe("verifySlackRequest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("verifies a valid request", async () => {
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    const body = '{"type":"event_callback"}';
    const signature = await signRequest(body, now, SIGNING_SECRET);

    const request = makeRequest(body, {
      "x-slack-signature": signature,
      "x-slack-request-timestamp": String(now)
    });

    expect(await verifySlackRequest(request, SIGNING_SECRET)).toBe(true);
  });

  it("rejects a request with wrong secret", async () => {
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    const body = '{"type":"event_callback"}';
    const signature = await signRequest(body, now, "wrong_secret");

    const request = makeRequest(body, {
      "x-slack-signature": signature,
      "x-slack-request-timestamp": String(now)
    });

    expect(await verifySlackRequest(request, SIGNING_SECRET)).toBe(false);
  });

  it("rejects a request with tampered body", async () => {
    const now = 1700000000;
    vi.setSystemTime(now * 1000);

    const originalBody = '{"type":"event_callback"}';
    const signature = await signRequest(originalBody, now, SIGNING_SECRET);

    const request = makeRequest('{"type":"tampered"}', {
      "x-slack-signature": signature,
      "x-slack-request-timestamp": String(now)
    });

    expect(await verifySlackRequest(request, SIGNING_SECRET)).toBe(false);
  });

  it("rejects a request older than 5 minutes", async () => {
    const now = 1700000000;
    const oldTimestamp = now - 301;
    vi.setSystemTime(now * 1000);

    const body = '{"type":"event_callback"}';
    const signature = await signRequest(body, oldTimestamp, SIGNING_SECRET);

    const request = makeRequest(body, {
      "x-slack-signature": signature,
      "x-slack-request-timestamp": String(oldTimestamp)
    });

    expect(await verifySlackRequest(request, SIGNING_SECRET)).toBe(false);
  });

  it("accepts a request within 5 minutes", async () => {
    const now = 1700000000;
    const recentTimestamp = now - 200;
    vi.setSystemTime(now * 1000);

    const body = '{"type":"event_callback"}';
    const signature = await signRequest(body, recentTimestamp, SIGNING_SECRET);

    const request = makeRequest(body, {
      "x-slack-signature": signature,
      "x-slack-request-timestamp": String(recentTimestamp)
    });

    expect(await verifySlackRequest(request, SIGNING_SECRET)).toBe(true);
  });

  it("rejects a request with missing signature header", async () => {
    const request = makeRequest('{"test":true}', {
      "x-slack-request-timestamp": "1700000000"
    });

    expect(await verifySlackRequest(request, SIGNING_SECRET)).toBe(false);
  });

  it("rejects a request with missing timestamp header", async () => {
    const request = makeRequest('{"test":true}', {
      "x-slack-signature": "v0=abc123"
    });

    expect(await verifySlackRequest(request, SIGNING_SECRET)).toBe(false);
  });

  it("rejects a request with non-numeric timestamp", async () => {
    const request = makeRequest('{"test":true}', {
      "x-slack-signature": "v0=abc123",
      "x-slack-request-timestamp": "not-a-number"
    });

    expect(await verifySlackRequest(request, SIGNING_SECRET)).toBe(false);
  });
});
