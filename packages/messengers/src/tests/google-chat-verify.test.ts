import { describe, it, expect } from "vitest";
import { verifyGoogleChatToken } from "../adapters/google-chat/verify";

describe("verifyGoogleChatToken", () => {
  it("returns true when token matches", () => {
    const payload = { type: "MESSAGE", token: "secret_abc123" };
    expect(verifyGoogleChatToken(payload, "secret_abc123")).toBe(true);
  });

  it("returns false when token does not match", () => {
    const payload = { type: "MESSAGE", token: "wrong_token" };
    expect(verifyGoogleChatToken(payload, "secret_abc123")).toBe(false);
  });

  it("returns false when token is missing from payload", () => {
    const payload = { type: "MESSAGE" };
    expect(verifyGoogleChatToken(payload, "secret_abc123")).toBe(false);
  });

  it("returns false for different-length tokens (timing safe)", () => {
    const payload = { type: "MESSAGE", token: "short" };
    expect(verifyGoogleChatToken(payload, "much_longer_secret")).toBe(false);
  });

  it("handles empty token in payload", () => {
    const payload = { type: "MESSAGE", token: "" };
    expect(verifyGoogleChatToken(payload, "secret")).toBe(false);
  });
});
