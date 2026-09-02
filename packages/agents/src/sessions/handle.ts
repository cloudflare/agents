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
  SessionStats,
  StoredCompaction,
  WriteOptions
} from "./types";

/** Summarizes a branch into an overlay. */
export type CompactionFunction = (
  messages: SessionMessage[]
) => Promise<CompactResult | null>;

export class Session {
  readonly sessionId: string;
  readonly #coreProvider: () => SessionsCore;
  readonly #ready: () => Promise<void>;

  get #core(): SessionsCore {
    return this.#coreProvider();
  }

  #compactionFn: CompactionFunction | null = null;
  #tokenThreshold: number | undefined;

  /** @internal Constructed by the Sessions capability only. */
  constructor(
    sessionId: string,
    core: () => SessionsCore,
    ready: () => Promise<void>
  ) {
    this.sessionId = sessionId;
    this.#coreProvider = core;
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
   * threshold. Requires `onCompaction()`. The trigger reads the O(1) stamped
   * estimate, never the transcript.
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
   * Per-row stored sizes (row plus continuation rows) and stamped token
   * estimates for the active branch path (root → leaf) WITHOUT loading
   * message content.
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

  /** O(1)-maintained aggregate stats for the active branch path. */
  async stats(): Promise<SessionStats> {
    await this.#ready();
    return this.#core.stats(this.sessionId);
  }

  async search(
    query: string,
    options?: { limit?: number }
  ): Promise<SearchResult[]> {
    await this.#ready();
    return this.#core.search(this.sessionId, query, options?.limit ?? 20);
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  async appendMessage(
    message: SessionMessage,
    options: AppendOptions = {}
  ): Promise<AppendResult> {
    await this.#ready();
    // Inlined, not raw: what a caller and the change feed receive must be the
    // same shape whether the append inserted or found a duplicate. Handing
    // back pointer form here is what forced hosts to sniff for
    // `attachment:sha256:` and re-read.
    const existing = this.#core.getMessage(this.sessionId, message.id);
    if (existing) {
      await this.#core.notify({
        type: "append",
        sessionId: this.sessionId,
        message: existing,
        parentId: options.parentId,
        inserted: false
      });
      return { inserted: false, message: existing };
    }

    const prepared = this.#prepare(message, options.source);
    const { inserted } = this.#core.append(
      this.sessionId,
      prepared.message,
      options.parentId,
      prepared.tokenEstimate
    );
    if (!inserted) {
      const stored =
        this.#core.getMessage(this.sessionId, message.id) ?? prepared.message;
      await this.#core.notify({
        type: "append",
        sessionId: this.sessionId,
        message: stored,
        parentId: options.parentId,
        inserted: false
      });
      return { inserted: false, message: stored };
    }

    // Everything Sessions hands back is inlined, whatever the caller passed.
    // A caller that read with `attachments: "pointer"` and wrote the result
    // back would otherwise put pointer form into the change feed and into its
    // own cache, and the same append would return one shape when it inserted
    // and another when it found a duplicate. No-op by reference for the
    // ordinary inline write.
    const emitted = this.#core.inlineMessage(prepared.message);

    let compacted = false;
    if (this.#tokenThreshold != null && this.#compactionFn) {
      compacted = await this.#maybeAutoCompact();
    }
    if (!compacted) {
      await this.#core.notify({
        type: "append",
        sessionId: this.sessionId,
        message: emitted,
        parentId: options.parentId,
        inserted: true
      });
    }
    return { inserted: true, message: emitted };
  }

  /** Append a chain of messages; returns the last appended id. */
  async appendMany(
    messages: SessionMessage[],
    options: AppendOptions = {}
  ): Promise<string | null> {
    let parentId = options.parentId;
    let lastId: string | null = null;
    for (const message of messages) {
      await this.appendMessage(message, { ...options, parentId });
      parentId = message.id;
      lastId = message.id;
    }
    return lastId;
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
    const outcome = await this.#core.update(
      this.sessionId,
      prepared.message,
      prepared.tokenEstimate
    );
    const emitted = this.#core.inlineMessage(prepared.message);
    if (outcome !== "updated") {
      if (outcome === "missing") return null;
      return emitted;
    }
    await this.#core.notify({
      type: "update",
      sessionId: this.sessionId,
      message: emitted
    });
    return emitted;
  }

  async upsertMessage(
    message: SessionMessage,
    options: AppendOptions = {}
  ): Promise<AppendResult> {
    await this.#ready();
    if (!this.#core.getMessageRaw(this.sessionId, message.id)) {
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
    await this.#core.deleteMessages(this.sessionId, messageIds);
    await this.#core.notify({
      type: "delete",
      sessionId: this.sessionId,
      messageIds
    });
  }

  async clearMessages(): Promise<void> {
    await this.#ready();
    await this.#core.clearMessages(this.sessionId);
    await this.#core.notify({ type: "clear", sessionId: this.sessionId });
  }

  /**
   * Copy the path ending at `atMessageId` (default: the active leaf) into a
   * new session. Message rows get fresh ids, continuation rows and all.
   * Compaction overlays are not copied.
   */
  async fork(
    options: { atMessageId?: string; toSessionId?: string } = {}
  ): Promise<{ sessionId: string; leafId: string | null }> {
    await this.#ready();
    return this.#core.fork(
      this.sessionId,
      options.toSessionId ?? crypto.randomUUID(),
      options.atMessageId
    );
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
   * of the active branch. Requires `onCompaction()`.
   *
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
    const existing = (await this.getCompactions()).filter(
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

  /** Gate on the stamped estimate, then compact. Failures are non-fatal. */
  async #maybeAutoCompact(): Promise<boolean> {
    const threshold = this.#tokenThreshold;
    if (threshold == null || !this.#compactionFn) return false;
    if (this.#core.stats(this.sessionId).tokenEstimate <= threshold) {
      return false;
    }
    try {
      return Boolean(await this.compact());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[Sessions] auto-compaction failed: ${detail}`);
      this.#core.io.emit("session:error", {
        sessionId: this.sessionId,
        error: detail
      });
      return false;
    }
  }
}
