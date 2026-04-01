/**
 * Session — conversation history with branching, compaction overlays,
 * context blocks, search, and AI tools.
 *
 * @example Builder API (recommended)
 * ```typescript
 * import { Session } from "agents/experimental/memory/session";
 *
 * const session = Session.create(this)
 *   .withContext("soul", { initialContent: "You are helpful.", readonly: true })
 *   .withContext("memory", { description: "Learned facts", maxTokens: 1100 })
 *   .withContext("todos", { description: "Task list", maxTokens: 2000 })
 *   .withCachedPrompt();
 *
 * // Custom storage (R2, KV, etc.)
 * const session = Session.create(this)
 *   .withContext("workspace", {
 *     provider: {
 *       get: () => env.BUCKET.get("ws.md").then(o => o?.text() ?? null),
 *       set: (c) => env.BUCKET.put("ws.md", c),
 *     }
 *   })
 *   .withCachedPrompt();
 *
 * // Read-only from external source
 * const session = Session.create(this)
 *   .withContext("config", {
 *     readonly: true,
 *     provider: { get: () => env.KV.get("agent-config") },
 *   })
 *   .withCachedPrompt();
 * ```
 */

export type { MessageQueryOptions, SessionOptions } from "./types";

export type {
  SessionProvider,
  SearchResult,
  StoredCompaction
} from "./provider";

export type { ContextConfig, ContextBlock } from "./context";

export { Session, type SessionContextOptions } from "./session";

export { AgentSessionProvider, type SqlProvider } from "./providers/agent";

export { AgentContextProvider } from "./providers/agent-context";

export { AiSearchContextProvider } from "./providers/ai-search";
