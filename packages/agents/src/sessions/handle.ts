/**
 * Per-session handle returned by `Sessions.session()`. Carries the
 * session-scoped compaction policy and orchestrates every public write:
 * sanitize → strip reserved client metadata → durable write → change feed.
 *
 * The handle also carries the session's prompt context: labelled blocks
 * declared with `withContext()`, rendered into a frozen system prompt that
 * is stored next to the messages. The frozen prompt and compaction overlays
 * exist for the same reason, a stable cached prefix, so the session refreshes
 * the prompt itself when it compacts or clears.
 */

import type { ToolSet } from "ai";
import {
  ContextBlocks,
  type ContextBlock,
  type ContextConfig,
  type WritableContextProvider
} from "../context/blocks";
import { AgentSearchProvider } from "../context/search";
import {
  AgentContextProvider,
  type SqlProvider
} from "../context/sqlite-provider";
import type { CompactResult } from "./compaction-helpers";
import { COMPACTION_PREFIX, isCompactionMessage } from "./compaction-helpers";
import type { SessionsCore } from "./core";
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

/** Options for a block declared with `withContext()` or `addContext()`. */
export type SessionContextOptions = Omit<ContextConfig, "label"> & {
  /**
   * Back the block with a full-text index in this object's SQLite. The
   * prompt shows an entry count; the model reads entries with
   * `search_context` and writes them with `set_context`. Cannot be combined
   * with `provider`.
   */
  searchable?: boolean;
};

export class Session {
  readonly sessionId: string;
  readonly #core: SessionsCore;
  readonly #ready: () => Promise<void>;

  #compactionFn: CompactionFunction | null = null;
  #tokenThreshold: number | undefined;

  /** Blocks declared with `withContext()`, by label, as declared. */
  readonly #declaredContext = new Map<string, SessionContextOptions>();
  #promptStore: WritableContextProvider | undefined;
  /** Built on first use; declarations are closed from then on. */
  #context: ContextBlocks | undefined;

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

  /**
   * Declare a prompt context block. The block renders as a section of the
   * system prompt; its provider decides whether the model can write or
   * search it. A block without a provider is stored in this object's SQLite
   * and is writable.
   *
   * Declare blocks before the context is first used (a field initializer is
   * the usual place). Redeclaring a label with the same options does
   * nothing; with different options it throws. After first use, add blocks
   * with `addContext()`.
   */
  withContext(label: string, options: SessionContextOptions = {}): this {
    const existing = this.#declaredContext.get(label);
    if (existing) {
      if (sameContextOptions(existing, options)) return this;
      throw new Error(
        `Context block "${label}" is already declared on this session with different options`
      );
    }
    if (this.#context) {
      throw new Error(
        `withContext("${label}") must run before the context is first used. Use addContext() to add a block afterwards.`
      );
    }
    this.#declaredContext.set(label, options);
    return this;
  }

  /**
   * Store the frozen system prompt in `store` instead of this object's
   * SQLite. The prompt is always stored; this only changes where.
   */
  withCachedPrompt(store?: WritableContextProvider): this {
    if (!store) return this;
    if (this.#context) {
      throw new Error(
        "withCachedPrompt() must run before the context is first used."
      );
    }
    this.#promptStore = store;
    return this;
  }

  // ── Context ──────────────────────────────────────────────────────────────

  /**
   * The engine behind this session's context blocks. The methods below
   * cover everyday use; reach for this to load blocks eagerly or for
   * lower-level access. Building it closes `withContext()`.
   */
  get context(): ContextBlocks {
    this.#context ??= new ContextBlocks(
      Array.from(this.#declaredContext, ([label, options]) =>
        this.#contextConfig(label, options)
      ),
      this.#promptStore ?? this.#contextStore("_system_prompt"),
      (label) => this.#contextStore(label)
    );
    return this.#context;
  }

  /**
   * Add a block after the context is in use, as skills and extensions do.
   * The frozen prompt does not change until `refreshSystemPrompt()`.
   */
  async addContext(
    label: string,
    options: SessionContextOptions = {}
  ): Promise<ContextBlock> {
    await this.#ready();
    return this.context.addBlock(this.#contextConfig(label, options));
  }

  /**
   * Remove a block. Returns false when no such block exists. The frozen
   * prompt does not change until `refreshSystemPrompt()`.
   */
  removeContext(label: string): boolean {
    return this.context.removeBlock(label);
  }

  /** A loaded block by label, or null before the blocks load. */
  getContextBlock(label: string): ContextBlock | null {
    return this.context.getBlock(label);
  }

  /** Every loaded block. Empty before the blocks load. */
  getContextBlocks(): ContextBlock[] {
    return this.context.getBlocks();
  }

  /** Overwrite a writable block. The frozen prompt is unchanged. */
  async replaceContextBlock(
    label: string,
    content: string
  ): Promise<ContextBlock> {
    await this.#ready();
    return this.context.setBlock(label, content);
  }

  /** Append to a writable block. The frozen prompt is unchanged. */
  async appendContextBlock(
    label: string,
    content: string
  ): Promise<ContextBlock> {
    await this.#ready();
    return this.context.appendToBlock(label, content);
  }

  /**
   * The system prompt for this session. The first call renders the blocks
   * and stores the result; later calls, including after an eviction, return
   * the stored string so the model provider's prefix cache stays warm.
   */
  async freezeSystemPrompt(): Promise<string> {
    await this.#ready();
    return this.context.freezeSystemPrompt();
  }

  /**
   * Re-read every block, re-render the prompt, and store it. Compaction and
   * `clearMessages()` call this for you.
   */
  async refreshSystemPrompt(): Promise<string> {
    await this.#ready();
    return this.context.refreshSystemPrompt();
  }

  /**
   * Current values of `whenChanged: "remind"` blocks that no longer match
   * the frozen prompt, for the host to send after the cached prefix. Null
   * when nothing changed.
   */
  async contextReminder(): Promise<string | null> {
    await this.#ready();
    return this.context.reminder();
  }

  /**
   * AI SDK tools for the blocks: `set_context` when any block is writable,
   * `search_context` when any is searchable (`SET_CONTEXT_TOOL` and
   * `SEARCH_CONTEXT_TOOL` in `agents/context`).
   */
  async tools(): Promise<ToolSet> {
    await this.#ready();
    return this.context.tools();
  }

  /**
   * @internal Drop every declaration and the built engine, so a host whose
   * startup re-runs on the same instance can declare its blocks again.
   * Stored block content and the stored prompt are untouched.
   */
  internal_resetContext(): void {
    this.#declaredContext.clear();
    this.#promptStore = undefined;
    this.#context = undefined;
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
    await this.#refreshContextAfter("clear");
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
    await this.#refreshContextAfter("compaction");
    await this.#core.notify({ type: "compact", sessionId: this.sessionId });
    return { ...result, fromMessageId: fromId };
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /**
   * SQLite for context providers, in the tagged-template shape they take.
   * Reached lazily, like every other Sessions service.
   */
  get #sql(): SqlProvider {
    const io = this.#core.io;
    return {
      sql: <T>(
        strings: TemplateStringsArray,
        ...values: (string | number | boolean | null)[]
      ) =>
        io.sql<T>(
          strings.join("?"),
          values.map((value) =>
            typeof value === "boolean" ? Number(value) : value
          )
        )
    };
  }

  /**
   * Storage key for a block of this session. The default session uses the
   * bare label; others suffix the session id, so sessions in one object
   * keep separate blocks and prompts.
   */
  #contextKey(label: string): string {
    return this.sessionId ? `${label}_${this.sessionId}` : label;
  }

  #contextStore(label: string): WritableContextProvider {
    return new AgentContextProvider(this.#sql, this.#contextKey(label));
  }

  #contextConfig(label: string, options: SessionContextOptions): ContextConfig {
    const { searchable, ...config } = options;
    if (!searchable) return { label, ...config };
    if (config.provider) {
      throw new Error(
        `Context block "${label}" sets both searchable and provider; choose one`
      );
    }
    return {
      label,
      ...config,
      provider: new AgentSearchProvider(this.#sql, this.#contextKey(label))
    };
  }

  /**
   * Rebuild the frozen prompt after a change that alters what the model has
   * seen. A session that never declared or used context has nothing to
   * rebuild. A failure leaves the stored prompt in place and is reported,
   * because the change that triggered it is already committed.
   */
  async #refreshContextAfter(change: "compaction" | "clear"): Promise<void> {
    if (!this.#context && this.#declaredContext.size === 0) return;
    try {
      await this.context.refreshSystemPrompt();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[Sessions] refreshing the system prompt after ${change} failed: ${detail}`
      );
      this.#core.io.emit("session:error", {
        sessionId: this.sessionId,
        error: detail
      });
    }
  }

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

/**
 * Whether two declarations of one label agree. Providers compare by
 * identity: two inline objects are two different providers.
 */
function sameContextOptions(
  a: SessionContextOptions,
  b: SessionContextOptions
): boolean {
  return (
    a.provider === b.provider &&
    a.description === b.description &&
    a.maxTokens === b.maxTokens &&
    a.whenChanged === b.whenChanged &&
    Boolean(a.searchable) === Boolean(b.searchable)
  );
}
