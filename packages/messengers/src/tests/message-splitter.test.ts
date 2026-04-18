import { describe, it, expect } from "vitest";
import { splitMessage } from "../message-splitter";

describe("splitMessage", () => {
  describe("no splitting needed", () => {
    it("returns the original text when under the limit", () => {
      expect(splitMessage("Hello world", { maxLength: 100 })).toEqual([
        "Hello world"
      ]);
    });

    it("returns the original text when exactly at the limit", () => {
      const text = "a".repeat(50);
      expect(splitMessage(text, { maxLength: 50 })).toEqual([text]);
    });

    it("handles empty string", () => {
      expect(splitMessage("", { maxLength: 100 })).toEqual([""]);
    });
  });

  describe("splitting at paragraph breaks", () => {
    it("splits at paragraph breaks when possible", () => {
      const text =
        "First paragraph with some content.\n\nSecond paragraph with more content.";
      const result = splitMessage(text, { maxLength: 50 });
      expect(result).toEqual([
        "First paragraph with some content.",
        "Second paragraph with more content."
      ]);
    });

    it("prefers paragraph breaks over other boundaries", () => {
      const text =
        "First paragraph here. With two sentences.\n\nSecond paragraph here.";
      const result = splitMessage(text, { maxLength: 50 });
      expect(result).toEqual([
        "First paragraph here. With two sentences.",
        "Second paragraph here."
      ]);
    });
  });

  describe("splitting at line breaks", () => {
    it("splits at line breaks when no paragraph break is available", () => {
      const text = "First line of content here\nSecond line of content here";
      const result = splitMessage(text, { maxLength: 35 });
      expect(result).toEqual([
        "First line of content here",
        "Second line of content here"
      ]);
    });
  });

  describe("splitting at sentence boundaries", () => {
    it("splits at sentence endings", () => {
      const text = "This is the first sentence. This is the second sentence.";
      const result = splitMessage(text, { maxLength: 40 });
      expect(result).toEqual([
        "This is the first sentence.",
        "This is the second sentence."
      ]);
    });

    it("handles exclamation marks", () => {
      const text = "Wow that is amazing! And then some more.";
      const result = splitMessage(text, { maxLength: 30 });
      expect(result).toEqual(["Wow that is amazing!", "And then some more."]);
    });

    it("handles question marks", () => {
      const text = "How are you doing today? I am doing well.";
      const result = splitMessage(text, { maxLength: 35 });
      expect(result).toEqual(["How are you doing today?", "I am doing well."]);
    });
  });

  describe("splitting at word boundaries", () => {
    it("splits at spaces when no sentence boundary works", () => {
      const text = "one two three four five six seven eight nine ten";
      const result = splitMessage(text, { maxLength: 20 });
      expect(result.length).toBeGreaterThan(1);
      for (const chunk of result) {
        expect(chunk.length).toBeLessThanOrEqual(20);
      }
    });

    it("does not break words in the middle", () => {
      const text = "hello world testing data split here now";
      const result = splitMessage(text, { maxLength: 15 });
      for (const chunk of result) {
        expect(chunk.length).toBeLessThanOrEqual(15);
      }
      // Reassembling should contain all original words
      const words = text.split(" ");
      const reassembled = result.join(" ");
      for (const word of words) {
        expect(reassembled).toContain(word);
      }
    });
  });

  describe("hard cut", () => {
    it("hard-cuts a single long word that exceeds the limit", () => {
      const text = "a".repeat(100);
      const result = splitMessage(text, { maxLength: 30 });
      expect(result.length).toBeGreaterThan(1);
      for (const chunk of result) {
        expect(chunk.length).toBeLessThanOrEqual(30);
      }
      expect(result.join("")).toBe(text);
    });
  });

  describe("continuation markers", () => {
    it("adds suffix to non-final chunks and prefix to continuation chunks", () => {
      const text = "First part of the message.\n\nSecond part of the message.";
      const result = splitMessage(text, {
        maxLength: 40,
        continuationPrefix: "... ",
        continuationSuffix: " ..."
      });
      expect(result[0]).toMatch(/ \.\.\.$/);
      expect(result[1]).toMatch(/^\.\.\. /);
    });

    it("throws if maxLength is too small for continuation overhead", () => {
      const longText = "a]".repeat(50);
      expect(() =>
        splitMessage(longText, {
          maxLength: 10,
          continuationPrefix: "abcdef",
          continuationSuffix: "ghijkl"
        })
      ).toThrow("maxLength must be larger");
    });
  });

  describe("multiple splits", () => {
    it("splits into three or more chunks when needed", () => {
      const text = Array.from(
        { length: 10 },
        (_, i) => `Sentence ${i + 1}.`
      ).join(" ");
      const result = splitMessage(text, { maxLength: 40 });
      expect(result.length).toBeGreaterThanOrEqual(3);
      for (const chunk of result) {
        expect(chunk.length).toBeLessThanOrEqual(40);
      }
    });

    it("preserves all content across chunks", () => {
      const text =
        "Hello world. This is a test. Of the message splitting system. It should work correctly.";
      const result = splitMessage(text, { maxLength: 35 });
      const reconstructed = result.join(" ");
      for (const word of text.split(" ")) {
        expect(reconstructed).toContain(word);
      }
    });
  });
});
