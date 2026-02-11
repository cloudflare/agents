import { describe, it, expect, beforeEach } from "vitest";
import { SentenceChunker } from "../sentence-chunker";

describe("SentenceChunker", () => {
  let chunker: SentenceChunker;

  beforeEach(() => {
    chunker = new SentenceChunker();
  });

  describe("add()", () => {
    it("returns nothing for a partial sentence", () => {
      expect(chunker.add("Hello, how are")).toEqual([]);
    });

    it("returns a sentence when text ends with terminator + space", () => {
      const result = chunker.add(
        "Hello, how are you doing today? I am doing well."
      );
      // First sentence is long enough, second stays in buffer (no trailing space/next sentence)
      expect(result).toEqual(["Hello, how are you doing today?"]);
    });

    it("accumulates across multiple add() calls", () => {
      expect(chunker.add("Hello, how are you ")).toEqual([]);
      expect(chunker.add("doing today? ")).toEqual([
        "Hello, how are you doing today?"
      ]);
      expect(chunker.add("I'm great! ")).toEqual([]);
      expect(chunker.add("Thanks for asking about it. ")).toEqual([
        "I'm great! Thanks for asking about it."
      ]);
    });

    it("handles multiple sentences in one chunk", () => {
      const result = chunker.add(
        "This is the first sentence here. This is the second one right here. And a third one comes now. "
      );
      expect(result).toEqual([
        "This is the first sentence here.",
        "This is the second one right here.",
        "And a third one comes now."
      ]);
    });

    it("handles exclamation marks as terminators", () => {
      expect(
        chunker.add("Wow that is so amazing! Tell me more about it. ")
      ).toEqual(["Wow that is so amazing!", "Tell me more about it."]);
    });

    it("handles question marks as terminators", () => {
      expect(
        chunker.add("How are you doing today? I am doing very well. ")
      ).toEqual(["How are you doing today?", "I am doing very well."]);
    });

    it("does not split on very short fragments like 'Dr.'", () => {
      // "Dr." alone is too short (< 20 chars) so it stays buffered
      expect(chunker.add("Dr. ")).toEqual([]);
      // But once the full sentence grows past MIN_SENTENCE_LENGTH it emits
      expect(chunker.add("Smith went to the store. ")).toEqual([
        "Dr. Smith went to the store."
      ]);
    });

    it("does not split on decimal numbers mid-word", () => {
      // "3.99" — the "." is followed by "9", not a space, so no split
      expect(chunker.add("The price was 3.99 ")).toEqual([]);
      expect(
        chunker.add("dollars for everything today. Next item costs more. ")
      ).toEqual([
        "The price was 3.99 dollars for everything today.",
        "Next item costs more."
      ]);
    });

    // TODO: Future optimisation — handle abbreviations like "Dr.", "U.S.", "etc."
    // These currently split if the preceding text is long enough.
    // See sentence-chunker.ts for the MIN_SENTENCE_LENGTH heuristic.
  });

  describe("flush()", () => {
    it("returns remaining buffer content", () => {
      chunker.add("This is an incomplete");
      expect(chunker.flush()).toEqual(["This is an incomplete"]);
    });

    it("returns empty array when buffer is empty", () => {
      expect(chunker.flush()).toEqual([]);
    });

    it("clears the buffer after flushing", () => {
      chunker.add("Some text here");
      chunker.flush();
      expect(chunker.flush()).toEqual([]);
    });

    it("returns remaining text after sentences have been extracted", () => {
      chunker.add("First sentence is complete. Second is not");
      // "First sentence is complete." is long enough
      expect(chunker.flush()).toEqual(["Second is not"]);
    });
  });

  describe("reset()", () => {
    it("discards buffered text", () => {
      chunker.add("Some buffered text");
      chunker.reset();
      expect(chunker.flush()).toEqual([]);
    });
  });

  describe("streaming simulation", () => {
    it("simulates token-by-token LLM streaming", () => {
      const tokens = [
        "Sure",
        ",",
        " I",
        "'d",
        " be",
        " happy",
        " to",
        " help",
        " you",
        " with",
        " that",
        ".",
        " Let",
        " me",
        " think",
        " about",
        " the",
        " best",
        " approach",
        " here",
        ".",
        " First",
        ",",
        " we",
        " should",
        " consider",
        " options",
        "."
      ];

      const allSentences: string[] = [];
      for (const token of tokens) {
        allSentences.push(...chunker.add(token));
      }
      allSentences.push(...chunker.flush());

      expect(allSentences).toEqual([
        "Sure, I'd be happy to help you with that.",
        "Let me think about the best approach here.",
        "First, we should consider options."
      ]);
    });
  });
});
