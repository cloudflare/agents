/**
 * Session — conversation history with branching, compaction overlays,
 * context blocks, search, and AI tools.
 *
 * @example Builder API (recommended)
 * ```typescript
 * import { Session } from "agents/experimental/memory/session";
 *
 * // Auto-wires SQLite providers for context blocks and cached prompt
 * const session = Session.create(this)
 *   .withContext("memory", { description: "Learned facts", maxTokens: 1100 })
 *   .withContext("soul", { defaultContent: "You are helpful.", readonly: true })
 *   .withCachedPrompt();
 *
 * // Multi-session: namespace providers by session ID
 * const session = Session.create(this)
 *   .forSession("chat-123")
 *   .withContext("memory", { maxTokens: 1100 })
 *   .withCachedPrompt();
 *
 * // Custom provider (R2, KV, etc.)
 * const session = Session.create(this)
 *   .withContext("workspace", {
 *     readonly: true,
 *     provider: {
 *       async get() {
 *         const obj = await env.BUCKET.get("workspace.md");
 *         return obj ? await obj.text() : null;
 *       },
 *       async set(content: string) {
 *         await env.BUCKET.put("workspace.md", content);
 *       },
 *     },
 *   })
 *   .withCachedPrompt();
 * ```
 *
 * @example Manual construction
 * ```typescript
 * import { Session, AgentSessionProvider, AgentContextProvider } from "agents/experimental/memory/session";
 *
 * const session = new Session(new AgentSessionProvider(this), {
 *   context: [
 *     { label: "memory", description: "Learned facts", maxTokens: 1100,
 *       provider: new AgentContextProvider(this, "memory") },
 *     { label: "soul", defaultContent: "You are helpful.", readonly: true },
 *   ],
 *   promptStore: new AgentContextProvider(this, "_system_prompt"),
 * });
 * ```
 */

export type { MessageQueryOptions, SessionOptions } from "./types";

export type {
  SessionProvider,
  SearchResult,
  StoredCompaction
} from "./provider";

export type { ContextProvider, ContextConfig, ContextBlock } from "./context";

export { Session, type SessionContextOptions } from "./session";

export { AgentSessionProvider, type SqlProvider } from "./providers/agent";

export { AgentContextProvider } from "./providers/agent-context";

export { SessionManager, type SessionInfo, type SessionManagerOptions } from "./manager";
