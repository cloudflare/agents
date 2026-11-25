import { describe, expect, it } from "vitest";
import { WEBSOCKET_MESSAGE_BYTES } from "../../internal/platform-limits";
import { fitsOutboundFrame } from "../../websockets/frame-limit";

describe("fitsOutboundFrame", () => {
  it("measures UTF-8 bytes, not characters", () => {
    // "€" is 3 bytes: over the limit in bytes while under it in characters.
    const over = "€".repeat(Math.floor(WEBSOCKET_MESSAGE_BYTES / 3) + 1);
    expect(over.length).toBeLessThan(WEBSOCKET_MESSAGE_BYTES);
    expect(fitsOutboundFrame(over)).toBe(false);
    expect(
      fitsOutboundFrame("€".repeat(Math.floor(WEBSOCKET_MESSAGE_BYTES / 3)))
    ).toBe(true);
  });

  it("refuses a frame production would drop: over 32 MiB less 73 bytes", () => {
    // Measured on a deployment: 33,554,359 bytes arrive, one more is dropped.
    expect(fitsOutboundFrame("x".repeat(33_554_360))).toBe(false);
    expect(fitsOutboundFrame("x".repeat(32 * 1024 * 1024))).toBe(false);
  });

  it("takes the shortcuts at the edges", () => {
    expect(fitsOutboundFrame("x".repeat(WEBSOCKET_MESSAGE_BYTES))).toBe(true);
    expect(fitsOutboundFrame("x".repeat(WEBSOCKET_MESSAGE_BYTES + 1))).toBe(
      false
    );
  });
});
