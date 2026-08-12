import { describe, expect, it } from "vitest";
import { TextSegmentJoiner } from "../text-segment-joiner";

const text = (value: string) => ({ type: "text", text: value }) as const;
const boundary = { type: "boundary" } as const;

describe("TextSegmentJoiner", () => {
  it("classifies structured chunks and separates non-adjacent text", () => {
    const joiner = new TextSegmentJoiner();

    expect(joiner.pushChunk({ type: "text-delta", text: "Before." })).toEqual([
      text("Before.")
    ]);
    expect(joiner.pushChunk({ type: "tool-call" })).toEqual([boundary]);
    expect(joiner.pushChunk({ type: "tool-result" })).toEqual([]);
    expect(joiner.pushChunk({ type: "text-delta", delta: "After." })).toEqual([
      text(" "),
      text("After.")
    ]);
  });

  it("treats text and stream lifecycle chunks as boundaries", () => {
    for (const type of [
      "text-start",
      "text-end",
      "start-step",
      "finish-step",
      "start",
      "finish"
    ]) {
      const joiner = new TextSegmentJoiner();
      joiner.pushChunk({ type: "text-delta", text: "Before." });
      expect(joiner.pushChunk({ type }), type).toEqual([boundary]);
    }
  });

  it("does not duplicate whitespace already provided by either segment", () => {
    const trailingWhitespace = new TextSegmentJoiner();
    trailingWhitespace.pushChunk({ type: "text-delta", text: "Before. " });
    trailingWhitespace.pushChunk({ type: "tool-call" });
    expect(
      trailingWhitespace.pushChunk({ type: "text-delta", text: "After." })
    ).toEqual([text("After.")]);

    const leadingWhitespace = new TextSegmentJoiner();
    leadingWhitespace.pushChunk({ type: "text-delta", text: "Before." });
    leadingWhitespace.pushChunk({ type: "tool-call" });
    expect(
      leadingWhitespace.pushChunk({ type: "text-delta", text: "\nAfter." })
    ).toEqual([text("\nAfter.")]);
  });

  it("reports only the first repeated boundary", () => {
    const joiner = new TextSegmentJoiner();
    expect(joiner.pushChunk({ type: "tool-call" })).toEqual([]);
    joiner.pushChunk({ type: "text-delta", text: "Before." });

    expect(joiner.pushChunk({ type: "tool-call" })).toEqual([boundary]);
    expect(joiner.pushChunk({ type: "tool-result" })).toEqual([]);
    expect(joiner.pushChunk({ type: "text-delta", text: "After." })).toEqual([
      text(" "),
      text("After.")
    ]);
  });

  it("does not add whitespace without text on both sides", () => {
    const joiner = new TextSegmentJoiner();
    expect(joiner.pushChunk({ type: "tool-call" })).toEqual([]);
    expect(joiner.pushChunk({ type: "text-delta", text: "First." })).toEqual([
      text("First.")
    ]);

    expect(joiner.pushChunk({ type: "tool-call" })).toEqual([boundary]);
    expect(joiner.pushChunk({ type: "text-delta", text: "" })).toEqual([]);
    expect(joiner.pushChunk({ type: "text-delta", text: "Second." })).toEqual([
      text(" "),
      text("Second.")
    ]);
  });
});
