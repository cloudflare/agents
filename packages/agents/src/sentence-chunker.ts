/**
 * Sentence chunker — accumulates streaming text and yields complete sentences.
 *
 * Isolated and testable: no dependencies on the voice pipeline, Agent, or AI APIs.
 * Feed it tokens via `add()`, get back sentences via the return value.
 * Call `flush()` at end-of-stream to get any remaining text.
 *
 * Current implementation: splits on sentence-ending punctuation (. ! ?) followed
 * by a space or end-of-input. This is intentionally simple — optimize later with
 * better heuristics (abbreviations, decimal numbers, quoted speech, etc.).
 */

/**
 * Punctuation characters that can end a sentence.
 */
const SENTENCE_TERMINATORS = new Set([".", "!", "?"]);

/**
 * Minimum character count before we'll emit a sentence.
 * Prevents emitting fragments like "Dr." or "U.S." as standalone sentences.
 */
const MIN_SENTENCE_LENGTH = 20;

export class SentenceChunker {
  #buffer = "";

  /**
   * Add a chunk of text (e.g. a streamed LLM token).
   * Returns an array of complete sentences extracted from the buffer.
   * May return 0, 1, or multiple sentences depending on the input.
   */
  add(text: string): string[] {
    this.#buffer += text;
    return this.#extractSentences();
  }

  /**
   * Flush any remaining text in the buffer as a final sentence.
   * Call this when the LLM stream ends.
   * Returns the remaining text (trimmed), or an empty array if nothing is left.
   */
  flush(): string[] {
    const remaining = this.#buffer.trim();
    this.#buffer = "";
    if (remaining.length > 0) {
      return [remaining];
    }
    return [];
  }

  /**
   * Reset the chunker, discarding any buffered text.
   */
  reset() {
    this.#buffer = "";
  }

  /**
   * Extract complete sentences from the buffer.
   * A sentence boundary is a terminator (. ! ?) followed by:
   * - a space and an uppercase letter (start of next sentence)
   * - a space and end of current buffer (likely a boundary)
   * - end of buffer after the terminator
   *
   * We leave ambiguous cases in the buffer until more text arrives.
   */
  #extractSentences(): string[] {
    const sentences: string[] = [];

    while (true) {
      const boundary = this.#findSentenceBoundary();
      if (boundary === -1) break;

      const sentence = this.#buffer.slice(0, boundary + 1).trim();
      this.#buffer = this.#buffer.slice(boundary + 1).trimStart();

      if (sentence.length > 0) {
        sentences.push(sentence);
      }
    }

    return sentences;
  }

  /**
   * Find the index of the end of the first complete sentence in the buffer.
   * Returns -1 if no complete sentence boundary is found.
   */
  #findSentenceBoundary(): number {
    for (let i = 0; i < this.#buffer.length; i++) {
      const char = this.#buffer[i];

      if (!SENTENCE_TERMINATORS.has(char)) continue;

      // Check what follows the terminator
      const nextChar = this.#buffer[i + 1];

      // If this is the last character in the buffer, don't split yet —
      // more text might follow (e.g. "3.14" or "Dr. Smith")
      if (nextChar === undefined) continue;

      // Terminator followed by space — likely a real sentence boundary
      if (nextChar === " " || nextChar === "\n") {
        // But only if the sentence is long enough to be real
        const candidate = this.#buffer.slice(0, i + 1).trim();
        if (candidate.length >= MIN_SENTENCE_LENGTH) {
          return i;
        }
      }
    }

    return -1;
  }
}
