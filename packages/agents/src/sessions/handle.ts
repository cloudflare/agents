/**
 * Per-session handle returned by `Sessions.session()`. Carries the
 * session-scoped configuration (compaction trigger and handlers) and
 * orchestrates every public write: sanitize → strip/guard client input →
 * offload attachments → cap the row → durable write → change feed.
 *
 * Method semantics deliberately mirror the legacy `Session` class so hosts
 * replatform with call-site renames, not logic changes.
 */

import type { UIMessage } from "ai";
import { enforceRowSizeLimit, sanitizeMessage } from "../chat/sanitize";
import {
  COMPACTION_PREFIX,
  type CompactResult
} from "../experimental/memory/utils/compaction-helpers";
import type { SessionsCore } from "./core";
import type {
  AppendOptions,
  AppendResult,
  CompactAfterOptions,
  CompactContext,
  CompactionErrorHandler,
  HistoryBatchReadOptions,
  HistoryReadOptions,
  RecentHistoryResult,
  SearchResult,
  SessionMessage,
  SessionRowStat,
  SessionStats,
  SessionTokenCounter,
  StoredCompaction
} from "./types";

export type CompactionFunction = (
  messages: SessionMessage[],
  context?: CompactContext
) => Promise<CompactResult | null>;

export class Session {
  readonly sessionId: string;
  readonly #core: SessionsCore;
  readonly #ready: () => Promise<void>;

  #compactionFn: CompactionFunction | null = null;
  #tokenThreshold: number | undefined;
  #tokenCounter: SessionTokenCounter | undefined;
  #compactionErrorHandler: CompactionErrorHandler | undefined;
  #warnedCompactionNoOp = false;

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

  // ── Builder (chainable, mirrors the legacy Session builder) ─────────────

  /**
   * Register a compaction function. Called by `compact()` to compress
   * message history into a summary overlay.
   */
  onCompaction(fn: CompactionFunction): this {
    this.#compactionFn = fn;
    return this;
  }

  /**
   * Auto-compact when the estimated token count exceeds the threshold,
   * checked after each `appendMessage`. Requires `onCompaction()`.
   *
   * The trigger is gated by the O(1) stamped-estimate stats — never a
   * full-history read. A configured `tokenCounter` is consulted to CONFIRM
   * a trigger after the gate crosses the threshold.
   */
  compactAfter(tokenThreshold: number, options?: CompactAfterOptions): this {
    this.#tokenThreshold = tokenThreshold;
    if (options?.tokenCounter) {
      this.#tokenCounter = options.tokenCounter;
    }
    return this;
  }

  /** Handle failures from the automatic `compactAfter()` trigger. */
  onCompactionError(handler: CompactionErrorHandler): this {
    this.#compactionErrorHandler = handler;
    return this;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /**
   * Stream the active branch path root → leaf with compaction overlays
   * applied. Peak memory is one bounded content chunk, never the whole
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
      const bytes = new TextEncoder().encode(
        JSON.stringify(message)
      ).byteLength;
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

  /** Materialized full-path read (reconciliation, `get-messages`). */
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
   * Byte-budgeted read of the most recent messages on the active branch
   * path (always at least the leaf message, and at least
   * `minRecentMessages` when the path is long enough). Wake-time memory
   * scales with the budget rather than total session history (#1710).
   */
  async getRecentHistory(
    maxContentBytes: number,
    minRecentMessages = 1,
    options: Pick<HistoryReadOptions, "reconstruct" | "leafId"> = {}
  ): Promise<RecentHistoryResult> {
    await this.#ready();
    return this.#core.getRecentHistory(
      this.sessionId,
      maxContentBytes,
      minRecentMessages,
      this.#core.attachments.resolveReconstructor(options.reconstruct),
      options.leafId
    );
  }

  /**
   * Per-row stored sizes and stamped token estimates for the active branch
   * path (root → leaf) WITHOUT loading message content.
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

  async getPathLength(leafId?: string | null): Promise<number> {
    await this.#ready();
    return this.#core.getPathLength(this.sessionId, leafId);
  }

  /** O(1)-maintained aggregate stats for the active branch path. */
  async stats(): Promise<SessionStats> {
    await this.#ready();
    return this.#core.stats(this.sessionId);
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
    const { inserted } = this.#core.append(
      this.sessionId,
      prepared.message,
      options.parentId,
      prepared.attachments
    );
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

  async updateMessage(message: SessionMessage): Promise<SessionMessage> {
    await this.#ready();
    const prepared = await this.#prepare(message, undefined);
    await this.#core.update(
      this.sessionId,
      prepared.message,
      prepared.attachments
    );
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
    const existing = this.#core.getMessageRaw(this.sessionId, message.id);
    if (existing) {
      const stored = await this.updateMessage(message);
      return { inserted: false, message: stored, attachments: [] };
    }
    return this.appendMessage(message, options);
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
    await this.#afterClear();
    await this.#core.notify({ type: "clear", sessionId: this.sessionId });
  }

  /**
   * Copy the path ending at `atMessageId` (default: the active leaf) into a
   * new session. Message rows get fresh ids; attachment blobs are shared,
   * never copied.
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
   * overlay. When `leafId` is provided, compact that root-to-leaf branch
   * instead of the active branch. Requires `onCompaction()`.
   *
   * The function receives pointer-mode history: attachment payloads are
   * never inlined into a summarization pass.
   */
  async compact(leafId?: string | null): Promise<CompactResult | null> {
    await this.#ready();
    if (!this.#compactionFn) {
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
      // Share the session's authoritative token counter so the compaction
      // function's boundary logic uses the same accounting as the
      // fire/no-fire decision.
      result = await this.#compactionFn(history, {
        tokenCounter: this.#tokenCounter
      });
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
    await this.#refreshPromptAfterCompaction();
    await this.#core.notify({ type: "compact", sessionId: this.sessionId });
    return { ...result, fromMessageId: fromId };
  }

  // ── Search ───────────────────────────────────────────────────────────────

  async search(
    query: string,
    options?: { limit?: number }
  ): Promise<SearchResult[]> {
    await this.#ready();
    return this.#core.search(this.sessionId, query, options?.limit ?? 20);
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /**
   * The shared write pipeline: sanitize provider metadata, strip reserved
   * metadata and guard pointers on client-source input, offload oversized
   * inline media (async, BEFORE the durable write so a stored pointer
   * always has bytes behind it), then cap the row.
   */
  async #prepare(
    message: SessionMessage,
    source: "client" | "server" | undefined
  ): Promise<{
    message: SessionMessage;
    attachments: AppendResult["attachments"];
  }> {
    // SAFETY: SessionMessage is structurally a UIMessage superset for the
    // fields sanitize/cap touch (parts, metadata).
    let prepared = sanitizeMessage(
      message as unknown as UIMessage
    ) as unknown as SessionMessage;
    if (source === "client") {
      prepared = this.#core.stripReservedMetadata(prepared);
      prepared = this.#core.attachments.guardClientPointers(
        this.sessionId,
        prepared
      );
    }
    const extraction = await this.#core.attachments.extract(prepared);
    const capped = enforceRowSizeLimit(
      extraction.message as unknown as UIMessage,
      {
        warn: (text) => console.warn(`[Sessions] ${text}`)
      }
    ) as unknown as SessionMessage;
    return { message: capped, attachments: extraction.attachments };
  }

  /** Gate → confirm → compact. Failures are non-fatal (message is stored). */
  async #maybeAutoCompact(): Promise<boolean> {
    const threshold = this.#tokenThreshold;
    const fn = this.#compactionFn;
    if (threshold == null || !fn) return false;

    const gateEstimate =
      this.#core.stats(this.sessionId).tokenEstimate +
      (await this.#extraTokenEstimate());
    if (gateEstimate <= threshold) return false;

    let estimate = gateEstimate;
    if (this.#tokenCounter) {
      try {
        const counted = await this.#tokenCounter({
          messages: await this.#core.getHistory(this.sessionId, {}, null),
          systemPrompt: await this.#systemPromptForEstimate(),
          contextBlocks: this.#contextBlocksForEstimate()
        });
        estimate = Number.isFinite(counted)
          ? Math.max(0, Math.ceil(counted))
          : 0;
      } catch (error) {
        await this.#handleAutoCompactionError(error);
        return false;
      }
      if (estimate <= threshold) return false;
    }

    try {
      const compacted = Boolean(await this.compact());
      if (!compacted && !this.#warnedCompactionNoOp) {
        // Over threshold but the compaction function returned null — history
        // was not shortened, so this fires again next turn. Surface it once
        // instead of looping silently.
        this.#warnedCompactionNoOp = true;
        console.warn(
          `[Sessions] Auto-compaction fired (~${estimate} tokens > ${threshold}) but the compaction function returned null, so history was not shortened. ` +
            (this.#tokenCounter
              ? "A tokenCounter is configured and flows to the boundary logic, but it is invoked per-message there — a whole-prompt/usage counter degrades the tail budget and can still no-op. Pass a per-message CompactOptions.tokenCounter for precise tail budgeting."
              : "If your history is tool-heavy, configure a tokenCounter on compactAfter() — it flows to createCompactFunction's boundary logic automatically.")
        );
      } else if (compacted) {
        this.#warnedCompactionNoOp = false;
      }
      return compacted;
    } catch (error) {
      await this.#handleAutoCompactionError(error);
      return false;
    }
  }

  async #handleAutoCompactionError(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    if (this.#compactionErrorHandler) {
      try {
        await this.#compactionErrorHandler(error);
      } catch (handlerError) {
        console.warn(
          `[Sessions] auto-compaction error handler failed: ${
            handlerError instanceof Error
              ? handlerError.message
              : String(handlerError)
          }`
        );
      }
    } else {
      console.warn(`[Sessions] auto-compaction failed: ${message}`);
    }
    this.#core.io.emit("session:error", {
      sessionId: this.sessionId,
      error: message
    });
  }

  // Context-system seams, overridden when the context module attaches
  // (system prompt and blocks feed the token counter's input).
  async #systemPromptForEstimate(): Promise<string> {
    return "";
  }

  #contextBlocksForEstimate(): unknown[] {
    return [];
  }

  async #extraTokenEstimate(): Promise<number> {
    return 0;
  }

  async #refreshPromptAfterCompaction(): Promise<void> {}

  async #afterClear(): Promise<void> {}
}
