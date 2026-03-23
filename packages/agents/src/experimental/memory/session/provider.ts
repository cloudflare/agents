/**
 * Session Provider Interface
 *
 * Pure storage interface for message CRUD with tree-structured branching.
 * Compaction, context blocks, and search are orchestrated by Session.
 */

import type { UIMessage } from "ai";
import type { MessageQueryOptions } from "./types";

/**
 * Search result from full-text search.
 */
export interface SearchResult {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  sessionId?: string;
}

/**
 * Compaction record — summary that replaces a range of messages in context assembly.
 */
export interface StoredCompaction {
  id: string;
  summary: string;
  fromMessageId: string;
  toMessageId: string;
  createdAt: string;
}

/**
 * Session storage provider interface.
 *
 * Messages are tree-structured via parentId for branching support.
 * Providers handle CRUD only — compaction logic is in Session.
 */
export interface SessionProvider {
  // ── Read ────────────────────────────────────────────────────────

  /** Get all messages (flat, chronological) */
  getMessages(options?: MessageQueryOptions): UIMessage[];

  /** Get a single message by ID */
  getMessage(id: string): UIMessage | null;

  /** Get the last N messages (most recent) */
  getLastMessages(n: number): UIMessage[];

  /** Fetch messages outside the recent window (for microCompaction) */
  getOlderMessages(keepRecent: number): UIMessage[];

  // ── Branching ──────────────────────────────────────────────────

  /**
   * Get the conversation history as a path from root to a specific leaf.
   * If leafId is null, returns the path to the most recent leaf.
   * This is the primary way to get the "current conversation."
   */
  getHistory(leafId?: string | null): UIMessage[];

  /**
   * Get the most recent leaf message (message with no children).
   */
  getLatestLeaf(): UIMessage | null;

  /**
   * Get children of a message (branches from that point).
   */
  getBranches(messageId: string): UIMessage[];

  /**
   * Get the number of messages on the path from root to the latest leaf.
   */
  getPathLength(leafId?: string | null): number;

  // ── Write ──────────────────────────────────────────────────────

  /**
   * Append a message. If parentId is provided, the message is parented
   * to that message. Otherwise it's appended after the latest leaf.
   * Idempotent — appending the same message.id twice is a no-op.
   */
  appendMessage(message: UIMessage, parentId?: string | null): void;

  /**
   * Append one or more messages (legacy flat interface).
   * Each message is parented to the previous one in sequence.
   */
  appendMessages(messages: UIMessage | UIMessage[]): Promise<void>;

  /** Insert or update a message */
  upsertMessage(message: UIMessage, parentId?: string | null): void;

  /** Update an existing message */
  updateMessage(message: UIMessage): void;

  /** Delete messages by ID */
  deleteMessages(messageIds: string[]): void;

  /** Clear all messages */
  clearMessages(): void;

  /** Bulk replace all messages (used by compact) */
  replaceMessages(messages: UIMessage[]): Promise<void>;

  // ── Compaction ─────────────────────────────────────────────────

  /**
   * Add a compaction record. The summary replaces messages from
   * fromMessageId to toMessageId when assembling history.
   */
  addCompaction(
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): StoredCompaction;

  /** Get all compaction records */
  getCompactions(): StoredCompaction[];

  // ── Search ─────────────────────────────────────────────────────

  /**
   * Full-text search across messages.
   * Optional — providers that support FTS should implement this.
   */
  searchMessages?(query: string, limit?: number): SearchResult[];
}
