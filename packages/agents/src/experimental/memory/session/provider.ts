/**
 * Session Provider Interface
 *
 * Pure storage for tree-structured messages with compaction overlays and search.
 */

import type { UIMessage } from "ai";

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

  getMessage(id: string): UIMessage | null;

  /**
   * Get conversation as a path from root to leaf.
   * Applies compaction overlays. If leafId is null, uses the latest leaf.
   */
  getHistory(leafId?: string | null): UIMessage[];

  getLatestLeaf(): UIMessage | null;

  getBranches(messageId: string): UIMessage[];

  getPathLength(leafId?: string | null): number;

  // ── Write ──────────────────────────────────────────────────────

  /**
   * Append a message. Parented to the latest leaf unless parentId is provided.
   * Idempotent — same message.id twice is a no-op.
   */
  appendMessage(message: UIMessage, parentId?: string | null): void;

  updateMessage(message: UIMessage): void;

  deleteMessages(messageIds: string[]): void;

  clearMessages(): void;

  // ── Compaction ─────────────────────────────────────────────────

  addCompaction(
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): StoredCompaction;

  getCompactions(): StoredCompaction[];

  // ── Search ─────────────────────────────────────────────────────

  searchMessages?(query: string, limit?: number): SearchResult[];
}
