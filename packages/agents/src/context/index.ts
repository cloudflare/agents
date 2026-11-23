/**
 * Prompt context for agents: labelled blocks composed into a system prompt,
 * and the tools a model uses to read and write them.
 *
 * `Context` binds blocks to a session. The transcript records the prompt
 * the model was sent and each change delivered after it, and the request is
 * a projection of that record, so nothing already sent is rewritten and
 * the provider's prefix cache holds. `ContextBlocks` is the blocks and
 * tools alone, with no prompt state.
 *
 * @experimental The whole `agents/context` surface may change before
 * stabilizing.
 */

export {
  ContextBlocks,
  type ContextBlock,
  type ContextConfig,
  type ContextProvider,
  type WritableContextProvider
} from "./blocks";
export { Context, type ContextOptions } from "./context";
export { AgentSearchProvider, type SearchProvider } from "./search";
export { AgentContextProvider, type SqlProvider } from "./sqlite-provider";
