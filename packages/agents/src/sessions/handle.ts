/**
 * Per-session handle returned by `Sessions.session()`. Carries the
 * session-scoped compaction policy and orchestrates every public write:
 * sanitize → strip reserved client metadata → durable write → change feed.
 *
 * The handle stores messages. Prompt assembly (context blocks, frozen
 * prompts, skills) lives in `agents/context` and composes with this handle
 * rather than living inside it.
 */

import type { CompactResult } from "./compaction-helpers";
import { COMPACTION_PREFIX } from "./compaction-helpers";
import type { SessionsCore } from "./core";
import { byteLength, sanitizeMessage } from "./sanitize";
import type {
  AppendOptions,
  AppendResult,
  HistoryBatchReadOptions,
  HistoryReadOptions,
  RecentHistoryResult,
  SearchResult,
  SessionMessage,
  SessionRowStat,
  StoredCompaction,
  WriteOptions
} from "./types";

/** Summarizes a branch into an overlay. */
export type CompactionFunction = (
  messages: SessionMessage[]
) => Promise<CompactResult | null>;

export class Session {
  readonly sessionId: string;
  readonly #core: SessionsCore;
  readonly #ready: () => Promise<void>;

  #compactionFn: CompactionFunction | null = null;
  #tokenThreshold: number | undefined;

  /** @internal Constructed by the Sessions capability only. */
  constructor(
    sessionId: string,
    core: SessionsCore,
    ready: () => Promise<void>
  ) {
    this.sessionId = sessionId;
    this.#core = core;
    this.#ready = ready;
  }

  // ── Builder ──────────────────────────────────────────────────────────────

  /** Register the function `compact()` calls to summarize a branch. */
  onCompaction(fn: CompactionFunction): this {
    this.#compactionFn = fn;
    return this;
  }

  /**
   * Auto-compact after an append once the estimated token count crosses the
   * threshold. Requires `onCompaction()`. The estimate is derived from the
   * stamped per-row estimates, never from the transcript.
   */
  compactAfter(tokenThreshold: number): this {
    this.#tokenThreshold = tokenThreshold;
    return this;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /**
   * Stream the active branch path root → leaf with compaction overlays
   * applied. Peak memory is one bounded content window, never the whole
   * transcript.
   */
  async *history(
    options: HistoryReadOptions = {}
  ): AsyncGenerator<SessionMessage, void, undefined> {
    await this.#ready();
    yield* this.#core.streamHistory(this.sessionId, options);
  }

  /**
   * Stream history in bounded non-empty batches. Both message count and
   * serialized bytes bound each batch; a single large message is yielded by
   * itself.
   */
  async *historyBatches(
    options: HistoryBatchReadOptions = {}
  ): AsyncGenerator<SessionMessage[], void, undefined> {
    const batchSize = Math.max(1, Math.floor(options.batchSize ?? 50));
    const maxBatchBytes = Math.max(
      1,
      Math.floor(options.maxBatchBytes ?? 4 * 1024 * 1024)
    );
    let batch: SessionMessage[] = [];
    let batchBytes = 0;

    for await (const message of this.history(options)) {
      const bytes = byteLength(JSON.stringify(message));
      if (
        batch.length > 0 &&
        (batch.length >= batchSize || batchBytes + bytes > maxBatchBytes)
      ) {
        yield batch;
        batch = [];
        batchBytes = 0;
      }
      batch.push(message);
      batchBytes += bytes;
      if (batch.length >= batchSize || batchBytes >= maxBatchBytes) {
        yield batch;
        batch = [];
        batchBytes = 0;
      }
    }
    if (batch.length > 0) yield batch;
  }

  /**
   * Materialize the whole selected path. Prefer `history()` or
   * `getRecentHistory()` inside a Durable Object: this holds every message
   * of the branch in memory at once.
   */
  async getHistory(
    options: HistoryReadOptions = {}
  ): Promise<SessionMessage[]> {
    await this.#ready();
    return this.#core.getHistory(this.sessionId, options);
  }

  /**
   * Byte-budgeted read of the most recent messages on the active branch path
   * (always at least the leaf). The budget counts each row, its continuation
   * rows, and the payloads it points at, so it bounds hydrated memory (#1710).
   */
  async getRecentHistory(
    maxContentBytes: number,
    options: Pick<HistoryReadOptions, "leafId"> = {}
  ): Promise<RecentHistoryResult> {
    await this.#ready();
    return this.#core.getRecentHistory(
      this.sessionId,
      maxContentBytes,
      options.leafId
    );
  }

  /**
   * Per-row stored sizes (row plus continuation rows and attachments) and
   * stamped token estimates for the active branch path (root → leaf)
   * WITHOUT loading message content.
   */
  async getHistoryRowStats(leafId?: string | null): Promise<SessionRowStat[]> {
    await this.#ready();
    return this.#core.pathRowStats(this.sessionId, leafId);
  }

  async getMessage(id: string): Promise<SessionMessage | null> {
    await this.#ready();
    return this.#core.getMessage(this.sessionId, id);
  }

  async getLatestLeaf(): Promise<SessionMessage | null> {
    await this.#ready();
    return this.#core.getLatestLeaf(this.sessionId);
  }

  async getBranches(messageId: string): Promise<SessionMessage[]> {
    await this.#ready();
    return this.#core.getBranches(this.sessionId, messageId);
  }

  /**
   * Full-text search over this session's text parts. The index is built on
   * the first call and maintained from then on.
   */
  async search(
    query: string,
    options?: { limit?: number }
  ): Promise<SearchResult[]> {
    await this.#ready();
    return this.#core.search(this.sessionId, query, options?.limit ?? 20);
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  /**
   * Append one message. Idempotent on id: a repeated append returns the row
   * already stored and dispatches an `append` event with `inserted: false`.
   */
  async appendMessage(
    message: SessionMessage,
    options: AppendOptions = {}
  ): Promise<AppendResult> {
    await this.#ready();
    const prepared = this.#prepare(message, options.source);
    const result = this.#core.append(
      this.sessionId,
      prepared.message,
      options.parentId,
      prepared.tokenEstimate
    );
    await this.#core.notify({
      type: "append",
      sessionId: this.sessionId,
      message: result.message,
      parentId: options.parentId,
      inserted: result.inserted
    });
    if (result.inserted) await this.#maybeAutoCompact();
    return result;
  }

  /**
   * Update one stored row. Returns the stored form, or `null` when the id is
   * not in this session. An unchanged message writes nothing and dispatches
   * no event.
   */
  async updateMessage(
    message: SessionMessage,
    options: WriteOptions = {}
  ): Promise<SessionMessage | null> {
    await this.#ready();
    const prepared = this.#prepare(message, options.source);
    const outcome = this.#core.update(
      this.sessionId,
      prepared.message,
      prepared.tokenEstimate
    );
    if (outcome === "missing") return null;
    if (outcome === "updated") {
      await this.#core.notify({
        type: "update",
        sessionId: this.sessionId,
        message: prepared.message
      });
    }
    return prepared.message;
  }

  async upsertMessage(
    message: SessionMessage,
    options: AppendOptions = {}
  ): Promise<AppendResult> {
    await this.#ready();
    if (!this.#core.exists(this.sessionId, message.id)) {
      return this.appendMessage(message, options);
    }
    const stored = await this.updateMessage(message, {
      source: options.source
    });
    return { inserted: false, message: stored ?? message };
  }

  /**
   * Import one historical message verbatim (migrations, cross-object moves):
   * explicit parent and timestamp, no change-feed event.
   */
  async importMessage(
    message: SessionMessage,
    options: { parentId: string | null; createdAt: number }
  ): Promise<void> {
    await this.#ready();
    this.#core.importMessage(this.sessionId, message, options);
  }

  async deleteMessages(messageIds: string[]): Promise<void> {
    await this.#ready();
    this.#core.deleteMessages(this.sessionId, messageIds);
    await this.#core.notify({
      type: "delete",
      sessionId: this.sessionId,
      messageIds
    });
  }

  async clearMessages(): Promise<void> {
    await this.#ready();
    this.#core.clearMessages(this.sessionId);
    await this.#core.notify({ type: "clear", sessionId: this.sessionId });
  }

  // ── Compaction ───────────────────────────────────────────────────────────

  async addCompaction(
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): Promise<StoredCompaction> {
    await this.#ready();
    return this.#core.addCompaction(
      this.sessionId,
      summary,
      fromMessageId,
      toMessageId
    );
  }

  async getCompactions(): Promise<StoredCompaction[]> {
    await this.#ready();
    return this.#core.getCompactions(this.sessionId);
  }

  /**
   * Run the registered compaction function and store the result as an
   * overlay. When `leafId` is given, compact that root-to-leaf branch instead
   * of the active branch. Requires `onCompaction()`. A compaction function
   * that throws is reported through the `session:error` capability event and
   * the call returns `null`.
   */
  async compact(leafId?: string | null): Promise<CompactResult | null> {
    await this.#ready();
    const fn = this.#compactionFn;
    if (!fn) {
      throw new Error(
        "No compaction function registered. Call onCompaction() first."
      );
    }
    const history = await this.#core.getHistory(this.sessionId, { leafId });

    let result: CompactResult | null;
    try {
      result = await fn(history);
    } catch (error) {
      this.#core.io.emit("session:error", {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
    if (!result) return null;

    const historyIds = new Set(history.map((message) => message.id));
    if (!historyIds.has(result.toMessageId)) return null;

    // Iterative compaction extends only an overlay visible on this branch.
    const existing = this.#core
      .getCompactions(this.sessionId)
      .filter(
        (compaction) =>
          historyIds.has(`${COMPACTION_PREFIX}${compaction.id}`) ||
          (historyIds.has(compaction.fromMessageId) &&
            historyIds.has(compaction.toMessageId))
      );
    const fromId =
      existing.length > 0 ? existing[0].fromMessageId : result.fromMessageId;

    this.#core.addCompaction(
      this.sessionId,
      result.summary,
      fromId,
      result.toMessageId
    );
    await this.#core.notify({ type: "compact", sessionId: this.sessionId });
    return { ...result, fromMessageId: fromId };
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /**
   * The shared write pipeline: sanitize provider metadata and strip reserved
   * metadata on client-source input. Content is never truncated and never
   * too large: a message that exceeds the row budget is split across
   * continuation rows by the durable write.
   */
  #prepare(
    message: SessionMessage,
    source: "client" | "server" | undefined
  ): { message: SessionMessage; tokenEstimate: number } {
    let prepared = sanitizeMessage(message);
    if (source === "client") {
      prepared = this.#core.stripReservedMetadata(prepared);
    }
    return {
      message: prepared,
      tokenEstimate: this.#core.estimateRowTokens(prepared)
    };
  }

  /** Gate on the derived estimate, then compact. Failures are non-fatal. */
  async #maybeAutoCompact(): Promise<void> {
    const threshold = this.#tokenThreshold;
    if (threshold == null || !this.#compactionFn) return;
    if (this.#core.tokenEstimate(this.sessionId) <= threshold) return;
    try {
      await this.compact();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[Sessions] auto-compaction failed: ${detail}`);
      this.#core.io.emit("session:error", {
        sessionId: this.sessionId,
        error: detail
      });
    }
  }
}
