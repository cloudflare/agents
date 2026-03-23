/**
 * Session — conversation history with branching, compaction overlays,
 * context blocks, search, and AI tools.
 *
 * @example
 * ```typescript
 * import { Session, AgentSessionProvider } from "agents/experimental/memory/session";
 *
 * const session = new Session(new AgentSessionProvider(this), {
 *   context: [
 *     { label: "memory", description: "Learned facts", maxTokens: 1100,
 *       provider: new AgentContextProvider(this, "memory") },
 *     { label: "soul", defaultContent: "You are helpful.", readonly: true },
 *   ]
 * });
 *
 * await session.init();
 *
 * // Tree-structured history with compaction overlays
 * session.appendMessage(userMsg);
 * const history = session.getHistory();
 *
 * // Frozen system prompt from context blocks
 * const systemPrompt = session.freezeSystemPrompt();
 *
 * // AI tool for block updates
 * const tools = { ...session.tools(), ...otherTools };
 *
 * // Non-destructive compaction
 * session.addCompaction(summary, fromId, toId);
 *
 * // Search
 * const results = session.search("deployment error");
 * ```
 */

export type { MessageQueryOptions, SessionOptions } from "./types";

export type { SessionProvider, SearchResult, StoredCompaction } from "./provider";

export type { ContextBlockProvider, ContextBlockConfig, ContextBlock } from "./context";

export { Session } from "./session";

export { AgentSessionProvider, type SqlProvider } from "./providers/agent";

export { AgentContextProvider } from "./providers/agent-context";

