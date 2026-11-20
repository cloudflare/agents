import { describe, expect, it } from "vitest";
import { chunkCarriesContent, takeAtFirstContent } from "../recovery-codec";

describe("chunkCarriesContent", () => {
  it.each([
    "start",
    "start-step",
    "finish-step",
    "finish",
    "error",
    "abort",
    "message-metadata",
    undefined
  ])("is false for %s, which a failing provider also sends", (type) => {
    expect(chunkCarriesContent(type)).toBe(false);
  });

  it.each([
    "text-start",
    "text-delta",
    "reasoning-start",
    "tool-input-start",
    "tool-input-available",
    "tool-output-available",
    "file",
    "source-url",
    "data-progress"
  ])("is true for %s", (type) => {
    expect(chunkCarriesContent(type)).toBe(true);
  });
});

describe("takeAtFirstContent", () => {
  it("takes nothing for a stream that fails before any content", async () => {
    let taken = 0;
    const gate = takeAtFirstContent(async () => {
      taken++;
    });
    for (const type of ["start", "start-step", "error"]) await gate(type);
    expect(taken).toBe(0);
  });

  it("takes once, before the first chunk with content", async () => {
    const log: string[] = [];
    const gate = takeAtFirstContent(async () => {
      log.push("take");
    });
    for (const type of ["start", "text-start", "text-delta", "finish"]) {
      await gate(type);
      log.push(type);
    }
    expect(log).toEqual([
      "start",
      "take",
      "text-start",
      "text-delta",
      "finish"
    ]);
  });

  it("does nothing without a take", () => {
    expect(takeAtFirstContent(undefined)("text-delta")).toBeUndefined();
  });
});
