/**
 * Session Provider Interface
 *
 * Pure storage interface for message CRUD.
 * Compaction and context blocks are orchestrated by the Session wrapper.
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
}

/**
 * Session storage provider interface.
 *
 * Implement this for custom storage backends (SQLite, Postgres, etc.).
 * Providers handle CRUD only — compaction and context are handled by Session.
 */
export interface SessionProvider {
  /** Get messages with optional filtering */
  getMessages(options?: MessageQueryOptions): UIMessage[];

  /** Get a single message by ID */
  getMessage(id: string): UIMessage | null;

  /** Get the last N messages (most recent) */
  getLastMessages(n: number): UIMessage[];

  /** Append one or more messages to storage */
  appendMessages(messages: UIMessage | UIMessage[]): Promise<void>;

  /** Update an existing message */
  updateMessage(message: UIMessage): void;

  /** Delete messages by ID */
  deleteMessages(messageIds: string[]): void;

  /** Clear all messages */
  clearMessages(): void;

  /** Fetch messages outside the recent window (for microCompaction) */
  getOlderMessages(keepRecent: number): UIMessage[];

  /** Bulk replace all messages (used by compact) */
  replaceMessages(messages: UIMessage[]): Promise<void>;

  /**
   * Full-text search across messages.
   * Optional — providers that support FTS should implement this.
   */
  searchMessages?(query: string, limit?: number): SearchResult[];
}
