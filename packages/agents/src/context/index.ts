/**
 * Prompt context for agents: labelled blocks composed into a system prompt,
 * a frozen snapshot that keeps the provider prefix cache warm, and the tools
 * a model uses to read and write them.
 *
 * Context is prompt assembly, not conversation storage — it composes with
 * `agents/sessions` rather than living inside it.
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
export { AgentSearchProvider, type SearchProvider } from "./search";
export { AgentContextProvider, type SqlProvider } from "./sqlite-provider";
