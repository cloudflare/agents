/**
 * Session Memory Types
 */

import type { UIMessage } from "ai";

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
 * Granular microCompaction rules.
 * Each rule can be true (use default), false (disable), or a number (custom threshold).
 */
export interface MicroCompactionRules {
  /**
   * Truncate tool outputs over this size (in chars).
   * @default 30000 chars
   */
  truncateToolOutputs?: boolean | number;

  /**
   * Truncate text parts over this size in older messages (in chars).
   * @default 10000 chars
   */
  truncateText?: boolean | number;

  /**
   * Number of recent messages to keep intact (not truncated).
   * @default 4
   */
  keepRecent?: number;
}

/**
 * Compaction function - user implements this to decide how to compact messages.
 * Could summarize with LLM, truncate, filter, or anything else.
 *
 * @param messages Current messages in the session
 * @returns New messages to replace the current ones
 */
export type CompactFunction = (messages: UIMessage[]) => Promise<UIMessage[]>;

/**
 * Configuration for full compaction (LLM summarization)
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
   * Receives current messages as stored, returns new messages.
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
  /**
   * Lightweight compaction that doesn't require LLM calls.
   * Truncates tool outputs and long text in older messages.
   *
   * Runs automatically on every `append()` — older messages (beyond `keepRecent`)
   * are truncated in storage.
   * This is a destructive operation: original content is permanently replaced.
   * `getMessages()` returns stored content as-is (already compacted).
   *
   * - `true` - enable with default rules
   * - `false` - disable
   * - `{ ... }` - enable with custom rules
   *
   * @default true
   */
  microCompaction?: boolean | MicroCompactionRules;

  /**
   * Full compaction with custom function (typically LLM summarization).
   */
  compaction?: CompactionConfig;
}
