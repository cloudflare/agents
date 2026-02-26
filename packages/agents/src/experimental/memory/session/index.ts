/**
 * Session Memory
 *
 * Conversation history storage with AI SDK compatibility.
 * Use UIMessage from "ai" package for message types.
 *
 * microCompaction is enabled by default - it truncates tool outputs and
 * long text parts in older messages without requiring an LLM.
 *
 * @example
 * ```typescript
 * import { AgentSessionProvider } from "agents/experimental/memory/session";
 *
 * // Default: microCompaction enabled
 * session = new AgentSessionProvider(this);
 *
 * // With auto-compaction threshold
 * session = new AgentSessionProvider(this, {
 *   compaction: { tokenThreshold: 20000, fn: summarize }
 * });
 *
 * // Custom microCompaction rules
 * session = new AgentSessionProvider(this, {
 *   microCompaction: { truncateToolOutputs: 2000, keepRecent: 10 }
 * });
 * ```
 */

export type {
  MessageQueryOptions,
  MicroCompactionRules,
  CompactFunction,
  CompactionConfig,
  CompactResult,
  SessionProviderOptions
} from "./types";

export type { SessionProvider } from "./provider";

export { AgentSessionProvider, type SqlProvider } from "./providers/agent";

// Re-export token utilities for convenience
export {
  estimateStringTokens,
  estimateMessageTokens,
  CHARS_PER_TOKEN,
  WORDS_TOKEN_MULTIPLIER,
  TOKENS_PER_MESSAGE,
} from "../utils/tokens";
