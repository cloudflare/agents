/**
 * Session Types
 */

import type { ContextConfig, WritableContextProvider } from "./context";

/**
 * Options for creating a Session.
 */
export interface SessionOptions {
  /** Context blocks for the system prompt. */
  context?: ContextConfig[];

  /** Provider for persisting the frozen system prompt. */
  promptStore?: WritableContextProvider;
}
