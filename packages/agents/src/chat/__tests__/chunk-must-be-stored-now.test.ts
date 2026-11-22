import { describe, expect, it } from "vitest";
import { chunkMustBeStoredNow } from "../recovery-codec";

describe("chunkMustBeStoredNow", () => {
  it("is true for a tool call and for a settled tool result", () => {
    for (const type of [
      "tool-input-available",
      "tool-output-available",
      "tool-output-error",
      "tool-output-denied"
    ]) {
      expect(chunkMustBeStoredNow(type)).toBe(true);
    }
  });

  it("is false for streaming content and structure", () => {
    for (const type of [
      "text-delta",
      "reasoning-delta",
      "tool-input-start",
      "tool-input-delta",
      "start-step",
      undefined
    ]) {
      expect(chunkMustBeStoredNow(type)).toBe(false);
    }
  });
});
