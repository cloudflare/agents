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
  parseProtocolMessage,
  applyChunkToParts
} from "agents/chat";
import type {
  StreamChunkData,
  ClientToolSchema,
  MessagePart
} from "agents/chat";
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
  /** Custom body fields from the client request. Persisted across hibernation. */
  body?: Record<string, unknown>;
}

/**
 * Result returned by `saveMessages()` and `continueLastTurn()`.
 */
export type SaveMessagesResult = {
  requestId: string;
  status: "completed" | "skipped";
};

/**
 * Context passed to `onChatRecovery` when an interrupted chat stream
 * is detected after DO restart.
 */
export type ChatRecoveryContext = {
  streamId: string;
  requestId: string;
  partialText: string;
  partialParts: MessagePart[];
  recoveryData: unknown | null;
  messages: UIMessage[];
  lastBody?: Record<string, unknown>;
  lastClientTools?: ClientToolSchema[];
};

/**
 * Options returned from `onChatRecovery` to control recovery behavior.
 */
export type ChatRecoveryOptions = {
  persist?: boolean;
  continue?: boolean;
};

const TIMED_OUT = Symbol("timed-out");

/**
 * Controls how overlapping user submit requests behave while another
 * chat turn is already active or queued.
 *
 * - `"queue"` (default) — queue every submit and process them in order.
 * - `"latest"` — keep only the latest overlapping submit; superseded submits
 *   still persist their user messages, but do not start their own model turn.
 * - `"merge"` — like latest, but all overlapping user messages remain in
 *   the conversation history. The model sees them all in one turn.
 * - `"drop"` — ignore overlapping submits entirely (messages not persisted).
 * - `{ strategy: "debounce" }` — trailing-edge latest with a quiet window.
 *
 * Only applies to `submit-message` requests. Regenerations, tool
 * continuations, approvals, clears, `saveMessages`, and `continueLastTurn`
 * keep their existing serialized behavior.
 */
export type MessageConcurrency =
  | "queue"
  | "latest"
  | "merge"
  | "drop"
  | { strategy: "debounce"; debounceMs?: number };

type NormalizedMessageConcurrency =
  | "queue"
  | "latest"
  | "merge"
  | "drop"
  | { strategy: "debounce"; debounceMs: number };

type SubmitConcurrencyDecision = {
  action: "execute" | "drop";
  submitSequence: number | null;
  debounceUntilMs: number | null;
};

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

  /**
   * Controls how overlapping user submit requests behave while another
   * chat turn is already active or queued.
   *
   * @default "queue"
   */
  messageConcurrency: MessageConcurrency = "queue";

  /**
   * When true, chat turns are wrapped in `runFiber` for durable execution.
   * Enables `onChatRecovery` hook and `this.stash()` during streaming.
   */
  unstable_chatRecovery = false;

  static readonly CHAT_FIBER_NAME = "__cf_internal_chat_turn";

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
      this._restoreBody();
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
  private _lastBody: Record<string, unknown> | undefined;
  private _continuation = new ContinuationState();
  private _continuationTimer: ReturnType<typeof setTimeout> | null = null;
  private _insideResponseHook = false;
  private _pendingInteractionPromise: Promise<boolean> | null = null;
  private _submitSequence = 0;
  private _latestOverlappingSubmitSequence = 0;
  private _activeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _activeDebounceResolve: (() => void) | null = null;
  private static MESSAGE_DEBOUNCE_MS = 750;

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
          await this._fireResponseHook({
            message: assistantMsg,
            requestId,
            continuation: false,
            status: "completed"
          });
        } else {
          await this._fireResponseHook({
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
          await this._fireResponseHook({
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

  // ── Programmatic API ───────────────────────────────────────────

  /**
   * Inject messages and trigger a model turn — without a WebSocket request.
   *
   * Use for scheduled responses, webhook-triggered turns, proactive agents,
   * or chaining from `onChatResponse`.
   *
   * Accepts static messages or a callback that derives messages from the
   * current state (useful when multiple calls queue up — the callback runs
   * with the latest messages when the turn actually starts).
   *
   * @example Scheduled follow-up
   * ```typescript
   * async onScheduled() {
   *   await this.saveMessages([{
   *     id: crypto.randomUUID(),
   *     role: "user",
   *     parts: [{ type: "text", text: "Time for your daily summary." }]
   *   }]);
   * }
   * ```
   *
   * @example Function form
   * ```typescript
   * await this.saveMessages((current) => [
   *   ...current,
   *   { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "Continue." }] }
   * ]);
   * ```
   */
  async saveMessages(
    messages:
      | UIMessage[]
      | ((currentMessages: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>)
  ): Promise<SaveMessagesResult> {
    const requestId = crypto.randomUUID();
    const clientTools = this._lastClientTools;
    const body = this._lastBody;
    const epoch = this._turnQueue.generation;
    let status: SaveMessagesResult["status"] = "completed";

    await this.keepAliveWhile(async () => {
      await this._turnQueue.enqueue(requestId, async () => {
        const resolved =
          typeof messages === "function"
            ? await messages(this.messages)
            : messages;

        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        for (const msg of resolved) {
          await this.session.appendMessage(msg);
        }
        this._broadcastMessages();

        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        const abortSignal = this._aborts.getSignal(requestId);
        try {
          const programmaticBody = async () => {
            const result = await agentContext.run(
              {
                agent: this,
                connection: undefined,
                request: undefined,
                email: undefined
              },
              () =>
                this.onChatMessage({
                  signal: abortSignal,
                  clientTools,
                  body
                })
            );

            if (result) {
              await this._streamResult(requestId, result, abortSignal);
            }
          };

          if (this.unstable_chatRecovery) {
            await this.runFiber(
              `${(this.constructor as typeof Think).CHAT_FIBER_NAME}:${requestId}`,
              async () => {
                await programmaticBody();
              }
            );
          } else {
            await programmaticBody();
          }
        } finally {
          this._aborts.remove(requestId);
        }
      });
    });

    if (this._turnQueue.generation !== epoch && status === "completed") {
      status = "skipped";
    }

    return { requestId, status };
  }

  /**
   * Run a new LLM call following the last assistant message.
   *
   * The model sees the full conversation (including the last assistant
   * response) and generates a new response. The new response is persisted
   * as a separate assistant message. Building block for chat recovery
   * (Phase 4), "generate more" buttons, and self-correction.
   *
   * Note: this creates a new message, not an append to the existing one.
   * True continuation-as-append (chunk rewriting) is planned for Phase 4.
   *
   * Returns early with `status: "skipped"` if there is no assistant message
   * to continue from.
   */
  protected async continueLastTurn(
    body?: Record<string, unknown>
  ): Promise<SaveMessagesResult> {
    const lastLeaf = this.session.getLatestLeaf();
    if (!lastLeaf || lastLeaf.role !== "assistant") {
      return { requestId: "", status: "skipped" };
    }

    const requestId = crypto.randomUUID();
    const clientTools = this._lastClientTools;
    const resolvedBody = body ?? this._lastBody;
    const epoch = this._turnQueue.generation;
    let status: SaveMessagesResult["status"] = "completed";

    await this.keepAliveWhile(async () => {
      await this._turnQueue.enqueue(requestId, async () => {
        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        const abortSignal = this._aborts.getSignal(requestId);
        try {
          const continueTurnBody = async () => {
            const result = await agentContext.run(
              {
                agent: this,
                connection: undefined,
                request: undefined,
                email: undefined
              },
              () =>
                this.onChatMessage({
                  signal: abortSignal,
                  clientTools,
                  body: resolvedBody,
                  continuation: true
                })
            );

            if (result) {
              await this._streamResult(requestId, result, abortSignal, {
                continuation: true
              });
            }
          };

          if (this.unstable_chatRecovery) {
            await this.runFiber(
              `${(this.constructor as typeof Think).CHAT_FIBER_NAME}:${requestId}`,
              async () => {
                await continueTurnBody();
              }
            );
          } else {
            await continueTurnBody();
          }
        } finally {
          this._aborts.remove(requestId);
        }
      });
    });

    if (this._turnQueue.generation !== epoch && status === "completed") {
      status = "skipped";
    }

    return { requestId, status };
  }

  /**
   * Override to apply custom transformations to messages before they are
   * persisted to Session storage. Runs after the built-in sanitization
   * (OpenAI metadata stripping, row size enforcement) but before
   * `session.appendMessage` / `session.updateMessage`.
   *
   * Use for redacting PII, stripping internal metadata, or custom compaction.
   */
  protected sanitizeMessageForPersistence(message: UIMessage): UIMessage {
    return message;
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
        const resultPromise = Promise.resolve().then(() => {
          this._applyToolResult(
            event.toolCallId,
            event.output,
            event.state as "output-error" | undefined,
            event.errorText
          );
          return true;
        });
        this._pendingInteractionPromise = resultPromise;
        resultPromise
          .finally(() => {
            if (this._pendingInteractionPromise === resultPromise) {
              this._pendingInteractionPromise = null;
            }
          })
          .catch(() => {});
        if (event.autoContinue) {
          this._scheduleAutoContinuation(connection);
        }
        break;
      }

      case "tool-approval": {
        const approvalPromise = Promise.resolve().then(() => {
          this._applyToolApproval(event.toolCallId, event.approved);
          return true;
        });
        this._pendingInteractionPromise = approvalPromise;
        approvalPromise
          .finally(() => {
            if (this._pendingInteractionPromise === approvalPromise) {
              this._pendingInteractionPromise = null;
            }
          })
          .catch(() => {});
        if (event.autoContinue) {
          this._scheduleAutoContinuation(connection);
        }
        break;
      }

      case "clear":
        this._handleClear(connection);
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

    let rawParsed: Record<string, unknown>;
    try {
      rawParsed = JSON.parse(event.init.body) as Record<string, unknown>;
    } catch {
      return;
    }

    const {
      messages: incomingMessages,
      clientTools: rawClientTools,
      trigger: rawTrigger,
      ...customBody
    } = rawParsed as {
      messages?: UIMessage[];
      clientTools?: ClientToolSchema[];
      trigger?: string;
      [key: string]: unknown;
    };
    if (!Array.isArray(incomingMessages)) return;

    const isRegeneration = rawTrigger === "regenerate-message";
    const isSubmitMessage = !isRegeneration;
    const requestId = event.id;

    const requestClientTools =
      rawClientTools && rawClientTools.length > 0 ? rawClientTools : undefined;
    if (requestClientTools) {
      this._lastClientTools = requestClientTools;
      this._persistClientTools();
    } else if (rawClientTools !== undefined) {
      this._lastClientTools = undefined;
      this._persistClientTools();
    }

    const requestBody =
      Object.keys(customBody).length > 0 ? customBody : undefined;
    this._lastBody = requestBody;
    this._persistBody();

    // ── Concurrency decision (before appending messages) ─────────
    const concurrencyDecision =
      this._getSubmitConcurrencyDecision(isSubmitMessage);

    if (concurrencyDecision.action === "drop") {
      this._rollbackDroppedSubmit(connection);
      this._completeSkippedRequest(connection, requestId);
      return;
    }

    // ── Persist and broadcast user messages ──────────────────────
    const clientToolsForTurn = this._lastClientTools;
    const bodyForTurn = this._lastBody;

    let branchParentId: string | undefined;
    if (isRegeneration && incomingMessages.length > 0) {
      branchParentId = incomingMessages[incomingMessages.length - 1].id;
    }

    for (const msg of incomingMessages) {
      await this.session.appendMessage(msg);
    }

    this._broadcastMessages([connection.id]);

    // ── Enter turn queue ────────────────────────────────────────
    const abortSignal = this._aborts.getSignal(requestId);
    const epoch = this._turnQueue.generation;

    try {
      await this.keepAliveWhile(async () => {
        const turnResult = await this._turnQueue.enqueue(
          requestId,
          async () => {
            // Superseded by a later overlapping submit (latest/merge/debounce)
            if (this._isSupersededSubmit(concurrencyDecision.submitSequence)) {
              this._completeSkippedRequest(connection, requestId);
              return;
            }

            // Debounce: wait for quiet period
            if (concurrencyDecision.debounceUntilMs !== null) {
              await this._waitForTimestamp(concurrencyDecision.debounceUntilMs);

              if (this._turnQueue.generation !== epoch) {
                this._completeSkippedRequest(connection, requestId);
                return;
              }
              if (
                this._isSupersededSubmit(concurrencyDecision.submitSequence)
              ) {
                this._completeSkippedRequest(connection, requestId);
                return;
              }
            }

            const chatTurnBody = async () => {
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
                    clientTools: clientToolsForTurn,
                    body: bodyForTurn
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
            };

            if (this.unstable_chatRecovery) {
              await this.runFiber(
                `${(this.constructor as typeof Think).CHAT_FIBER_NAME}:${requestId}`,
                async () => {
                  await chatTurnBody();
                }
              );
            } else {
              await chatTurnBody();
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

  /**
   * Abort the active turn, invalidate queued turns, and reset
   * concurrency/continuation state. Call this when intercepting
   * clear events or implementing custom reset logic.
   *
   * Does NOT clear messages, streams, or persisted state —
   * only turn execution state.
   */
  protected resetTurnState(): void {
    this._turnQueue.reset();
    this._aborts.destroyAll();
    if (this._continuationTimer) {
      clearTimeout(this._continuationTimer);
      this._continuationTimer = null;
    }
    this._cancelActiveDebounce();
    this._pendingInteractionPromise = null;
    this._continuation.sendResumeNone();
    this._continuation.clearAll();
  }

  private _handleClear(connection?: Connection) {
    this.resetTurnState();

    this._resumableStream.clearAll();
    this._pendingResumeConnections.clear();
    this._lastClientTools = undefined;
    this._persistClientTools();
    this._lastBody = undefined;
    this._persistBody();
    this.session.clearMessages();
    this._broadcast(
      { type: MSG_CHAT_CLEAR },
      connection ? [connection.id] : undefined
    );
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

        await this._fireResponseHook({
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
    const sized = enforceRowSizeLimit(sanitized);
    const safe = this.sanitizeMessageForPersistence(sized);

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

  private _persistBody(): void {
    if (this._lastBody) {
      this._configSet("lastBody", JSON.stringify(this._lastBody));
    } else {
      this._configDelete("lastBody");
    }
  }

  private _restoreBody(): void {
    const raw = this._configGet("lastBody");
    if (raw) {
      try {
        this._lastBody = JSON.parse(raw);
      } catch {
        this._lastBody = undefined;
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

  // ── Stability + pending interactions ─────────────────────────────

  protected hasPendingInteraction(): boolean {
    return this.messages.some(
      (message) =>
        message.role === "assistant" &&
        this._messageHasPendingInteraction(message)
    );
  }

  protected async waitUntilStable(options?: {
    timeout?: number;
  }): Promise<boolean> {
    const deadline =
      options?.timeout != null ? Date.now() + options.timeout : null;

    while (true) {
      if (
        (await this._awaitWithDeadline(
          this._turnQueue.waitForIdle(),
          deadline
        )) === TIMED_OUT
      ) {
        return false;
      }

      if (!this.hasPendingInteraction()) {
        return true;
      }

      const pending = this._pendingInteractionPromise;
      if (pending) {
        let result: boolean | typeof TIMED_OUT;
        try {
          result = await this._awaitWithDeadline(pending, deadline);
        } catch {
          continue;
        }
        if (result === TIMED_OUT) {
          return false;
        }
      } else {
        if (
          (await this._awaitWithDeadline(
            new Promise<void>((resolve) => setTimeout(resolve, 100)),
            deadline
          )) === TIMED_OUT
        ) {
          return false;
        }
      }
    }
  }

  private async _awaitWithDeadline<T>(
    promise: Promise<T>,
    deadline: number | null
  ): Promise<T | typeof TIMED_OUT> {
    if (deadline == null) {
      return promise;
    }
    const remainingMs = Math.max(0, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout>;
    const result = await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), remainingMs);
      })
    ]);
    clearTimeout(timer!);
    return result;
  }

  private _messageHasPendingInteraction(message: UIMessage): boolean {
    return message.parts.some(
      (part) =>
        "state" in part &&
        ((part as Record<string, unknown>).state === "input-available" ||
          (part as Record<string, unknown>).state === "approval-requested")
    );
  }

  // ── Chat recovery via fibers ───────────────────────────────────

  protected override async _handleInternalFiberRecovery(
    ctx: FiberRecoveryContext
  ): Promise<boolean> {
    const chatPrefix = (this.constructor as typeof Think).CHAT_FIBER_NAME + ":";
    if (!ctx.name.startsWith(chatPrefix)) {
      return false;
    }

    const requestId = ctx.name.slice(chatPrefix.length);

    let streamId = "";
    if (requestId) {
      const rows = this.sql<{ id: string }>`
        SELECT id FROM cf_ai_chat_stream_metadata
        WHERE request_id = ${requestId}
        ORDER BY created_at DESC LIMIT 1
      `;
      if (rows.length > 0) {
        streamId = rows[0].id;
      }
    }
    if (!streamId && this._resumableStream.hasActiveStream()) {
      streamId = this._resumableStream.activeStreamId ?? "";
    }

    const partial = streamId
      ? this._getPartialStreamText(streamId)
      : { text: "", parts: [] as MessagePart[] };

    const options = await this.onChatRecovery({
      streamId: streamId ?? "",
      requestId,
      partialText: partial.text,
      partialParts: partial.parts,
      recoveryData: ctx.snapshot,
      messages: [...this.messages],
      lastBody: this._lastBody,
      lastClientTools: this._lastClientTools
    });

    const streamStillActive =
      streamId &&
      this._resumableStream.hasActiveStream() &&
      this._resumableStream.activeStreamId === streamId;

    if (options.persist !== false && streamStillActive) {
      this._persistOrphanedStream(streamId);
    }

    if (streamStillActive) {
      this._resumableStream.complete(streamId);
    }

    if (options.continue !== false) {
      const lastLeaf = this.session.getLatestLeaf();
      const targetId = lastLeaf?.role === "assistant" ? lastLeaf.id : undefined;
      await this.schedule(
        0,
        "_chatRecoveryContinue",
        targetId ? { targetAssistantId: targetId } : undefined,
        { idempotent: true }
      );
    }

    return true;
  }

  protected async onChatRecovery(
    _ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    return {};
  }

  async _chatRecoveryContinue(data?: {
    targetAssistantId?: string;
  }): Promise<void> {
    const ready = await this.waitUntilStable({ timeout: 10_000 });
    if (!ready) {
      console.warn(
        "[Think] _chatRecoveryContinue timed out waiting for stable state, skipping continuation"
      );
      return;
    }

    const targetId = data?.targetAssistantId;
    const lastLeaf = this.session.getLatestLeaf();
    if (targetId && lastLeaf?.id !== targetId) {
      return;
    }

    await this.continueLastTurn();
  }

  private _getPartialStreamText(streamId: string): {
    text: string;
    parts: MessagePart[];
  } {
    const chunks = this._resumableStream.getStreamChunks(streamId);
    const parts: MessagePart[] = [];

    for (const chunk of chunks) {
      try {
        const data = JSON.parse(chunk.body);
        applyChunkToParts(parts, data);
      } catch {
        // skip malformed chunks
      }
    }

    const text = parts
      .filter(
        (p): p is MessagePart & { type: "text"; text: string } =>
          p.type === "text" && "text" in p
      )
      .map((p) => p.text)
      .join("");

    return { text, parts };
  }

  // ── Concurrency strategies ──────────────────────────────────────

  private _normalizeMessageConcurrency(): NormalizedMessageConcurrency {
    if (typeof this.messageConcurrency === "string") {
      return this.messageConcurrency;
    }
    const debounceMs = this.messageConcurrency.debounceMs;
    return {
      strategy: "debounce",
      debounceMs:
        typeof debounceMs === "number" &&
        Number.isFinite(debounceMs) &&
        debounceMs >= 0
          ? debounceMs
          : Think.MESSAGE_DEBOUNCE_MS
    };
  }

  private _getSubmitConcurrencyDecision(
    isSubmitMessage: boolean
  ): SubmitConcurrencyDecision {
    const queuedTurns = this._turnQueue.queuedCount();

    if (!isSubmitMessage || queuedTurns === 0) {
      return {
        action: "execute",
        submitSequence: null,
        debounceUntilMs: null
      };
    }

    const concurrency = this._normalizeMessageConcurrency();

    if (concurrency === "queue") {
      return {
        action: "execute",
        submitSequence: null,
        debounceUntilMs: null
      };
    }

    if (concurrency === "drop") {
      return {
        action: "drop",
        submitSequence: null,
        debounceUntilMs: null
      };
    }

    const submitSequence = ++this._submitSequence;
    this._latestOverlappingSubmitSequence = submitSequence;

    if (concurrency === "latest" || concurrency === "merge") {
      return {
        action: "execute",
        submitSequence,
        debounceUntilMs: null
      };
    }

    return {
      action: "execute",
      submitSequence,
      debounceUntilMs: Date.now() + concurrency.debounceMs
    };
  }

  private _isSupersededSubmit(submitSequence: number | null): boolean {
    return (
      submitSequence !== null &&
      submitSequence < this._latestOverlappingSubmitSequence
    );
  }

  private async _waitForTimestamp(timestampMs: number): Promise<void> {
    const remainingMs = timestampMs - Date.now();
    if (remainingMs <= 0) return;

    await new Promise<void>((resolve) => {
      this._activeDebounceResolve = resolve;
      this._activeDebounceTimer = setTimeout(() => {
        this._activeDebounceTimer = null;
        this._activeDebounceResolve = null;
        resolve();
      }, remainingMs);
    });
  }

  private _cancelActiveDebounce(): void {
    if (this._activeDebounceTimer !== null) {
      clearTimeout(this._activeDebounceTimer);
      this._activeDebounceTimer = null;
    }
    if (this._activeDebounceResolve !== null) {
      this._activeDebounceResolve();
      this._activeDebounceResolve = null;
    }
  }

  private _completeSkippedRequest(
    connection: Connection,
    requestId: string
  ): void {
    connection.send(
      JSON.stringify({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body: "",
        done: true
      })
    );
  }

  private _rollbackDroppedSubmit(connection: Connection): void {
    connection.send(
      JSON.stringify({
        type: MSG_CHAT_MESSAGES,
        messages: this.messages
      })
    );
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
          const continuationBody = async () => {
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
                  body: this._lastBody,
                  continuation: true
                })
            );
            if (result) {
              await this._streamResult(requestId, result, abortSignal, {
                continuation: true
              });
              streamed = true;
            }
          };

          if (this.unstable_chatRecovery) {
            await this.runFiber(
              `${(this.constructor as typeof Think).CHAT_FIBER_NAME}:${requestId}`,
              async () => {
                await continuationBody();
              }
            );
          } else {
            await continuationBody();
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

  private async _fireResponseHook(result: ChatResponseResult): Promise<void> {
    if (this._insideResponseHook) return;
    this._insideResponseHook = true;
    try {
      await this.onChatResponse(result);
    } catch (err) {
      console.error("[Think] onChatResponse error:", err);
    } finally {
      this._insideResponseHook = false;
    }
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
