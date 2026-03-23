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
 * import { createCompactFunction } from "agents/experimental/memory/utils";
 *
 * const session = new Session(new AgentSessionProvider(this), {
 *   compaction: {
 *     tokenThreshold: 100000,
 *     fn: createCompactFunction({
 *       summarize: (prompt) => generateText({ model, prompt }).then(r => r.text)
 *     })
 *   },
 *   context: [
 *     { label: "memory", description: "Persistent notes", maxTokens: 1100,
 *       provider: new MyBlockProvider() },
 *     { label: "soul", defaultContent: "You are helpful.", readonly: true },
 *   ]
 * });
 *
 * await session.init();
 *
 * // Frozen snapshot — same string on every call (preserves prefix cache)
 * const systemPrompt = session.toSystemPrompt();
 *
 * // AI tools
 * const tools = { ...session.tools(), ...otherTools };
 *
 * // On new session, refresh to pick up block changes from previous session
 * session.refreshSystemPrompt();
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
