/**
 * Think — an opinionated chat agent base class.
 *
 * Works as both a **top-level agent** (speaking the `cf_agent_chat_*`
 * WebSocket protocol to browser clients) and a **sub-agent** (called
 * via `chat()` over RPC from a parent agent).
 *
 * Each instance gets its own SQLite storage backed by Session — providing
 * tree-structured messages, context blocks, compaction, FTS5 search, and
 * multi-session support.
 *
 * Override points:
 *   - getModel()            — return the LanguageModel to use
 *   - getSystemPrompt()     — return the system prompt (fallback when no context blocks)
 *   - getTools()            — return the ToolSet for the agentic loop
 *   - getMaxSteps()         — max tool-call rounds per turn (default: 10)
 *   - configureSession()    — add context blocks, compaction, search, skills
 *   - assembleContext()     — customize context assembly (system prompt + messages)
 *   - onChatMessage()       — full control over inference (override the agentic loop)
 *   - onChatResponse()      — post-turn lifecycle hook (logging, chaining, analytics)
 *   - onChatError()         — customize error handling
 *
 * Production features:
 *   - WebSocket chat protocol (compatible with useAgentChat / useChat)
 *   - Sub-agent RPC streaming via StreamCallback
 *   - Session-backed storage with tree-structured messages
 *   - Context blocks with LLM-writable persistent memory
 *   - Non-destructive compaction (summaries replace ranges at read time)
 *   - FTS5 full-text search across conversation history
 *   - Abort/cancel support via AbortRegistry
 *   - Error handling with partial message persistence
 *   - Message sanitization (strips OpenAI ephemeral metadata)
 *   - Row size enforcement (compacts large tool outputs)
 *   - Resumable streams (replay on reconnect)
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
 *
 * @example With context blocks and self-updating memory
 * ```typescript
 * import { Think } from "@cloudflare/think";
 * import type { Session } from "@cloudflare/think";
 *
 * export class MemoryAgent extends Think<Env> {
 *   getModel() { ... }
 *
 *   configureSession(session: Session) {
 *     return session
 *       .withContext("soul", {
 *         provider: { get: async () => "You are a helpful coding assistant." }
 *       })
 *       .withContext("memory", {
 *         description: "Important facts learned during conversation.",
 *         maxTokens: 2000
 *       })
 *       .withCachedPrompt();
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
import type { FiberContext, FiberRecoveryContext } from "agents";
import {
  sanitizeMessage,
  enforceRowSizeLimit,
  StreamAccumulator,
  CHAT_MESSAGE_TYPES,
  TurnQueue,
  ResumableStream,
  ContinuationState,
  createToolsFromClientSchemas,
  AbortRegistry,
  applyToolUpdate,
  toolResultUpdate,
  toolApprovalUpdate,
  parseProtocolMessage
} from "agents/chat";
import type { StreamChunkData, ClientToolSchema } from "agents/chat";
import { Session } from "agents/experimental/memory/session";
import { truncateOlderMessages } from "agents/experimental/memory/utils";

export { Session } from "agents/experimental/memory/session";
export type { FiberContext, FiberRecoveryContext } from "agents";

// ── Wire protocol constants ────────────────────────────────────────
const MSG_CHAT_MESSAGES = CHAT_MESSAGE_TYPES.CHAT_MESSAGES;
const MSG_CHAT_RESPONSE = CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE;
const MSG_CHAT_CLEAR = CHAT_MESSAGE_TYPES.CHAT_CLEAR;
const MSG_STREAM_RESUMING = CHAT_MESSAGE_TYPES.STREAM_RESUMING;
const MSG_STREAM_RESUME_NONE = CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE;
const MSG_MESSAGE_UPDATED = CHAT_MESSAGE_TYPES.MESSAGE_UPDATED;

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
  /** Client-provided tool schemas for dynamic tool registration. */
  clientTools?: ClientToolSchema[];
  /** True when this is a continuation (auto-continue after tool result, recovery). */
  continuation?: boolean;
}

/**
 * Result passed to `onChatResponse` after a chat turn completes.
 */
export type ChatResponseResult = {
  message: UIMessage;
  requestId: string;
  continuation: boolean;
  status: "completed" | "error" | "aborted";
  error?: string;
};

/**
 * An opinionated chat agent base class.
 *
 * @experimental Requires the `"experimental"` compatibility flag.
 */
export class Think<
  Env extends Cloudflare.Env = Cloudflare.Env,
  Config = Record<string, unknown>
> extends Agent<Env> {
  /**
   * Wait for MCP server connections to be ready before calling
   * `onChatMessage`. When enabled, `this.mcp.getAITools()` returns
   * the full set of MCP-discovered tools inside `onChatMessage`.
   *
   * Set to `true` for a default 10s timeout, or `{ timeout: ms }`
   * for a custom timeout. Defaults to `false` (no waiting).
   */
  waitForMcpConnections: boolean | { timeout: number } = false;

  /** The conversation session — messages, context, compaction, search. */
  session!: Session;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const _onStart = this.onStart.bind(this);
    this.onStart = async () => {
      const baseSession = Session.create(this);
      this.session = await this.configureSession(baseSession);

      // Force Session to initialize its tables (assistant_messages,
      // assistant_config, etc.) so that subsequent config reads work.
      this.session.getHistory();

      this._resumableStream = new ResumableStream(this.sql.bind(this));
      this._restoreClientTools();
      this._setupProtocolHandlers();

      await _onStart();
    };
  }

  /**
   * Conversation history. Computed from the active session.
   * Always fresh — reads from Session's tree-structured storage.
   */
  get messages(): UIMessage[] {
    return this.session.getHistory();
  }

  private _aborts = new AbortRegistry();
  private _turnQueue = new TurnQueue();
  private _resumableStream!: ResumableStream;
  private _pendingResumeConnections: Set<string> = new Set();
  private _lastClientTools: ClientToolSchema[] | undefined;
  private _continuation = new ContinuationState();
  private _continuationTimer: ReturnType<typeof setTimeout> | null = null;
  private _insideResponseHook = false;

  // ── Dynamic config ──────────────────────────────────────────────

  #configCache: Config | null = null;

  /**
   * Persist a typed configuration object.
   * Stored in Session's assistant_config table — survives restarts and hibernation.
   */
  configure(config: Config): void {
    const json = JSON.stringify(config);
    this._configSet("_think_config", json);
    this.#configCache = config;
  }

  /**
   * Read the persisted configuration, or null if never configured.
   */
  getConfig(): Config | null {
    if (this.#configCache) return this.#configCache;
    const raw = this._configGet("_think_config");
    if (raw !== undefined) {
      this.#configCache = JSON.parse(raw) as Config;
      return this.#configCache;
    }
    return null;
  }

  // ── Config storage helpers (assistant_config table) ─────────────

  private _configSet(key: string, value: string): void {
    const sessionId = this._sessionId();
    this.sql`
      INSERT OR REPLACE INTO assistant_config (session_id, key, value)
      VALUES (${sessionId}, ${key}, ${value})
    `;
  }

  private _configGet(key: string): string | undefined {
    const sessionId = this._sessionId();
    const rows = this.sql<{ value: string }>`
      SELECT value FROM assistant_config
      WHERE session_id = ${sessionId} AND key = ${key}
    `;
    return rows[0]?.value;
  }

  private _configDelete(key: string): void {
    const sessionId = this._sessionId();
    this.sql`
      DELETE FROM assistant_config
      WHERE session_id = ${sessionId} AND key = ${key}
    `;
  }

  private _sessionId(): string {
    return "";
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
   * Used as fallback when no context blocks are configured via `configureSession`.
   */
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
   * Configure the session. Called once during `onStart`.
   * Override to add context blocks, compaction, search, skills.
   *
   * The base session is pre-created with `Session.create(this)`.
   * Return it with builder methods chained.
   *
   * Async is supported — use it to read configuration from KV, D1,
   * or R2 before setting up context blocks.
   *
   * @example
   * ```typescript
   * configureSession(session: Session) {
   *   return session
   *     .withContext("memory", { description: "Learned facts", maxTokens: 2000 })
   *     .withCachedPrompt();
   * }
   * ```
   *
   * @example Async configuration from KV
   * ```typescript
   * async configureSession(session: Session) {
   *   const config = await this.env.KV.get("agent-config", "json");
   *   return session
   *     .withContext("memory", { maxTokens: config.memoryTokens })
   *     .withCachedPrompt();
   * }
   * ```
   */
  configureSession(session: Session): Session | Promise<Session> {
    return session;
  }

  /**
   * Assemble context for the LLM from the current session state.
   *
   * Default implementation:
   * 1. Freezes the system prompt from context blocks (falls back to getSystemPrompt())
   * 2. Gets history from session
   * 3. Applies read-time truncation (old tool outputs, long text)
   * 4. Converts to model messages with tool call pruning
   *
   * Returns { system, messages } so the caller has both.
   */
  async assembleContext(): Promise<{
    system: string;
    messages: ModelMessage[];
  }> {
    // freezeSystemPrompt() triggers context block loading if needed.
    // It returns "" when no blocks are configured or all are empty —
    // in that case, fall back to the simple getSystemPrompt() override.
    const frozenPrompt = await this.session.freezeSystemPrompt();
    const system = frozenPrompt || this.getSystemPrompt();

    const history = this.session.getHistory();
    const truncated = truncateOlderMessages(history);
    const messages = pruneMessages({
      messages: await convertToModelMessages(truncated),
      toolCalls: "before-last-2-messages"
    });

    return { system, messages };
  }

  /**
   * Handle a chat turn and return the streaming result.
   *
   * The default implementation runs the agentic loop:
   * 1. Merge tools: getTools() + clientTools + session context tools + options.tools
   * 2. Assemble context (system prompt + messages) from session state
   * 3. Call `streamText` with the model, system prompt, tools, and step limit
   *
   * Override for full control over inference.
   *
   * @returns A result with `toUIMessageStream()` — AI SDK's `streamText()`
   *          return value satisfies this interface.
   */
  async onChatMessage(options?: ChatMessageOptions): Promise<StreamableResult> {
    const baseTools = this.getTools();
    const clientToolSet = createToolsFromClientSchemas(options?.clientTools);
    const contextTools = await this.session.tools();
    const tools = {
      ...baseTools,
      ...clientToolSet,
      ...contextTools,
      ...options?.tools
    };

    const { system, messages } = await this.assembleContext();
    if (messages.length === 0) {
      throw new Error(
        "No messages to send to the model. This usually means the chat request " +
          "arrived before any messages were persisted."
      );
    }
    return streamText({
      model: this.getModel(),
      system,
      messages,
      tools,
      stopWhen: stepCountIs(this.getMaxSteps()),
      abortSignal: options?.signal
    });
  }

  /**
   * Called after a chat turn completes and the assistant message has been
   * persisted. The turn lock is released before this hook runs, so it is
   * safe to call other methods from inside.
   *
   * Fires for all turn completion paths: WebSocket chat requests,
   * sub-agent RPC, and auto-continuation.
   *
   * Override for logging, chaining, analytics, usage tracking.
   */
  onChatResponse(_result: ChatResponseResult): void | Promise<void> {}

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

      await this.session.appendMessage(userMsg);

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

        const assistantMsg = accumulator.toMessage();
        this._persistAssistantMessage(assistantMsg);

        if (!aborted) {
          await callback.onDone();
          this._fireResponseHook({
            message: assistantMsg,
            requestId,
            continuation: false,
            status: "completed"
          });
        } else {
          this._fireResponseHook({
            message: assistantMsg,
            requestId,
            continuation: false,
            status: "aborted"
          });
        }
      } catch (error) {
        const assistantMsg =
          accumulator.parts.length > 0 ? accumulator.toMessage() : null;
        if (assistantMsg) {
          this._persistAssistantMessage(assistantMsg);
        }

        const wrapped = this.onChatError(error);
        const errorMessage =
          wrapped instanceof Error ? wrapped.message : String(wrapped);

        if (assistantMsg) {
          this._fireResponseHook({
            message: assistantMsg,
            requestId,
            continuation: false,
            status: "error",
            error: errorMessage
          });
        }

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

  /** Clear all messages from storage. */
  clearMessages(): void {
    this.session.clearMessages();
  }

  // ── WebSocket protocol ──────────────────────────────────────────

  private _setupProtocolHandlers() {
    const _onConnect = this.onConnect.bind(this);
    this.onConnect = async (
      connection: Connection,
      ctx: { request: Request }
    ) => {
      if (this._resumableStream.hasActiveStream()) {
        this._notifyStreamResuming(connection);
      }
      connection.send(
        JSON.stringify({
          type: MSG_CHAT_MESSAGES,
          messages: this.messages
        })
      );
      return _onConnect(connection, ctx);
    };

    const _onClose = this.onClose.bind(this);
    this.onClose = async (
      connection: Connection,
      code: number,
      reason: string,
      wasClean: boolean
    ) => {
      this._pendingResumeConnections.delete(connection.id);
      this._continuation.awaitingConnections.delete(connection.id);
      if (this._continuation.pending?.connectionId === connection.id) {
        this._continuation.pending = null;
      }
      if (this._continuation.activeConnectionId === connection.id) {
        this._continuation.activeConnectionId = null;
      }
      return _onClose(connection, code, reason, wasClean);
    };

    const _onMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      if (typeof message === "string") {
        const event = parseProtocolMessage(message);
        if (event) {
          await this._handleProtocolEvent(connection, event);
          return;
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

  private async _handleProtocolEvent(
    connection: Connection,
    event: NonNullable<ReturnType<typeof parseProtocolMessage>>
  ): Promise<void> {
    switch (event.type) {
      case "stream-resume-request":
        this._handleStreamResumeRequest(connection);
        break;

      case "stream-resume-ack":
        this._handleStreamResumeAck(connection, event.id);
        break;

      case "chat-request":
        if (event.init?.method === "POST") {
          await this._handleChatRequest(connection, event);
        }
        break;

      case "tool-result": {
        if (
          event.clientTools &&
          Array.isArray(event.clientTools) &&
          event.clientTools.length > 0
        ) {
          this._lastClientTools = event.clientTools as ClientToolSchema[];
          this._persistClientTools();
        }
        this._applyToolResult(
          event.toolCallId,
          event.output,
          event.state as "output-error" | undefined,
          event.errorText
        );
        if (event.autoContinue) {
          this._scheduleAutoContinuation(connection);
        }
        break;
      }

      case "tool-approval": {
        this._applyToolApproval(event.toolCallId, event.approved);
        if (event.autoContinue) {
          this._scheduleAutoContinuation(connection);
        }
        break;
      }

      case "clear":
        this._handleClear();
        break;

      case "cancel":
        this._aborts.cancel(event.id);
        break;

      case "messages":
        break;
    }
  }

  private _handleStreamResumeRequest(connection: Connection): void {
    if (this._resumableStream.hasActiveStream()) {
      if (
        this._continuation.activeRequestId ===
          this._resumableStream.activeRequestId &&
        this._continuation.activeConnectionId !== null &&
        this._continuation.activeConnectionId !== connection.id
      ) {
        connection.send(JSON.stringify({ type: MSG_STREAM_RESUME_NONE }));
      } else {
        this._notifyStreamResuming(connection);
      }
    } else if (
      this._continuation.pending !== null &&
      this._continuation.pending.connectionId === connection.id
    ) {
      this._continuation.awaitingConnections.set(connection.id, connection);
    } else {
      connection.send(JSON.stringify({ type: MSG_STREAM_RESUME_NONE }));
    }
  }

  private _handleStreamResumeAck(
    connection: Connection,
    requestId: string
  ): void {
    this._pendingResumeConnections.delete(connection.id);
    if (
      this._resumableStream.hasActiveStream() &&
      this._resumableStream.activeRequestId === requestId
    ) {
      const orphanedStreamId = this._resumableStream.replayChunks(
        connection,
        this._resumableStream.activeRequestId
      );
      if (orphanedStreamId) {
        this._persistOrphanedStream(orphanedStreamId);
      }
    }
  }

  private async _handleChatRequest(
    connection: Connection,
    event: Extract<
      NonNullable<ReturnType<typeof parseProtocolMessage>>,
      { type: "chat-request" }
    >
  ) {
    if (!event.init?.body) return;

    let parsed: {
      messages?: UIMessage[];
      clientTools?: ClientToolSchema[];
      trigger?: string;
    };
    try {
      parsed = JSON.parse(event.init.body) as typeof parsed;
    } catch {
      return;
    }

    const incomingMessages = parsed.messages;
    if (!Array.isArray(incomingMessages)) return;

    const isRegeneration = parsed.trigger === "regenerate-message";

    const requestClientTools = parsed.clientTools?.length
      ? parsed.clientTools
      : undefined;
    if (requestClientTools) {
      this._lastClientTools = requestClientTools;
      this._persistClientTools();
    } else if (parsed.clientTools !== undefined) {
      this._lastClientTools = undefined;
      this._persistClientTools();
    }

    const clientToolsForTurn = this._lastClientTools;

    // For regeneration, the client sends a truncated message list ending
    // at the branch point. The new assistant response will be parented to
    // the last message in that list, creating a sibling branch — the old
    // response stays in the tree, accessible via session.getBranches().
    let branchParentId: string | undefined;
    if (isRegeneration && incomingMessages.length > 0) {
      branchParentId = incomingMessages[incomingMessages.length - 1].id;
    }

    for (const msg of incomingMessages) {
      await this.session.appendMessage(msg);
    }

    this._broadcastMessages([connection.id]);

    const requestId = event.id;
    const abortSignal = this._aborts.getSignal(requestId);

    try {
      await this.keepAliveWhile(async () => {
        const turnResult = await this._turnQueue.enqueue(
          requestId,
          async () => {
            if (this.waitForMcpConnections) {
              const timeout =
                typeof this.waitForMcpConnections === "object"
                  ? this.waitForMcpConnections.timeout
                  : 10_000;
              await this.mcp.waitForConnections({ timeout });
            }

            const result = await agentContext.run(
              {
                agent: this,
                connection,
                request: undefined,
                email: undefined
              },
              () =>
                this.onChatMessage({
                  signal: abortSignal,
                  clientTools: clientToolsForTurn
                })
            );

            if (result) {
              await this._streamResult(requestId, result, abortSignal, {
                parentId: branchParentId
              });
            } else {
              this._broadcastChat({
                type: MSG_CHAT_RESPONSE,
                id: requestId,
                body: "No response was generated.",
                done: true
              });
            }
          }
        );

        if (turnResult.status === "stale") {
          this._broadcastChat({
            type: MSG_CHAT_RESPONSE,
            id: requestId,
            body: "",
            done: true
          });
        }
      });
    } catch (error) {
      this._broadcastChat({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body: error instanceof Error ? error.message : "Error",
        done: true,
        error: true
      });
    } finally {
      this._aborts.remove(requestId);
    }
  }

  private _handleClear() {
    this._turnQueue.reset();
    this._aborts.destroyAll();

    this._resumableStream.clearAll();
    this._pendingResumeConnections.clear();
    this._lastClientTools = undefined;
    this._persistClientTools();
    if (this._continuationTimer) {
      clearTimeout(this._continuationTimer);
      this._continuationTimer = null;
    }
    this._continuation.sendResumeNone();
    this._continuation.clearAll();
    this.session.clearMessages();
    this._broadcast({ type: MSG_CHAT_CLEAR });
  }

  private async _streamResult(
    requestId: string,
    result: StreamableResult,
    abortSignal?: AbortSignal,
    options?: { continuation?: boolean; parentId?: string }
  ) {
    const clearGen = this._turnQueue.generation;
    const streamId = this._resumableStream.start(requestId);
    const continuation = options?.continuation ?? false;
    const parentId = options?.parentId;

    if (this._continuation.pending?.requestId === requestId) {
      this._continuation.activatePending();
      this._continuation.flushAwaitingConnections((c) =>
        this._notifyStreamResuming(c as Connection)
      );
    }

    const accumulator = new StreamAccumulator({
      messageId: crypto.randomUUID()
    });

    let doneSent = false;
    let streamAborted = false;
    let streamError: string | undefined;

    try {
      for await (const chunk of result.toUIMessageStream()) {
        if (abortSignal?.aborted) {
          streamAborted = true;
          break;
        }

        const { action } = accumulator.applyChunk(
          chunk as unknown as StreamChunkData
        );

        if (action?.type === "error") {
          this._broadcastChat({
            type: MSG_CHAT_RESPONSE,
            id: requestId,
            body: action.error,
            done: false,
            error: true
          });
          continue;
        }

        const chunkBody = JSON.stringify(chunk);
        this._resumableStream.storeChunk(streamId, chunkBody);
        this._broadcastChat({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: chunkBody,
          done: false
        });
      }

      this._resumableStream.complete(streamId);
      this._pendingResumeConnections.clear();
      this._broadcastChat({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body: "",
        done: true
      });
      doneSent = true;
    } catch (error) {
      streamError = error instanceof Error ? error.message : "Stream error";
      this._resumableStream.markError(streamId);
      this._pendingResumeConnections.clear();
      if (!doneSent) {
        this._broadcastChat({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: streamError,
          done: true,
          error: true
        });
        doneSent = true;
      }
    } finally {
      if (!doneSent) {
        this._resumableStream.markError(streamId);
        this._pendingResumeConnections.clear();
        this._broadcastChat({
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
        const assistantMsg = accumulator.toMessage();
        this._persistAssistantMessage(assistantMsg, parentId);
        this._broadcastMessages();

        this._fireResponseHook({
          message: assistantMsg,
          requestId,
          continuation,
          status: streamAborted
            ? "aborted"
            : streamError
              ? "error"
              : "completed",
          error: streamError
        });
      } catch (e) {
        console.error("Failed to persist assistant message:", e);
      }
    }
  }

  // ── Session-backed persistence ──────────────────────────────────

  private _persistAssistantMessage(msg: UIMessage, parentId?: string): void {
    const sanitized = sanitizeMessage(msg);
    const safe = enforceRowSizeLimit(sanitized);

    const existing = this.session.getMessage(safe.id);
    if (existing) {
      this.session.updateMessage(safe);
    } else {
      // appendMessage is async due to potential auto-compaction, but
      // we fire-and-forget here since the message write itself is synchronous
      // in AgentSessionProvider — only the optional compaction is async.
      // parentId is set for regeneration — the new response branches from
      // the same parent as the old one rather than appending to the latest leaf.
      void this.session.appendMessage(safe, parentId);
    }
  }

  private _persistClientTools(): void {
    if (this._lastClientTools) {
      this._configSet("lastClientTools", JSON.stringify(this._lastClientTools));
    } else {
      this._configDelete("lastClientTools");
    }
  }

  private _restoreClientTools(): void {
    const raw = this._configGet("lastClientTools");
    if (raw) {
      try {
        this._lastClientTools = JSON.parse(raw);
      } catch {
        this._lastClientTools = undefined;
      }
    }
  }

  // ── Tool state updates (shared primitives from agents/chat) ─────

  private _applyToolResult(
    toolCallId: string,
    output: unknown,
    overrideState?: "output-error",
    errorText?: string
  ): void {
    const update = toolResultUpdate(
      toolCallId,
      output,
      overrideState,
      errorText
    );
    this._applyToolUpdateToMessages(update);
  }

  private _applyToolApproval(toolCallId: string, approved: boolean): void {
    const update = toolApprovalUpdate(toolCallId, approved);
    this._applyToolUpdateToMessages(update);
  }

  private _applyToolUpdateToMessages(update: {
    toolCallId: string;
    matchStates: string[];
    apply: (part: Record<string, unknown>) => Record<string, unknown>;
  }): void {
    const history = this.messages;
    for (const msg of history) {
      const result = applyToolUpdate(
        msg.parts as Array<Record<string, unknown>>,
        update
      );
      if (result) {
        const updatedMsg = {
          ...msg,
          parts: result.parts as UIMessage["parts"]
        };
        const safe = enforceRowSizeLimit(sanitizeMessage(updatedMsg));
        this.session.updateMessage(safe);
        this._broadcast({ type: MSG_MESSAGE_UPDATED, message: safe });
        return;
      }
    }
  }

  // ── Auto-continuation ──────────────────────────────────────────

  private _scheduleAutoContinuation(connection: Connection): void {
    if (this._continuation.pending?.pastCoalesce) {
      this._continuation.deferred = {
        connection,
        connectionId: connection.id,
        clientTools: this._lastClientTools,
        body: undefined,
        errorPrefix: "[Think] Auto-continuation failed:",
        prerequisite: null
      };
      return;
    }

    if (this._continuation.pending) {
      this._continuation.pending.connection = connection;
      this._continuation.pending.connectionId = connection.id;
      this._continuation.pending.clientTools = this._lastClientTools;
      this._continuation.awaitingConnections.set(connection.id, connection);
      return;
    }

    if (this._continuationTimer) {
      clearTimeout(this._continuationTimer);
    }
    this._continuationTimer = setTimeout(() => {
      this._continuationTimer = null;
      this._fireAutoContinuation(connection);
    }, 50);
  }

  private _fireAutoContinuation(connection: Connection): void {
    if (!this._continuation.pending) {
      const requestId = crypto.randomUUID();
      this._continuation.pending = {
        connection,
        connectionId: connection.id,
        requestId,
        clientTools: this._lastClientTools,
        body: undefined,
        errorPrefix: "[Think] Auto-continuation failed:",
        prerequisite: null,
        pastCoalesce: false
      };
      this._continuation.awaitingConnections.set(connection.id, connection);
    }

    const { requestId, clientTools } = this._continuation.pending!;
    const abortSignal = this._aborts.getSignal(requestId);

    this.keepAliveWhile(async () => {
      await this._turnQueue.enqueue(requestId, async () => {
        if (this._continuation.pending) {
          this._continuation.pending.pastCoalesce = true;
        }
        let streamed = false;
        try {
          const result = await agentContext.run(
            {
              agent: this,
              connection,
              request: undefined,
              email: undefined
            },
            () =>
              this.onChatMessage({
                signal: abortSignal,
                clientTools,
                continuation: true
              })
          );
          if (result) {
            await this._streamResult(requestId, result, abortSignal, {
              continuation: true
            });
            streamed = true;
          }
        } finally {
          this._aborts.remove(requestId);
          if (!streamed) {
            this._continuation.sendResumeNone();
          }
          this._continuation.clearPending();
          this._activateDeferredContinuation();
        }
      });
    }).catch((error) => {
      console.error("[Think] Auto-continuation failed:", error);
      this._aborts.remove(requestId);
    });
  }

  private _activateDeferredContinuation(): void {
    const pending = this._continuation.activateDeferred(() =>
      crypto.randomUUID()
    );
    if (!pending) return;

    this._fireAutoContinuation(pending.connection as Connection);
  }

  // ── Response hook ──────────────────────────────────────────────

  private _fireResponseHook(result: ChatResponseResult): void {
    if (this._insideResponseHook) return;
    this._insideResponseHook = true;
    try {
      const maybePromise = this.onChatResponse(result);
      if (
        maybePromise &&
        typeof maybePromise === "object" &&
        "then" in maybePromise
      ) {
        (maybePromise as Promise<void>)
          .catch((err) => {
            console.error("[Think] onChatResponse error:", err);
          })
          .finally(() => {
            this._insideResponseHook = false;
          });
        return;
      }
    } catch (err) {
      console.error("[Think] onChatResponse error:", err);
    }
    this._insideResponseHook = false;
  }

  // ── Resume helpers ──────────────────────────────────────────────

  private _notifyStreamResuming(connection: Connection): void {
    if (!this._resumableStream.hasActiveStream()) return;
    this._pendingResumeConnections.add(connection.id);
    connection.send(
      JSON.stringify({
        type: MSG_STREAM_RESUMING,
        id: this._resumableStream.activeRequestId
      })
    );
  }

  private _persistOrphanedStream(streamId: string): void {
    this._resumableStream.flushBuffer();
    const chunks = this._resumableStream.getStreamChunks(streamId);
    if (chunks.length === 0) return;

    const accumulator = new StreamAccumulator({
      messageId: crypto.randomUUID()
    });
    for (const chunk of chunks) {
      try {
        accumulator.applyChunk(JSON.parse(chunk.body) as StreamChunkData);
      } catch {
        // skip malformed chunks
      }
    }

    if (accumulator.parts.length > 0) {
      this._persistAssistantMessage(accumulator.toMessage());
      this._broadcastMessages();
    }
  }

  private _broadcastChat(message: Record<string, unknown>, exclude?: string[]) {
    const allExclusions = [
      ...(exclude || []),
      ...this._pendingResumeConnections
    ];
    this.broadcast(JSON.stringify(message), allExclusions);
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
