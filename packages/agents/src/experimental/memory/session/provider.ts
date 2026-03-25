/**
 * Session Provider Interface
 *
 * Pure storage for tree-structured messages with compaction overlays and search.
 * Methods return `T | Promise<T>` so both sync (DO SQLite) and async (PlanetScale, etc.) work.
 */

import type { UIMessage } from "ai";

export interface SearchResult {
  id: string;
  role: string;
  content: string;
  createdAt: string;
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

  getMessage(id: string): UIMessage | null | Promise<UIMessage | null>;

  /**
   * Get conversation as a path from root to leaf.
   * Applies compaction overlays. If leafId is null, uses the latest leaf.
   */
  getHistory(leafId?: string | null): UIMessage[] | Promise<UIMessage[]>;

  getLatestLeaf(): UIMessage | null | Promise<UIMessage | null>;

  getBranches(messageId: string): UIMessage[] | Promise<UIMessage[]>;

  getPathLength(leafId?: string | null): number | Promise<number>;

  // ── Write ──────────────────────────────────────────────────────

  /**
   * Append a message. Parented to the latest leaf unless parentId is provided.
   * Idempotent — same message.id twice is a no-op.
   */
  appendMessage(
    message: UIMessage,
    parentId?: string | null
  ): void | Promise<void>;

  updateMessage(message: UIMessage): void | Promise<void>;

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
