/**
 * Session — conversation history with branching, compaction overlays,
 * context blocks, search, and AI tools.
 *
 * @example Builder API (recommended)
 * ```typescript
 * import { Session } from "agents/experimental/memory/session";
 *
 * // Readonly block (provider with only get)
 * const session = Session.create(this)
 *   .withContext("soul", {
 *     initialContent: "You are helpful.",
 *     provider: { get: async () => "You are helpful." }
 *   })
 *   .withContext("memory", { description: "Learned facts", maxTokens: 1100 })
 *   .withCachedPrompt();
 *
 * // Skills from R2 (on-demand loading via load_context tool)
 * import { R2SkillProvider } from "agents/experimental/memory/session";
 *
 * const session = Session.create(this)
 *   .withContext("skills", {
 *     provider: new R2SkillProvider(env.SKILLS_BUCKET, { prefix: "skills/" })
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

export type {
  ContextProvider,
  WritableContextProvider,
  ContextConfig,
  ContextBlock
} from "./context";

export { isWritableProvider } from "./context";

export { Session, type SessionContextOptions } from "./session";

export { AgentSessionProvider, type SqlProvider } from "./providers/agent";

export { AgentContextProvider } from "./providers/agent-context";

export {
  SessionManager,
  type SessionInfo,
  type SessionManagerOptions
} from "./manager";

export type { SkillProvider } from "./skills";

export { R2SkillProvider, isSkillProvider } from "./skills";
