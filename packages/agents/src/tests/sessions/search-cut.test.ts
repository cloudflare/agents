import { describe, expect, it } from "vitest";
import { lastSeparator } from "../../sessions/core";

/**
 * The search index's cut point for a message's first row. Before #3124 an
 * end-anchored regex found it. On a slice of several megabytes that also
 * holds a character outside the Basic Multilingual Plane, the regex threw
 * `RangeError: Maximum call stack size exceeded`. With the row budget at
 * 1.9 MB a slice never reaches that size; at 8 MB it does.
 */
describe("lastSeparator", () => {
  it("finds the cut in a 7.9 MB slice with an emoji near its end", () => {
    // The input that overflowed the stack before #3124.
    const text = `start ${"y".repeat(7_900_000 - 13)}\u{1F600}abcdef`;
    expect(lastSeparator(text)).toBe(text.length - 8);
  });

  it("finds the separator before the last word of a 7.9 MB slice", () => {
    const word = "x".repeat(7_900_000);
    expect(lastSeparator(`start ${word}`)).toBe(5);
  });

  it("returns -1 for one unbroken 7.9 MB word", () => {
    expect(lastSeparator("y".repeat(7_900_000))).toBe(-1);
  });

  it("points at the first unit of a surrogate-pair separator, and keeps a combining mark in the word", () => {
    expect(lastSeparator("a b\u{1F600}")).toBe(3);
    expect(lastSeparator("a nee\u0301dle")).toBe(1);
  });
});
