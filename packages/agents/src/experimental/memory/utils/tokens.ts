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

import type { SessionMessage } from "../session/types";

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

function estimateUnknownTokens(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return estimateStringTokens(value);

  try {
    return estimateStringTokens(JSON.stringify(value));
  } catch {
    return estimateStringTokens(String(value));
  }
}

/**
 * Estimate total token count for an array of UIMessages.
 *
 * Walks each message's parts (text, reasoning, tool invocations, tool results)
 * and applies per-message overhead.
 *
 * This is a heuristic. Do not use where exact counts are required.
 */
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

// ── Model-Reported Usage ─────────────────────────────────────────────
//
// Mirrors pi's (earendil-works/pi) context accounting: usage comes from
// assistant message metadata, never a user callback; the heuristic above
// only covers messages newer than the last reported usage.

/**
 * Usage shape read from assistant message metadata. Structurally compatible
 * with the AI SDK's `LanguageModelUsage` and OpenAI-style usage objects.
 */
export interface MessageUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedInputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

function asTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * Calculate total context tokens from a usage object.
 * Uses the native `totalTokens` field when available, falls back to summing
 * the components.
 */
export function calculateContextTokens(usage: MessageUsage): number {
  return (
    asTokenCount(usage.totalTokens) ||
    asTokenCount(usage.inputTokens ?? usage.promptTokens) +
      asTokenCount(usage.outputTokens ?? usage.completionTokens) +
      asTokenCount(usage.cachedInputTokens ?? usage.cacheReadTokens) +
      asTokenCount(usage.cacheWriteTokens)
  );
}

/**
 * Get usage from an assistant message's metadata if available.
 * Recognizes `metadata.totalUsage` and `metadata.usage` (the AI SDK
 * `messageMetadata` conventions) as well as a usage-shaped `metadata` itself.
 */
export function getAssistantUsage(
  message: SessionMessage
): MessageUsage | undefined {
  if (message.role !== "assistant") return undefined;
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const m = metadata as { usage?: unknown; totalUsage?: unknown };
  for (const candidate of [m.totalUsage, m.usage, metadata]) {
    if (
      candidate &&
      typeof candidate === "object" &&
      calculateContextTokens(candidate as MessageUsage) > 0
    ) {
      return candidate as MessageUsage;
    }
  }
  return undefined;
}

export interface ContextUsageEstimate {
  /** Total estimated context tokens (model-reported + trailing heuristic). */
  tokens: number;
  /** Model-reported tokens from the last assistant message carrying usage. */
  usageTokens: number;
  /** Heuristic estimate for messages newer than the last reported usage. */
  trailingTokens: number;
  /** Index of the assistant message the usage came from. */
  lastUsageIndex: number;
}

/**
 * Estimate context tokens using the last assistant usage when available.
 * Messages after the last usage are estimated with the heuristic; the
 * model-reported total already covers everything before it (including the
 * system prompt). Returns null when no message carries usage — callers fall
 * back to the pure heuristic.
 */
export function estimateContextTokensFromUsage(
  messages: SessionMessage[]
): ContextUsageEstimate | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = getAssistantUsage(messages[i]);
    if (!usage) continue;
    const usageTokens = calculateContextTokens(usage);
    let trailingTokens = 0;
    for (let j = i + 1; j < messages.length; j++) {
      trailingTokens += estimateMessageTokens([messages[j]]);
    }
    return {
      tokens: usageTokens + trailingTokens,
      usageTokens,
      trailingTokens,
      lastUsageIndex: i
    };
  }
  return null;
}
