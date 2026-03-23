/**
 * Session Types
 */

import type { UIMessage } from "ai";
import type { ContextBlockConfig } from "./context";

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
 * Compaction function — user implements this to decide how to compact messages.
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
 * Options for creating a Session.
 */
export interface SessionOptions {
  /**
   * Lightweight compaction that doesn't require LLM calls.
   * Truncates tool outputs and long text in older messages.
   *
   * @default true
   */
  microCompaction?: boolean | MicroCompactionRules;

  /**
   * Full compaction with custom function (typically LLM summarization).
   */
  compaction?: CompactionConfig;

  /**
   * Context blocks — persistent key-value blocks injected into the system prompt.
   * Each block can have its own storage provider (R2, SQLite, KV, etc.).
   *
   * @example
   * ```typescript
   * context: [
   *   { label: "memory", description: "Persistent notes", maxTokens: 1100,
   *     provider: new R2BlockProvider(env.BUCKET, "memory.md") },
   *   { label: "soul", defaultContent: "You are...", readonly: true },
   * ]
   * ```
   */
  context?: ContextBlockConfig[];
}
