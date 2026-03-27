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
import type { CompactResult } from "../utils/compaction-helpers";
import { estimateMessageTokens } from "../utils/tokens";
import { MessageType } from "../../../types";

export type SessionContextOptions = Omit<ContextConfig, "label">;

// Raw builder entry — provider resolved at init time so chain order doesn't matter
interface PendingContext {
  label: string;
  options: SessionContextOptions;
}

/** Agent-like object that can broadcast to connected clients */
interface Broadcaster {
  broadcast(message: string | ArrayBufferLike): void;
}

function isBroadcaster(obj: unknown): obj is Broadcaster {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "broadcast" in obj &&
    typeof (obj as Broadcaster).broadcast === "function"
  );
}

export class Session {
  private storage!: SessionProvider;
  private context!: ContextBlocks;

  // Builder state — only used with Session.create()
  private _agent?: SqlProvider;
  private _broadcaster?: Broadcaster;
  private _sessionId?: string;
  private _pending?: PendingContext[];
  private _cachedPrompt?: ContextProvider | true;
  private _compactionFn?:
    | ((messages: UIMessage[]) => Promise<CompactResult | null>)
    | null;
  private _tokenThreshold?: number;
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
   *   .withContext("soul", { initialContent: "You are helpful.", readonly: true })
   *   .withContext("memory", { description: "Learned facts", maxTokens: 1100 })
   *   .withCachedPrompt();
   *
   * // Custom storage (R2, KV, etc.)
   * const session = Session.create(this)
   *   .withContext("workspace", {
   *     provider: {
   *       get: () => env.BUCKET.get("ws.md").then(o => o?.text() ?? null),
   *       set: (c) => env.BUCKET.put("ws.md", c),
   *     }
   *   })
   *   .withCachedPrompt();
   * ```
   */
  static create(agent: SqlProvider): Session {
    const session: Session = Object.create(Session.prototype);
    session._agent = agent;
    if (isBroadcaster(agent)) {
      session._broadcaster = agent;
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

  /**
   * Register a compaction function. Called by `compact()` to compress
   * message history into a summary overlay.
   */
  onCompaction(
    fn: (messages: UIMessage[]) => Promise<CompactResult | null>
  ): this {
    this._compactionFn = fn;
    return this;
  }

  /**
   * Auto-compact when estimated token count exceeds the threshold.
   * Checked after each `appendMessage`. Requires `onCompaction()`.
   */
  compactAfter(tokenThreshold: number): this {
    this._tokenThreshold = tokenThreshold;
    return this;
  }

  // ── Lazy init ───────────────────────────────────────────────────

  private _ensureReady(): void {
    if (this._ready) return;

    // Resolve context configs — sessionId is final by now
    const configs: ContextConfig[] = (this._pending ?? []).map(
      ({ label, options: opts }) => {
        let provider = opts.provider;
        if (!provider && !opts.readonly) {
          const key = this._sessionId ? `${label}_${this._sessionId}` : label;
          provider = new AgentContextProvider(this._agent!, key);
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

  // ── Status broadcast ────────────────────────────────────────────

  private _broadcastSession(data: Record<string, unknown>): void {
    if (!this._broadcaster) return;
    this._broadcaster.broadcast(
      JSON.stringify({ type: MessageType.CF_AGENT_SESSION, ...data })
    );
  }

  private _broadcastSessionError(error: string): void {
    if (!this._broadcaster) return;
    this._broadcaster.broadcast(
      JSON.stringify({ type: MessageType.CF_AGENT_SESSION_ERROR, error })
    );
  }

  // ── Write ─────────────────────────────────────────────────────

  async appendMessage(
    message: UIMessage,
    parentId?: string | null
  ): Promise<void> {
    this._ensureReady();
    this.storage.appendMessage(message, parentId);

    // Auto-compact if token threshold is set and exceeded
    if (this._tokenThreshold && this._compactionFn) {
      const history = this.getHistory();
      const tokenEstimate = estimateMessageTokens(history);
      if (tokenEstimate > this._tokenThreshold) {
        try {
          await this.compact();
        } catch {
          // Auto-compact failure is non-fatal — message is already appended
        }
      }
    }
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

  /**
   * Run the registered compaction function and store the result as an overlay.
   * Requires `onCompaction()` to be called first.
   */
  async compact(): Promise<CompactResult | null> {
    this._ensureReady();
    if (!this._compactionFn) {
      throw new Error(
        "No compaction function registered. Call onCompaction() first."
      );
    }

    const history = this.getHistory();
    if (history.length < 4) return null;

    const tokensBefore = estimateMessageTokens(history);
    this._broadcastSession({
      phase: "compacting",
      tokenEstimate: tokensBefore,
      tokenThreshold: this._tokenThreshold ?? null
    });

    let result: CompactResult | null;
    try {
      result = await this._compactionFn(history);
    } catch (err) {
      this._broadcastSessionError(
        err instanceof Error ? err.message : String(err)
      );
      throw err;
    }

    if (!result) {
      this._broadcastSession({
        phase: "idle",
        tokenEstimate: tokensBefore,
        tokenThreshold: this._tokenThreshold ?? null
      });
      return null;
    }

    // Iterative compaction — extend from earliest existing compaction's start
    const existing = this.getCompactions();
    const fromId =
      existing.length > 0 ? existing[0].fromMessageId : result.fromMessageId;

    this.addCompaction(result.summary, fromId, result.toMessageId);
    await this.refreshSystemPrompt();

    const tokensAfter = estimateMessageTokens(this.getHistory());
    this._broadcastSession({
      phase: "idle",
      tokenEstimate: tokensAfter,
      tokenThreshold: this._tokenThreshold ?? null,
      compacted: {
        tokensBefore,
        tokensAfter
      }
    });

    return { ...result, fromMessageId: fromId };
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
    createdAt?: string;
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
