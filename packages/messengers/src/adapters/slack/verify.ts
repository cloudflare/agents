/**
 * Verify Slack webhook request signatures using HMAC-SHA256.
 *
 * Slack sends three headers for verification:
 *   - x-slack-signature: v0=<hex-encoded HMAC>
 *   - x-slack-request-timestamp: Unix epoch seconds
 *
 * The signing base string is: "v0:{timestamp}:{body}"
 */

import { timingSafeEqual } from "../../timing-safe-equal";

const FIVE_MINUTES_S = 5 * 60;

export async function verifySlackRequest(
  request: Request,
  signingSecret: string
): Promise<boolean> {
  const signature = request.headers.get("x-slack-signature");
  const timestampStr = request.headers.get("x-slack-request-timestamp");

  if (!signature || !timestampStr) {
    return false;
  }

  const timestamp = Number(timestampStr);
  if (Number.isNaN(timestamp)) {
    return false;
  }

  // Reject requests older than 5 minutes to prevent replay attacks
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > FIVE_MINUTES_S) {
    return false;
  }

  const body = await request.clone().text();
  const sigBase = `v0:${timestamp}:${body}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(sigBase)
  );

  const expected = `v0=${arrayToHex(new Uint8Array(signatureBytes))}`;

  return timingSafeEqual(signature, expected);
}

function arrayToHex(arr: Uint8Array): string {
  const parts: string[] = [];
  for (const byte of arr) {
    parts.push(byte.toString(16).padStart(2, "0"));
  }
  return parts.join("");
}
