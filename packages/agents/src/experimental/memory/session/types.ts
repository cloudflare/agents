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
  /** Context blocks for the system prompt. */
  context?: ContextBlockConfig[];

  /** Provider for persisting the frozen system prompt. */
  promptStore?: ContextBlockProvider;
}
