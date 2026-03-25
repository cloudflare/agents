/**
 * Session — conversation history, context blocks, compaction, search, and tools.
 */

import type { ToolSet } from "ai";
import type { UIMessage } from "ai";
import type { SessionProvider, StoredCompaction } from "./provider";
import type { SessionOptions } from "./types";
import {
  ContextBlocks,
  type ContextBlock,
  type ContextConfig,
  type ContextProvider
} from "./context";
import { AgentSessionProvider, type SqlProvider } from "./providers/agent";
import { AgentContextProvider } from "./providers/agent-context";

export type SessionContextOptions = Omit<ContextConfig, "label">;

// Raw builder entry — provider resolved at init time so chain order doesn't matter
interface PendingContext {
  label: string;
  options: SessionContextOptions;
}

// Detect whether the argument is a SqlProvider (has sql tagged template method)
function isSqlProvider(arg: SqlProvider | SessionProvider): arg is SqlProvider {
  return "sql" in arg && typeof (arg as SqlProvider).sql === "function";
}

export class Session {
  private storage!: SessionProvider;
  private context!: ContextBlocks;

  // Builder state — only used with Session.create()
  private _agent?: SqlProvider;
  private _storageProvider?: SessionProvider;
  private _sessionId?: string;
  private _pending?: PendingContext[];
  private _cachedPrompt?: ContextProvider | true;
  private _ready = false;

  constructor(storage: SessionProvider, options?: SessionOptions) {
    this.storage = storage;
    this.context = new ContextBlocks(
      options?.context ?? [],
      options?.promptStore
    );
    this._ready = true;
  }

  /**
   * Chainable session creation with auto-wired providers.
   *
   * Pass a `SqlProvider` (Agent with `sql` method) for auto-wired SQLite,
   * or a `SessionProvider` directly for custom storage (PlanetScale, etc.).
   *
   * @example
   * ```ts
   * // Auto-wired SQLite (DO Agent)
   * const session = Session.create(this)
   *   .withContext("soul", { initialContent: "You are helpful.", readonly: true })
   *   .withContext("memory", { description: "Learned facts", maxTokens: 1100 })
   *   .withCachedPrompt();
   *
   * // Custom storage provider (PlanetScale, etc.)
   * const session = Session.create(planetscaleProvider)
   *   .withContext("memory", {
   *     maxTokens: 1100,
   *     provider: new PlanetScaleContextProvider(conn, "memory")
   *   })
   *   .withCachedPrompt(new PlanetScaleContextProvider(conn, "_prompt"));
   * ```
   */
  static create(storageOrAgent: SqlProvider | SessionProvider): Session {
    const session: Session = Object.create(Session.prototype);
    if (isSqlProvider(storageOrAgent)) {
      session._agent = storageOrAgent;
    } else {
      session._storageProvider = storageOrAgent;
    }
    session._pending = [];
    session._ready = false;
    return session;
  }

  // ── Builder methods ─────────────────────────────────────────────

  forSession(sessionId: string): this {
    this._sessionId = sessionId;
    return this;
  }

  withContext(label: string, options?: SessionContextOptions): this {
    this._pending!.push({ label, options: options ?? {} });
    return this;
  }

  withCachedPrompt(provider?: ContextProvider): this {
    this._cachedPrompt = provider ?? true;
    return this;
  }

  // ── Lazy init ───────────────────────────────────────────────────

  private _ensureReady(): void {
    if (this._ready) return;

    // Resolve context configs — sessionId is final by now
    const configs: ContextConfig[] = (this._pending ?? []).map(
      ({ label, options: opts }) => {
        let provider = opts.provider;
        if (!provider && !opts.readonly && this._agent) {
          const key = this._sessionId ? `${label}_${this._sessionId}` : label;
          provider = new AgentContextProvider(this._agent, key);
        }
        return {
          label,
          description: opts.description,
          initialContent: opts.initialContent,
          maxTokens: opts.maxTokens,
          readonly: opts.readonly,
          provider
        };
      }
    );

    // Resolve prompt store
    let promptStore: ContextProvider | undefined;
    if (this._cachedPrompt === true && this._agent) {
      const key = this._sessionId
        ? `_system_prompt_${this._sessionId}`
        : "_system_prompt";
      promptStore = new AgentContextProvider(this._agent, key);
    } else if (this._cachedPrompt && this._cachedPrompt !== true) {
      promptStore = this._cachedPrompt;
    }

    // Resolve storage
    if (this._storageProvider) {
      this.storage = this._storageProvider;
    } else if (this._agent) {
      this.storage = new AgentSessionProvider(this._agent, this._sessionId);
    } else {
      throw new Error(
        "Session.create() requires a SqlProvider or SessionProvider"
      );
    }

    this.context = new ContextBlocks(configs, promptStore);
    this._ready = true;
  }

  // ── History (tree-structured) ─────────────────────────────────

  async getHistory(leafId?: string | null): Promise<UIMessage[]> {
    this._ensureReady();
    return this.storage.getHistory(leafId);
  }

  async getMessage(id: string): Promise<UIMessage | null> {
    this._ensureReady();
    return this.storage.getMessage(id);
  }

  async getLatestLeaf(): Promise<UIMessage | null> {
    this._ensureReady();
    return this.storage.getLatestLeaf();
  }

  async getBranches(messageId: string): Promise<UIMessage[]> {
    this._ensureReady();
    return this.storage.getBranches(messageId);
  }

  async getPathLength(leafId?: string | null): Promise<number> {
    this._ensureReady();
    return this.storage.getPathLength(leafId);
  }

  // ── Write ─────────────────────────────────────────────────────

  async appendMessage(
    message: UIMessage,
    parentId?: string | null
  ): Promise<void> {
    this._ensureReady();
    await this.storage.appendMessage(message, parentId);
  }

  async updateMessage(message: UIMessage): Promise<void> {
    this._ensureReady();
    await this.storage.updateMessage(message);
  }

  async deleteMessages(messageIds: string[]): Promise<void> {
    this._ensureReady();
    await this.storage.deleteMessages(messageIds);
  }

  async clearMessages(): Promise<void> {
    this._ensureReady();
    await this.storage.clearMessages();
  }

  // ── Compaction ────────────────────────────────────────────────

  async addCompaction(
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): Promise<StoredCompaction> {
    this._ensureReady();
    return this.storage.addCompaction(summary, fromMessageId, toMessageId);
  }

  async getCompactions(): Promise<StoredCompaction[]> {
    this._ensureReady();
    return this.storage.getCompactions();
  }

  async needsCompaction(maxMessages?: number): Promise<boolean> {
    this._ensureReady();
    const history = await this.getHistory();
    return history.length > (maxMessages ?? 100);
  }

  // ── Context Blocks ────────────────────────────────────────────

  getContextBlock(label: string): ContextBlock | null {
    this._ensureReady();
    return this.context.getBlock(label);
  }

  getContextBlocks(): ContextBlock[] {
    this._ensureReady();
    return this.context.getBlocks();
  }

  async replaceContextBlock(
    label: string,
    content: string
  ): Promise<ContextBlock> {
    this._ensureReady();
    return this.context.setBlock(label, content);
  }

  async appendContextBlock(
    label: string,
    content: string
  ): Promise<ContextBlock> {
    this._ensureReady();
    return this.context.appendToBlock(label, content);
  }

  // ── System Prompt ─────────────────────────────────────────────

  async freezeSystemPrompt(): Promise<string> {
    this._ensureReady();
    return this.context.freezeSystemPrompt();
  }

  async refreshSystemPrompt(): Promise<string> {
    this._ensureReady();
    return this.context.refreshSystemPrompt();
  }

  // ── Search ────────────────────────────────────────────────────

  async search(
    query: string,
    options?: { limit?: number }
  ): Promise<
    Array<{
      id: string;
      role: string;
      content: string;
      createdAt: string;
    }>
  > {
    this._ensureReady();
    if (!this.storage.searchMessages) {
      throw new Error("Session provider does not support search");
    }
    return this.storage.searchMessages(query, options?.limit ?? 20);
  }

  // ── Tools ─────────────────────────────────────────────────────

  /** Returns update_context tool for writing to context blocks. */
  async tools(): Promise<ToolSet> {
    this._ensureReady();
    return this.context.tools();
  }
}
