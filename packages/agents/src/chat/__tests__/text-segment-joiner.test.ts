import { describe, expect, it } from "vitest";
import {
  isTextSegmentBoundary,
  TextSegmentJoiner
} from "../text-segment-joiner";

describe("isTextSegmentBoundary", () => {
  it("treats every structured event other than text deltas as a boundary", () => {
    expect(isTextSegmentBoundary("tool-call")).toBe(true);
    expect(isTextSegmentBoundary("tool-result")).toBe(true);
    expect(isTextSegmentBoundary("text-start")).toBe(true);
    expect(isTextSegmentBoundary("text-end")).toBe(true);
    expect(isTextSegmentBoundary("start-step")).toBe(true);
    expect(isTextSegmentBoundary("finish-step")).toBe(true);
    expect(isTextSegmentBoundary("start")).toBe(true);
    expect(isTextSegmentBoundary("finish")).toBe(true);
    expect(isTextSegmentBoundary("text-delta")).toBe(false);
    expect(isTextSegmentBoundary(undefined)).toBe(false);
  });
});

describe("TextSegmentJoiner", () => {
  it("separates text segments across a stream boundary", () => {
    const joiner = new TextSegmentJoiner();

    expect(joiner.pushText("Before.")).toEqual(["Before."]);
    joiner.markBoundary();
    expect(joiner.pushText("After.")).toEqual([" ", "After."]);
  });

  it("does not duplicate whitespace already provided by either segment", () => {
    const trailingWhitespace = new TextSegmentJoiner();
    trailingWhitespace.pushText("Before. ");
    trailingWhitespace.markBoundary();
    expect(trailingWhitespace.pushText("After.")).toEqual(["After."]);

    const leadingWhitespace = new TextSegmentJoiner();
    leadingWhitespace.pushText("Before.");
    leadingWhitespace.markBoundary();
    expect(leadingWhitespace.pushText("\nAfter.")).toEqual(["\nAfter."]);
  });

  it("reports only the first repeated boundary", () => {
    const joiner = new TextSegmentJoiner();
    expect(joiner.markBoundary()).toBe(false);
    joiner.pushText("Before.");

    expect(joiner.markBoundary()).toBe(true);
    expect(joiner.markBoundary()).toBe(false);
    expect(joiner.pushText("After.")).toEqual([" ", "After."]);
  });

  it("does not add whitespace without text on both sides", () => {
    const joiner = new TextSegmentJoiner();
    joiner.markBoundary();
    expect(joiner.pushText("First.")).toEqual(["First."]);

    joiner.markBoundary();
    expect(joiner.pushText("")).toEqual([]);
    expect(joiner.pushText("Second.")).toEqual([" ", "Second."]);
  });
});
