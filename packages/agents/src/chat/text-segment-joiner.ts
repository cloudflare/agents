/**
 * @internal Identifies structured stream chunks that can separate text
 * segments. Only text deltas are contiguous text rather than boundaries.
 */
export function isTextSegmentBoundary(type: unknown): boolean {
  return typeof type === "string" && type !== "text-delta";
}

/**
 * @internal Joins text segments without gluing words across structured stream
 * boundaries. Sibling-package support for `@cloudflare/voice` and
 * `@cloudflare/think`, not a public API.
 */
export class TextSegmentJoiner {
  #hasText = false;
  #lastTextEndedWithWhitespace = false;
  #needsBoundarySpace = false;

  markBoundary(): boolean {
    if (!this.#hasText || this.#needsBoundarySpace) return false;
    this.#needsBoundarySpace = true;
    return true;
  }

  pushText(text: string): string[] {
    if (!text) return [];

    const chunks: string[] = [];
    if (
      this.#needsBoundarySpace &&
      !this.#lastTextEndedWithWhitespace &&
      !/^\s/.test(text)
    ) {
      chunks.push(" ");
    }

    chunks.push(text);
    this.#hasText = true;
    this.#lastTextEndedWithWhitespace = /\s$/.test(text);
    this.#needsBoundarySpace = false;
    return chunks;
  }
}
