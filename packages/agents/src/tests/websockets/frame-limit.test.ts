import { describe, expect, it } from "vitest";
import {
  MAX_OUTBOUND_FRAME_BYTES,
  fitsOutboundFrame
} from "../../websockets/frame-limit";

describe("fitsOutboundFrame", () => {
  it("measures UTF-8 bytes, not characters", () => {
    // "€" is 3 bytes: over the limit in bytes while under it in characters.
    const over = "€".repeat(Math.floor(MAX_OUTBOUND_FRAME_BYTES / 3) + 1);
    expect(over.length).toBeLessThan(MAX_OUTBOUND_FRAME_BYTES);
    expect(fitsOutboundFrame(over)).toBe(false);
    expect(
      fitsOutboundFrame("€".repeat(Math.floor(MAX_OUTBOUND_FRAME_BYTES / 3)))
    ).toBe(true);
  });

  it("takes the shortcuts at the edges", () => {
    expect(fitsOutboundFrame("x".repeat(MAX_OUTBOUND_FRAME_BYTES))).toBe(true);
    expect(fitsOutboundFrame("x".repeat(MAX_OUTBOUND_FRAME_BYTES + 1))).toBe(
      false
    );
  });
});
