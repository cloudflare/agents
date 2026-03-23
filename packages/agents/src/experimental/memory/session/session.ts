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
  type ContextBlockConfig,
  type ContextBlockProvider
} from "./context";
import { AgentSessionProvider, type SqlProvider } from "./providers/agent";
import { AgentContextProvider } from "./providers/agent-context";

export interface SessionContextOptions {
  description?: string;
  defaultContent?: string;
  maxTokens?: number;
  readonly?: boolean;
  provider?: ContextBlockProvider;
}

// Raw builder entry — provider resolved at init time so chain order doesn't matter
interface PendingContext {
  label: string;
  options: SessionContextOptions;
}

export class Session {
  private storage!: SessionProvider;
  private context!: ContextBlocks;

  // Builder state — only used with Session.create()
  private _agent?: SqlProvider;
  private _sessionId?: string;
  private _pending?: PendingContext[];
  private _cachedPrompt?: ContextBlockProvider | true;
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
   * Chainable session creation with auto-wired SQLite providers.
   * Chain methods in any order — providers are resolved lazily on first use.
   *
   * @example
   * ```ts
   * const session = Session.create(this)
   *   .withContext("memory", { description: "Learned facts", maxTokens: 1100 })
   *   .withContext("soul", { defaultContent: "You are helpful.", readonly: true })
   *   .withCachedPrompt();
   *
   * // Multi-session with namespaced providers
   * const session = Session.create(this)
   *   .forSession("chat-123")
   *   .withContext("memory", { maxTokens: 1100 })
   *   .withCachedPrompt();
   *
   * // Custom provider (R2, KV, etc.)
   * const session = Session.create(this)
   *   .withContext("workspace", { provider: new R2ContextProvider(env.BUCKET, "workspace.md") })
   *   .withCachedPrompt();
   * ```
   */
  static create(agent: SqlProvider): Session {
    const session: Session = Object.create(Session.prototype);
    session._agent = agent;
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

  withCachedPrompt(provider?: ContextBlockProvider): this {
    this._cachedPrompt = provider ?? true;
    return this;
  }

  // ── Lazy init ───────────────────────────────────────────────────

  private _ensureReady(): void {
    if (this._ready) return;

    // Resolve context configs — sessionId is final by now
    const configs: ContextBlockConfig[] = (this._pending ?? []).map(
      ({ label, options: opts }) => {
        let provider = opts.provider;
        if (!provider && !opts.readonly) {
          const key = this._sessionId ? `${label}_${this._sessionId}` : label;
          provider = new AgentContextProvider(this._agent!, key);
        }
        return {
          label,
          description: opts.description,
          defaultContent: opts.defaultContent,
          maxTokens: opts.maxTokens,
          readonly: opts.readonly,
          provider
        };
      }
    );

    // Resolve prompt store
    let promptStore: ContextBlockProvider | undefined;
    if (this._cachedPrompt === true) {
      const key = this._sessionId
        ? `_system_prompt_${this._sessionId}`
        : "_system_prompt";
      promptStore = new AgentContextProvider(this._agent!, key);
    } else if (this._cachedPrompt) {
      promptStore = this._cachedPrompt;
    }

    this.storage = new AgentSessionProvider(this._agent!, this._sessionId);
    this.context = new ContextBlocks(configs, promptStore);
    this._ready = true;
  }

  // ── History (tree-structured) ─────────────────────────────────

  getHistory(leafId?: string | null): UIMessage[] {
    this._ensureReady();
    return this.storage.getHistory(leafId);
  }

  getMessage(id: string): UIMessage | null {
    this._ensureReady();
    return this.storage.getMessage(id);
  }

  getLatestLeaf(): UIMessage | null {
    this._ensureReady();
    return this.storage.getLatestLeaf();
  }

  getBranches(messageId: string): UIMessage[] {
    this._ensureReady();
    return this.storage.getBranches(messageId);
  }

  getPathLength(leafId?: string | null): number {
    this._ensureReady();
    return this.storage.getPathLength(leafId);
  }

  // ── Write ─────────────────────────────────────────────────────

  appendMessage(message: UIMessage, parentId?: string | null): void {
    this._ensureReady();
    this.storage.appendMessage(message, parentId);
  }

  updateMessage(message: UIMessage): void {
    this._ensureReady();
    this.storage.updateMessage(message);
  }

  deleteMessages(messageIds: string[]): void {
    this._ensureReady();
    this.storage.deleteMessages(messageIds);
  }

  clearMessages(): void {
    this._ensureReady();
    this.storage.clearMessages();
  }

  // ── Compaction ────────────────────────────────────────────────

  addCompaction(
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): StoredCompaction {
    this._ensureReady();
    return this.storage.addCompaction(summary, fromMessageId, toMessageId);
  }

  getCompactions(): StoredCompaction[] {
    this._ensureReady();
    return this.storage.getCompactions();
  }

  needsCompaction(maxMessages?: number): boolean {
    this._ensureReady();
    return this.storage.getPathLength() > (maxMessages ?? 100);
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

  search(
    query: string,
    options?: { limit?: number }
  ): Array<{
    id: string;
    role: string;
    content: string;
    createdAt: string;
  }> {
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
