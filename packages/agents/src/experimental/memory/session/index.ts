/**
 * Session Memory
 *
 * Conversation history storage with AI SDK compatibility.
 * Use UIMessage from "ai" package for message types.
 *
 * @example
 * ```typescript
 * import { AgentSessionProvider } from "agents/experimental/memory/session";
 *
 * class MyAgent extends Agent {
 *   // Lightweight compaction - truncates tool outputs and long text
 *   session = new AgentSessionProvider(this, {
 *     compaction: { tokenThreshold: 20000, microCompact: true }
 *   });
 * }
 * ```
 */

export type {
  MessageQueryOptions,
  CompactFunction,
  CompactionConfig,
  CompactResult,
  SessionProviderOptions
} from "./types";

export type { SessionProvider } from "./provider";

export { AgentSessionProvider, type SqlProvider } from "./providers/agent";
