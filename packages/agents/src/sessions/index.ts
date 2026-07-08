/**
 * Session — conversation history with branching, compaction overlays,
 * context blocks, search, and AI tools.
 *
 * @example Builder API (recommended)
 * ```typescript
 * import { Session } from "agents/sessions";
 *
 * // Readonly block (provider with only get)
 * const session = Session.create(this)
 *   .withContext("soul", {
 *     provider: { get: async () => "You are helpful." }
 *   })
 *   .withContext("memory", { description: "Learned facts", maxTokens: 1100 })
 *   .withCachedPrompt();
 *
 * // Skills from R2 (on-demand loading via load_context tool)
 * import { R2SkillProvider } from "agents/sessions";
 *
 * const session = Session.create(this)
 *   .withContext("skills", {
 *     provider: new R2SkillProvider(env.SKILLS_BUCKET, { prefix: "skills/" })
 *   })
 *   .withCachedPrompt();
 * ```
 */

export type {
  ContextBlock,
  ContextConfig,
  ContextProvider,
  WritableContextProvider
} from "./context";
export { isWritableProvider } from "./context";
export {
  type SessionInfo,
  SessionManager,
  type SessionManagerOptions
} from "./manager";
export type {
  HistoryRowStat,
  RecentHistoryResult,
  SearchResult,
  SessionProvider,
  StoredCompaction
} from "./provider";
export { AgentSessionProvider, type SqlProvider } from "./providers/agent";
export { AgentContextProvider } from "./providers/agent-context";

export {
  PostgresSessionProvider,
  type PgClientLike,
  type PostgresClient,
  type PostgresConnection
} from "./providers/postgres";

export { PostgresContextProvider } from "./providers/postgres-context";

export { PostgresSearchProvider } from "./providers/postgres-search";

export { Session, type SessionContextOptions } from "./session";
export type { SearchProvider } from "./search";
export { AgentSearchProvider, isSearchProvider } from "./search";
export type { SkillProvider } from "./skills";
export { isSkillProvider, R2SkillProvider } from "./skills";
export {
  estimateStringTokens,
  estimateMessageTokens,
  CHARS_PER_TOKEN,
  WORDS_TOKEN_MULTIPLIER,
  TOKENS_PER_MESSAGE,
  truncateOlderMessages,
  createCompactFunction,
  isCompactionMessage,
  COMPACTION_PREFIX,
  sanitizeToolPairs,
  alignBoundaryForward,
  alignBoundaryBackward,
  findTailCutByTokens,
  computeSummaryBudget,
  buildSummaryPrompt
} from "./utils";
export type {
  TruncateOptions,
  CompactResult,
  CompactOptions,
  CompactTokenCounter
} from "./utils";
export type {
  CompactAfterOptions,
  CompactionErrorHandler,
  SessionMessage,
  SessionMessagePart,
  SessionOptions,
  SessionTokenCounter,
  SessionTokenCounterInput
} from "./types";
