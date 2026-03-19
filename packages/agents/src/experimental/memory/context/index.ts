/**
 * Context Memory
 *
 * Persistent key-value blocks for agent context (personality, preferences, tasks).
 * Blocks can be readonly (developer-set, AI can read) or writable (AI can edit via tools).
 *
 * @example
 * ```typescript
 * import { Context, AgentContextProvider } from "agents/experimental/memory/context";
 *
 * // In your Agent class:
 * context = new Context(new AgentContextProvider(this), {
 *   blocks: [
 *     { label: "soul", description: "Agent personality", defaultContent: "helpful", readonly: true },
 *     { label: "todos", description: "User's todo list", maxTokens: 5000 }
 *   ]
 * });
 *
 * // Read blocks for system prompt
 * const systemPrompt = context.toString();
 *
 * // AI tool integration
 * const tools = { ...context.tools(), ...otherTools };
 * ```
 */

export type {
  BlockSource,
  ContextBlock,
  StoredBlock,
  BlockMetadata,
  SetBlockOptions,
  BlockDefinition,
  ContextOptions
} from "./types";

export type { ContextProvider } from "./provider";

export { Context } from "./context";

export { AgentContextProvider, type SqlProvider } from "./providers/agent";
