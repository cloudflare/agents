/**
 * Token Estimation Utilities
 *
 * IMPORTANT: These are heuristic estimates, not actual tokenizer counts.
 *
 * We intentionally avoid real tokenizers (e.g. tiktoken, sentencepiece) because:
 * - A single tiktoken instance costs ~80-120MB of heap
 * - Cloudflare Workers have tight memory limits (128MB)
 * - For compaction thresholds, a conservative estimate is sufficient
 *
 * The hybrid approach (max of character-based and word-based estimates) handles
 * both dense token content (JSON, code) and natural language reasonably well.
 *
 * Calibration notes:
 * - Character-based: ~4 chars per token (conservative, from OpenAI guidance)
 * - Word-based: ~1.3 tokens per word (empirical, from Mastra's memory system)
 * - Per-message overhead: ~4 tokens for role/framing (empirical)
 *
 * These ratios are tuned for English. CJK, emoji-heavy, or highly technical
 * content may have different ratios. The conservative estimates help ensure
 * compaction triggers before context windows are actually exceeded.
 */

import type { UIMessage } from "ai";

/** Approximate characters per token for English text */
export const CHARS_PER_TOKEN = 4;

/** Approximate token multiplier per whitespace-separated word */
export const WORDS_TOKEN_MULTIPLIER = 1.3;

/** Approximate overhead tokens per message (role, framing) */
export const TOKENS_PER_MESSAGE = 4;

/**
 * Estimate token count for a string using a hybrid heuristic.
 *
 * Takes the max of two estimates:
 * - Character-based: `length / 4` — better for dense content (JSON, code, URLs)
 * - Word-based: `words * 1.3` — better for natural language prose
 *
 * This is a heuristic. Do not use where exact counts are required.
 */
export function estimateStringTokens(text: string): number {
  if (!text) return 0;
  const charEstimate = text.length / CHARS_PER_TOKEN;
  const wordEstimate =
    text.split(/\s+/).filter(Boolean).length * WORDS_TOKEN_MULTIPLIER;
  return Math.ceil(Math.max(charEstimate, wordEstimate));
}

/**
 * Estimate total token count for an array of UIMessages.
 *
 * Walks each message's parts (text, tool invocations, tool results)
 * and applies per-message overhead.
 *
 * This is a heuristic. Do not use where exact counts are required.
 */
export function estimateMessageTokens(messages: UIMessage[]): number {
  let tokens = 0;
  for (const msg of messages) {
    tokens += TOKENS_PER_MESSAGE;
    for (const part of msg.parts) {
      if (part.type === "text") {
        tokens += estimateStringTokens(
          (part as { type: "text"; text: string }).text
        );
      } else if (
        part.type.startsWith("tool-") ||
        part.type === "dynamic-tool"
      ) {
        const toolPart = part as { input?: unknown; output?: unknown };
        if (toolPart.input) {
          tokens += estimateStringTokens(JSON.stringify(toolPart.input));
        }
        if (toolPart.output) {
          tokens += estimateStringTokens(JSON.stringify(toolPart.output));
        }
      }
    }
  }
  return tokens;
}
