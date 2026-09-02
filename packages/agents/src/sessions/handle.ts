/**
 * Per-session handle returned by `Sessions.session()`. Carries the
 * session-scoped compaction policy and orchestrates every public write:
 * sanitize → strip/guard client input → offload payloads → durable write →
 * change feed.
 *
 * The handle stores messages. Prompt assembly (context blocks, frozen
 * prompts, skills) lives in `agents/context` and composes with this handle
 * rather than living inside it.
 */

import type { CompactResult } from "./compaction-helpers";
import { COMPACTION_PREFIX } from "./compaction-helpers";
import { MAX_INLINE_ROW_BYTES } from "./attachments";
import type { SessionsCore } from "./core";
import { SessionMessageTooLargeError } from "./errors";
import { runMaintenancePass } from "./maintenance";
import { byteLength, sanitizeMessage } from "./sanitize";
import type {
  AppendOptions,
  AppendResult,
  HistoryBatchReadOptions,
  HistoryReadOptions,
  RecentHistoryResult,
  SearchResult,
  SessionMaintenanceResult,
  SessionMessage,
  SessionRowStat,
  SessionStats,
  StoredCompaction,
  WriteOptions
} from "./types";

/** Summarizes a branch into an overlay. Receives pointer-mode history. */
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

  #maintenanceRunning = false;
  #maintenanceScheduled = false;
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
    yield* this.#core.streamHistory(
      this.sessionId,
      options,
      this.#core.attachments.resolveReconstructor(options.reconstruct)
    );
  }

  /**
   * Stream history in bounded non-empty batches. Both message count and
   * reconstructed serialized bytes bound each batch; a single large message
   * is yielded by itself.
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
   * of the branch, with attachments inlined, in memory at once.
   */
  async getHistory(
    options: HistoryReadOptions = {}
  ): Promise<SessionMessage[]> {
    await this.#ready();
    return this.#core.getHistory(
      this.sessionId,
      options,
      this.#core.attachments.resolveReconstructor(options.reconstruct)
    );
  }

  /**
   * Byte-budgeted read of the most recent messages on the active branch path
   * (always at least the leaf, and at least `minRecentMessages` when the path
   * is long enough). When reconstructing, the budget counts the attachment
   * bytes each row inflates back, so it bounds hydrated memory (#1710).
   */
  async getRecentHistory(
    maxContentBytes: number,
    minRecentMessages = 1,
    options: Pick<HistoryReadOptions, "reconstruct" | "leafId"> = {}
  ): Promise<RecentHistoryResult> {
    await this.#ready();
    const result = await this.#core.getRecentHistory(
      this.sessionId,
      maxContentBytes,
      minRecentMessages,
      this.#core.attachments.resolveReconstructor(options.reconstruct),
      options.leafId
    );
    if (result.truncated) this.#scheduleMaintenance();
    return result;
  }

  /**
   * Per-row stored sizes, attachment sizes, and stamped token estimates for
   * the active branch path (root → leaf) WITHOUT loading message content.
   */
  async getHistoryRowStats(leafId?: string | null): Promise<SessionRowStat[]> {
    await this.#ready();
    return this.#core.pathRowStats(this.sessionId, leafId);
  }

  async getMessage(
    id: string,
    options: Pick<HistoryReadOptions, "reconstruct"> = {}
  ): Promise<SessionMessage | null> {
    await this.#ready();
    return this.#core.getMessage(
      this.sessionId,
      id,
      this.#core.attachments.resolveReconstructor(options.reconstruct)
    );
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
    const existing = this.#core.getMessageRaw(this.sessionId, message.id);
    if (existing) {
      await this.#core.notify({
        type: "append",
        sessionId: this.sessionId,
        message: existing,
        parentId: options.parentId,
        inserted: false
      });
      return { inserted: false, message: existing, attachments: [] };
    }

    const prepared = await this.#prepare(message, options.source);
    let inserted: boolean;
    try {
      ({ inserted } = this.#core.append(
        this.sessionId,
        prepared.message,
        options.parentId,
        prepared.tokenEstimate
      ));
    } catch (error) {
      await this.#core.attachments.discardUnreferenced(prepared.attachments);
      throw error;
    }
    if (!inserted) {
      await this.#core.attachments.discardUnreferenced(prepared.attachments);
      const stored =
        this.#core.getMessageRaw(this.sessionId, message.id) ??
        prepared.message;
      await this.#core.notify({
        type: "append",
        sessionId: this.sessionId,
        message: stored,
        parentId: options.parentId,
        inserted: false
      });
      return { inserted: false, message: stored, attachments: [] };
    }

    let compacted = false;
    if (this.#tokenThreshold != null && this.#compactionFn) {
      compacted = await this.#maybeAutoCompact();
    }
    if (!compacted) {
      await this.#core.notify({
        type: "append",
        sessionId: this.sessionId,
        message: prepared.message,
        parentId: options.parentId,
        inserted: true
      });
    }
    return {
      inserted: true,
      message: prepared.message,
      attachments: prepared.attachments
    };
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
    const prepared = await this.#prepare(message, options.source);
    let outcome: Awaited<ReturnType<SessionsCore["update"]>>;
    try {
      outcome = await this.#core.update(
        this.sessionId,
        prepared.message,
        prepared.tokenEstimate
      );
    } catch (error) {
      await this.#core.attachments.discardUnreferenced(prepared.attachments);
      throw error;
    }
    if (outcome !== "updated") {
      await this.#core.attachments.discardUnreferenced(prepared.attachments);
      if (outcome === "missing") return null;
      return prepared.message;
    }
    await this.#core.notify({
      type: "update",
      sessionId: this.sessionId,
      message: prepared.message
    });
    return prepared.message;
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
    return {
      inserted: false,
      message: stored ?? message,
      attachments: []
    };
  }

  /**
   * Import one historical message verbatim (migrations, cross-object moves):
   * explicit parent and timestamp, no offload, no change-feed event.
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
   * new session. Message rows get fresh ids; attachment blobs are shared,
   * never copied. Compaction overlays are not copied.
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

  /**
   * Move inline payloads of aged rows into attachment storage — legacy rows,
   * rows written under a looser policy, and large tool outputs. Recent rows
   * are untouched. Bounded per pass; reschedules itself while a backlog
   * remains.
   */
  async runMaintenance(): Promise<SessionMaintenanceResult | null> {
    await this.#ready();
    return this.#runMaintenance();
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
   * The function receives pointer-mode history: attachment payloads are never
   * inlined into a summarization pass.
   */
  async compact(leafId?: string | null): Promise<CompactResult | null> {
    await this.#ready();
    const fn = this.#compactionFn;
    if (!fn) {
      throw new Error(
        "No compaction function registered. Call onCompaction() first."
      );
    }
    const history = await this.#core.getHistory(
      this.sessionId,
      { leafId },
      null
    );

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
   * The shared write pipeline: sanitize provider metadata, strip reserved
   * metadata and guard pointers on client-source input, then move payloads
   * out of the row (async, BEFORE the durable write, so a stored pointer
   * always has bytes behind it). Content is never truncated: a row that
   * cannot fit its budget after offload is rejected.
   */
  async #prepare(
    message: SessionMessage,
    source: "client" | "server" | undefined
  ): Promise<{
    message: SessionMessage;
    attachments: AppendResult["attachments"];
    tokenEstimate: number;
  }> {
    let prepared = sanitizeMessage(message);
    if (source === "client") {
      prepared = this.#core.stripReservedMetadata(prepared);
      prepared = await this.#core.attachments.guardClientPointers(prepared);
    }
    const offloaded = await this.#core.attachments.offload(prepared, {
      rowBudgetBytes: MAX_INLINE_ROW_BYTES
    });
    if (
      offloaded.rowBytes !== undefined &&
      offloaded.rowBytes > MAX_INLINE_ROW_BYTES
    ) {
      await this.#core.attachments.discardUnreferenced(offloaded.attachments);
      throw new SessionMessageTooLargeError(
        message.id,
        offloaded.rowBytes,
        MAX_INLINE_ROW_BYTES
      );
    }
    return {
      message: offloaded.message,
      attachments: offloaded.attachments,
      tokenEstimate: this.#core.estimateRowTokens(offloaded.message)
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

  #scheduleMaintenance(): void {
    if (
      this.#maintenanceScheduled ||
      this.#maintenanceRunning ||
      !this.#core.attachments.options.maintenance
    ) {
      return;
    }
    this.#maintenanceScheduled = true;
    setTimeout(() => {
      this.#maintenanceScheduled = false;
      void this.#runMaintenance();
    }, 0);
  }

  async #runMaintenance(): Promise<SessionMaintenanceResult | null> {
    if (
      this.#maintenanceRunning ||
      !this.#core.attachments.options.maintenance
    ) {
      return null;
    }
    this.#maintenanceRunning = true;
    let result: SessionMaintenanceResult | null = null;
    try {
      result = await runMaintenancePass(this.#core, this.sessionId);
    } catch (error) {
      this.#core.io.emit("session:maintenance:failed", {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.#maintenanceRunning = false;
    }
    // Chain the next pass only after clearing the running flag, which
    // `#scheduleMaintenance` treats as "already covered".
    if (result?.backlogRemains) this.#scheduleMaintenance();
    return result;
  }
}
