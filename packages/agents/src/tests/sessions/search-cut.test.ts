import { describe, expect, it } from "vitest";
import { lastSeparator } from "../../sessions/core";

/**
 * Where search cuts a message's indexed text: before its last word, found by
 * scanning back. The end-anchored regex it replaced (#3124) ran out of stack
 * on a slice of several megabytes, the size an 8 MB row budget indexes.
 */
describe("Sessions search cut", () => {
  it("finds the last separator after a 7.9 MB word without running out of stack", () => {
    // The input that overflowed the regex: a separator, a long word, then
    // a separator before the last word. The regex's greedy word loop ran
    // to the emoji and backtracked through every character
    // (RangeError: Maximum call stack size exceeded).
    const text = `start ${"y".repeat(7_900_000)}\u{1F600}abc`;
    expect(lastSeparator(text)).toBe(6 + 7_900_000);
  });

  it("finds the separator before a 7.9 MB last word", () => {
    expect(lastSeparator(`needle ${"x".repeat(7_900_000)}`)).toBe(6);
  });

  it("returns -1 for a single word", () => {
    expect(lastSeparator("x".repeat(100_000))).toBe(-1);
  });

  it("treats an emoji as one separator and a combining mark as part of a word", () => {
    // U+1F600 is two UTF-16 units: the cut starts at the first of them.
    expect(lastSeparator("start\u{1F600}abc")).toBe(5);
    // The accent belongs to the word, so the space before it is the cut.
    expect(lastSeparator("one nee\u0301dle")).toBe(3);
  });
});
