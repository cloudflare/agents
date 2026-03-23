/**
 * Session — unified API for conversation history with branching,
 * compaction, context blocks, search, and AI tools.
 *
 * @example
 * ```typescript
 * import { Session, AgentSessionProvider } from "agents/experimental/memory/session";
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
 * // Branching: get conversation as tree path
 * const history = session.getHistory();        // root → latest leaf
 * const branches = session.getBranches(msgId); // children of a message
 *
 * // Frozen snapshot — same string on every call
 * const systemPrompt = session.toSystemPrompt();
 *
 * // AI tools
 * const tools = { ...session.tools(), ...otherTools };
 *
 * // Compaction: non-destructive overlay
 * session.addCompaction(summary, fromId, toId);
 *
 * // Search
 * const results = session.search("deployment error");
 *
 * // Refresh on new session
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

export type { SessionProvider, SearchResult, StoredCompaction } from "./provider";

export type {
  ContextBlockProvider,
  ContextBlockConfig,
  ContextBlock,
} from "./context";

export { Session } from "./session";

export { AgentSessionProvider, type SqlProvider } from "./providers/agent";
