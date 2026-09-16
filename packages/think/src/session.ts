/**
 * Think's conversation handle.
 *
 * Wraps the `agents/sessions` `Session` handle that `Think.sessions` hands
 * out, so that a subclass written against the pre-Sessions Think API keeps
 * compiling and running unchanged:
 *
 *   - the context builder methods (`withContext`, `withCachedPrompt`) that
 *     used to live on the session, now queued and folded into
 *     `Think.configureContext()`;
 *   - the context accessors (`addContext`, `getContextBlock`,
 *     `refreshSystemPrompt`, `tools`, ...), now forwarded to `Think.context`;
 *   - the positional `appendMessage(message, parentId)` and
 *     `getHistory(leafId)` forms alongside the options-object forms.
 *
 * Storage calls delegate to the real handle; the context forwards are
 * deprecated and exist only so an upgrade is a no-op. New code should read
 * `this.context` directly and declare blocks in `configureContext()`.
 *
 * The wrapper is explicit forwarding rather than a subclass or Proxy because
 * `Session` keeps its state in `#private` fields, which neither survives.
 */

import type { ToolSet } from "ai";
import type {
  AppendOptions,
  AppendResult,
  CompactionFunction,
  CompactResult,
  HistoryBatchReadOptions,
  HistoryReadOptions,
  RecentHistoryResult,
  SearchResult,
  Session,
  SessionMessage,
  SessionRowStat,
  StoredCompaction,
  WriteOptions
} from "agents/sessions";
import type {
  ContextBlock,
  ContextBlocks,
  ContextConfig,
  WritableContextProvider
} from "agents/context";

/** Options for a block declared through `withContext()` / `addContext()`. */
export type SessionContextOptions = Omit<ContextConfig, "label">;

/** Receives an error thrown by the registered compaction function. */
export type CompactionErrorHandler = (error: unknown) => void | Promise<void>;

/**
 * @deprecated `compactAfter()` gates on the token estimate Sessions stamps on
 * each row; a custom counter is no longer consulted. Accepted so existing
 * calls compile.
 */
export interface CompactAfterOptions {
  tokenCounter?: unknown;
}

export class ThinkSession {
  readonly #handle: Session;
  readonly #context: () => ContextBlocks;
  /** Blocks queued by `withContext()`; `null` once startup consumed them. */
  #pendingContext: ContextConfig[] | null = [];
  #promptStore: WritableContextProvider | undefined;
  #compactionErrorHandler: CompactionErrorHandler | null = null;

  /** @internal Constructed by Think during `onStart`. */
  constructor(handle: Session, context: () => ContextBlocks) {
    this.#handle = handle;
    this.#context = context;
  }

  get sessionId(): string {
    return this.#handle.sessionId;
  }

  /** @internal Blocks declared through `withContext()` during configuration. */
  internal_takePendingContext(): ContextConfig[] {
    const pending = this.#pendingContext ?? [];
    this.#pendingContext = null;
    return pending;
  }

  /** @internal A custom frozen-prompt store passed to `withCachedPrompt()`. */
  internal_promptStore(): WritableContextProvider | undefined {
    return this.#promptStore;
  }

  // ── Builder (configureSession) ────────────────────────────────────────────

  /**
   * Declare a prompt context block.
   *
   * @deprecated Return the block from `configureContext()` instead. Only
   * callable inside `configureSession()`; after startup use
   * `this.context.addBlock()`.
   */
  withContext(label: string, options: SessionContextOptions = {}): this {
    if (!this.#pendingContext) {
      throw new Error(
        "withContext() is only available inside configureSession(). " +
          "After startup, add a block with this.context.addBlock()."
      );
    }
    this.#pendingContext.push({ label, ...options });
    return this;
  }

  /**
   * Persist the frozen system prompt.
   *
   * @deprecated The frozen prompt is always persisted now, so this is a
   * no-op. A custom `provider` is still honoured as the prompt store.
   */
  withCachedPrompt(provider?: WritableContextProvider): this {
    if (provider) this.#promptStore = provider;
    return this;
  }

  /** Register the function `compact()` calls to summarize a branch. */
  onCompaction(fn: CompactionFunction): this {
    this.#handle.onCompaction(async (messages) => {
      try {
        return await fn(messages);
      } catch (error) {
        const handler = this.#compactionErrorHandler;
        if (!handler) throw error;
        await handler(error);
        return null;
      }
    });
    return this;
  }

  /**
   * Auto-compact after an append once the stamped token estimate crosses the
   * threshold. Requires `onCompaction()`.
   */
  compactAfter(tokenThreshold: number, _options?: CompactAfterOptions): this {
    this.#handle.compactAfter(tokenThreshold);
    return this;
  }

  /**
   * Observe compaction failures. When set, a failing compaction function
   * calls the handler and the compaction is skipped; without one the failure
   * is reported through the `session:error` capability event.
   */
  onCompactionError(handler: CompactionErrorHandler): this {
    this.#compactionErrorHandler = handler;
    return this;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  history(
    options?: HistoryReadOptions
  ): AsyncGenerator<SessionMessage, void, undefined> {
    return this.#handle.history(options);
  }

  historyBatches(
    options?: HistoryBatchReadOptions
  ): AsyncGenerator<SessionMessage[], void, undefined> {
    return this.#handle.historyBatches(options);
  }

  /**
   * Materialize the whole selected path. Accepts a leaf id positionally, as
   * the pre-Sessions API did, or a read-options object.
   */
  getHistory(
    leafIdOrOptions?: string | null | HistoryReadOptions
  ): Promise<SessionMessage[]> {
    return this.#handle.getHistory(readOptions(leafIdOrOptions));
  }

  /**
   * Byte-budgeted read of the most recent messages on the active path. The
   * pre-Sessions `minRecentMessages` argument is accepted and ignored: the
   * budget is a hard ceiling, and the newest message is always returned.
   */
  getRecentHistory(
    maxContentBytes: number,
    optionsOrMinRecentMessages?: number | Pick<HistoryReadOptions, "leafId">
  ): Promise<RecentHistoryResult> {
    const options =
      typeof optionsOrMinRecentMessages === "object"
        ? optionsOrMinRecentMessages
        : undefined;
    return this.#handle.getRecentHistory(maxContentBytes, options);
  }

  getHistoryRowStats(leafId?: string | null): Promise<SessionRowStat[]> {
    return this.#handle.getHistoryRowStats(leafId);
  }

  /** @deprecated Read `getHistoryRowStats()` and take its length. */
  async getPathLength(leafId?: string | null): Promise<number> {
    return (await this.#handle.getHistoryRowStats(leafId)).length;
  }

  getMessage(id: string): Promise<SessionMessage | null> {
    return this.#handle.getMessage(id);
  }

  getLatestLeaf(): Promise<SessionMessage | null> {
    return this.#handle.getLatestLeaf();
  }

  getBranches(messageId: string): Promise<SessionMessage[]> {
    return this.#handle.getBranches(messageId);
  }

  search(query: string, options?: { limit?: number }): Promise<SearchResult[]> {
    return this.#handle.search(query, options);
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  /**
   * Append one message. Accepts the parent id positionally, as the
   * pre-Sessions API did, or an options object.
   */
  appendMessage(
    message: SessionMessage,
    parentIdOrOptions?: string | null | AppendOptions
  ): Promise<AppendResult> {
    return this.#handle.appendMessage(
      message,
      appendOptions(parentIdOrOptions)
    );
  }

  updateMessage(
    message: SessionMessage,
    options?: WriteOptions
  ): Promise<SessionMessage | null> {
    return this.#handle.updateMessage(message, options);
  }

  upsertMessage(
    message: SessionMessage,
    parentIdOrOptions?: string | null | AppendOptions
  ): Promise<AppendResult> {
    return this.#handle.upsertMessage(
      message,
      appendOptions(parentIdOrOptions)
    );
  }

  importMessage(
    message: SessionMessage,
    options: { parentId: string | null; createdAt: number }
  ): Promise<void> {
    return this.#handle.importMessage(message, options);
  }

  deleteMessages(messageIds: string[]): Promise<void> {
    return this.#handle.deleteMessages(messageIds);
  }

  clearMessages(): Promise<void> {
    return this.#handle.clearMessages();
  }

  // ── Compaction ───────────────────────────────────────────────────────────

  addCompaction(
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): Promise<StoredCompaction> {
    return this.#handle.addCompaction(summary, fromMessageId, toMessageId);
  }

  getCompactions(): Promise<StoredCompaction[]> {
    return this.#handle.getCompactions();
  }

  compact(leafId?: string | null): Promise<CompactResult | null> {
    return this.#handle.compact(leafId);
  }

  // ── Context forwards ─────────────────────────────────────────────────────
  //
  // Prompt context lives on `Think.context` now. These forwards keep the
  // pre-Sessions call sites working and will be removed in a later minor.

  /** @deprecated Use `this.context.addBlock({ label, ...options })`. */
  addContext(
    label: string,
    options: SessionContextOptions = {}
  ): Promise<ContextBlock> {
    return this.#context().addBlock({ label, ...options });
  }

  /** @deprecated Use `this.context.removeBlock(label)`. */
  removeContext(label: string): boolean {
    return this.#context().removeBlock(label);
  }

  /** @deprecated Use `this.context.getBlock(label)`. */
  getContextBlock(label: string): ContextBlock | null {
    return this.#context().getBlock(label);
  }

  /** @deprecated Use `this.context.getBlocks()`. */
  getContextBlocks(): ContextBlock[] {
    return this.#context().getBlocks();
  }

  /** @deprecated Use `this.context.setBlock(label, content)`. */
  replaceContextBlock(label: string, content: string): Promise<ContextBlock> {
    return this.#context().setBlock(label, content);
  }

  /** @deprecated Use `this.context.appendToBlock(label, content)`. */
  appendContextBlock(label: string, content: string): Promise<ContextBlock> {
    return this.#context().appendToBlock(label, content);
  }

  /** @deprecated Use `this.context.freezeSystemPrompt()`. */
  freezeSystemPrompt(): Promise<string> {
    return this.#context().freezeSystemPrompt();
  }

  /** @deprecated Use `this.context.refreshSystemPrompt()`. */
  refreshSystemPrompt(): Promise<string> {
    return this.#context().refreshSystemPrompt();
  }

  /** @deprecated Use `this.context.tools()`. */
  tools(): Promise<ToolSet> {
    return this.#context().tools();
  }
}

function readOptions(
  leafIdOrOptions: string | null | HistoryReadOptions | undefined
): HistoryReadOptions | undefined {
  if (leafIdOrOptions === undefined) return undefined;
  if (leafIdOrOptions === null || typeof leafIdOrOptions === "string") {
    return { leafId: leafIdOrOptions };
  }
  return leafIdOrOptions;
}

function appendOptions(
  parentIdOrOptions: string | null | AppendOptions | undefined
): AppendOptions | undefined {
  if (parentIdOrOptions === undefined) return undefined;
  if (parentIdOrOptions === null || typeof parentIdOrOptions === "string") {
    return { parentId: parentIdOrOptions };
  }
  return parentIdOrOptions;
}
