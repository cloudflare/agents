/**
 * Session Types
 */

import type { ContextBlockConfig, ContextBlockProvider } from "./context";

/**
 * Options for querying messages
 */
export interface MessageQueryOptions {
  limit?: number;
  offset?: number;
  before?: Date;
  after?: Date;
  role?: "user" | "assistant" | "system";
}

/**
 * Options for creating a Session.
 */
export interface SessionOptions {
  /**
   * Context blocks — persistent key-value blocks injected into the system prompt.
   * Each block can have its own storage provider (R2, SQLite, KV, etc.).
   */
  context?: ContextBlockConfig[];

  /**
   * Provider for persisting the frozen system prompt.
   * If provided, the prompt survives DO eviction without re-rendering.
   * Use AgentContextProvider or any ContextBlockProvider implementation.
   */
  promptStore?: ContextBlockProvider;
}
