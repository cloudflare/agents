/**
 * Think — a unified Agent base class for chat sessions.
 *
 * Works as both a **top-level agent** (speaking the `cf_agent_chat_*`
 * WebSocket protocol to browser clients) and a **sub-agent** (called
 * via `chat()` over RPC from a parent agent).
 *
 * Each instance gets its own SQLite storage and runs the full chat
 * lifecycle:
 *   store user message → assemble context → call LLM → stream events → persist response
 *
 * Uses SessionManager for message persistence, giving you branching and
 * compaction support for free.
 *
 * Override points:
 *   - getModel()         — return the LanguageModel to use
 *   - getSystemPrompt()  — return the system prompt
 *   - getTools()         — return the ToolSet for the agentic loop
 *   - getMaxSteps()      — max tool-call rounds per turn (default: 10)
 *   - assembleContext()   — customize context assembly from this.messages
 *   - onChatMessage()    — full control over inference (override the agentic loop)
 *   - onChatError()      — customize error handling
 *
 * Production features:
 *   - WebSocket chat protocol (compatible with useAgentChat / useChat)
 *   - Multi-session management (create, switch, list, delete, rename)
 *   - Sub-agent RPC streaming via StreamCallback
 *   - Abort/cancel support via AbortSignal
 *   - Error handling with partial message persistence
 *   - Message sanitization (strips OpenAI ephemeral metadata)
 *   - Row size enforcement (compacts large tool outputs)
 *   - Configurable storage bounds (maxPersistedMessages)
 *   - Incremental persistence (skips unchanged messages)
 *   - Richer input (accepts UIMessage or string)
 *
 * @experimental Requires the `"experimental"` compatibility flag.
 *
 * @example
 * ```typescript
 * import { Think } from "@cloudflare/think";
 * import { createWorkersAI } from "workers-ai-provider";
 * import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
 * import { Workspace } from "@cloudflare/shell";
 *
 * export class ChatSession extends Think<Env> {
 *   workspace = new Workspace(this);
 *
 *   getModel() {
 *     return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.5");
 *   }
 *
 *   getTools() {
 *     return createWorkspaceTools(this.workspace);
 *   }
 * }
 * ```
 */

import type { LanguageModel, ModelMessage, ToolSet, UIMessage } from "ai";
import {
  convertToModelMessages,
  stepCountIs,
  streamText
} from "ai";
import {
  Agent,
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext
} from "agents";
import type { Connection, WSMessage } from "agents";
import type { Workspace } from "@cloudflare/shell";
import { withFibers } from "agents/experimental/forever";
import type { FiberMethods } from "agents/experimental/forever";
import { SessionManager } from "./session/index";
import type { SessionInfo } from "./session/index";
import { SqliteBlockProvider } from "agents/experimental/memory/session";
import type { ContextBlockConfig } from "agents/experimental/memory/session";
type Session = SessionInfo;
import { applyChunkToParts } from "./message-builder";
import type { StreamChunkData } from "./message-builder";
import { sanitizeMessage, enforceRowSizeLimit } from "./sanitize";

export type { Session } from "./session/index";
export type {
  FiberState,
  FiberRecoveryContext,
  FiberContext,
  FiberCompleteContext,
  FiberMethods
} from "agents/experimental/forever";

// ── Fiber base class ──────────────────────────────────────────────────
// Think extends withFibers(Agent) so fiber methods (spawnFiber, etc.)
// are always available on the prototype. The `fibers` flag controls
// whether interrupted fibers are recovered on start.
//
// The type cast preserves Agent's generic constructor while adding
// FiberMethods to the instance type, avoiding unsafe interface merging.
type ThinkBaseConstructor = {
  new <
    Env extends Cloudflare.Env = Cloudflare.Env,
    State = unknown,
    Props extends Record<string, unknown> = Record<string, unknown>
  >(
    ctx: DurableObjectState,
    env: Env
  ): Agent<Env, State, Props> & FiberMethods;
};

const ThinkBase = withFibers(Agent) as unknown as ThinkBaseConstructor;

// ── Wire protocol constants ────────────────────────────────────────
// These string values are wire-compatible with @cloudflare/ai-chat's
// MessageType enum. Defined locally to avoid a circular dependency.
const MSG_CHAT_MESSAGES = "cf_agent_chat_messages";
const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";
const MSG_CHAT_CLEAR = "cf_agent_chat_clear";
const MSG_CHAT_CANCEL = "cf_agent_chat_request_cancel";

/**
 * Callback interface for streaming chat events from a Think.
 *
 * Designed to work across the sub-agent RPC boundary — implement as
 * an RpcTarget in the parent agent and pass to `chat()`.
 *
 * Methods may return a Promise for async RPC callbacks.
 */
export interface StreamCallback {
  /** Called for each UIMessageChunk event during streaming. */
  onEvent(json: string): void | Promise<void>;
  /** Called when the stream completes successfully (not called on abort). */
  onDone(): void | Promise<void>;
  /** Called when an error occurs during streaming. */
  onError?(error: string): void | Promise<void>;
}

/**
 * Minimal interface for the result of `onChatMessage()`.
 * Must provide a `toUIMessageStream()` method that returns an
 * async-iterable stream of UI message chunks.
 *
 * The AI SDK's `streamText()` result satisfies this interface.
 */
export interface StreamableResult {
  toUIMessageStream(): AsyncIterable<unknown>;
}

/**
 * Options for a chat turn (sub-agent RPC entry point).
 */
export interface ChatOptions {
  /** AbortSignal — fires when the caller wants to cancel the turn. */
  signal?: AbortSignal;
  /** Extra tools to merge with getTools() for this turn only. */
  tools?: ToolSet;
}

/**
 * Options passed to the onChatMessage handler.
 */
export interface ChatMessageOptions {
  /** AbortSignal for cancelling the request */
  signal?: AbortSignal;
  /** Extra tools to merge with getTools() for this turn only. */
  tools?: ToolSet;
}

/**
 * A unified Agent base class for chat sessions.
 *
 * Works as both a top-level agent (WebSocket chat protocol) and a
 * sub-agent (RPC streaming via `chat()`).
 *
 * @experimental Requires the `"experimental"` compatibility flag.
 */
export class Think<
  Env extends Cloudflare.Env = Cloudflare.Env,
  Config = Record<string, unknown>
> extends (ThinkBase as ThinkBaseConstructor)<Env> {
  /** Session manager — persistence layer with branching and compaction. */
  sessions!: SessionManager;

  /** In-memory messages for the current conversation. Authoritative after load. */
  messages: UIMessage[] = [];

  /**
   * Enable durable fiber recovery on start. Set to `true` to
   * automatically recover interrupted fibers when the DO restarts.
   *
   * Fiber methods (`spawnFiber()`, `stashFiber()`, etc.) are always
   * available — this flag only controls automatic recovery.
   *
   * @experimental
   */
  fibers = false;

  /**
   * Maximum number of messages on the current branch before
   * onCompact() is called during assembleContext().
   * Set to `undefined` (default) for no limit.
   *
   * @deprecated Use SessionManagerOptions.maxContextMessages instead.
   */
  maxPersistedMessages: number | undefined = undefined;

  /**
   * Cache of last-persisted JSON for each message ID.
   * Used for incremental persistence: skip SQL writes for unchanged messages.
   * @internal
   */
  private _persistedMessageCache: Map<string, string> = new Map();

  private _sessionId: string | null = null;
  private _abortControllers = new Map<string, AbortController>();
  private _clearGeneration = 0;

  // ── Dynamic config ──────────────────────────────────────────────

  #configTableReady = false;
  #configCache: Config | null = null;

  private _ensureConfigTable(): void {
    if (this.#configTableReady) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS _think_config (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      )
    `;
    this.#configTableReady = true;
  }

  /**
   * Persist a typed configuration object.
   * Stored in SQLite so it survives restarts and hibernation.
   */
  configure(config: Config): void {
    this._ensureConfigTable();
    const json = JSON.stringify(config);
    this.sql`
      INSERT OR REPLACE INTO _think_config (key, value) VALUES ('config', ${json})
    `;
    this.#configCache = config;
  }

  /**
   * Read the persisted configuration, or null if never configured.
   */
  getConfig(): Config | null {
    if (this.#configCache) return this.#configCache;
    this._ensureConfigTable();
    const rows = this.sql<{ value: string }>`
      SELECT value FROM _think_config WHERE key = 'config'
    `;
    if (rows.length > 0) {
      this.#configCache = JSON.parse(rows[0].value) as Config;
      return this.#configCache;
    }
    return null;
  }

  onStart() {
    // Wire context blocks with SQLite-backed providers
    const blockDefs = this.getContextBlocks();
    const contextConfig: ContextBlockConfig[] = blockDefs.map((def) => ({
      ...def,
      provider: def.readonly ? undefined : new SqliteBlockProvider(this, def.label),
    }));

    this.sessions = new SessionManager(this, {
      exec: (query, ...values) => {
        this.ctx.storage.sql.exec(query, ...values);
      },
      sessionOptions: contextConfig.length > 0 ? { context: contextConfig } : undefined,
    });

    const existing = this.sessions.list();
    if (existing.length > 0) {
      this._sessionId = existing[0].id;
      this.messages = this.sessions.getHistory(this._sessionId);
      this._rebuildPersistenceCache();
    }
    this._setupProtocolHandlers();

    if (this.fibers) {
      void this.checkFibers();
    }
  }

  // ── Override points ──────────────────────────────────────────────

  /**
   * Return the language model to use for inference.
   * Must be overridden by subclasses that rely on the default
   * `onChatMessage` implementation (the agentic loop).
   */
  getModel(): LanguageModel {
    throw new Error(
      "Override getModel() to return a LanguageModel, or override onChatMessage() for full control."
    );
  }

  /**
   * Return the system prompt for the assistant.
   *
   * Default: renders context blocks as the system prompt (frozen snapshot).
   * If no context blocks are configured, returns a default prompt.
   * Override for full control over the system prompt.
   */
  getSystemPrompt(): string {
    // If we have a session with context blocks, use the frozen snapshot
    if (this._sessionId) {
      const session = this.sessions.getSession(this._sessionId);
      const contextPrompt = session.toSystemPrompt();
      if (contextPrompt) return contextPrompt;
    }
    return "You are a helpful assistant.";
  }

  /**
   * Return context block definitions for persistent memory.
   * Override to add blocks like memory, todos, user profile, etc.
   * Blocks are stored in DO SQLite automatically.
   *
   * ```typescript
   * getContextBlocks() {
   *   return [
   *     { label: "memory", description: "Learned facts", maxTokens: 1100 },
   *     { label: "todos", description: "Task list", maxTokens: 2000 },
   *     { label: "soul", defaultContent: "You are helpful.", readonly: true },
   *   ];
   * }
   * ```
   */
  getContextBlocks(): Omit<ContextBlockConfig, "provider">[] {
    return [];
  }

  /**
   * Return the tools available to the assistant.
   * Override to provide workspace tools, custom tools, etc.
   *
   * Context block tools (update_context) are merged in automatically
   * if getContextBlocks() returns any writable blocks.
   */
  getTools(): ToolSet {
    return {};
  }

  /**
   * Return the maximum number of tool-call steps per turn.
   */
  getMaxSteps(): number {
    return 10;
  }

  /**
   * Return the workspace instance for this session, or null if none.
   *
   * Override in subclasses that create a Workspace. Used by
   * HostBridgeLoopback to provide workspace access to extension Workers.
   */
  getWorkspace(): Workspace | null {
    return null;
  }

  // ── Workspace proxy methods (called by HostBridgeLoopback via RPC) ──

  async _hostReadFile(path: string): Promise<string | null> {
    const ws = this.getWorkspace();
    if (!ws) throw new Error("No workspace available on this agent");
    return ws.readFile(path);
  }

  async _hostWriteFile(path: string, content: string): Promise<void> {
    const ws = this.getWorkspace();
    if (!ws) throw new Error("No workspace available on this agent");
    await ws.writeFile(path, content);
  }

  async _hostDeleteFile(path: string): Promise<boolean> {
    const ws = this.getWorkspace();
    if (!ws) throw new Error("No workspace available on this agent");
    return ws.deleteFile(path);
  }

  async _hostListFiles(
    dir: string
  ): Promise<
    Array<{ name: string; type: string; size: number; path: string }>
  > {
    const ws = this.getWorkspace();
    if (!ws) throw new Error("No workspace available on this agent");
    return ws.readDir(dir);
  }

  /**
   * Assemble the model messages from the current conversation history.
   *
   * Checks if compaction is needed and runs onCompact() if so.
   * Then reloads history (which applies compaction overlays)
   * and converts to model format.
   *
   * Override to customize context assembly.
   */
  async assembleContext(): Promise<ModelMessage[]> {
    if (this._sessionId && this.sessions.needsCompaction(this._sessionId)) {
      await this.onCompact();
      this.messages = this.sessions.getHistory(this._sessionId);
    }

    return convertToModelMessages(this.messages);
  }

  /**
   * Called when the conversation exceeds maxContextMessages.
   *
   * Default: no-op (compaction is opt-in).
   * Override to generate a summary and split the session:
   *
   * ```typescript
   * async onCompact() {
   *   const history = this.sessions.getHistory(this._sessionId!);
   *   const summary = await generateText({ model: this.getModel(), prompt: buildSummaryPrompt(history) });
   *   const newSession = this.sessions.compactAndSplit(this._sessionId!, summary.text);
   *   this._sessionId = newSession.id;
   * }
   * ```
   */
  async onCompact(): Promise<void> {
    // No-op by default — override to implement
  }

  /**
   * Handle a chat turn and return the streaming result.
   *
   * The default implementation runs the agentic loop:
   * 1. Assemble context from `this.messages`
   * 2. Call `streamText` with the model, system prompt, tools, and step limit
   *
   * Override for full control over inference (e.g. different models per turn,
   * RAG pipelines, routing to specialized sub-agents, etc.).
   *
   * When this is called, `this.messages` already contains the user's
   * latest message persisted to the current session.
   *
   * @returns A result with `toUIMessageStream()` — AI SDK's `streamText()`
   *          return value satisfies this interface.
   */
  async onChatMessage(options?: ChatMessageOptions): Promise<StreamableResult> {
    const baseTools = this.getTools();
    // Merge context block tools (update_context) if configured
    const contextTools = this._sessionId
      ? this.sessions.getSession(this._sessionId).tools()
      : {};
    const tools = { ...baseTools, ...contextTools, ...options?.tools };

    return streamText({
      model: this.getModel(),
      system: this.getSystemPrompt(),
      messages: await this.assembleContext(),
      tools,
      stopWhen: stepCountIs(this.getMaxSteps()),
      abortSignal: options?.signal
    });
  }

  /**
   * Handle an error that occurred during a chat turn.
   * Override to customize error handling (e.g. logging, metrics).
   *
   * @param error The error that occurred
   * @returns The error (or a wrapped version) to propagate
   */
  onChatError(error: unknown): unknown {
    return error;
  }

  // ── Sub-agent RPC entry point ───────────────────────────────────

  /**
   * Run a chat turn: persist the user message, run the agentic loop,
   * stream UIMessageChunk events via callback, and persist the
   * assistant's response.
   *
   * On error or abort, the partial assistant message is still persisted
   * so the user doesn't lose context.
   *
   * @param userMessage The user's message (string or UIMessage for multi-modal)
   * @param callback Streaming callback (typically an RpcTarget from the parent)
   * @param options Optional chat options (e.g. AbortSignal)
   */
  async chat(
    userMessage: string | UIMessage,
    callback: StreamCallback,
    options?: ChatOptions
  ): Promise<void> {
    // Ensure a session exists
    if (!this._sessionId) {
      const session = this.sessions.create("default");
      this._sessionId = session.id;
    }

    // Persist user message
    const userMsg: UIMessage =
      typeof userMessage === "string"
        ? {
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text: userMessage }]
          }
        : userMessage;

    this.sessions.append(this._sessionId, userMsg);
    this.messages = this.sessions.getHistory(this._sessionId);

    // Build assistant message from stream chunks
    const assistantMsg: UIMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: []
    };

    try {
      // Run the agentic loop (or custom override)
      const result = await this.onChatMessage({
        signal: options?.signal,
        tools: options?.tools
      });

      // Stream UIMessageChunk events via callback
      let aborted = false;
      for await (const chunk of result.toUIMessageStream()) {
        if (options?.signal?.aborted) {
          aborted = true;
          break;
        }
        applyChunkToParts(
          assistantMsg.parts,
          chunk as unknown as StreamChunkData
        );
        await callback.onEvent(JSON.stringify(chunk));
      }

      // Persist assistant message (sanitized + size-enforced)
      this._persistAssistantMessage(assistantMsg);

      // Only signal completion if not aborted
      if (!aborted) {
        await callback.onDone();
      }
    } catch (error) {
      // Persist partial assistant message so context isn't lost
      if (assistantMsg.parts.length > 0) {
        this._persistAssistantMessage(assistantMsg);
      }

      const wrapped = this.onChatError(error);
      const errorMessage =
        wrapped instanceof Error ? wrapped.message : String(wrapped);

      if (callback.onError) {
        await callback.onError(errorMessage);
      } else {
        // Re-throw if no error callback — caller must handle it
        throw wrapped;
      }
    }
  }

  // ── Session management ─────────────────────────────────────────

  getSessions(): Session[] {
    return this.sessions.list();
  }

  createSession(name: string): Session {
    const session = this.sessions.create(name);
    this._sessionId = session.id;
    this.messages = [];
    this._broadcastMessages();
    return session;
  }

  switchSession(sessionId: string): UIMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this._sessionId = sessionId;
    this.messages = this.sessions.getHistory(sessionId);
    this._broadcastMessages();
    return this.messages;
  }

  deleteSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.sessions.delete(sessionId);
    if (this._sessionId === sessionId) {
      this._sessionId = null;
      this.messages = [];
      this._broadcastMessages();
    }
  }

  renameSession(sessionId: string, name: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.sessions.rename(sessionId, name);
  }

  getCurrentSessionId(): string | null {
    return this._sessionId;
  }

  // ── Message access ───────────────────────────────────────────────

  /**
   * Get the current session info, or null if no session exists yet.
   */
  getSession(): Session | null {
    if (!this._sessionId) return null;
    return this.sessions.get(this._sessionId);
  }

  /**
   * Get the conversation history as UIMessage[].
   */
  getHistory(): UIMessage[] {
    if (!this._sessionId) return [];
    return this.sessions.getHistory(this._sessionId);
  }

  /**
   * Get the total message count for this session.
   */
  getMessageCount(): number {
    if (!this._sessionId) return 0;
    return this.sessions.getMessageCount(this._sessionId);
  }

  /**
   * Clear all messages from this session (preserves the session itself).
   */
  clearMessages(): void {
    if (!this._sessionId) return;
    this.sessions.clearMessages(this._sessionId);
    this.messages = [];
    this._persistedMessageCache.clear();
  }

  // ── WebSocket protocol ──────────────────────────────────────────

  /**
   * Wrap onMessage and onRequest to intercept the chat protocol.
   * Unrecognized messages are forwarded to the user's handlers.
   * @internal
   */
  private _setupProtocolHandlers() {
    const _onMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      if (typeof message === "string") {
        try {
          const data = JSON.parse(message) as Record<string, unknown>;
          if (await this._handleProtocol(connection, data)) return;
        } catch {
          // Not JSON — fall through to user handler
        }
      }
      return _onMessage(connection, message);
    };

    const _onRequest = this.onRequest.bind(this);
    this.onRequest = async (request: Request) => {
      const url = new URL(request.url);
      if (
        url.pathname === "/get-messages" ||
        url.pathname.endsWith("/get-messages")
      ) {
        const sessionId = url.searchParams.get("sessionId");
        if (sessionId) {
          const session = this.sessions.get(sessionId);
          if (!session) {
            return Response.json(
              { error: "Session not found" },
              { status: 404 }
            );
          }
          return Response.json(this.sessions.getHistory(sessionId));
        }
        return Response.json(this.messages);
      }
      return _onRequest(request);
    };
  }

  /**
   * Route an incoming WebSocket message to the appropriate handler.
   * Returns true if the message was handled by the protocol.
   * @internal
   */
  private async _handleProtocol(
    connection: Connection,
    data: Record<string, unknown>
  ): Promise<boolean> {
    const type = data.type as string;

    if (type === MSG_CHAT_REQUEST) {
      const init = data.init as { method?: string; body?: string } | undefined;
      if (init?.method === "POST") {
        await this._handleChatRequest(connection, data);
        return true;
      }
    }

    if (type === MSG_CHAT_CLEAR) {
      this._handleClear();
      return true;
    }

    if (type === MSG_CHAT_CANCEL) {
      this._handleCancel(data.id as string);
      return true;
    }

    return false;
  }

  /**
   * Handle CF_AGENT_USE_CHAT_REQUEST:
   * 1. Parse incoming messages
   * 2. Ensure a session exists
   * 3. Persist user messages to session
   * 4. Call onChatMessage
   * 5. Stream response back to clients
   * 6. Persist assistant message to session
   * @internal
   */
  private async _handleChatRequest(
    connection: Connection,
    data: Record<string, unknown>
  ) {
    const init = data.init as { body?: string };
    if (!init?.body) return;

    let parsed: { messages?: UIMessage[] };
    try {
      parsed = JSON.parse(init.body) as { messages?: UIMessage[] };
    } catch {
      return;
    }

    const incomingMessages = parsed.messages;
    if (!Array.isArray(incomingMessages)) return;

    // Ensure a session exists — title from first user message
    if (!this._sessionId) {
      const firstUserMsg = incomingMessages.find((m) => m.role === "user");
      const title = firstUserMsg
        ? this._titleFromMessage(firstUserMsg)
        : "New Chat";
      const session = this.sessions.create(title);
      this._sessionId = session.id;
    }

    // Persist incoming messages to session (idempotent via INSERT OR IGNORE)
    this.sessions.appendAll(this._sessionId, incomingMessages);

    // Reload from session (authoritative)
    this.messages = this.sessions.getHistory(this._sessionId);

    // Broadcast updated messages to other connections
    this._broadcastMessages([connection.id]);

    // Set up abort controller
    const requestId = data.id as string;
    const abortController = new AbortController();
    this._abortControllers.set(requestId, abortController);

    try {
      await this.keepAliveWhile(async () => {
        const result = await agentContext.run(
          { agent: this, connection, request: undefined, email: undefined },
          () =>
            this.onChatMessage({
              signal: abortController.signal
            })
        );

        if (result) {
          await this._streamResult(requestId, result, abortController.signal);
        } else {
          this._broadcast({
            type: MSG_CHAT_RESPONSE,
            id: requestId,
            body: "No response was generated.",
            done: true
          });
        }
      });
    } catch (error) {
      this._broadcast({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body: error instanceof Error ? error.message : "Error",
        done: true,
        error: true
      });
    } finally {
      this._abortControllers.delete(requestId);
    }
  }

  /**
   * Handle CF_AGENT_CHAT_CLEAR: abort streams, clear current session messages.
   * @internal
   */
  private _handleClear() {
    for (const controller of this._abortControllers.values()) {
      controller.abort();
    }
    this._abortControllers.clear();

    if (this._sessionId) {
      this.sessions.clearMessages(this._sessionId);
    }

    this.messages = [];
    this._persistedMessageCache.clear();
    this._clearGeneration++;
    this._broadcast({ type: MSG_CHAT_CLEAR });
  }

  /**
   * Handle CF_AGENT_CHAT_REQUEST_CANCEL: abort a specific request.
   * @internal
   */
  private _handleCancel(requestId: string) {
    const controller = this._abortControllers.get(requestId);
    if (controller) {
      controller.abort();
    }
  }

  /**
   * Iterate a StreamableResult, broadcast chunks to clients,
   * build a UIMessage, and persist it to the session.
   * @internal
   */
  private async _streamResult(
    requestId: string,
    result: StreamableResult,
    abortSignal?: AbortSignal
  ) {
    const clearGen = this._clearGeneration;

    const message: UIMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: []
    };

    let doneSent = false;

    try {
      for await (const chunk of result.toUIMessageStream()) {
        if (abortSignal?.aborted) break;

        const data = chunk as StreamChunkData;

        // Build UIMessage from stream events
        const handled = applyChunkToParts(message.parts, data);

        if (!handled) {
          // Handle metadata events that applyChunkToParts doesn't cover
          switch (data.type) {
            case "start": {
              if (data.messageId != null) {
                message.id = data.messageId;
              }
              if (data.messageMetadata != null) {
                message.metadata = message.metadata
                  ? { ...message.metadata, ...data.messageMetadata }
                  : data.messageMetadata;
              }
              break;
            }
            case "finish": {
              if (data.messageMetadata != null) {
                message.metadata = message.metadata
                  ? { ...message.metadata, ...data.messageMetadata }
                  : data.messageMetadata;
              }
              // Track usage
              const usage = (data as Record<string, unknown>).usage as
                { promptTokens?: number; completionTokens?: number } | undefined;
              if (usage && this._sessionId) {
                this.sessions.addUsage(
                  this._sessionId,
                  usage.promptTokens ?? 0,
                  usage.completionTokens ?? 0,
                  0 // cost not available from stream
                );
              }
              break;
            }
            case "message-metadata": {
              if (data.messageMetadata != null) {
                message.metadata = message.metadata
                  ? { ...message.metadata, ...data.messageMetadata }
                  : data.messageMetadata;
              }
              break;
            }
            case "error": {
              this._broadcast({
                type: MSG_CHAT_RESPONSE,
                id: requestId,
                body: data.errorText ?? JSON.stringify(data),
                done: false,
                error: true
              });
              continue;
            }
          }
        }

        // Broadcast chunk to clients
        this._broadcast({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: JSON.stringify(chunk),
          done: false
        });
      }

      this._broadcast({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body: "",
        done: true
      });
      doneSent = true;
    } catch (error) {
      if (!doneSent) {
        this._broadcast({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: error instanceof Error ? error.message : "Stream error",
          done: true,
          error: true
        });
        doneSent = true;
      }
    } finally {
      if (!doneSent) {
        this._broadcast({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: "",
          done: true
        });
      }
    }

    // Persist the assistant message to the session (sanitized + size-enforced).
    // Skip if a clear happened during this stream (clearGeneration changed).
    // Wrapped in try-catch: the stream done message was already sent above,
    // so a persistence error must not propagate to the outer catch (which
    // would broadcast a second done message).
    if (
      message.parts.length > 0 &&
      this._sessionId &&
      this._clearGeneration === clearGen
    ) {
      try {
        this._persistAssistantMessage(message);
        this._broadcastMessages();
      } catch (e) {
        console.error("Failed to persist assistant message:", e);
      }
    }
  }

  // ── Persistence internals ────────────────────────────────────────

  /**
   * Persist an assistant message with sanitization, size enforcement,
   * and incremental persistence.
   * @internal
   */
  private _persistAssistantMessage(msg: UIMessage): void {
    if (!this._sessionId) return;

    const sanitized = sanitizeMessage(msg);
    const safe = enforceRowSizeLimit(sanitized);
    const json = JSON.stringify(safe);

    // Skip SQL write if unchanged (incremental persistence)
    if (this._persistedMessageCache.get(safe.id) !== json) {
      this.sessions.upsert(this._sessionId, safe);
      this._persistedMessageCache.set(safe.id, json);
    }


    this.messages = this.sessions.getHistory(this._sessionId);
  }

  /**
   * Rebuild the persistence cache from current messages.
   * Called on startup to enable incremental persistence.
   * @internal
   */
  private _rebuildPersistenceCache(): void {
    this._persistedMessageCache.clear();
    for (const msg of this.messages) {
      this._persistedMessageCache.set(msg.id, JSON.stringify(msg));
    }
  }


  /**
   * Generate a session title from the first user message.
   * @internal
   */
  private _titleFromMessage(msg: UIMessage): string {
    const text = msg.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join(" ");
    return text.slice(0, 60) || "New Chat";
  }

  /**
   * Broadcast a JSON message to all connected clients.
   * @internal
   */
  private _broadcast(message: Record<string, unknown>, exclude?: string[]) {
    this.broadcast(JSON.stringify(message), exclude);
  }

  /**
   * Broadcast the current message list to all connected clients.
   * @internal
   */
  private _broadcastMessages(exclude?: string[]) {
    this._broadcast(
      { type: MSG_CHAT_MESSAGES, messages: this.messages },
      exclude
    );
  }
}
