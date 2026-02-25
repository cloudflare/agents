/**
 * Session Memory
 *
 * Conversation history storage with AI SDK compatibility.
 *
 * @example
 * ```typescript
 * import { AgentSessionProvider } from "agents/experimental/memory/session";
 *
 * class MyAgent extends Agent {
 *   session = new AgentSessionProvider(this, {
 *     compaction: {
 *       tokenThreshold: 20000,
 *       fn: async (messages) => {
 *         // Summarize entire conversation
 *         const summary = await llm.summarize(messages);
 *         return [{ id: 'summary', role: 'system', parts: [{ type: 'text', text: summary }] }];
 *       }
 *     }
 *   });
 * }
 * ```
 */

// Types
export type {
  AIMessage,
  AIMessagePart,
  MessageQueryOptions,
  CompactFunction,
  CompactionConfig,
  CompactResult,
  SessionProviderOptions
} from "./types";

// Provider interface
export type { SessionProvider } from "./provider";

// Providers
export { AgentSessionProvider, type SqlProvider } from "./providers/agent";
