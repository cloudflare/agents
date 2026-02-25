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
 *   session = new AgentSessionProvider(this);
 *
 *   async onChatMessage() {
 *     const messages = this.session.getMessages();
 *     // Use messages with AI SDK...
 *   }
 * }
 * ```
 */

// Types
export type { AIMessage, AIMessagePart, MessageQueryOptions } from "./types";

// Provider interface
export type { SessionProvider } from "./provider";

// Providers
export { AgentSessionProvider, type SqlProvider } from "./providers/agent";
