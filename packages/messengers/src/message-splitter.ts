/**
 * Splits a message into chunks that fit within a platform's character
 * limit. Tries to split at natural boundaries:
 *   1. Paragraph breaks (\n\n)
 *   2. Line breaks (\n)
 *   3. Sentence endings (. ! ?)
 *   4. Word boundaries (spaces)
 *   5. Hard cut (last resort)
 */

interface SplitOptions {
  /** Maximum characters per chunk. */
  maxLength: number;
  /**
   * String to prepend to continuation chunks (e.g. "...").
   * Defaults to empty.
   */
  continuationPrefix?: string;
  /**
   * String to append to non-final chunks (e.g. "...").
   * Defaults to empty.
   */
  continuationSuffix?: string;
}

export function splitMessage(text: string, options: SplitOptions): string[] {
  const {
    maxLength,
    continuationPrefix = "",
    continuationSuffix = ""
  } = options;

  if (text.length <= maxLength) {
    return [text];
  }

  const overhead = continuationPrefix.length + continuationSuffix.length;
  const effectiveMax = maxLength - overhead;

  if (effectiveMax <= 0) {
    throw new Error(
      "maxLength must be larger than continuation prefix + suffix"
    );
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      const chunk =
        chunks.length > 0 ? continuationPrefix + remaining : remaining;
      chunks.push(chunk);
      break;
    }

    const isFirst = chunks.length === 0;
    const limit = isFirst
      ? maxLength - continuationSuffix.length
      : effectiveMax;

    const splitPoint = findSplitPoint(remaining, limit);
    const part = remaining.slice(0, splitPoint).trimEnd();
    remaining = remaining.slice(splitPoint).trimStart();

    if (isFirst) {
      chunks.push(part + continuationSuffix);
    } else {
      chunks.push(continuationPrefix + part + continuationSuffix);
    }
  }

  return chunks;
}

function findSplitPoint(text: string, maxLength: number): number {
  if (text.length <= maxLength) {
    return text.length;
  }

  const searchRegion = text.slice(0, maxLength);

  // Try paragraph break
  const paragraphBreak = searchRegion.lastIndexOf("\n\n");
  if (paragraphBreak > maxLength * 0.3) {
    return paragraphBreak + 2;
  }

  // Try line break
  const lineBreak = searchRegion.lastIndexOf("\n");
  if (lineBreak > maxLength * 0.3) {
    return lineBreak + 1;
  }

  // Try sentence boundary (. ! ? followed by space or end)
  const sentenceMatch = findLastSentenceBoundary(searchRegion);
  if (sentenceMatch > maxLength * 0.3) {
    return sentenceMatch;
  }

  // Try word boundary
  const spaceIndex = searchRegion.lastIndexOf(" ");
  if (spaceIndex > maxLength * 0.3) {
    return spaceIndex + 1;
  }

  // Hard cut
  return maxLength;
}

function findLastSentenceBoundary(text: string): number {
  let lastPos = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "." || ch === "!" || ch === "?") {
      const next = text[i + 1];
      if (next === undefined || next === " " || next === "\n") {
        lastPos = i + 1;
        break;
      }
    }
  }
  return lastPos;
}
