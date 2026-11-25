import { describe, expect, it } from "vitest";
import { chunkMustBeStoredNow } from "../recovery-codec";

describe("chunkMustBeStoredNow", () => {
  it("is true for a tool call, an approval request, a settled tool result and a steering message", () => {
    for (const type of [
      "steering-message",
      "tool-input-available",
      "tool-approval-request",
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
