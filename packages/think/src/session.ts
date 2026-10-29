/**
 * Think's conversation handle.
 *
 * Wraps the `agents/sessions` `Session` handle that `Think.sessions` hands
 * out, so that a subclass written against the pre-Sessions Think API keeps
 * compiling and running unchanged:
 *
 *   - `withContext()` and `withCachedPrompt()`, queued during
 *     `configureSession()` so Think can declare them on the handle after the
 *     blocks `configureContext()` returns;
 *   - `onCompactionError()`;
 *   - the positional `appendMessage(message, parentId)` and
 *     `getHistory(leafId)` forms alongside the options-object forms.
 *
 * Everything else, context accessors included, delegates to the handle.
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
  SessionContextOptions,
  SessionMessage,
  SessionRowStat,
  StoredCompaction,
  WriteOptions
} from "agents/sessions";
import type { ContextBlock, WritableContextProvider } from "agents/context";

export type { SessionContextOptions };

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
  /** Why context is unavailable on this host, when it is. */
  readonly #contextUnsupported: string | undefined;
  /** Blocks queued by `withContext()`; `null` once startup consumed them. */
  #pendingContext: (SessionContextOptions & { label: string })[] | null = [];
  #promptStore: WritableContextProvider | undefined;
  #compactionErrorHandler: CompactionErrorHandler | null = null;

  /** @internal Constructed by Think during `onStart`. */
  constructor(handle: Session, options: { contextUnsupported?: string } = {}) {
    this.#handle = handle;
    this.#contextUnsupported = options.contextUnsupported;
  }

  /** The handle, for context calls; throws on a host without context. */
  #context(): Session {
    if (this.#contextUnsupported) throw new Error(this.#contextUnsupported);
    return this.#handle;
  }

  get sessionId(): string {
    return this.#handle.sessionId;
  }

  /** @internal Blocks declared through `withContext()` during configuration. */
  internal_takePendingContext(): (SessionContextOptions & {
    label: string;
  })[] {
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
   * Declare a prompt context block. Equivalent to returning it from
   * `configureContext()`, and rendered after those blocks. Only callable
   * inside `configureSession()`; after startup use `addContext()`.
   */
  withContext(label: string, options: SessionContextOptions = {}): this {
    if (!this.#pendingContext) {
      throw new Error(
        "withContext() is only available inside configureSession(). " +
          "After startup, add a block with this.session.addContext()."
      );
    }
    this.#pendingContext.push({ label, ...options });
    return this;
  }

  /**
   * Store the frozen system prompt in `provider` instead of this agent's
   * SQLite. The prompt is always stored; without an argument this does
   * nothing.
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

  // ── Context ──────────────────────────────────────────────────────────────

  addContext(
    label: string,
    options: SessionContextOptions = {}
  ): Promise<ContextBlock> {
    return this.#context().addContext(label, options);
  }

  removeContext(label: string): boolean {
    return this.#context().removeContext(label);
  }

  getContextBlock(label: string): ContextBlock | null {
    return this.#context().getContextBlock(label);
  }

  getContextBlocks(): ContextBlock[] {
    return this.#context().getContextBlocks();
  }

  replaceContextBlock(label: string, content: string): Promise<ContextBlock> {
    return this.#context().replaceContextBlock(label, content);
  }

  appendContextBlock(label: string, content: string): Promise<ContextBlock> {
    return this.#context().appendContextBlock(label, content);
  }

  freezeSystemPrompt(): Promise<string> {
    return this.#context().freezeSystemPrompt();
  }

  refreshSystemPrompt(): Promise<string> {
    return this.#context().refreshSystemPrompt();
  }

  contextReminder(): Promise<string | null> {
    return this.#context().contextReminder();
  }

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
