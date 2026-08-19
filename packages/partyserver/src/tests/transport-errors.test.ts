import { describe, expect, it } from "vitest";

import { isBenignTeardownError } from "../transport-errors";

// readyState values: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
const OPEN = { readyState: 1 };
const CLOSING = { readyState: 2 };
const CLOSED = { readyState: 3 };

const retryable = { retryable: true, message: "Network connection lost." };
const networkLost = { message: "Network connection lost." };
const peerGone = { message: "WebSocket peer disconnected" };
const appError = { message: "user threw in onMessage" };

describe("isBenignTeardownError", () => {
  it("suppresses retryable teardown errors on a closing/closed socket", () => {
    expect(isBenignTeardownError(CLOSING, retryable)).toBe(true);
    expect(isBenignTeardownError(CLOSED, retryable)).toBe(true);
  });

  it("suppresses known teardown messages on a closing/closed socket (string fallback)", () => {
    expect(isBenignTeardownError(CLOSED, networkLost)).toBe(true);
    expect(isBenignTeardownError(CLOSED, peerGone)).toBe(true);
  });

  it("does NOT suppress when the socket is still OPEN (real mid-connection error)", () => {
    expect(isBenignTeardownError(OPEN, retryable)).toBe(false);
    expect(isBenignTeardownError(OPEN, networkLost)).toBe(false);
  });

  it("does NOT suppress a genuine application error even on a closed socket", () => {
    expect(isBenignTeardownError(CLOSED, appError)).toBe(false);
  });

  it("prefers the structured retryable flag over message text", () => {
    // No recognizable message, but retryable === true -> still benign.
    expect(
      isBenignTeardownError(CLOSED, { retryable: true, message: "weird" })
    ).toBe(true);
  });

  it("handles non-object errors safely", () => {
    expect(isBenignTeardownError(CLOSED, undefined)).toBe(false);
    expect(isBenignTeardownError(CLOSED, "Network connection lost.")).toBe(
      false
    );
    expect(isBenignTeardownError({}, retryable)).toBe(false);
  });
});
