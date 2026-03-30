/**
 * Think — an opinionated chat agent base class.
 *
 * Works as both a **top-level agent** (speaking the `cf_agent_chat_*`
 * WebSocket protocol to browser clients) and a **sub-agent** (called
 * via `chat()` over RPC from a parent agent).
 *
 * Each instance gets its own SQLite storage and runs the full chat
 * lifecycle:
 *   store user message → assemble context → call LLM → stream events → persist response
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
 *   - Sub-agent RPC streaming via StreamCallback
 *   - Abort/cancel support via AbortSignal
 *   - Error handling with partial message persistence
 *   - Message sanitization (strips OpenAI ephemeral metadata)
 *   - Row size enforcement (compacts large tool outputs)
 *   - Configurable storage bounds (maxPersistedMessages)
 *   - Incremental persistence (skips unchanged messages)
 *
 * @experimental Requires the `"experimental"` compatibility flag.
 *
 * @example
 * ```typescript
 * import { Think } from "@cloudflare/think";
 * import { createWorkersAI } from "workers-ai-provider";
 *
 * export class MyAgent extends Think<Env> {
 *   getModel() {
 *     return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.5");
 *   }
 *
 *   getSystemPrompt() {
 *     return "You are a helpful coding assistant.";
 *   }
 * }
 * ```
 */

import type { LanguageModel, ModelMessage, ToolSet, UIMessage } from "ai";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText
} from "ai";
import {
  Agent,
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext
} from "agents";
import type { Connection, WSMessage } from "agents";
import { withFibers } from "agents/experimental/forever";
import type { FiberMethods } from "agents/experimental/forever";
import {
  sanitizeMessage,
  enforceRowSizeLimit,
  StreamAccumulator,
  CHAT_MESSAGE_TYPES,
  TurnQueue
} from "agents/chat";
import type { StreamChunkData } from "agents/chat";

export type {
  FiberState,
  FiberRecoveryContext,
  FiberContext,
  FiberCompleteContext,
  FiberMethods
} from "agents/experimental/forever";

// ── Fiber base class ──────────────────────────────────────────────────
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
const MSG_CHAT_MESSAGES = CHAT_MESSAGE_TYPES.CHAT_MESSAGES;
const MSG_CHAT_REQUEST = CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST;
const MSG_CHAT_RESPONSE = CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE;
const MSG_CHAT_CLEAR = CHAT_MESSAGE_TYPES.CHAT_CLEAR;
const MSG_CHAT_CANCEL = CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL;

/**
 * Callback interface for streaming chat events from a Think sub-agent.
 *
 * Designed to work across the sub-agent RPC boundary — implement as
 * an RpcTarget in the parent agent and pass to `chat()`.
 */
export interface StreamCallback {
  onEvent(json: string): void | Promise<void>;
  onDone(): void | Promise<void>;
  onError?(error: string): void | Promise<void>;
}

/**
 * Minimal interface for the result of `onChatMessage()`.
 * The AI SDK's `streamText()` result satisfies this interface.
 */
export interface StreamableResult {
  toUIMessageStream(): AsyncIterable<unknown>;
}

/**
 * Options for a chat turn (sub-agent RPC entry point).
 */
export interface ChatOptions {
  signal?: AbortSignal;
  tools?: ToolSet;
}

/**
 * Options passed to the onChatMessage handler.
 */
export interface ChatMessageOptions {
  signal?: AbortSignal;
  tools?: ToolSet;
}

/**
 * An opinionated chat agent base class.
 *
 * @experimental Requires the `"experimental"` compatibility flag.
 */
export class Think<
  Env extends Cloudflare.Env = Cloudflare.Env,
  Config = Record<string, unknown>
> extends (ThinkBase as ThinkBaseConstructor)<Env> {
  /** In-memory messages for the current conversation. Authoritative after load. */
  messages: UIMessage[] = [];

  /**
   * Enable durable fiber recovery on start. Set to `true` to
   * automatically recover interrupted fibers when the DO restarts.
   *
   * @experimental
   */
  fibers = false;

  /**
   * Maximum number of messages to keep in storage.
   * When exceeded, oldest messages are deleted after each persist.
   * Set to `undefined` (default) for no limit.
   *
   * This controls storage only — it does not affect what's sent to the LLM.
   * Use `pruneMessages()` in `assembleContext()` to control LLM context.
   */
  maxPersistedMessages: number | undefined = undefined;

  private _persistedMessageCache: Map<string, string> = new Map();
  private _storageReady = false;
  private _abortControllers = new Map<string, AbortController>();
  private _turnQueue = new TurnQueue();

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

  // ── Lifecycle ───────────────────────────────────────────────────

  onStart() {
    this._initStorage();
    this.messages = this._loadMessages();
    this._rebuildPersistenceCache();
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

  /** Return the system prompt for the assistant. */
  getSystemPrompt(): string {
    return "You are a helpful assistant.";
  }

  /** Return the tools available to the assistant. */
  getTools(): ToolSet {
    return {};
  }

  /** Return the maximum number of tool-call steps per turn. */
  getMaxSteps(): number {
    return 10;
  }

  /**
   * Assemble the model messages from the current conversation history.
   * Override to customize context assembly (e.g. inject memory,
   * project context, or apply compaction).
   */
  async assembleContext(): Promise<ModelMessage[]> {
    return pruneMessages({
      messages: await convertToModelMessages(this.messages),
      toolCalls: "before-last-2-messages"
    });
  }

  /**
   * Handle a chat turn and return the streaming result.
   *
   * The default implementation runs the agentic loop:
   * 1. Assemble context from `this.messages`
   * 2. Call `streamText` with the model, system prompt, tools, and step limit
   *
   * Override for full control over inference.
   *
   * @returns A result with `toUIMessageStream()` — AI SDK's `streamText()`
   *          return value satisfies this interface.
   */
  async onChatMessage(options?: ChatMessageOptions): Promise<StreamableResult> {
    const baseTools = this.getTools();
    const tools = options?.tools
      ? { ...baseTools, ...options.tools }
      : baseTools;
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
   * @param userMessage The user's message (string or UIMessage)
   * @param callback Streaming callback (typically an RpcTarget from the parent)
   * @param options Optional chat options (e.g. AbortSignal)
   */
  async chat(
    userMessage: string | UIMessage,
    callback: StreamCallback,
    options?: ChatOptions
  ): Promise<void> {
    const requestId = crypto.randomUUID();

    await this._turnQueue.enqueue(requestId, async () => {
      const userMsg: UIMessage =
        typeof userMessage === "string"
          ? {
              id: crypto.randomUUID(),
              role: "user",
              parts: [{ type: "text", text: userMessage }]
            }
          : userMessage;

      this._appendMessage(userMsg);
      this.messages = this._loadMessages();

      const accumulator = new StreamAccumulator({
        messageId: crypto.randomUUID()
      });

      try {
        const result = await this.onChatMessage({
          signal: options?.signal,
          tools: options?.tools
        });

        let aborted = false;
        for await (const chunk of result.toUIMessageStream()) {
          if (options?.signal?.aborted) {
            aborted = true;
            break;
          }
          accumulator.applyChunk(chunk as unknown as StreamChunkData);
          await callback.onEvent(JSON.stringify(chunk));
        }

        this._persistAssistantMessage(accumulator.toMessage());

        if (!aborted) {
          await callback.onDone();
        }
      } catch (error) {
        if (accumulator.parts.length > 0) {
          this._persistAssistantMessage(accumulator.toMessage());
        }

        const wrapped = this.onChatError(error);
        const errorMessage =
          wrapped instanceof Error ? wrapped.message : String(wrapped);

        if (callback.onError) {
          await callback.onError(errorMessage);
        } else {
          throw wrapped;
        }
      }
    });
  }

  // ── Message access ──────────────────────────────────────────────

  /** Get the conversation history as UIMessage[]. */
  getMessages(): UIMessage[] {
    return this.messages;
  }

  /** Clear all messages from storage and memory. */
  clearMessages(): void {
    this._clearMessages();
    this.messages = [];
    this._persistedMessageCache.clear();
  }

  // ── WebSocket protocol ──────────────────────────────────────────

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
        return Response.json(this.messages);
      }
      return _onRequest(request);
    };
  }

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

    for (const msg of incomingMessages) {
      this._appendMessage(msg);
    }
    this.messages = this._loadMessages();

    this._broadcastMessages([connection.id]);

    const requestId = data.id as string;
    const abortController = new AbortController();
    this._abortControllers.set(requestId, abortController);

    try {
      await this.keepAliveWhile(async () => {
        await this._turnQueue.enqueue(requestId, async () => {
          const result = await agentContext.run(
            {
              agent: this,
              connection,
              request: undefined,
              email: undefined
            },
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

  private _handleClear() {
    this._turnQueue.reset();

    for (const controller of this._abortControllers.values()) {
      controller.abort();
    }
    this._abortControllers.clear();

    this._clearMessages();
    this.messages = [];
    this._persistedMessageCache.clear();
    this._broadcast({ type: MSG_CHAT_CLEAR });
  }

  private _handleCancel(requestId: string) {
    const controller = this._abortControllers.get(requestId);
    if (controller) {
      controller.abort();
    }
  }

  private async _streamResult(
    requestId: string,
    result: StreamableResult,
    abortSignal?: AbortSignal
  ) {
    const clearGen = this._turnQueue.generation;

    const accumulator = new StreamAccumulator({
      messageId: crypto.randomUUID()
    });

    let doneSent = false;

    try {
      for await (const chunk of result.toUIMessageStream()) {
        if (abortSignal?.aborted) break;

        const { action } = accumulator.applyChunk(
          chunk as unknown as StreamChunkData
        );

        if (action?.type === "error") {
          this._broadcast({
            type: MSG_CHAT_RESPONSE,
            id: requestId,
            body: action.error,
            done: false,
            error: true
          });
          continue;
        }

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

    if (
      accumulator.parts.length > 0 &&
      this._turnQueue.generation === clearGen
    ) {
      try {
        this._persistAssistantMessage(accumulator.toMessage());
        this._broadcastMessages();
      } catch (e) {
        console.error("Failed to persist assistant message:", e);
      }
    }
  }

  // ── Storage internals ───────────────────────────────────────────

  private _initStorage(): void {
    if (this._storageReady) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS assistant_messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    this._storageReady = true;
  }

  private _loadMessages(): UIMessage[] {
    const rows = this.sql<{ content: string }>`
      SELECT content FROM assistant_messages ORDER BY created_at ASC
    `;
    return rows.map((row) => JSON.parse(row.content) as UIMessage);
  }

  private _appendMessage(msg: UIMessage): void {
    const json = JSON.stringify(msg);
    this.sql`
      INSERT OR IGNORE INTO assistant_messages (id, role, content)
      VALUES (${msg.id}, ${msg.role}, ${json})
    `;
    this._persistedMessageCache.set(msg.id, json);
  }

  private _upsertMessage(msg: UIMessage): void {
    const json = JSON.stringify(msg);
    this.sql`
      INSERT OR REPLACE INTO assistant_messages (id, role, content)
      VALUES (${msg.id}, ${msg.role}, ${json})
    `;
    this._persistedMessageCache.set(msg.id, json);
  }

  private _clearMessages(): void {
    this.sql`DELETE FROM assistant_messages`;
  }

  private _deleteMessages(ids: string[]): void {
    for (const id of ids) {
      this.sql`DELETE FROM assistant_messages WHERE id = ${id}`;
    }
  }

  private _persistAssistantMessage(msg: UIMessage): void {
    const sanitized = sanitizeMessage(msg);
    const safe = enforceRowSizeLimit(sanitized);
    const json = JSON.stringify(safe);

    if (this._persistedMessageCache.get(safe.id) !== json) {
      this._upsertMessage(safe);
    }

    if (this.maxPersistedMessages != null) {
      this._enforceMaxPersistedMessages();
    }

    this.messages = this._loadMessages();
  }

  private _rebuildPersistenceCache(): void {
    this._persistedMessageCache.clear();
    for (const msg of this.messages) {
      this._persistedMessageCache.set(msg.id, JSON.stringify(msg));
    }
  }

  private _enforceMaxPersistedMessages(): void {
    if (this.maxPersistedMessages == null) return;

    const history = this._loadMessages();
    if (history.length <= this.maxPersistedMessages) return;

    const excess = history.length - this.maxPersistedMessages;
    const toRemove = history.slice(0, excess);

    this._deleteMessages(toRemove.map((m) => m.id));
    for (const msg of toRemove) {
      this._persistedMessageCache.delete(msg.id);
    }
  }

  private _broadcast(message: Record<string, unknown>, exclude?: string[]) {
    this.broadcast(JSON.stringify(message), exclude);
  }

  private _broadcastMessages(exclude?: string[]) {
    this._broadcast(
      { type: MSG_CHAT_MESSAGES, messages: this.messages },
      exclude
    );
  }
}
