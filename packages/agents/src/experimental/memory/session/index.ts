/**
 * Session Memory
 *
 * Conversation history storage with AI SDK compatibility.
 * Use UIMessage from "ai" package for message types.
 *
 * @example
 * ```typescript
 * import { AgentSessionProvider } from "agents/experimental/memory/session";
 * import type { UIMessage } from "ai";
 *
 * class MyAgent extends Agent {
 *   session = new AgentSessionProvider(this, {
 *     compaction: {
 *       tokenThreshold: 20000,
 *       fn: async (messages) => {
 *         const summary = await llm.summarize(messages);
 *         return [{ id: 'summary', role: 'system', parts: [{ type: 'text', text: summary }] }];
 *       }
 *     }
 *   });
 * }
 * ```
 */

export type {
  MessageQueryOptions,
  CompactFunction,
  CompactionConfig,
  CompactResult,
  SessionProviderOptions
} from "./types";

export type { SessionProvider } from "./provider";

export { AgentSessionProvider, type SqlProvider } from "./providers/agent";
