/**
 * Session — conversation history, context blocks, compaction, search, and tools.
 */

import type { ToolSet } from "ai";
import type { SessionProvider, StoredCompaction } from "./provider";
import type { SessionMessage, SessionOptions } from "./types";
import {
  ContextBlocks,
  type ContextBlock,
  type ContextConfig,
  type WritableContextProvider
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
  private _cachedPrompt?: WritableContextProvider | true;
  private _compactionFn?:
    | ((messages: SessionMessage[]) => Promise<CompactResult | null>)
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
   *   .withContext("soul", { provider: { get: async () => "You are helpful." } })
   *   .withContext("memory", { description: "Learned facts", maxTokens: 1100 })
   *   .withCachedPrompt();
   *
   * // Skills from R2 (on-demand loading via load_context tool)
   * const session = Session.create(this)
   *   .withContext("skills", {
   *     provider: new R2SkillProvider(env.SKILLS_BUCKET, { prefix: "skills/" })
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

  withCachedPrompt(provider?: WritableContextProvider): this {
    this._cachedPrompt = provider ?? true;
    return this;
  }

  /**
   * Register a compaction function. Called by `compact()` to compress
   * message history into a summary overlay.
   */
  onCompaction(
    fn: (messages: SessionMessage[]) => Promise<CompactResult | null>
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
        if (!provider) {
          // No provider → auto-wire to writable SQLite
          const key = this._sessionId ? `${label}_${this._sessionId}` : label;
          provider = new AgentContextProvider(this._agent!, key);
        }
        return {
          label,
          description: opts.description,
          maxTokens: opts.maxTokens,
          provider
        };
      }
    );

    // Resolve prompt store
    let promptStore: WritableContextProvider | undefined;
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
    this.context.setUnloadCallback((label, key) => {
      this._reclaimLoadedSkill(label, key);
    });
    this._restoreLoadedSkills();
    this._ready = true;
  }

  /**
   * Reconstruct which skills are loaded by scanning conversation history
   * for load_context tool results that haven't been unloaded.
   * Called during init to survive hibernation/eviction.
   */
  private _restoreLoadedSkills(): void {
    const history = this.storage.getHistory();
    const loaded = new Set<string>();

    for (const msg of history) {
      if (msg.role !== "assistant") continue;
      for (const part of msg.parts) {
        if (
          part.toolName === "load_context" &&
          part.state === "output-available"
        ) {
          const input = part.input as
            | { label?: string; key?: string }
            | undefined;
          if (input?.label && input?.key) {
            const id = `${input.label}:${input.key}`;
            if (
              typeof part.output === "string" &&
              part.output.startsWith("[skill unloaded:")
            ) {
              loaded.delete(id);
            } else {
              loaded.add(id);
            }
          }
        } else if (
          part.toolName === "unload_context" &&
          part.state === "output-available"
        ) {
          const input = part.input as
            | { label?: string; key?: string }
            | undefined;
          if (input?.label && input?.key) {
            loaded.delete(`${input.label}:${input.key}`);
          }
        }
      }
    }

    if (loaded.size > 0) {
      this.context.restoreLoadedSkills(loaded);
    }
  }

  /**
   * Replace a load_context tool result in conversation history
   * with a short marker to reclaim context space.
   */
  private _reclaimLoadedSkill(label: string, key: string): void {
    const history = this.storage.getHistory();
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg.role !== "assistant") continue;

      let changed = false;
      const newParts = msg.parts.map((part) => {
        if (
          part.toolName === "load_context" &&
          part.state === "output-available"
        ) {
          const input = part.input as
            | { label?: string; key?: string }
            | undefined;
          if (input?.label === label && input?.key === key) {
            changed = true;
            return { ...part, output: `[skill unloaded: ${key}]` };
          }
        }
        return part;
      });

      if (changed) {
        this.storage.updateMessage({
          ...msg,
          parts: newParts as SessionMessage["parts"]
        });
        return;
      }
    }
  }

  // ── History (tree-structured) ─────────────────────────────────

  getHistory(leafId?: string | null): SessionMessage[] {
    this._ensureReady();
    return this.storage.getHistory(leafId);
  }

  getMessage(id: string): SessionMessage | null {
    this._ensureReady();
    return this.storage.getMessage(id);
  }

  getLatestLeaf(): SessionMessage | null {
    this._ensureReady();
    return this.storage.getLatestLeaf();
  }

  getBranches(messageId: string): SessionMessage[] {
    this._ensureReady();
    return this.storage.getBranches(messageId);
  }

  getPathLength(leafId?: string | null): number {
    this._ensureReady();
    return this.storage.getPathLength(leafId);
  }

  // ── Broadcast ──────────────────────────────────────────────────

  private _broadcast(type: MessageType, data: Record<string, unknown>): void {
    if (!this._broadcaster) return;
    this._broadcaster.broadcast(JSON.stringify({ type, ...data }));
  }

  private _emitStatus(
    phase: "idle" | "compacting",
    extra?: Record<string, unknown>
  ): number {
    const tokenEstimate = estimateMessageTokens(this.getHistory());
    this._broadcast(MessageType.CF_AGENT_SESSION, {
      phase,
      tokenEstimate,
      tokenThreshold: this._tokenThreshold ?? null,
      ...extra
    });
    return tokenEstimate;
  }

  private _emitError(error: string): void {
    this._broadcast(MessageType.CF_AGENT_SESSION_ERROR, { error });
  }

  // ── Write ─────────────────────────────────────────────────────

  async appendMessage(
    message: SessionMessage,
    parentId?: string | null
  ): Promise<void> {
    this._ensureReady();
    this.storage.appendMessage(message, parentId);

    const tokenEstimate = this._emitStatus("idle");

    if (
      this._tokenThreshold != null &&
      this._compactionFn &&
      tokenEstimate > this._tokenThreshold
    ) {
      try {
        await this.compact();
      } catch {
        // Auto-compact failure is non-fatal — message is already appended
      }
    }
  }

  updateMessage(message: SessionMessage): void {
    this._ensureReady();
    this.storage.updateMessage(message);
    this._emitStatus("idle");
  }

  deleteMessages(messageIds: string[]): void {
    this._ensureReady();
    this.storage.deleteMessages(messageIds);
    this._emitStatus("idle");
  }

  clearMessages(): void {
    this._ensureReady();
    this.storage.clearMessages();
    this.context.clearSkillState();
    this._emitStatus("idle");
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

    const tokensBefore = this._emitStatus("compacting");

    let result: CompactResult | null;
    try {
      result = await this._compactionFn(this.getHistory());
    } catch (err) {
      this._emitError(err instanceof Error ? err.message : String(err));
      return null;
    }

    if (!result) {
      this._emitStatus("idle");
      return null;
    }

    // Validate toMessageId exists in the history
    const historyIds = new Set(this.getHistory().map((m) => m.id));
    if (!historyIds.has(result.toMessageId)) {
      this._emitStatus("idle");
      return null;
    }

    // Iterative compaction — extend from earliest existing compaction's start
    const existing = this.getCompactions();
    const fromId =
      existing.length > 0 ? existing[0].fromMessageId : result.fromMessageId;

    this.addCompaction(result.summary, fromId, result.toMessageId);
    await this.refreshSystemPrompt();

    this._emitStatus("idle", {
      compacted: { tokensBefore }
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

  /**
   * Dynamically register a new context block after session initialization.
   * Used by extensions to contribute context blocks at runtime.
   *
   * The block's provider is initialized and loaded immediately.
   * Call `refreshSystemPrompt()` afterward to include the new block
   * in the system prompt.
   *
   * Note: When called without a provider, auto-wires to SQLite via
   * AgentContextProvider. Requires the session to have been created
   * via `Session.create(agent)` (not the direct constructor).
   */
  async addContext(
    label: string,
    options?: SessionContextOptions
  ): Promise<ContextBlock> {
    this._ensureReady();
    const opts = options ?? {};
    let provider = opts.provider;
    if (!provider) {
      const key = this._sessionId ? `${label}_${this._sessionId}` : label;
      provider = new AgentContextProvider(this._agent!, key);
    }
    return this.context.addBlock({
      label,
      description: opts.description,
      maxTokens: opts.maxTokens,
      provider
    });
  }

  /**
   * Remove a dynamically registered context block.
   * Used during extension unload cleanup.
   *
   * Returns true if the block existed and was removed.
   * Call `refreshSystemPrompt()` afterward to rebuild the prompt
   * without the removed block.
   */
  removeContext(label: string): boolean {
    this._ensureReady();
    return this.context.removeBlock(label);
  }

  // ── Skills ───────────────────────────────────────────────────

  /**
   * Unload a previously loaded skill, reclaiming context space.
   * The tool result in conversation history is replaced with a short marker.
   */
  unloadSkill(label: string, key: string): boolean {
    this._ensureReady();
    return this.context.unloadSkill(label, key);
  }

  /**
   * Get currently loaded skill keys (as "label:key" strings).
   */
  getLoadedSkillKeys(): Set<string> {
    this._ensureReady();
    return this.context.getLoadedSkillKeys();
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

  /** Returns set_context and load_context tools. */
  async tools(): Promise<ToolSet> {
    this._ensureReady();
    return this.context.tools();
  }
}
