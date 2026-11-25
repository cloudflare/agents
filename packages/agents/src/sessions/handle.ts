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
import {
  COMPACTION_PREFIX,
  OLDEST_PART,
  isCompactionMessage
} from "./compaction-helpers";
import { COMPACT_INPUT_BYTES, type SessionsCore } from "./core";
import { mirrorSessionChanges, type SessionMirrorOptions } from "./mirror";
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

  // ── Change feed ──────────────────────────────────────────────────────────

  /**
   * Keep an in-memory transcript in step with this session's change feed,
   * so write sites never hand-patch it. Returns the unsubscribe function.
   */
  mirror<M extends { id: string }>(
    options: SessionMirrorOptions<M>
  ): () => void {
    return mirrorSessionChanges(
      (listener) => this.#core.subscribe(listener),
      this.sessionId,
      options
    );
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /**
   * Stream the active branch path root → leaf (leaf → root with
   * `newestFirst`) with compaction overlays applied. Peak memory is one
   * bounded content window, never the whole transcript, and a consumer that
   * breaks out early leaves the rows it never reached unread.
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

  /**
   * @internal Sibling-package support, not a public API. A page of the
   * stored path from the newest row back: depths `skip` to
   * `skip + limit - 1`, rows under an overlay included; with `after`, counted
   * from that row's parent, to continue from a previous page. With
   * `measure`, each row carries its hydrated size.
   */
  async internal_storedPathRows(options: {
    skip: number;
    limit: number;
    measure?: boolean;
    after?: string;
  }): Promise<Array<{ id: string; bytes: number }>> {
    await this.#ready();
    return this.#core.storedPathRows(this.sessionId, options);
  }

  /**
   * @internal Sibling-package support, not a public API. Which of `ids`
   * this session holds: stored rows, and the summaries its overlays show
   * (`compaction_<id>`). Key probes, no content read.
   */
  async internal_existingIds(ids: readonly string[]): Promise<Set<string>> {
    await this.#ready();
    return this.#core.existingIds(this.sessionId, ids);
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
   *
   * A compaction overlay (a `compaction_` id) is derived on read and is never
   * stored. Clients post their transcript back after every compaction, so
   * this and every other write drops one silently: nothing is written and no
   * event is dispatched.
   */
  async appendMessage(
    message: SessionMessage,
    options: AppendOptions = {}
  ): Promise<AppendResult> {
    await this.#ready();
    if (isCompactionMessage(message)) return { inserted: false, message };
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
   * no event. A compaction overlay is never a stored row, so it reports
   * `null`.
   */
  async updateMessage(
    message: SessionMessage,
    options: WriteOptions = {}
  ): Promise<SessionMessage | null> {
    await this.#ready();
    if (isCompactionMessage(message)) return null;
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

  /**
   * @internal Synchronous write aperture for same-isolate first-party
   * machinery that must commit a message inside a caller-owned SQLite
   * transaction — the stream cutover, where the finished message and the
   * discard of its stream rows land together. Bypasses readiness (the
   * caller owns startup ordering) and defers everything that follows a
   * write — the change-feed dispatch and auto-compaction: call the returned
   * `after()` once the transaction commits, or subscribers (the host's
   * message mirror) never hear about the write. If the transaction rolls
   * back after an `upsert` ran inside it, call `abandon()`: the write is
   * gone but the in-memory tail and token-total caches already moved.
   * Will break without notice; never use from application code.
   */
  __DO_NOT_USE_WILL_BREAK__sync(): {
    upsert(
      message: SessionMessage,
      options?: AppendOptions
    ): { result: AppendResult; after: () => Promise<void> };
    abandon(): void;
  } {
    return {
      abandon: () => this.#core.forgetCaches(this.sessionId),
      upsert: (message, options = {}) => {
        if (isCompactionMessage(message)) {
          return {
            result: { inserted: false, message },
            after: () => Promise.resolve()
          };
        }
        const prepared = this.#prepare(message, options.source);
        if (!this.#core.exists(this.sessionId, message.id)) {
          const result = this.#core.append(
            this.sessionId,
            prepared.message,
            options.parentId,
            prepared.tokenEstimate
          );
          return {
            result,
            after: async () => {
              await this.#core.notify({
                type: "append",
                sessionId: this.sessionId,
                message: result.message,
                parentId: options.parentId,
                inserted: result.inserted
              });
              if (result.inserted) await this.#maybeAutoCompact();
            }
          };
        }
        const outcome = this.#core.update(
          this.sessionId,
          prepared.message,
          prepared.tokenEstimate
        );
        return {
          result: { inserted: false, message: prepared.message },
          after: () =>
            outcome === "updated"
              ? this.#core.notify({
                  type: "update",
                  sessionId: this.sessionId,
                  message: prepared.message
                })
              : Promise.resolve()
        };
      }
    };
  }

  async upsertMessage(
    message: SessionMessage,
    options: AppendOptions = {}
  ): Promise<AppendResult> {
    await this.#ready();
    if (isCompactionMessage(message)) return { inserted: false, message };
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
   * explicit parent and timestamp. A row actually written dispatches an
   * `import` change event so a host cache can mark itself stale; it is not
   * an `append`, so a cache does not patch itself per imported row, and an
   * id that already exists writes nothing and dispatches nothing.
   *
   * Unlike the other writes, a `compaction_` id is imported as given: a
   * summary copied from another session's `history()` is the only record of
   * the context it replaced, and later rows may be parented to it. History
   * reads hide such a row only when it duplicates one of this session's own
   * compaction overlays.
   */
  async importMessage(
    message: SessionMessage,
    options: { parentId: string | null; createdAt: number }
  ): Promise<void> {
    await this.#ready();
    const inserted = this.#core.importMessage(this.sessionId, message, options);
    if (!inserted) return;
    await this.#core.notify({
      type: "import",
      sessionId: this.sessionId,
      message,
      parentId: options.parentId
    });
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

  /**
   * Store an overlay directly. Dispatches a `compaction` change event: the
   * rows are untouched, but what a path read returns has changed.
   */
  async addCompaction(
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): Promise<StoredCompaction> {
    await this.#ready();
    const compaction = this.#core.addCompaction(
      this.sessionId,
      summary,
      fromMessageId,
      toMessageId
    );
    await this.#core.notify({
      type: "compaction",
      sessionId: this.sessionId,
      compaction
    });
    return compaction;
  }

  async getCompactions(): Promise<StoredCompaction[]> {
    await this.#ready();
    return this.#core.getCompactions(this.sessionId);
  }

  // ── Annotations and config (internal) ────────────────────────────────────

  /**
   * @internal Sibling-package support, not a public API. Server-side data a
   * first-party module keeps about messages of this session, by kind. Never
   * part of a message and never sent to a client; deleted with its message
   * and on clear; an overlay carries the newest annotation of each kind
   * from the rows it hides, and keeps it after those rows are deleted (its
   * summary was written with them). Returns only the ids that have one.
   */
  async internal_annotations(
    kind: string,
    messageIds: readonly string[]
  ): Promise<Map<string, string>> {
    await this.#ready();
    return this.#core.annotations(this.sessionId, kind, messageIds);
  }

  /** @internal Store one annotation (see {@link internal_annotations}). */
  async internal_setAnnotation(
    kind: string,
    messageId: string,
    value: string
  ): Promise<void> {
    await this.#ready();
    this.#core.setAnnotation(this.sessionId, kind, messageId, value);
  }

  /**
   * @internal The newest annotation of `kind` among the messages
   * `getHistory({ leafId })` returns, overlay messages included.
   */
  async internal_latestAnnotation(
    kind: string,
    leafId?: string | null
  ): Promise<{ messageId: string; value: string } | null> {
    await this.#ready();
    return this.#core.latestAnnotation(this.sessionId, kind, leafId);
  }

  /**
   * @internal Sibling-package support, not a public API. The table Context
   * keeps its blocks in for this Sessions instance: today's block table for
   * the default, with the instance's suffix for a named one.
   */
  get internal_contextBlocksTable(): string {
    return this.#core.tables.contextBlocks;
  }

  /**
   * @internal A value a first-party module keeps for this session. Keys
   * starting with `transcript:` are deleted by `clearMessages()`; any other
   * key outlives a clear.
   */
  async internal_config(key: string): Promise<string | null> {
    await this.#ready();
    return this.#core.config(this.sessionId, key);
  }

  /** @internal Set, or delete with `null`, a value kept for this session. */
  async internal_setConfig(key: string, value: string | null): Promise<void> {
    await this.#ready();
    this.#core.setConfig(this.sessionId, key, value);
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
    // The oldest visible part that fits one round's budget: a long
    // uncompacted path compacts in rounds instead of failing to load.
    const {
      messages: history,
      omitted,
      omittedTokens
    } = await this.#core.oldestVisible(
      this.sessionId,
      COMPACT_INPUT_BYTES,
      leafId
    );
    // `createCompactFunction` then protects no recent tail inside the part:
    // the recent messages are past it, and protecting some here could
    // leave a round with nothing to summarize, round after round.
    if (omitted > 0) {
      Object.defineProperty(history, OLDEST_PART, {
        value: { messages: omitted, tokens: omittedTokens }
      });
    }

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

    // Iterative compaction extends the overlay this branch shows, keeping
    // its start and the head below it.
    const visible = history.find((message) => isCompactionMessage(message));
    // A range ending at a summary message re-summarizes that overlay: the
    // new one ends where it ends and supersedes it.
    let toMessageId = result.toMessageId;
    if (toMessageId.startsWith(COMPACTION_PREFIX)) {
      const ended = this.#core
        .getCompactions(this.sessionId)
        .find((c) => `${COMPACTION_PREFIX}${c.id}` === toMessageId);
      if (!ended) return null;
      toMessageId = ended.toMessageId;
    }
    const stored = this.#core.addCompaction(
      this.sessionId,
      result.summary,
      result.fromMessageId,
      toMessageId,
      visible?.id.slice(COMPACTION_PREFIX.length)
    );
    const fromId = stored.fromMessageId;
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
