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

/** Per-row info for the active branch path, root → leaf order. */
export interface HistoryRowStat {
  id: string;
  /** Stored message role (e.g. "user" / "assistant"). */
  role: string;
  /** Serialized content size of the stored row in bytes. */
  bytes: number;
}

/** Result of a byte-budgeted history read. */
export interface RecentHistoryResult {
  /**
   * The most recent messages on the active branch path whose summed stored
   * content size fits `maxContentBytes`, root → leaf order, with compaction
   * overlays applied within the window. The window always covers at least
   * the leaf row (and `minRecentMessages` rows when requested), but rows
   * whose stored content fails to parse are skipped — so a corrupt leaf can
   * yield fewer messages than the window covers.
   */
  messages: SessionMessage[];
  /** True when older messages were left out to satisfy the byte budget. */
  truncated: boolean;
  /** Summed stored content size of the FULL path, in bytes. */
  totalContentBytes: number;
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

  /**
   * Optional: byte-budgeted read of the most recent messages on the active
   * branch path. Lets hosts hydrate a bounded window instead of the full
   * transcript, so wake-time memory scales with the budget rather than total
   * session history (#1710). Providers that don't implement it fall back to
   * a full `getHistory()` read in `Session.getRecentHistory()`.
   *
   * `minRecentMessages` (default 1) is a floor on the window size: the most
   * recent N rows are always included even when they exceed the byte budget.
   * Hosts use this to guarantee the window never shrinks below the recent
   * span their model context assembly expects (rows are individually capped
   * at write time, so the floor keeps memory bounded).
   */
  getRecentHistory?(
    leafId: string | null | undefined,
    maxContentBytes: number,
    minRecentMessages?: number
  ): RecentHistoryResult | Promise<RecentHistoryResult>;

  /**
   * Optional: per-row stored sizes for the active branch path (root → leaf),
   * WITHOUT loading message content. Lets hosts find oversized rows (e.g.
   * inline base64 media) and process them one at a time with bounded memory.
   */
  getHistoryRowStats?(
    leafId?: string | null
  ): HistoryRowStat[] | Promise<HistoryRowStat[]>;

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
