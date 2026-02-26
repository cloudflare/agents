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
 * import { Session, AgentSessionProvider } from "agents/experimental/memory/session";
 *
 * // Default: microCompaction enabled
 * session = new Session(new AgentSessionProvider(this));
 *
 * // With auto-compaction threshold
 * session = new Session(new AgentSessionProvider(this), {
 *   compaction: { tokenThreshold: 20000, fn: summarize }
 * });
 *
 * // Custom microCompaction rules
 * session = new Session(new AgentSessionProvider(this), {
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

export { Session } from "./session";

export { AgentSessionProvider, type SqlProvider } from "./providers/agent";
