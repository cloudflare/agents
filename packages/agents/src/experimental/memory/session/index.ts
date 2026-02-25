/**
 * Session Memory
 *
 * Conversation history storage with AI SDK compatibility.
 * Use UIMessage from "ai" package for message types.
 *
 * microCompact is enabled by default - it truncates tool outputs and
 * long text parts in older messages without requiring an LLM.
 *
 * @example
 * ```typescript
 * import { AgentSessionProvider } from "agents/experimental/memory/session";
 *
 * // Default: microCompact enabled
 * session = new AgentSessionProvider(this);
 *
 * // With auto-compaction threshold
 * session = new AgentSessionProvider(this, {
 *   compaction: { tokenThreshold: 20000, fn: summarize }
 * });
 *
 * // Custom microCompact rules
 * session = new AgentSessionProvider(this, {
 *   microCompact: { truncateToolOutputs: 2000, keepRecent: 10 }
 * });
 * ```
 */

export type {
  MessageQueryOptions,
  MicroCompactRules,
  CompactFunction,
  CompactionConfig,
  CompactResult,
  SessionProviderOptions
} from "./types";

export type { SessionProvider } from "./provider";

export { AgentSessionProvider, type SqlProvider } from "./providers/agent";
