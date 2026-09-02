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
  isWritableProvider,
  type ContextBlock,
  type ContextConfig,
  type ContextProvider,
  type SkillUnloadCallback,
  type WritableContextProvider
} from "./blocks";
export {
  AgentSearchProvider,
  isSearchProvider,
  type SearchProvider
} from "./search";
export {
  isSkillProvider,
  R2SkillProvider,
  reclaimLoadedSkill,
  restoreLoadedSkills,
  type SkillProvider,
  type SkillSession
} from "./skills";
export { AgentContextProvider, type SqlProvider } from "./sqlite-provider";
