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

// Detect whether the argument is a SqlProvider (has sql tagged template method)
function isSqlProvider(arg: SqlProvider | SessionProvider): arg is SqlProvider {
  return "sql" in arg && typeof (arg as SqlProvider).sql === "function";
}

export class Session {
  private storage!: SessionProvider;
  private context!: ContextBlocks;

  // Builder state — only used with Session.create()
  private _agent?: SqlProvider;
  private _broadcaster?: Broadcaster;
  private _storageProvider?: SessionProvider;
  private _sessionId?: string;
  private _pending?: PendingContext[];
  private _cachedPrompt?: WritableContextProvider | true;
  private _compactionFn?:
    | ((messages: SessionMessage[]) => Promise<CompactResult | null>)
    | null;
  private _tokenThreshold?: number;
  private _ready = false;
  // Promise for the async skill restore kicked off during _ensureReady().
  // Every async public method awaits this before touching storage or
  // skill-state — guarantees loaded-skill tracking is rehydrated after
  // hibernation, even for async SessionProviders.
  private _restorePromise?: Promise<void>;

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
  static create(provider: SqlProvider | SessionProvider): Session {
    const session: Session = Object.create(Session.prototype);
    if (isSqlProvider(provider)) {
      session._agent = provider;
      if (isBroadcaster(provider)) {
        session._broadcaster = provider;
      }
    } else {
      session._storageProvider = provider;
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
        if (!provider && this._agent) {
          // No provider + has SqlProvider → auto-wire to writable SQLite
          const key = this._sessionId ? `${label}_${this._sessionId}` : label;
          provider = new AgentContextProvider(this._agent, key);
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
    this.context.setUnloadCallback((label, key) => {
      this._reclaimLoadedSkill(label, key).catch(() => {});
    });
    this._ready = true;
    // Kick off skill restoration in the background. Async public methods
    // await `_ensureRestored()` before touching skill-tracking state.
    this._restorePromise = this._restoreLoadedSkills().catch(() => {
      // Restore failures are non-fatal: we lose tracking for this DO
      // lifetime but the session itself stays usable.
    });
  }

  /**
   * Await the background skill-restore kicked off by `_ensureReady()`.
   * Idempotent and cheap — every async public method calls this so that
   * `_loadedSkills` reflects conversation history before any read or write.
   */
  private async _ensureRestored(): Promise<void> {
    this._ensureReady();
    if (this._restorePromise) await this._restorePromise;
  }

  /**
   * Reconstruct which skills are loaded by scanning conversation history
   * for load_context tool results that haven't been unloaded.
   * Runs once per init to survive hibernation / eviction, including for
   * async SessionProviders (e.g. Postgres) where we must `await` history.
   */
  private async _restoreLoadedSkills(): Promise<void> {
    const history = await this.storage.getHistory();

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
   * Reclaim context-window tokens consumed by a previously loaded skill.
   *
   * When a skill is loaded via the `load_context` tool, its full body is
   * embedded as that tool call's `output-available` result inside the
   * assistant message — which means every subsequent turn replays the
   * entire skill as part of the conversation history and pays for it in
   * input tokens.
   *
   * This method walks back through history, finds the matching
   * `load_context` tool result for `(label, key)`, and replaces its bulky
   * `output` with a short marker `[skill unloaded: <key>]`. The skill
   * content is dropped from future turns and the tokens are reclaimed.
   * The skill itself stays available to reload via `load_context`.
   */
  private async _reclaimLoadedSkill(label: string, key: string): Promise<void> {
    const history = await this.storage.getHistory();
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
        await this.storage.updateMessage({
          ...msg,
          parts: newParts as SessionMessage["parts"]
        });
        return;
      }
    }
  }

  // ── History (tree-structured) ─────────────────────────────────

  async getHistory(leafId?: string | null): Promise<SessionMessage[]> {
    await this._ensureRestored();
    return this.storage.getHistory(leafId);
  }

  async getMessage(id: string): Promise<SessionMessage | null> {
    await this._ensureRestored();
    return this.storage.getMessage(id);
  }

  async getLatestLeaf(): Promise<SessionMessage | null> {
    await this._ensureRestored();
    return this.storage.getLatestLeaf();
  }

  async getBranches(messageId: string): Promise<SessionMessage[]> {
    await this._ensureRestored();
    return this.storage.getBranches(messageId);
  }

  async getPathLength(leafId?: string | null): Promise<number> {
    await this._ensureRestored();
    return this.storage.getPathLength(leafId);
  }

  // ── Broadcast ──────────────────────────────────────────────────

  private _broadcast(type: MessageType, data: Record<string, unknown>): void {
    if (!this._broadcaster) return;
    this._broadcaster.broadcast(JSON.stringify({ type, ...data }));
  }

  private async _emitStatus(
    phase: "idle" | "compacting",
    extra?: Record<string, unknown>
  ): Promise<number> {
    const tokenEstimate = estimateMessageTokens(await this.getHistory());
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
    await this._ensureRestored();
    await this.storage.appendMessage(message, parentId);

    const tokenEstimate = await this._emitStatus("idle");

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

  async updateMessage(message: SessionMessage): Promise<void> {
    await this._ensureRestored();
    await this.storage.updateMessage(message);
    await this._emitStatus("idle");
  }

  async deleteMessages(messageIds: string[]): Promise<void> {
    await this._ensureRestored();
    await this.storage.deleteMessages(messageIds);
    await this._emitStatus("idle");
  }

  async clearMessages(): Promise<void> {
    await this._ensureRestored();
    await this.storage.clearMessages();
    this.context.clearSkillState();
    await this.context.refreshSystemPrompt();
    await this._emitStatus("idle");
  }

  // ── Compaction ────────────────────────────────────────────────

  async addCompaction(
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): Promise<StoredCompaction> {
    await this._ensureRestored();
    return this.storage.addCompaction(summary, fromMessageId, toMessageId);
  }

  async getCompactions(): Promise<StoredCompaction[]> {
    await this._ensureRestored();
    return this.storage.getCompactions();
  }

  /**
   * Run the registered compaction function and store the result as an overlay.
   * Requires `onCompaction()` to be called first.
   */
  async compact(): Promise<CompactResult | null> {
    await this._ensureRestored();
    if (!this._compactionFn) {
      throw new Error(
        "No compaction function registered. Call onCompaction() first."
      );
    }

    const tokensBefore = await this._emitStatus("compacting");

    let result: CompactResult | null;
    try {
      result = await this._compactionFn(await this.getHistory());
    } catch (err) {
      this._emitError(err instanceof Error ? err.message : String(err));
      return null;
    }

    if (!result) {
      await this._emitStatus("idle");
      return null;
    }

    // Validate toMessageId exists in the history
    const historyIds = new Set((await this.getHistory()).map((m) => m.id));
    if (!historyIds.has(result.toMessageId)) {
      await this._emitStatus("idle");
      return null;
    }

    // Iterative compaction — extend from earliest existing compaction's start
    const existing = await this.getCompactions();
    const fromId =
      existing.length > 0 ? existing[0].fromMessageId : result.fromMessageId;

    await this.addCompaction(result.summary, fromId, result.toMessageId);
    await this.refreshSystemPrompt();

    await this._emitStatus("idle", {
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
    await this._ensureRestored();
    return this.context.setBlock(label, content);
  }

  async appendContextBlock(
    label: string,
    content: string
  ): Promise<ContextBlock> {
    await this._ensureRestored();
    return this.context.appendToBlock(label, content);
  }

  /**
   * Dynamically register a new context block after session initialization.
   *
   * This is a **builder / runtime API**, not an LLM tool. The LLM writes
   * into existing context blocks via the `set_context` tool (see
   * `ContextBlocks.tools()`); it cannot declare new blocks itself. This
   * method is how extension / host code contributes blocks at runtime
   * (e.g. an extension's `onLoad` handler registering its own memory block).
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
    await this._ensureRestored();
    const opts = options ?? {};
    let provider = opts.provider;
    if (!provider) {
      if (!this._agent) {
        throw new Error(
          `addContext("${label}") requires an explicit provider when Session uses a SessionProvider`
        );
      }
      const key = this._sessionId ? `${label}_${this._sessionId}` : label;
      provider = new AgentContextProvider(this._agent, key);
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
   *
   * Async so that the session's background skill-state restore (which
   * reads conversation history) is awaited first — otherwise a freshly
   * rehydrated DO could report "not loaded" for a skill that's actually
   * present in history.
   */
  async unloadSkill(label: string, key: string): Promise<boolean> {
    await this._ensureRestored();
    return this.context.unloadSkill(label, key);
  }

  /**
   * Get currently loaded skill keys (as "label:key" strings).
   * Async for the same reason as `unloadSkill` — must wait for restore.
   */
  async getLoadedSkillKeys(): Promise<Set<string>> {
    await this._ensureRestored();
    return this.context.getLoadedSkillKeys();
  }

  // ── System Prompt ─────────────────────────────────────────────

  async freezeSystemPrompt(): Promise<string> {
    await this._ensureRestored();
    return this.context.freezeSystemPrompt();
  }

  async refreshSystemPrompt(): Promise<string> {
    await this._ensureRestored();
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
      createdAt?: string;
    }>
  > {
    await this._ensureRestored();
    if (!this.storage.searchMessages) {
      throw new Error("Session provider does not support search");
    }
    return this.storage.searchMessages(query, options?.limit ?? 20);
  }

  // ── Tools ─────────────────────────────────────────────────────

  /** Returns set_context and load_context tools. */
  async tools(): Promise<ToolSet> {
    await this._ensureRestored();
    return this.context.tools();
  }
}
