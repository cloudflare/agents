/**
 * Session Memory Types
 *
 * Re-exports AI SDK types and defines session-specific types.
 */

import type { UIMessage } from "ai";

// Re-export AI SDK message types
export type { UIMessage, UIMessagePart } from "ai";

/**
 * Options for querying messages
 */
export interface MessageQueryOptions {
  /** Maximum number of messages to return */
  limit?: number;
  /** Number of messages to skip */
  offset?: number;
  /** Only return messages created before this timestamp */
  before?: Date;
  /** Only return messages created after this timestamp */
  after?: Date;
  /** Filter by role */
  role?: "user" | "assistant" | "system";
}

/**
 * Compaction function - user implements this to decide how to compact messages.
 * Could summarize with LLM, truncate, filter, or anything else.
 *
 * @param messages Current messages in the session
 * @returns New messages to replace the current ones
 */
export type CompactFunction = (
  messages: UIMessage[]
) => Promise<UIMessage[]>;

/**
 * Configuration for automatic session compaction
 */
export interface CompactionConfig {
  /**
   * Token threshold for automatic compaction.
   * When estimated tokens exceed this, compact() is called automatically on append().
   * If not set, auto-compaction is disabled (you can still call compact() manually).
   */
  tokenThreshold?: number;

  /**
   * Function to compact messages.
   * Receives current messages, returns new messages.
   */
  fn: CompactFunction;
}

/**
 * Result of compaction operation
 */
export interface CompactResult {
  /** Whether compaction succeeded */
  success: boolean;
  /** Error message if compaction failed */
  error?: string;
}

/**
 * Options for creating a session provider
 */
export interface SessionProviderOptions {
  /** Compaction configuration */
  compaction?: CompactionConfig;
}
