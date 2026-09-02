/**
 * Token estimation heuristics.
 *
 * Real tokenizers cost ~100 MB of heap, so Sessions estimates: the larger of
 * ~4 characters per token and ~1.3 tokens per word, plus a small per-message
 * framing charge. Attachments get a flat image charge or a bytes/4 charge
 * capped so a large document cannot dominate a compaction trigger. These
 * numbers gate cheap triggers only; model-reported usage stays authoritative.
 */

import type { SessionMessage } from "./types";

/** Approximate characters per token for English text */
export const CHARS_PER_TOKEN = 4;

/** Approximate token multiplier per whitespace-separated word */
export const WORDS_TOKEN_MULTIPLIER = 1.3;

/** Approximate overhead tokens per message (role, framing) */
export const TOKENS_PER_MESSAGE = 4;

/** Flat token charge for an image attachment (vision-model ballpark). */
export const IMAGE_ATTACHMENT_TOKENS = 1_600;

/** Ceiling for a non-image attachment's bytes/4 token charge. */
export const MAX_ATTACHMENT_TOKENS = 20_000;

export function estimateStringTokens(text: string): number {
  if (!text) return 0;
  const charEstimate = text.length / CHARS_PER_TOKEN;
  const wordEstimate =
    text.split(/\s+/).filter(Boolean).length * WORDS_TOKEN_MULTIPLIER;
  return Math.ceil(Math.max(charEstimate, wordEstimate));
}

function estimateUnknownTokens(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return estimateStringTokens(value);
  try {
    return estimateStringTokens(JSON.stringify(value));
  } catch {
    return estimateStringTokens(String(value));
  }
}

/** Estimate tokens for messages from their text, reasoning, and tool parts. */
export function estimateMessageTokens(messages: SessionMessage[]): number {
  let tokens = 0;
  for (const msg of messages) {
    tokens += TOKENS_PER_MESSAGE;
    for (const part of msg.parts) {
      if (part.type === "text" || part.type === "reasoning") {
        tokens += estimateUnknownTokens(part.text ?? part.reasoning);
      } else if (
        part.type.startsWith("tool-") ||
        part.type === "dynamic-tool"
      ) {
        tokens += estimateUnknownTokens(part.input);
        tokens += estimateUnknownTokens(part.output ?? part.result);
      } else if (part.text !== undefined) {
        tokens += estimateUnknownTokens(part.text);
      } else if (part.result !== undefined) {
        tokens += estimateUnknownTokens(part.result);
      }
    }
  }
  return tokens;
}

/** Heuristic token weight of one attachment so media never counts as zero. */
export function estimateAttachmentTokens(
  mediaType: string,
  bytes: number
): number {
  if (mediaType.startsWith("image/")) return IMAGE_ATTACHMENT_TOKENS;
  return Math.min(Math.ceil(bytes / 4), MAX_ATTACHMENT_TOKENS);
}
