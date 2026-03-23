/**
 * Session Memory
 *
 * Unified API for conversation history + persistent context blocks.
 *
 * - Messages: CRUD with microCompaction (cheap) and full compaction (user-supplied fn)
 * - Context blocks: MEMORY, USER, SOUL, etc. with frozen snapshot for prompt caching
 * - AI tools: `update_context` tool for the AI to modify writable blocks
 * - Search: FTS5 full-text search across messages
 *
 * @example
 * ```typescript
 * import { Session, AgentSessionProvider } from "agents/experimental/memory/session";
 *
 * const session = new Session(new AgentSessionProvider(this), {
 *   compaction: { tokenThreshold: 100000, fn: summarize },
 *   context: [
 *     { label: "memory", description: "Persistent notes", maxTokens: 1100,
 *       provider: new MyBlockProvider() },
 *     { label: "soul", defaultContent: "You are helpful.", readonly: true },
 *   ]
 * });
 *
 * await session.init(); // load context blocks from providers
 *
 * const systemPrompt = session.toSystemPrompt(); // frozen snapshot
 * const tools = { ...session.tools(), ...otherTools }; // AI can update writable blocks
 * ```
 */

export type {
  MessageQueryOptions,
  MicroCompactionRules,
  CompactFunction,
  CompactionConfig,
  CompactResult,
  SessionOptions
} from "./types";

export type { SessionProvider, SearchResult } from "./provider";

export type {
  ContextBlockProvider,
  ContextBlockConfig,
  ContextBlock,
} from "./context";

export { Session } from "./session";

export { AgentSessionProvider, type SqlProvider } from "./providers/agent";
