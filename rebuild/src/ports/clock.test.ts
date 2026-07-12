import { describe, expect, it } from "vitest";
import { systemClock } from "./clock.js";

describe("systemClock", () => {
  it("returns the current epoch milliseconds", () => {
    const before = Date.now();
    const value = systemClock.now();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });
});
