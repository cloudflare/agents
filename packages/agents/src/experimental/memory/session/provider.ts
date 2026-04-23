/**
 * Session Provider Interface
 *
 * Pure storage for tree-structured messages with compaction overlays and search.
 * Methods return `T | Promise<T>` so both sync (DO SQLite) and async (PlanetScale, etc.) work.
 */

import type { SessionMessage } from "./types";

export interface SearchResult {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
  sessionId?: string;
}

export interface StoredCompaction {
  id: string;
  summary: string;
  fromMessageId: string;
  toMessageId: string;
  createdAt: string;
}

/**
 * Session storage provider.
 * Messages are tree-structured via parentId for branching.
 */
export interface SessionProvider {
  // ── Read ────────────────────────────────────────────────────────

  getMessage(
    id: string
  ): SessionMessage | null | Promise<SessionMessage | null>;

  /**
   * Get conversation as a path from root to leaf.
   * Applies compaction overlays. If leafId is null, uses the latest leaf.
   */
  getHistory(
    leafId?: string | null
  ): SessionMessage[] | Promise<SessionMessage[]>;

  getLatestLeaf(): SessionMessage | null | Promise<SessionMessage | null>;

  getBranches(messageId: string): SessionMessage[] | Promise<SessionMessage[]>;

  getPathLength(leafId?: string | null): number | Promise<number>;

  // ── Write ──────────────────────────────────────────────────────

  /**
   * Append a message.
   *
   * `parentId` semantics:
   *   - `undefined` / omitted → auto-detect: attach to the current latest leaf.
   *   - `null`                → create a root message with no parent.
   *   - string                → attach to the given parent id (provider may
   *                            fall back to root if the parent doesn't
   *                            belong to this session).
   *
   * Idempotent — appending the same `message.id` twice is a no-op.
   */
  appendMessage(
    message: SessionMessage,
    parentId?: string | null
  ): void | Promise<void>;

  updateMessage(message: SessionMessage): void | Promise<void>;

  deleteMessages(messageIds: string[]): void | Promise<void>;

  clearMessages(): void | Promise<void>;

  // ── Compaction ─────────────────────────────────────────────────

  addCompaction(
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): StoredCompaction | Promise<StoredCompaction>;

  getCompactions(): StoredCompaction[] | Promise<StoredCompaction[]>;

  // ── Search ─────────────────────────────────────────────────────

  searchMessages?(
    query: string,
    limit?: number
  ): SearchResult[] | Promise<SearchResult[]>;
}
