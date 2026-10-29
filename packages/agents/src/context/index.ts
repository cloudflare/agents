/**
 * Prompt context for agents: labelled blocks composed into a system prompt,
 * a frozen snapshot that keeps the provider prefix cache warm, and the tools
 * a model uses to read and write them.
 *
 * Most code declares blocks on a session with `withContext()` (see
 * `agents/sessions`), which stores them and the frozen prompt in the
 * object's SQLite. This module holds the provider types, the providers, and
 * `ContextBlocks`, the engine a session uses, for hosts that build a prompt
 * without a session.
 *
 * @experimental The whole `agents/context` surface may change before
 * stabilizing.
 */

export {
  ContextBlocks,
  SEARCH_CONTEXT_TOOL,
  SET_CONTEXT_TOOL,
  type ContextBlock,
  type ContextConfig,
  type ContextProvider,
  type WritableContextProvider
} from "./blocks";
export { AgentSearchProvider, type SearchProvider } from "./search";
export { AgentContextProvider, type SqlProvider } from "./sqlite-provider";
