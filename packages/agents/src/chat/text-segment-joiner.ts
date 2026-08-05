/** @internal A parsed structured-stream chunk accepted by the joiner. */
export interface TextSegmentChunk {
  delta?: unknown;
  text?: unknown;
  type?: unknown;
}

/** @internal A text or semantic boundary emitted by the joiner. */
export type TextSegmentEvent =
  | { type: "text"; text: string }
  | { type: "boundary" };

/**
 * @internal Converts structured stream chunks into text and boundary events
 * without gluing words across non-text chunks. Sibling-package support for
 * `@cloudflare/voice` and `@cloudflare/think`, not a public API.
 */
export class TextSegmentJoiner {
  #hasText = false;
  #lastTextEndedWithWhitespace = false;
  #needsBoundarySpace = false;

  pushChunk(chunk: TextSegmentChunk): TextSegmentEvent[] {
    if (chunk.type === "text-delta") {
      const text = textFromChunk(chunk);
      return text ? this.#pushText(text) : [];
    }

    if (typeof chunk.type !== "string" || !this.#markBoundary()) return [];
    return [{ type: "boundary" }];
  }

  #markBoundary(): boolean {
    if (!this.#hasText || this.#needsBoundarySpace) return false;
    this.#needsBoundarySpace = true;
    return true;
  }

  #pushText(text: string): TextSegmentEvent[] {
    const events: TextSegmentEvent[] = [];
    if (
      this.#needsBoundarySpace &&
      !this.#lastTextEndedWithWhitespace &&
      !/^\s/.test(text)
    ) {
      events.push({ type: "text", text: " " });
    }

    events.push({ type: "text", text });
    this.#hasText = true;
    this.#lastTextEndedWithWhitespace = /\s$/.test(text);
    this.#needsBoundarySpace = false;
    return events;
  }
}

function textFromChunk(chunk: TextSegmentChunk): string | null {
  if (typeof chunk.text === "string") return chunk.text;
  if (typeof chunk.delta === "string") return chunk.delta;
  return null;
}
