import type {
  UIMessage,
  StreamTextOnFinishCallback,
  TextUIPart,
  ToolSet,
  UIMessageChunk
} from "ai";
import {
  Agent,
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext,
  type AgentToolRunInspection,
  type AgentToolStoredChunk,
  type AgentContext,
  type Connection,
  type ConnectionContext,
  type FiberRecoveryContext,
  type WSMessage
} from "agents";

import {
  MessageType,
  type IncomingMessage,
  type OutgoingMessage
} from "./types";
import { autoTransformMessages } from "./ai-chat-v5-migration";
import { reconcileMessages, resolveToolMergeId } from "agents/chat";
import {
  applyChunkToParts,
  isReplayChunk,
  sanitizeMessage,
  byteLength as chatByteLength,
  ROW_MAX_BYTES,
  TurnQueue,
  SubmitConcurrencyController,
  type TurnResult,
  type MessagePart,
  type StreamChunkData,
  type SubmitConcurrencyDecision
} from "agents/chat";
import { ResumableStream } from "agents/chat";
import {
  ContinuationState,
  AbortRegistry,
  type ContinuationConnection,
  type ClientToolSchema
} from "agents/chat";
import type {
  ChatResponseResult,
  ChatRecoveryContext,
  ChatRecoveryOptions,
  MessageConcurrency,
  SaveMessagesOptions,
  SaveMessagesResult
} from "agents/chat";
import { nanoid } from "nanoid";

// Re-export lifecycle types from the shared chat toolkit so existing
// consumers (`import type { ChatResponseResult } from "@cloudflare/ai-chat"`)
// continue to work.
export type {
  ChatResponseResult,
  ChatRecoveryContext,
  ChatRecoveryOptions,
  MessageConcurrency,
  SaveMessagesOptions,
  SaveMessagesResult
} from "agents/chat";

function sendIfOpen(connection: Connection, message: string): boolean {
  try {
    connection.send(message);
    return true;
  } catch (error) {
    if (isWebSocketClosedSendError(error)) return false;
    throw error;
  }
}

function isWebSocketClosedSendError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.message.includes("WebSocket send() after close")
  );
}

export type ChatMessage = UIMessage;

const TIMED_OUT = Symbol("timed-out");

/**
 * Provider-executed tool fields that contain opaque replay tokens and must be
 * persisted exactly as returned by the provider.
 */
const PROVIDER_TOOL_OPAQUE_STRING_KEY_PREFIX = "encrypted";

/**
 * Max string length preserved in `input`/`output` of provider-executed tool
 * parts (e.g. Anthropic code_execution / text_editor). Strings exceeding this
 * limit are truncated with a marker so persisted messages stay small.
 */
const PROVIDER_TOOL_MAX_STRING_LENGTH = 500;

/**
 * Validates that a parsed message has the minimum required structure.
 * Returns false for messages that would cause runtime errors downstream
 * (e.g. in convertToModelMessages or the UI layer).
 *
 * Checks:
 * - `id` is a non-empty string
 * - `role` is one of the valid roles
 * - `parts` is an array (may be empty — the AI SDK enforces nonempty
 *   on incoming messages, but we are lenient on persisted data)
 */
function isValidMessageStructure(msg: unknown): msg is UIMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;

  if (typeof m.id !== "string" || m.id.length === 0) return false;

  if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") {
    return false;
  }

  if (!Array.isArray(m.parts)) return false;

  return true;
}

/**
 * Schema for a client-defined tool sent from the browser.
 * These tools are executed on the client, not the server.
 *
 * **For most apps**, define tools on the server with `tool()` from `"ai"` —
 * you get full Zod type safety, server-side execution, and simpler code.
 * Use `onToolCall` in `useAgentChat` for tools that need client-side execution.
 *
 * **For SDKs and platforms** where the tool surface is determined dynamically
 * by the embedding application at runtime, client tool schemas let the
 * client register tools the server does not know about at deploy time.
 *
 * Note: Uses `parameters` (JSONSchema7) rather than AI SDK's `inputSchema`
 * because this is the wire format. Zod schemas cannot be serialized.
 */
export type { ClientToolSchema } from "agents/chat";

type ChatRequestTrigger = "submit-message" | "regenerate-message";
type AIChatAgentToolRunStatus = "running" | "completed" | "error" | "aborted";
type AIChatAgentToolRunRow = {
  run_id: string;
  request_id: string | null;
  status: AIChatAgentToolRunStatus;
  input_json: string | null;
  output_json: string | null;
  summary: string | null;
  error_message: string | null;
  started_at: number;
  completed_at: number | null;
};
type AIChatStreamMetadataRow = {
  id: string;
  status: string;
  request_id: string;
};
type AIChatStreamChunkRow = {
  body: string;
  chunk_index: number;
};

/**
 * Options passed to the onChatMessage handler.
 */
export type OnChatMessageOptions = {
  /**
   * Unique ID for this chat message exchange.
   *
   * For initial user messages this is the client-generated ID from the
   * `CF_AGENT_USE_CHAT_REQUEST` WebSocket frame. For tool continuations
   * (auto-continue after client tool results or approvals) this is a
   * server-generated ID.
   */
  requestId: string;
  /** AbortSignal for cancelling the request */
  abortSignal?: AbortSignal;
  /**
   * Tool schemas sent from the client for dynamic tool registration.
   * These represent tools that will be executed on the client side.
   * Use `createToolsFromClientSchemas()` to convert these to AI SDK tool format.
   *
   * **For most apps**, you do not need this — define tools on the server with
   * `tool()` from `"ai"` and use `onToolCall` for client-side execution.
   *
   * **For SDKs and platforms** where tools are defined dynamically by the
   * client at runtime and the server does not know the tool surface ahead
   * of time, this field carries the client-provided tool schemas.
   */
  clientTools?: ClientToolSchema[];
  /**
   * Custom body data sent from the client via `prepareSendMessagesRequest`
   * or the AI SDK's `body` option in `sendMessage`.
   *
   * Contains all fields from the request body except `messages` and `clientTools`,
   * which are handled separately.
   *
   * During tool continuations (auto-continue after client tool results), this
   * contains the body from the most recent chat request. The value is persisted
   * to SQLite so it survives Durable Object hibernation. It is cleared when the
   * chat is cleared via `CF_AGENT_CHAT_CLEAR`.
   */
  body?: Record<string, unknown>;
  /**
   * Whether this turn is a continuation of a previous assistant message
   * (auto-continue after tool result, `continueLastTurn`, or recovery).
   *
   * Use this to adjust system prompts, select different models, skip
   * expensive context assembly, or log differently for continuations.
   */
  continuation?: boolean;
};

export { createToolsFromClientSchemas } from "agents/chat";

const decoder = new TextDecoder();
const agentToolChunkEncoder = new TextEncoder();

/**
 * Extension of Agent with built-in chat capabilities
 * @template Env Environment type containing bindings
 */
export class AIChatAgent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> {
  /**
   * Registry of per-request AbortControllers.
   * Used to propagate cancellation signals for any external calls made by the agent.
   */
  private _abortRegistry: AbortRegistry;

  /**
   * Resumable stream manager -- handles chunk buffering, persistence, and replay.
   * @internal Protected for testing purposes.
   */
  protected _resumableStream!: ResumableStream;

  /**
   * The message currently being streamed. Used to apply tool results
   * before the message is persisted.
   * @internal
   */
  private _streamingMessage: UIMessage | null = null;

  /**
   * Queued by `_reply` so the hook can fire after the turn lock releases.
   * Uses an array to avoid losing results when multiple turns complete
   * during a single `onChatResponse` call.
   * @internal
   */
  private _pendingChatResponseResults: ChatResponseResult[] = [];

  /**
   * Re-entrancy guard: true while `onChatResponse` is executing.
   * Prevents recursive hook calls when the hook triggers `saveMessages`.
   * @internal
   */
  private _insideResponseHook = false;

  /**
   * Resolves when the current pending client-tool interaction (tool result or
   * approval) has been written to state. Set when an apply promise is created,
   * cleared when it settles. Used by waitUntilStable to avoid polling.
   */
  private _pendingInteractionPromise: Promise<boolean> | null = null;

  /**
   * Tracks the ID of a streaming message that was persisted early due to
   * a tool entering approval-requested state. When set, stream completion
   * updates the existing persisted message instead of appending a new one.
   * @internal
   */
  private _approvalPersistedMessageId: string | null = null;

  /**
   * Serial queue for chat turns. Handles promise-chain serialization,
   * generation-based invalidation on clear, and active-request tracking.
   */
  private _turnQueue = new TurnQueue();

  /**
   * When true, chat turns are wrapped in `runFiber` for durable execution.
   * Enables `onChatRecovery` hook and `this.stash()` during streaming.
   * Set to `true` in subclasses to enable durable streaming.
   */
  chatRecovery = false;

  /** First queued overlap message index for merge strategy, keyed by epoch. */
  private _mergeQueuedUserStartIndexByEpoch = new Map<number, number>();

  /** Shared admission policy state for overlapping submit-message requests. */
  private _submitConcurrency = new SubmitConcurrencyController({
    defaultDebounceMs: AIChatAgent.MESSAGE_DEBOUNCE_MS
  });

  /**
   * Set of connection IDs that are pending stream resume.
   * These connections have received CF_AGENT_STREAM_RESUMING but haven't sent ACK yet.
   * They should be excluded from live stream broadcasts until they ACK.
   * @internal
   */
  private _pendingResumeConnections: Set<string> = new Set();

  /**
   * Continuation lifecycle state: pending, deferred, active, and
   * connections awaiting a continuation stream to start.
   */
  private _continuation = new ContinuationState();
  private _agentToolForwarders = new Map<
    string,
    Set<(chunk: AgentToolStoredChunk) => void>
  >();
  private _agentToolClosers = new Map<string, Set<() => void>>();
  private _agentToolAbortControllers = new Map<string, AbortController>();
  private _agentToolLastErrors = new Map<string, string>();
  private _agentToolPreTurnAssistantIds = new Map<string, Set<string>>();
  private _agentToolLiveSequences = new Map<string, number>();
  private _agentToolActiveRunId: string | null = null;

  /**
   * Client tool schemas from the most recent chat request.
   * Stored so they can be passed to onChatMessage during tool continuations.
   * @internal
   */
  protected _lastClientTools: ClientToolSchema[] | undefined;

  /**
   * Custom body data from the most recent chat request.
   * Stored so it can be passed to onChatMessage during tool continuations.
   * @internal
   */
  protected _lastBody: Record<string, unknown> | undefined;

  /**
   * Cache of last-persisted JSON for each message ID.
   * Used for incremental persistence: skip SQL writes for unchanged messages.
   * Lost on hibernation, repopulated from SQLite on wake.
   * @internal
   */
  private _persistedMessageCache: Map<string, string> = new Map();

  /**
   * Small debounce window to batch adjacent client-side tool results/approvals
   * into a single server continuation turn.
   */
  private static AUTO_CONTINUATION_COALESCE_MS = 10;

  /** Default wait for trailing-edge debounced overlapping submits. */
  private static MESSAGE_DEBOUNCE_MS = 750;

  /**
   * Maximum number of messages to keep in SQLite storage.
   * When the conversation exceeds this limit, oldest messages are deleted
   * after each persist. Set to `undefined` (default) for no limit.
   *
   * This controls storage only — it does not affect what's sent to the LLM.
   * Use `pruneMessages()` from the AI SDK in your `onChatMessage` to control
   * LLM context separately.
   *
   * @example
   * ```typescript
   * class MyAgent extends AIChatAgent<Env> {
   *   maxPersistedMessages = 100; // Keep last 100 messages in storage
   * }
   * ```
   */
  maxPersistedMessages: number | undefined = undefined;

  /**
   * Controls how overlapping user submit requests behave while another chat
   * turn is already active or queued.
   *
   * - `"queue"` (default) — queue every submit and process them in order.
   * - `"latest"` — keep only the latest overlapping submit; superseded submits
   *   still persist their user messages, but do not start their own model turn.
   * - `"merge"` — queue overlapping submits, then collapse their trailing user
   *   messages into one combined user turn before the latest queued turn runs.
   * - `"drop"` — ignore overlapping submits entirely.
   * - `{ strategy: "debounce" }` — trailing-edge latest with a quiet window.
   *
   * This setting only applies to `sendMessage()` / `trigger: "submit-message"`
   * requests. Regenerations, tool continuations, approvals, clears, and
   * programmatic `saveMessages()` calls keep their existing serialized
   * behavior.
   */
  messageConcurrency: MessageConcurrency = "queue";

  /**
   * When enabled, waits for all MCP server connections to be ready before
   * calling `onChatMessage`. This prevents the race condition where
   * `getAITools()` returns an incomplete set because connections are still
   * restoring after Durable Object hibernation.
   *
   * - `false` (default) — non-blocking; `onChatMessage` runs immediately.
   * - `true` — waits indefinitely for all connections to settle.
   * - `{ timeout: number }` — waits up to `timeout` milliseconds.
   *
   * For lower-level control, call `this.mcp.waitForConnections()` directly
   * inside your `onChatMessage` instead.
   *
   * @example
   * ```typescript
   * class MyAgent extends AIChatAgent<Env> {
   *   waitForMcpConnections = true;
   * }
   * ```
   *
   * @example
   * ```typescript
   * class MyAgent extends AIChatAgent<Env> {
   *   waitForMcpConnections = { timeout: 10_000 };
   * }
   * ```
   */
  waitForMcpConnections: boolean | { timeout: number } = { timeout: 10_000 };

  /**
   * Array of chat messages for the current conversation.
   *
   * Public and mutable for backwards compatibility. Framework code
   * generally writes through `saveMessages` / `persistMessages`, but
   * existing subclasses may still assign `this.messages = [...]` or
   * mutate the array directly.
   */
  messages: UIMessage[] = [];

  override broadcast(
    msg: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void {
    if (this._agentToolForwarders.size > 0 && typeof msg === "string") {
      try {
        const parsed = JSON.parse(msg) as {
          type?: unknown;
          body?: unknown;
          error?: unknown;
        };
        if (parsed.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE) {
          if (parsed.error === true && typeof parsed.body === "string") {
            const runIds =
              this._agentToolActiveRunId !== null
                ? [this._agentToolActiveRunId]
                : [...this._agentToolForwarders.keys()];
            for (const runId of runIds) {
              this._agentToolLastErrors.set(runId, parsed.body);
            }
          } else if (
            typeof parsed.body === "string" &&
            parsed.body.length > 0
          ) {
            const entries =
              this._agentToolActiveRunId !== null
                ? [
                    [
                      this._agentToolActiveRunId,
                      this._agentToolForwarders.get(
                        this._agentToolActiveRunId
                      ) ?? new Set<(chunk: AgentToolStoredChunk) => void>()
                    ] as const
                  ]
                : [...this._agentToolForwarders.entries()];
            for (const [runId, forwarders] of entries) {
              const sequence = this._agentToolLiveSequences.get(runId) ?? 0;
              this._agentToolLiveSequences.set(runId, sequence + 1);
              const chunk = { sequence, body: parsed.body };
              for (const forward of forwarders) forward(chunk);
            }
          }
        }
      } catch {
        // Non-chat frames pass through unchanged.
      }
    }
    super.broadcast(msg, without);
  }

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.sql`create table if not exists cf_ai_chat_agent_messages (
      id text primary key,
      message text not null,
      created_at datetime default current_timestamp
    )`;

    // Key-value table for request context that must survive hibernation
    // (e.g., custom body fields, client tools from the last chat request).
    this.sql`create table if not exists cf_ai_chat_request_context (
      key text primary key,
      value text not null
    )`;

    this._ensureAgentToolTables();

    // Restore request context from SQLite (survives hibernation)
    this._restoreRequestContext();

    // Initialize resumable stream manager (creates its own tables + restores state)
    this._resumableStream = new ResumableStream(this.sql.bind(this));

    // Load messages and automatically transform them to v5 format.
    // Note: _loadMessagesFromDb() runs structural validation which requires
    // `parts` to be an array. Legacy v4 messages (with `content` instead of
    // `parts`) would fail this check — but that's fine because autoTransformMessages
    // already migrated them on a previous load, and persistMessages wrote them back.
    // Any message still without `parts` at this point is genuinely corrupt.
    const rawMessages = this._loadMessagesFromDb();

    // Automatic migration following https://jhak.im/blog/ai-sdk-migration-handling-previously-saved-messages
    this.messages = autoTransformMessages(rawMessages);

    this._abortRegistry = new AbortRegistry();
    const _onConnect = this.onConnect.bind(this);
    this.onConnect = async (connection: Connection, ctx: ConnectionContext) => {
      if (this._cf_requestTargetsSubAgent(ctx.request)) {
        return _onConnect(connection, ctx);
      }

      // Notify client about active streams that can be resumed
      if (this._resumableStream.hasActiveStream()) {
        this._notifyStreamResuming(connection);
      }
      // Call consumer's onConnect
      return _onConnect(connection, ctx);
    };

    // Wrap onClose to clean up pending resume connections
    const _onClose = this.onClose.bind(this);
    this.onClose = async (
      connection: Connection,
      code: number,
      reason: string,
      wasClean: boolean
    ) => {
      // Clean up pending resume state for this connection
      this._pendingResumeConnections.delete(connection.id);
      this._continuation.awaitingConnections.delete(connection.id);
      if (this._continuation.pending?.connectionId === connection.id) {
        this._continuation.pending = null;
      }
      if (this._continuation.activeConnectionId === connection.id) {
        this._continuation.activeConnectionId = null;
      }
      // Call consumer's onClose
      return _onClose(connection, code, reason, wasClean);
    };

    // Wrap onMessage
    const _onMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      if (this._cf_connectionTargetsSubAgent(connection)) {
        return _onMessage(connection, message);
      }

      // Handle AIChatAgent's internal messages first
      if (typeof message === "string") {
        let data: IncomingMessage;
        try {
          data = JSON.parse(message) as IncomingMessage;
        } catch (_error) {
          // Not JSON, forward to consumer
          return _onMessage(connection, message);
        }

        // Handle chat request
        if (
          data.type === MessageType.CF_AGENT_USE_CHAT_REQUEST &&
          data.init.method === "POST"
        ) {
          const { body } = data.init;
          if (!body) {
            console.warn(
              "[AIChatAgent] Received chat request with empty body, ignoring"
            );
            return;
          }

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(body as string);
          } catch (_parseError) {
            console.warn(
              "[AIChatAgent] Received chat request with invalid JSON body, ignoring"
            );
            return;
          }

          const {
            messages,
            clientTools,
            trigger: _trigger,
            ...customBody
          } = parsed as {
            messages: UIMessage[];
            clientTools?: ClientToolSchema[];
            trigger?: string;
            [key: string]: unknown;
          };
          const chatMessageId = data.id;
          const transformedMessages = autoTransformMessages(messages);
          const requestTrigger: ChatRequestTrigger =
            _trigger === "regenerate-message"
              ? "regenerate-message"
              : "submit-message";
          const requestClientTools = clientTools?.length
            ? clientTools
            : undefined;
          const requestBody =
            Object.keys(customBody).length > 0 ? customBody : undefined;
          const epoch = this._turnQueue.generation;
          const concurrencyDecision =
            this._getSubmitConcurrencyDecision(requestTrigger);

          if (concurrencyDecision.action === "drop") {
            this._rollbackDroppedSubmit(connection);
            this._completeSkippedRequest(connection, chatMessageId);
            return;
          }

          // Track that this request is past the concurrency decision but
          // not yet enqueued in _turnQueue. Decremented synchronously
          // before _runExclusiveChatTurn (which increments queuedCount).
          const releasePendingEnqueue = this._submitConcurrency.beginEnqueue();
          try {
            // Persist and broadcast user messages before entering the turn
            // queue so other tabs see the new message immediately and so
            // overlapping submits under latest/merge/debounce can inspect
            // the full message list when their turn starts.
            this._broadcastChatMessage(
              {
                messages: transformedMessages,
                type: MessageType.CF_AGENT_CHAT_MESSAGES
              },
              [connection.id]
            );

            await this.persistMessages(transformedMessages, [connection.id], {
              _deleteStaleRows: true
            });

            if (concurrencyDecision.strategy === "merge") {
              await this._mergeQueuedUserMessages(epoch);
            }
          } finally {
            releasePendingEnqueue();
          }
          return this._runExclusiveChatTurn(
            chatMessageId,
            async () => {
              if (
                this._submitConcurrency.isSuperseded(
                  concurrencyDecision.submitSequence
                )
              ) {
                this._completeSkippedRequest(connection, chatMessageId);
                return;
              }

              if (concurrencyDecision.debounceUntilMs !== null) {
                await this._submitConcurrency.waitForTimestamp(
                  concurrencyDecision.debounceUntilMs
                );

                if (this._turnQueue.generation !== epoch) {
                  this._completeSkippedRequest(connection, chatMessageId);
                  return;
                }

                if (
                  this._submitConcurrency.isSuperseded(
                    concurrencyDecision.submitSequence
                  )
                ) {
                  this._completeSkippedRequest(connection, chatMessageId);
                  return;
                }
              }

              // Re-merge inside the lock: more overlapping submits may have
              // persisted additional user messages while this turn was queued.
              if (concurrencyDecision.strategy === "merge") {
                await this._mergeQueuedUserMessages(epoch);

                if (this._turnQueue.generation !== epoch) {
                  this._completeSkippedRequest(connection, chatMessageId);
                  return;
                }

                if (
                  this._submitConcurrency.isSuperseded(
                    concurrencyDecision.submitSequence
                  )
                ) {
                  this._completeSkippedRequest(connection, chatMessageId);
                  return;
                }
              }

              // Optionally wait for in-flight MCP connections to settle (e.g. after hibernation restore)
              // so that getAITools() returns the full set of tools in onChatMessage
              if (this.waitForMcpConnections) {
                const timeout =
                  typeof this.waitForMcpConnections === "object"
                    ? this.waitForMcpConnections.timeout
                    : undefined;
                await this.mcp.waitForConnections(
                  timeout != null ? { timeout } : undefined
                );
              }

              this._setRequestContext(requestClientTools, requestBody);

              this._emit("message:request");

              const abortSignal = this._abortRegistry.getSignal(chatMessageId);

              return this._tryCatchChat(async () => {
                // Wrap in agentContext.run() to propagate connection context to onChatMessage
                // This ensures getCurrentAgent() returns the connection inside tool execute functions
                return agentContext.run(
                  {
                    agent: this,
                    connection,
                    request: undefined,
                    email: undefined
                  },
                  async () => {
                    const chatTurnBody = async () => {
                      try {
                        const response = await this.onChatMessage(
                          async (_finishResult) => {
                            // User-provided hook. Cleanup is now handled by _reply,
                            // so this is optional for the user to pass to streamText.
                          },
                          {
                            requestId: chatMessageId,
                            abortSignal,
                            clientTools: requestClientTools,
                            body: requestBody,
                            continuation: false
                          }
                        );

                        if (response) {
                          await this._reply(
                            chatMessageId,
                            response,
                            [connection.id],
                            {
                              chatMessageId
                            }
                          );
                        } else {
                          console.warn(
                            `[AIChatAgent] onChatMessage returned no response for chatMessageId: ${chatMessageId}`
                          );
                          this._broadcastChatMessage(
                            {
                              body: "No response was generated by the agent.",
                              done: true,
                              id: chatMessageId,
                              type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
                            },
                            [connection.id]
                          );
                        }
                      } finally {
                        this._abortRegistry.remove(chatMessageId);
                      }
                    };

                    if (this.chatRecovery) {
                      await this.runFiber(
                        `${(this.constructor as typeof AIChatAgent).CHAT_FIBER_NAME}:${chatMessageId}`,
                        async () => {
                          await chatTurnBody();
                        }
                      );
                    } else {
                      await chatTurnBody();
                    }
                  }
                );
              });
            },
            {
              epoch,
              onStale: () =>
                this._completeSkippedRequest(connection, chatMessageId)
            }
          );
        }

        // Handle clear chat
        if (data.type === MessageType.CF_AGENT_CHAT_CLEAR) {
          this.resetTurnState();
          this.sql`delete from cf_ai_chat_agent_messages`;
          this._resumableStream.clearAll();
          this._pendingResumeConnections.clear();
          this._lastClientTools = undefined;
          this._lastBody = undefined;
          this._persistRequestContext();
          this._persistedMessageCache.clear();
          this.messages = [];
          this._broadcastChatMessage(
            { type: MessageType.CF_AGENT_CHAT_CLEAR },
            [connection.id]
          );
          this._emit("message:clear");
          return;
        }

        // Handle message replacement
        if (data.type === MessageType.CF_AGENT_CHAT_MESSAGES) {
          const transformedMessages = autoTransformMessages(data.messages);
          await this.persistMessages(transformedMessages, [connection.id]);
          return;
        }

        // Handle request cancellation
        if (data.type === MessageType.CF_AGENT_CHAT_REQUEST_CANCEL) {
          this._abortRegistry.cancel(data.id);
          this._emit("message:cancel", { requestId: data.id });
          return;
        }

        // Handle client-initiated stream resume request.
        // The client sends this after its message handler is registered,
        // avoiding the race condition where CF_AGENT_STREAM_RESUMING sent
        // in onConnect arrives before the client's handler is ready.
        if (data.type === MessageType.CF_AGENT_STREAM_RESUME_REQUEST) {
          if (this._resumableStream.hasActiveStream()) {
            if (
              this._continuation.activeRequestId ===
                this._resumableStream.activeRequestId &&
              this._continuation.activeConnectionId !== null &&
              this._continuation.activeConnectionId !== connection.id
            ) {
              sendIfOpen(
                connection,
                JSON.stringify({
                  type: MessageType.CF_AGENT_STREAM_RESUME_NONE
                })
              );
            } else {
              this._notifyStreamResuming(connection);
            }
          } else if (
            this._continuation.pending !== null &&
            this._continuation.pending.connectionId === connection.id
          ) {
            this._continuation.awaitingConnections.set(
              connection.id,
              connection
            );
          } else {
            sendIfOpen(
              connection,
              JSON.stringify({
                type: MessageType.CF_AGENT_STREAM_RESUME_NONE
              })
            );
          }
          return;
        }

        // Handle stream resume acknowledgment
        if (data.type === MessageType.CF_AGENT_STREAM_RESUME_ACK) {
          this._pendingResumeConnections.delete(connection.id);

          if (
            this._resumableStream.hasActiveStream() &&
            this._resumableStream.activeRequestId === data.id
          ) {
            const orphanedStreamId = this._resumableStream.replayChunks(
              connection,
              this._resumableStream.activeRequestId
            );

            // If the stream was orphaned (restored from SQLite after
            // hibernation with no live reader), reconstruct the partial
            // assistant message from stored chunks and persist it so it
            // survives further page refreshes.
            if (orphanedStreamId) {
              this._persistOrphanedStream(orphanedStreamId);
            }
          } else if (this._resumableStream.hasActiveStream()) {
            // Ignore ACKs for a different active stream request id.
          } else if (
            !this._resumableStream.replayCompletedChunksByRequestId(
              connection,
              data.id
            )
          ) {
            sendIfOpen(
              connection,
              JSON.stringify({
                body: "",
                done: true,
                id: data.id,
                type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
                replay: true
              })
            );
          }
          return;
        }

        // Handle client-side tool result
        if (data.type === MessageType.CF_AGENT_TOOL_RESULT) {
          const {
            toolCallId,
            toolName,
            output,
            state,
            errorText,
            autoContinue,
            clientTools
          } = data;

          // Update cached client tools so subsequent continuations use the latest schemas
          if (clientTools?.length) {
            this._lastClientTools = clientTools as ClientToolSchema[];
            this._persistRequestContext();
          }

          const overrideState =
            state === "output-error" ? "output-error" : undefined;

          this._emit("tool:result", { toolCallId, toolName });

          const applyPromise = this._applyToolResult(
            toolCallId,
            toolName,
            output,
            overrideState,
            errorText
          );
          this._pendingInteractionPromise = applyPromise;
          applyPromise
            .finally(() => {
              if (this._pendingInteractionPromise === applyPromise) {
                this._pendingInteractionPromise = null;
              }
            })
            .catch(() => {});

          if (autoContinue) {
            this._enqueueAutoContinuation(
              connection,
              clientTools ?? this._lastClientTools,
              this._lastBody,
              "[AIChatAgent] Tool continuation failed:",
              applyPromise
            );
          }
          return;
        }

        // Handle client-side tool approval response
        if (data.type === MessageType.CF_AGENT_TOOL_APPROVAL) {
          const { toolCallId, approved, autoContinue } = data;
          this._emit("tool:approval", { toolCallId, approved });
          const approvalPromise = this._applyToolApproval(toolCallId, approved);
          this._pendingInteractionPromise = approvalPromise;
          approvalPromise
            .finally(() => {
              if (this._pendingInteractionPromise === approvalPromise) {
                this._pendingInteractionPromise = null;
              }
            })
            .catch(() => {});

          if (autoContinue) {
            this._enqueueAutoContinuation(
              connection,
              this._lastClientTools,
              this._lastBody,
              "[AIChatAgent] Tool approval continuation failed:",
              approvalPromise
            );
          }
          return;
        }
      }

      // Forward unhandled messages to consumer's onMessage
      return _onMessage(connection, message);
    };

    const _onRequest = this.onRequest.bind(this);
    this.onRequest = async (request: Request) => {
      return this._tryCatchChat(async () => {
        const url = new URL(request.url);
        if (url.pathname.split("/").pop() === "get-messages") {
          return Response.json(this._loadMessagesFromDb());
        }
        return _onRequest(request);
      });
    };
  }

  private _ensureAgentToolTables() {
    this.sql`create table if not exists cf_ai_chat_agent_tool_runs (
      run_id text primary key,
      request_id text,
      status text not null,
      input_json text,
      output_json text,
      summary text,
      error_message text,
      started_at integer not null,
      completed_at integer
    )`;
    const addColumnIfNotExists = (sql: string) => {
      try {
        this.ctx.storage.sql.exec(sql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("duplicate column")) {
          throw error;
        }
      }
    };
    addColumnIfNotExists(
      "alter table cf_ai_chat_agent_tool_runs add column input_json text"
    );
    addColumnIfNotExists(
      "alter table cf_ai_chat_agent_tool_runs add column output_json text"
    );
    addColumnIfNotExists(
      "alter table cf_ai_chat_agent_tool_runs add column summary text"
    );
    this.sql`create index if not exists idx_ai_chat_agent_tool_request_id
      on cf_ai_chat_agent_tool_runs(request_id)`;
  }

  private _flushAwaitingStreamStartConnections() {
    if (!this._resumableStream.hasActiveStream()) {
      return;
    }

    this._continuation.flushAwaitingConnections((c: ContinuationConnection) =>
      this._notifyStreamResuming(c as Connection)
    );
  }

  private _mergeAutoContinuationPrerequisite(
    current: Promise<boolean> | null,
    next?: Promise<boolean>
  ): Promise<boolean> | null {
    if (!next) {
      return current;
    }

    if (!current) {
      return next;
    }

    return Promise.all([current, next]).then(
      ([currentApplied, nextApplied]) => {
        return currentApplied && nextApplied;
      }
    );
  }

  private _storeDeferredAutoContinuation(
    connection: Connection,
    clientTools: ClientToolSchema[] | undefined,
    body: Record<string, unknown> | undefined,
    errorPrefix: string,
    prerequisite?: Promise<boolean>
  ) {
    const existing = this._continuation.deferred;
    this._continuation.deferred = {
      connection,
      connectionId: connection.id,
      clientTools,
      body,
      errorPrefix,
      prerequisite: this._mergeAutoContinuationPrerequisite(
        existing?.prerequisite ?? null,
        prerequisite
      )
    };
  }

  private _activateDeferredAutoContinuation() {
    const pending = this._continuation.activateDeferred(() => nanoid());
    if (!pending) return;
    this._queueAutoContinuation(pending.requestId);
  }

  private _clearAllAutoContinuationState(sendNone = false) {
    this._clearPendingAutoContinuation(sendNone);
    this._continuation.clearDeferred();
  }

  private _clearPendingAutoContinuation(sendNone = false) {
    if (sendNone) {
      this._continuation.sendResumeNone();
    }
    this._continuation.clearPending();
  }

  /**
   * Notify a connection about an active stream that can be resumed.
   * The client should respond with CF_AGENT_STREAM_RESUME_ACK to receive chunks.
   * @param connection - The WebSocket connection to notify
   */
  private _notifyStreamResuming(connection: Connection) {
    if (!this._resumableStream.hasActiveStream()) {
      return;
    }

    // Notify client - they will send ACK when ready
    const sent = sendIfOpen(
      connection,
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUMING,
        id: this._resumableStream.activeRequestId
      })
    );
    if (sent) {
      // Add connection to pending set - they'll be excluded from live broadcasts
      // until they send ACK to receive the full stream replay
      this._pendingResumeConnections.add(connection.id);
    }
  }

  // ── Delegate methods for backward compatibility with tests ─────────
  // These protected methods delegate to _resumableStream so existing
  // test workers that call them directly continue to work.

  /** @internal Delegate to _resumableStream */
  protected get _activeStreamId(): string | null {
    return this._resumableStream?.activeStreamId ?? null;
  }

  /** @internal Delegate to _resumableStream */
  protected get _activeRequestId(): string | null {
    return this._resumableStream?.activeRequestId ?? null;
  }

  /** @internal Delegate to _resumableStream */
  protected _startStream(requestId: string): string {
    const streamId = this._resumableStream.start(requestId);
    if (this._continuation.pending?.requestId === requestId) {
      this._continuation.activatePending();
      this._flushAwaitingStreamStartConnections();
      this._activateDeferredAutoContinuation();
    }
    return streamId;
  }

  /** @internal Delegate to _resumableStream */
  protected _completeStream(streamId: string) {
    const completedRequestId = this._resumableStream.activeRequestId;
    this._resumableStream.complete(streamId);
    this._pendingResumeConnections.clear();
    if (completedRequestId === this._continuation.activeRequestId) {
      this._continuation.activeRequestId = null;
      this._continuation.activeConnectionId = null;
    }
  }

  /** @internal Delegate to _resumableStream */
  protected _storeStreamChunk(streamId: string, body: string) {
    this._resumableStream.storeChunk(streamId, body);
  }

  /** @internal Delegate to _resumableStream */
  protected _flushChunkBuffer() {
    this._resumableStream.flushBuffer();
  }

  /** @internal Delegate to _resumableStream */
  protected _restoreActiveStream() {
    this._resumableStream.restore();
  }

  /** @internal Delegate to _resumableStream */
  protected _markStreamError(streamId: string) {
    this._resumableStream.markError(streamId);
    this._pendingResumeConnections.clear();
  }

  /**
   * Reconstruct and persist a partial assistant message from an orphaned
   * stream's stored chunks. Called when the DO wakes from hibernation and
   * discovers an active stream with no live LLM reader.
   *
   * Replays each chunk body through `applyChunkToParts` to rebuild the
   * message parts, then persists the result so it survives further refreshes.
   * @internal
   */
  protected _persistOrphanedStream(streamId: string) {
    const chunks = this._resumableStream.getStreamChunks(streamId);
    if (!chunks.length) return;

    const fallbackId = `assistant_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const message: UIMessage = {
      id: fallbackId,
      role: "assistant",
      parts: []
    };

    for (const chunk of chunks) {
      try {
        const data = JSON.parse(chunk.body);

        // Capture message ID from the "start" event if present
        if (data.type === "start" && data.messageId != null) {
          message.id = data.messageId;
        }
        if (
          (data.type === "start" ||
            data.type === "finish" ||
            data.type === "message-metadata") &&
          data.messageMetadata != null
        ) {
          message.metadata = message.metadata
            ? { ...message.metadata, ...data.messageMetadata }
            : data.messageMetadata;
        }

        applyChunkToParts(message.parts, data);
      } catch {
        // Skip malformed chunk bodies
      }
    }

    if (message.parts.length > 0) {
      // Continuation streams have their messageId stripped (#1229) so the
      // start chunk won't contain one. Fall back to the last assistant
      // message — continuations always append to it.
      if (message.id === fallbackId) {
        for (let i = this.messages.length - 1; i >= 0; i--) {
          if (this.messages[i].role === "assistant") {
            message.id = this.messages[i].id;
            break;
          }
        }
      }

      // Check if a message with this ID already exists (e.g., from an
      // early persist during tool approval, or a continuation resuming
      // the last assistant message). Update in place if so.
      const existingIdx = this.messages.findIndex((m) => m.id === message.id);
      if (existingIdx >= 0) {
        // Merge: keep existing parts and append new ones from the stream
        const existing = this.messages[existingIdx];
        message.parts = [...existing.parts, ...message.parts];
        if (existing.metadata) {
          message.metadata = message.metadata
            ? { ...existing.metadata, ...message.metadata }
            : existing.metadata;
        }
      }
      const updatedMessages =
        existingIdx >= 0
          ? this.messages.map((m, i) => (i === existingIdx ? message : m))
          : [...this.messages, message];
      this.persistMessages(updatedMessages);
    }
  }

  /**
   * Restore _lastBody and _lastClientTools from SQLite.
   * Called in the constructor so these values survive DO hibernation.
   * @internal
   */
  private _restoreRequestContext() {
    const rows =
      this.sql<{ key: string; value: string }>`
        select key, value from cf_ai_chat_request_context
      ` || [];

    for (const row of rows) {
      try {
        if (row.key === "lastBody") {
          this._lastBody = JSON.parse(row.value);
        } else if (row.key === "lastClientTools") {
          this._lastClientTools = JSON.parse(row.value);
        }
      } catch {
        // Corrupted row — ignore and let the next request overwrite it
      }
    }
  }

  /**
   * Persist _lastBody and _lastClientTools to SQLite so they survive hibernation.
   * Uses upsert (INSERT OR REPLACE) so repeated calls are safe.
   * @internal
   */
  private _persistRequestContext() {
    // Persist or delete body
    if (this._lastBody) {
      this.sql`
        insert or replace into cf_ai_chat_request_context (key, value)
        values ('lastBody', ${JSON.stringify(this._lastBody)})
      `;
    } else {
      this.sql`delete from cf_ai_chat_request_context where key = 'lastBody'`;
    }
    // Persist or delete client tools
    if (this._lastClientTools) {
      this.sql`
        insert or replace into cf_ai_chat_request_context (key, value)
        values ('lastClientTools', ${JSON.stringify(this._lastClientTools)})
      `;
    } else {
      this
        .sql`delete from cf_ai_chat_request_context where key = 'lastClientTools'`;
    }
  }

  private _broadcastChatMessage(message: OutgoingMessage, exclude?: string[]) {
    // Combine explicit exclusions with connections pending stream resume.
    // Pending connections should not receive live stream chunks until they ACK,
    // at which point they'll receive the full replay via _sendStreamChunks.
    const allExclusions = [
      ...(exclude || []),
      ...this._pendingResumeConnections
    ];
    this.broadcast(JSON.stringify(message), allExclusions);
  }

  /**
   * Broadcasts a text event for non-SSE responses.
   * This ensures plain text responses follow the AI SDK v5 stream protocol.
   *
   * @param streamId - The stream identifier for chunk storage
   * @param event - The text event payload (text-start, text-delta with delta, or text-end)
   * @param continuation - Whether this is a continuation of a previous stream
   */
  private _broadcastTextEvent(
    streamId: string,
    event:
      | { type: "text-start"; id: string }
      | { type: "text-delta"; id: string; delta: string }
      | { type: "text-end"; id: string },
    continuation: boolean
  ) {
    const body = JSON.stringify(event);
    this._storeStreamChunk(streamId, body);
    this._broadcastChatMessage({
      body,
      done: false,
      id: event.id,
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      ...(continuation && { continuation: true })
    });
  }

  private _loadMessagesFromDb(): UIMessage[] {
    const rows =
      this.sql`select * from cf_ai_chat_agent_messages order by created_at` ||
      [];

    // Populate the persistence cache from DB so incremental persistence
    // can skip SQL writes for messages already stored.
    this._persistedMessageCache.clear();

    return rows
      .map((row) => {
        try {
          const messageStr = row.message as string;
          const parsed = JSON.parse(messageStr) as UIMessage;

          // Structural validation: ensure required fields exist and have
          // the correct types. This catches corrupted rows, manual tampering,
          // or schema drift from older versions without crashing the agent.
          if (!isValidMessageStructure(parsed)) {
            console.warn(
              `[AIChatAgent] Skipping invalid message ${row.id}: ` +
                "missing or malformed id, role, or parts"
            );
            return null;
          }

          // Cache the raw JSON keyed by message ID
          this._persistedMessageCache.set(parsed.id, messageStr);
          return parsed;
        } catch (error) {
          console.error(`Failed to parse message ${row.id}:`, error);
          return null;
        }
      })
      .filter((msg): msg is UIMessage => msg !== null);
  }

  private async _tryCatchChat<T>(fn: () => T | Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      throw this.onError(e);
    }
  }

  private isChatTurnActive(): boolean {
    return this._turnQueue.isActive;
  }

  /**
   * Wait until the agent is fully idle — both the turn queue is drained
   * AND no submits are in flight between the concurrency decision and
   * `_runExclusiveChatTurn` (mid-`persistMessages` etc.).
   *
   * Just awaiting `_turnQueue.waitForIdle()` would miss submits whose
   * handlers have bumped `_latestOverlappingSubmitSequence` and
   * incremented `_pendingEnqueueCount` but haven't yet reached
   * `_runExclusiveChatTurn` — those would race with anything calling
   * `waitForIdle()` (tests, `waitUntilStable`, recovery code).
   */
  private async waitForIdle(): Promise<void> {
    await this._submitConcurrency.waitForIdle(() =>
      this._turnQueue.waitForIdle()
    );
  }

  private _getSubmitConcurrencyDecision(
    trigger: ChatRequestTrigger
  ): SubmitConcurrencyDecision {
    const decision = this._submitConcurrency.decide({
      concurrency: this.messageConcurrency,
      isSubmitMessage: trigger === "submit-message",
      queuedTurns: this._turnQueue.queuedCount()
    });

    if (decision.strategy === "merge") {
      if (
        !this._mergeQueuedUserStartIndexByEpoch.has(this._turnQueue.generation)
      ) {
        this._mergeQueuedUserStartIndexByEpoch.set(
          this._turnQueue.generation,
          this.messages.length
        );
      }
    }

    return decision;
  }

  private async _mergeQueuedUserMessages(
    epoch = this._turnQueue.generation
  ): Promise<void> {
    const mergedMessages = this._getMergedQueuedUserMessages(epoch);
    if (!mergedMessages) {
      return;
    }

    await this.persistMessages(mergedMessages, [], {
      _deleteStaleRows: true
    });
  }

  private _getMergedQueuedUserMessages(epoch: number): UIMessage[] | null {
    const queuedUserStart = this._mergeQueuedUserStartIndexByEpoch.get(epoch);
    if (queuedUserStart === undefined) {
      return null;
    }

    let queuedUserEnd = queuedUserStart;
    while (this.messages[queuedUserEnd]?.role === "user") {
      queuedUserEnd++;
    }

    if (
      queuedUserEnd === queuedUserStart &&
      queuedUserStart < this.messages.length
    ) {
      console.warn(
        `[AIChatAgent] merge: expected user messages at index ${queuedUserStart} ` +
          `but found role="${this.messages[queuedUserStart]?.role}"; skipping merge`
      );
    }

    const queuedUserMessages = this.messages.slice(
      queuedUserStart,
      queuedUserEnd
    );
    if (queuedUserMessages.length < 2) {
      return null;
    }

    return [
      ...this.messages.slice(0, queuedUserStart),
      AIChatAgent._mergeUserMessages(queuedUserMessages),
      ...this.messages.slice(queuedUserEnd)
    ];
  }

  private static _mergeUserMessages(messages: UIMessage[]): UIMessage {
    const [firstMessage, ...remainingMessages] = messages;
    if (!firstMessage) {
      throw new Error("cannot merge an empty message list");
    }

    let mergedParts = AIChatAgent._cloneMessageParts(firstMessage.parts);
    for (const message of remainingMessages) {
      AIChatAgent._appendMergedText(mergedParts, "\n\n");
      mergedParts = AIChatAgent._mergeMessageParts(mergedParts, message.parts);
    }

    const lastMessage = messages[messages.length - 1] ?? firstMessage;
    return {
      ...lastMessage,
      parts: mergedParts
    };
  }

  private static _mergeMessageParts(
    currentParts: UIMessage["parts"],
    nextParts: UIMessage["parts"]
  ): UIMessage["parts"] {
    const mergedParts = AIChatAgent._cloneMessageParts(currentParts);

    for (const part of nextParts) {
      if (part.type === "text") {
        AIChatAgent._appendMergedText(mergedParts, part.text);
        continue;
      }

      mergedParts.push(part);
    }

    return mergedParts;
  }

  private static _cloneMessageParts(
    parts: UIMessage["parts"]
  ): UIMessage["parts"] {
    return [...parts];
  }

  private static _appendMergedText(
    parts: UIMessage["parts"],
    text: string
  ): void {
    if (text.length === 0) {
      return;
    }

    const lastPart = parts[parts.length - 1];
    if (lastPart?.type === "text") {
      parts[parts.length - 1] = {
        ...lastPart,
        text: lastPart.text + text
      };
      return;
    }

    const textPart: TextUIPart = {
      type: "text",
      text
    };
    parts.push(textPart);
  }

  private _setRequestContext(
    clientTools?: ClientToolSchema[],
    body?: Record<string, unknown>
  ) {
    this._lastClientTools = clientTools?.length ? clientTools : undefined;
    this._lastBody = body && Object.keys(body).length > 0 ? body : undefined;
    this._persistRequestContext();
  }

  private _messagesForClientSync(): readonly UIMessage[] {
    if (!this._streamingMessage || this._streamingMessage.parts.length === 0) {
      return this.messages;
    }

    const existingIdx = this.messages.findIndex(
      (message) => message.id === this._streamingMessage?.id
    );

    if (existingIdx >= 0) {
      return this.messages.map((message, idx) =>
        idx === existingIdx && this._streamingMessage
          ? this._streamingMessage
          : message
      );
    }

    return [...this.messages, this._streamingMessage];
  }

  private _sendDirectMessage(
    connection: Connection,
    message: OutgoingMessage
  ): void {
    try {
      connection.send(JSON.stringify(message));
    } catch {
      // Connection closed before the server could reply.
    }
  }

  private _completeSkippedRequest(connection: Connection, requestId: string) {
    this._sendDirectMessage(connection, {
      body: "",
      done: true,
      id: requestId,
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
    });
  }

  private _rollbackDroppedSubmit(connection: Connection) {
    this._sendDirectMessage(connection, {
      messages: this._messagesForClientSync(),
      type: MessageType.CF_AGENT_CHAT_MESSAGES
    });
  }

  /** `true` when an assistant message is waiting on a client tool result or approval. */
  protected hasPendingInteraction(): boolean {
    if (
      this._streamingMessage &&
      this._messageHasPendingInteraction(this._streamingMessage)
    ) {
      return true;
    }

    return this.messages.some(
      (message) =>
        message.role === "assistant" &&
        this._messageHasPendingInteraction(message)
    );
  }

  /**
   * Waits until the conversation is fully stable — no active stream, no
   * pending client-tool interactions, and no queued continuation turns.
   *
   * Returns `true` when stable. Returns `false` if `timeout` expires before
   * a pending interaction resolves. Safe to call at any time; if there is
   * nothing pending it returns immediately.
   */
  protected async waitUntilStable(options?: {
    timeout?: number;
  }): Promise<boolean> {
    const deadline =
      options?.timeout != null ? Date.now() + options.timeout : null;

    while (true) {
      // Drain active turns AND any in-flight submits past the concurrency
      // decision (mid-`persistMessages`) so `hasPendingInteraction()`
      // reflects settled message state rather than in-flight streaming
      // state. Just `_turnQueue.waitForIdle()` would miss submits whose
      // handlers have bumped `_latestOverlappingSubmitSequence` and
      // incremented `_pendingEnqueueCount` but haven't yet enqueued.
      while (true) {
        if (
          (await this._awaitWithDeadline(
            this._turnQueue.waitForIdle(),
            deadline
          )) === TIMED_OUT
        ) {
          return false;
        }
        if (this._submitConcurrency.pendingEnqueueCount === 0) break;
        if (
          (await this._awaitWithDeadline(
            new Promise<void>((resolve) => setTimeout(resolve, 5)),
            deadline
          )) === TIMED_OUT
        ) {
          return false;
        }
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
        // No tool result/approval apply is currently in flight; we are still
        // waiting for the user to resolve the interaction.
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

  private abortActiveTurn(): boolean {
    if (!this._turnQueue.activeRequestId) {
      return false;
    }

    this._abortRegistry.cancel(this._turnQueue.activeRequestId);
    return true;
  }

  /**
   * Aborts the active turn and invalidates queued continuations. Call this
   * when intercepting `CF_AGENT_CHAT_CLEAR` before the SDK sees the message —
   * the built-in handler calls it automatically.
   */
  protected resetTurnState(): void {
    this._mergeQueuedUserStartIndexByEpoch.delete(this._turnQueue.generation);
    this._turnQueue.reset();
    this._abortRegistry.destroyAll();
    this._submitConcurrency.reset();
    this._pendingInteractionPromise = null;
    this._continuation.sendResumeNone();
    this._continuation.clearAll();
    this._pendingChatResponseResults.length = 0;
  }

  /**
   * Abort a single in-flight chat turn by request id.
   *
   * Equivalent to the cancel path that fires when a client sends a
   * `chat-request-cancel` WebSocket message — the inference loop's
   * signal aborts and the turn's `ChatResponseResult` reports
   * `status: "aborted"`. No-op if no controller exists for `requestId`.
   *
   * Most callers don't have the request id and want
   * {@link abortAllRequests} instead. Prefer
   * {@link SaveMessagesOptions.signal} when driving a turn
   * programmatically — it threads the abort intent in from the start
   * without requiring the caller to know the id.
   */
  protected abortRequest(requestId: string, reason?: unknown): void {
    this._abortRegistry.cancel(requestId, reason);
  }

  /**
   * Abort every in-flight chat turn on this agent.
   *
   * Aborts all controllers in the registry and clears it. Used by
   * subclasses that drive single-purpose turns (e.g. an RPC-driven
   * sub-agent helper that runs one turn at a time) and want a coarse
   * "cancel whatever is running" handle without tracking request ids.
   *
   * Does NOT reset queued turns, continuation timers, or submit
   * concurrency state — use {@link resetTurnState} for the full
   * teardown that runs on `chat-clear`.
   */
  protected abortAllRequests(): void {
    this._abortRegistry.destroyAll();
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
        (part.state === "input-available" ||
          part.state === "approval-requested")
    );
  }

  /**
   * Run a chat turn exclusively so `_reply()` never overlaps with another
   * streaming turn.
   */
  private async _runExclusiveChatTurn<T>(
    requestId: string,
    fn: () => Promise<T>,
    options?: { epoch?: number; onStale?: () => void }
  ): Promise<T> {
    const generation = options?.epoch;
    let result: TurnResult<T>;
    try {
      result = await this._turnQueue.enqueue(requestId, fn, {
        generation
      });
    } finally {
      // Clean merge map when all turns for a generation complete
      const gen = generation ?? this._turnQueue.generation;
      if (this._turnQueue.queuedCount(gen) === 0) {
        this._mergeQueuedUserStartIndexByEpoch.delete(gen);
      }

      if (
        this._pendingChatResponseResults.length > 0 &&
        !this._insideResponseHook
      ) {
        this._insideResponseHook = true;
        try {
          await this.keepAliveWhile(async () => {
            while (this._pendingChatResponseResults.length > 0) {
              const chatResult = this._pendingChatResponseResults.shift()!;
              try {
                await this.onChatResponse(chatResult);
              } catch (hookError) {
                console.error("[AIChatAgent] onChatResponse threw:", hookError);
              }
            }
          });
        } finally {
          this._insideResponseHook = false;
        }
      }
    }

    if (result!.status === "stale") {
      options?.onStale?.();
      return undefined as T;
    }
    return result!.value;
  }

  private _enqueueAutoContinuation(
    connection: Connection,
    clientTools: ClientToolSchema[] | undefined,
    body: Record<string, unknown> | undefined,
    errorPrefix: string,
    prerequisite?: Promise<boolean>
  ) {
    if (this._continuation.pending) {
      if (this._continuation.pending.pastCoalesce) {
        this._storeDeferredAutoContinuation(
          connection,
          clientTools,
          body,
          errorPrefix,
          prerequisite
        );
        return;
      }

      this._continuation.pending.connection = connection;
      this._continuation.pending.connectionId = connection.id;
      this._continuation.awaitingConnections.set(connection.id, connection);
      this._continuation.pending.clientTools = clientTools;
      this._continuation.pending.body = body;
      this._continuation.pending.errorPrefix = errorPrefix;
      this._continuation.pending.prerequisite =
        this._mergeAutoContinuationPrerequisite(
          this._continuation.pending.prerequisite,
          prerequisite
        );
      return;
    }

    const requestId = nanoid();
    this._continuation.pending = {
      connection,
      connectionId: connection.id,
      requestId,
      clientTools,
      body,
      errorPrefix,
      prerequisite: this._mergeAutoContinuationPrerequisite(null, prerequisite),
      pastCoalesce: false
    };
    this._continuation.awaitingConnections.set(connection.id, connection);
    this._queueAutoContinuation(requestId);
  }

  private async _awaitPendingAutoContinuationPrerequisite(): Promise<boolean> {
    while (true) {
      const prerequisite = this._continuation.pending?.prerequisite;
      if (!prerequisite) {
        return true;
      }

      const applied = await prerequisite;
      if (!applied) {
        return false;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, AIChatAgent.AUTO_CONTINUATION_COALESCE_MS)
      );

      if (this._continuation.pending?.prerequisite === prerequisite) {
        return true;
      }
    }
  }

  private _queueAutoContinuation(requestId: string) {
    const epoch = this._turnQueue.generation;
    // _runExclusiveChatTurn must be called synchronously so the chat turn
    // queue is set up immediately — otherwise waitForIdle() can resolve
    // before the continuation starts.  keepAlive() is called inside the
    // turn to prevent hibernation while waiting for prerequisites /
    // streaming, without deferring the queue registration.
    this._runExclusiveChatTurn(
      requestId,
      async () => {
        const dispose = await this.keepAlive();
        try {
          const applied =
            await this._awaitPendingAutoContinuationPrerequisite();
          if (!applied) {
            this._clearAllAutoContinuationState(true);
            return;
          }

          const connection = this._continuation.pending
            ?.connection as Connection | null;
          if (!connection) {
            this._clearAllAutoContinuationState(true);
            return;
          }

          const clientTools = this._continuation.pending?.clientTools;
          const body = this._continuation.pending?.body;
          if (this._continuation.pending) {
            this._continuation.pending.pastCoalesce = true;
          }

          const abortSignal = this._abortRegistry.getSignal(requestId);

          return this._tryCatchChat(async () => {
            return agentContext.run(
              {
                agent: this,
                connection,
                request: undefined,
                email: undefined
              },
              async () => {
                const autoContinuationBody = async () => {
                  try {
                    const response = await this.onChatMessage(
                      async (_finishResult) => {},
                      {
                        requestId,
                        abortSignal,
                        clientTools,
                        body,
                        continuation: true
                      }
                    );

                    if (response) {
                      await this._reply(requestId, response, [], {
                        continuation: true,
                        chatMessageId: requestId
                      });
                      this._activateDeferredAutoContinuation();
                    } else {
                      this._clearPendingAutoContinuation(true);
                      this._activateDeferredAutoContinuation();
                    }
                  } finally {
                    this._abortRegistry.remove(requestId);
                  }
                };

                if (this.chatRecovery) {
                  await this.runFiber(
                    `${(this.constructor as typeof AIChatAgent).CHAT_FIBER_NAME}:${requestId}`,
                    async () => {
                      await autoContinuationBody();
                    }
                  );
                } else {
                  await autoContinuationBody();
                }
              }
            );
          });
        } finally {
          dispose();
        }
      },
      {
        epoch,
        onStale: () => this._clearAllAutoContinuationState(true)
      }
    ).catch((error) => {
      const errorPrefix =
        this._continuation.pending?.errorPrefix ??
        "[AIChatAgent] Auto-continuation failed:";
      this._clearAllAutoContinuationState(true);
      console.error(errorPrefix, error);
    });
  }

  /**
   * @returns `true` if the registry's controller for `requestId` was
   *   aborted during the turn (so the caller can surface
   *   `status: "aborted"` to the public API). Returns `false` for
   *   successful or errored completion.
   */
  private async _runProgrammaticChatTurn(
    requestId: string,
    clientTools?: ClientToolSchema[],
    body?: Record<string, unknown>,
    externalSignal?: AbortSignal
  ): Promise<boolean> {
    this._setRequestContext(clientTools, body);
    let wasAborted = false;

    await this._tryCatchChat(async () => {
      return agentContext.run(
        {
          agent: this,
          connection: undefined,
          request: undefined,
          email: undefined
        },
        async () => {
          const abortSignal = this._abortRegistry.getSignal(requestId);
          // Wire the optional external signal to the registry's
          // controller. Detacher MUST run in `finally` to avoid leaking
          // listeners on long-lived parent signals — including the case
          // where `runFiber` itself throws (e.g. SQLite error inserting
          // the fiber row) before `programmaticBody` is ever invoked.
          const detachExternal = this._abortRegistry.linkExternal(
            requestId,
            externalSignal
          );
          try {
            const programmaticBody = async () => {
              const response = await this.onChatMessage(() => {}, {
                requestId,
                abortSignal,
                clientTools,
                body,
                continuation: false
              });

              if (response) {
                await this._reply(requestId, response, [], {
                  chatMessageId: requestId
                });
              }
            };

            if (this.chatRecovery) {
              await this.runFiber(
                `${(this.constructor as typeof AIChatAgent).CHAT_FIBER_NAME}:${requestId}`,
                async () => {
                  await programmaticBody();
                }
              );
            } else {
              await programmaticBody();
            }
          } finally {
            if (abortSignal?.aborted) wasAborted = true;
            detachExternal();
            this._abortRegistry.remove(requestId);
          }
        }
      );
    });

    return wasAborted;
  }

  /**
   * Handle incoming chat messages and generate a response
   * @param onFinish Callback to be called when the response is finished
   * @param options Options including abort signal and client-defined tools
   * @returns Response to send to the client or undefined
   */
  async onChatMessage(
    // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
    // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
    _options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    throw new Error(
      "received a chat message, override onChatMessage and return a Response to send to the client"
    );
  }

  /**
   * Called after a chat turn completes and the assistant message has been
   * persisted. The turn lock is released before this hook runs, so it is
   * safe to call `saveMessages` from inside.
   *
   * Fires for all turn completion paths: WebSocket chat requests,
   * `saveMessages`, and auto-continuation.
   *
   * Responses triggered from inside `onChatResponse` (e.g. via `saveMessages`)
   * do not fire `onChatResponse` recursively.
   *
   * The default implementation is a no-op.
   *
   * @param result - Information about the completed turn
   *
   * @example
   * ```ts
   * class MyAgent extends AIChatAgent<Env> {
   *   protected async onChatResponse(result: ChatResponseResult) {
   *     if (result.status === "completed") {
   *       this.broadcast(JSON.stringify({ streaming: false }));
   *     }
   *   }
   * }
   * ```
   */
  protected onChatResponse(
    // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
    _result: ChatResponseResult
  ): void | Promise<void> {}

  /**
   * Override this method to apply custom transformations to messages before
   * they are persisted to storage. This hook runs **after** the built-in
   * sanitization (OpenAI metadata stripping, Anthropic provider-executed tool
   * payload truncation, empty reasoning part filtering).
   *
   * The default implementation returns the message unchanged.
   *
   * @param message - The pre-sanitized message about to be persisted
   * @returns The transformed message to persist
   *
   * @example
   * ```ts
   * class MyAgent extends AIChatAgent<Env> {
   *   protected sanitizeMessageForPersistence(
   *     message: UIMessage
   *   ): UIMessage {
   *     return {
   *       ...message,
   *       parts: message.parts.map(part => {
   *         if ("output" in part && typeof part.output === "string"
   *             && part.output.length > 1000) {
   *           return { ...part, output: "[redacted]" };
   *         }
   *         return part;
   *       })
   *     };
   *   }
   * }
   * ```
   */
  protected sanitizeMessageForPersistence(
    // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
    message: UIMessage
  ): UIMessage {
    return message;
  }

  /**
   * Convert an agent-tool input payload into the synthetic user message that
   * starts a headless `AIChatAgent` turn.
   */
  protected formatAgentToolInput(
    input: unknown,
    request: { runId: string }
  ): UIMessage {
    let text: string;
    try {
      text = typeof input === "string" ? input : JSON.stringify(input, null, 2);
    } catch {
      text = String(input);
    }

    return {
      id: `agent-tool-${request.runId}-input`,
      role: "user",
      parts: [{ type: "text", text }]
    };
  }

  /**
   * Override to return structured agent-tool output instead of the default
   * final assistant text.
   */
  protected getAgentToolOutput(
    _request: { runId: string; input: unknown },
    messagesAfterStart: readonly UIMessage[]
  ): unknown {
    return AIChatAgent._extractLatestAssistantText(messagesAfterStart);
  }

  /**
   * Override to customize the concise summary stored on the parent run.
   */
  protected getAgentToolSummary(
    _request: { runId: string; input: unknown },
    output: unknown,
    messagesAfterStart: readonly UIMessage[]
  ): string {
    if (typeof output === "string") return output;
    if (output === undefined) {
      return AIChatAgent._extractLatestAssistantText(messagesAfterStart) ?? "";
    }
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }

  async startAgentToolRun(
    input: unknown,
    options: { runId: string; signal?: AbortSignal }
  ): Promise<AgentToolRunInspection> {
    const existing = await this.inspectAgentToolRun(options.runId);
    if (existing) return existing;

    const startedAt = Date.now();
    const controller = new AbortController();
    const assistantIdsBeforeStart = new Set(
      this.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.id)
    );

    this.sql`
      insert into cf_ai_chat_agent_tool_runs
        (run_id, request_id, status, input_json, started_at)
      values (${options.runId}, null, 'running', ${AIChatAgent._stringifyAgentToolValue(input)}, ${startedAt})
    `;
    this._agentToolAbortControllers.set(options.runId, controller);
    this._agentToolPreTurnAssistantIds.set(
      options.runId,
      assistantIdsBeforeStart
    );
    this._agentToolLiveSequences.set(options.runId, 0);

    const abortFromParent = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) {
      abortFromParent();
    } else {
      options.signal?.addEventListener("abort", abortFromParent, {
        once: true
      });
    }

    const lifecycle = async () => {
      let requestId: string | undefined;
      try {
        const previousClientTools = this._lastClientTools;
        const previousBody = this._lastBody;
        this._setRequestContext(undefined, { agentToolInput: input });
        const result = await this.saveMessages(
          async (messages) => {
            this._agentToolActiveRunId = options.runId;
            return [
              ...messages,
              this.formatAgentToolInput(input, { runId: options.runId })
            ];
          },
          { signal: controller.signal }
        ).finally(() => {
          this._setRequestContext(previousClientTools, previousBody);
        });
        requestId = result.requestId;

        if (result.status === "aborted") {
          this.sql`
            update cf_ai_chat_agent_tool_runs
            set request_id = ${requestId}, status = 'aborted',
                completed_at = ${Date.now()}
            where run_id = ${options.runId}
          `;
          return;
        }

        if (result.status === "skipped") {
          this.sql`
            update cf_ai_chat_agent_tool_runs
            set request_id = ${requestId}, status = 'error',
                error_message = 'Agent tool run was skipped because the chat was cleared.',
                completed_at = ${Date.now()}
            where run_id = ${options.runId}
          `;
          return;
        }

        const streamError = this._agentToolLastErrors.get(options.runId);
        if (streamError) {
          this.sql`
            update cf_ai_chat_agent_tool_runs
            set request_id = ${requestId}, status = 'error',
                error_message = ${streamError}, completed_at = ${Date.now()}
            where run_id = ${options.runId}
          `;
          return;
        }

        const messagesAfterStart = this._getAgentToolMessagesAfterStart(
          options.runId
        );
        const output = this.getAgentToolOutput(
          { runId: options.runId, input },
          messagesAfterStart
        );
        const summary = this.getAgentToolSummary(
          { runId: options.runId, input },
          output,
          messagesAfterStart
        );

        this.sql`
          update cf_ai_chat_agent_tool_runs
          set request_id = ${requestId}, status = 'completed',
              output_json = ${AIChatAgent._stringifyAgentToolValue(output)},
              summary = ${summary}, error_message = null,
              completed_at = ${Date.now()}
          where run_id = ${options.runId}
        `;
      } catch (error) {
        if (controller.signal.aborted) {
          this.sql`
            update cf_ai_chat_agent_tool_runs
            set request_id = ${requestId ?? null}, status = 'aborted',
                completed_at = ${Date.now()}
            where run_id = ${options.runId}
          `;
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this._agentToolLastErrors.set(options.runId, message);
        this.sql`
          update cf_ai_chat_agent_tool_runs
          set request_id = ${requestId ?? null}, status = 'error',
              error_message = ${message}, completed_at = ${Date.now()}
          where run_id = ${options.runId}
        `;
      } finally {
        options.signal?.removeEventListener("abort", abortFromParent);
        this._agentToolAbortControllers.delete(options.runId);
        this._agentToolLiveSequences.delete(options.runId);
        if (this._agentToolActiveRunId === options.runId) {
          this._agentToolActiveRunId = null;
        }
        this._agentToolLastErrors.delete(options.runId);
        this._agentToolPreTurnAssistantIds.delete(options.runId);
        this._closeAgentToolTailers(options.runId);
      }
    };

    void this.keepAliveWhile(lifecycle);

    return {
      runId: options.runId,
      status: "running",
      startedAt
    };
  }

  async cancelAgentToolRun(runId: string, reason?: unknown): Promise<void> {
    this._agentToolAbortControllers.get(runId)?.abort(reason);
    this.sql`
      update cf_ai_chat_agent_tool_runs
      set status = 'aborted', completed_at = coalesce(completed_at, ${Date.now()})
      where run_id = ${runId} and status = 'running'
    `;
    this._closeAgentToolTailers(runId);
  }

  async inspectAgentToolRun(
    runId: string
  ): Promise<AgentToolRunInspection | null> {
    const row = this._getAgentToolRunRow(runId);
    if (!row) return null;

    if (
      row.status === "running" &&
      !this._agentToolAbortControllers.has(runId)
    ) {
      const error =
        "Agent tool run was interrupted before the child could finish.";
      this.sql`
        update cf_ai_chat_agent_tool_runs
        set status = 'error', error_message = ${error}, completed_at = ${Date.now()}
        where run_id = ${runId}
      `;
      row.status = "error";
      row.error_message = error;
      row.completed_at = Date.now();
    }

    const streamId = row.request_id
      ? this._getAgentToolStreamId(row.request_id)
      : undefined;
    const messagesAfterStart = this._getAgentToolMessagesAfterStart(runId);
    const input = AIChatAgent._parseAgentToolValue(row.input_json);
    const output =
      row.status === "completed"
        ? (AIChatAgent._parseAgentToolValue(row.output_json) ??
          this.getAgentToolOutput({ runId, input }, messagesAfterStart))
        : undefined;

    return {
      runId,
      status: row.status,
      requestId: row.request_id ?? undefined,
      streamId,
      output,
      summary: row.status === "completed" ? (row.summary ?? "") : undefined,
      error:
        row.status === "error" ? (row.error_message ?? undefined) : undefined,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined
    };
  }

  async getAgentToolChunks(
    runId: string,
    options?: { afterSequence?: number }
  ): Promise<AgentToolStoredChunk[]> {
    this._flushChunkBuffer();
    const row = this._getAgentToolRunRow(runId);
    if (!row?.request_id) return [];

    return this._getAgentToolStoredChunks(
      row.request_id,
      options?.afterSequence
    );
  }

  async tailAgentToolRun(
    runId: string,
    options?: { afterSequence?: number; signal?: AbortSignal }
  ): Promise<ReadableStream<AgentToolStoredChunk>> {
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          controller.close();
        };
        const onAbort = () => close();

        try {
          if (options?.signal?.aborted) {
            close();
            return;
          }
          options?.signal?.addEventListener("abort", onAbort, { once: true });

          for (const chunk of await this.getAgentToolChunks(runId, options)) {
            if (closed) return;
            controller.enqueue(
              agentToolChunkEncoder.encode(`${JSON.stringify(chunk)}\n`)
            );
          }

          const inspection = await this.inspectAgentToolRun(runId);
          if (!inspection || inspection.status !== "running") {
            close();
            return;
          }

          const forwarders =
            this._agentToolForwarders.get(runId) ??
            new Set<(chunk: AgentToolStoredChunk) => void>();
          const forward = (chunk: AgentToolStoredChunk) => {
            if (!closed) {
              controller.enqueue(
                agentToolChunkEncoder.encode(`${JSON.stringify(chunk)}\n`)
              );
            }
          };
          forwarders.add(forward);
          this._agentToolForwarders.set(runId, forwarders);

          const closers =
            this._agentToolClosers.get(runId) ?? new Set<() => void>();
          closers.add(close);
          this._agentToolClosers.set(runId, closers);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: () => {}
    });
    return stream as unknown as ReadableStream<AgentToolStoredChunk>;
  }

  private _getAgentToolRunRow(runId: string): AIChatAgentToolRunRow | null {
    const rows = this.sql<AIChatAgentToolRunRow>`
      select run_id, request_id, status, input_json, output_json, summary,
             error_message, started_at, completed_at
      from cf_ai_chat_agent_tool_runs
      where run_id = ${runId}
    `;
    return rows[0] ?? null;
  }

  private _getAgentToolStreamId(requestId: string): string | undefined {
    const rows = this.sql<AIChatStreamMetadataRow>`
      select id, status, request_id
      from cf_ai_chat_stream_metadata
      where request_id = ${requestId}
      order by rowid desc
      limit 1
    `;
    return rows[0]?.id;
  }

  private _getAgentToolStoredChunks(
    requestId: string,
    afterSequence = -1
  ): AgentToolStoredChunk[] {
    const streamId = this._getAgentToolStreamId(requestId);
    if (!streamId) return [];

    const rows = this.sql<AIChatStreamChunkRow>`
      select body, chunk_index
      from cf_ai_chat_stream_chunks
      where stream_id = ${streamId} and chunk_index > ${afterSequence}
      order by chunk_index asc
    `;
    return rows.map((row) => ({
      sequence: row.chunk_index,
      body: row.body
    }));
  }

  private _getAgentToolMessagesAfterStart(runId: string): UIMessage[] {
    const previousAssistantIds =
      this._agentToolPreTurnAssistantIds.get(runId) ?? new Set<string>();
    return this.messages.filter(
      (message) =>
        message.role !== "assistant" || !previousAssistantIds.has(message.id)
    );
  }

  private _closeAgentToolTailers(runId: string) {
    const closers = this._agentToolClosers.get(runId);
    if (closers) {
      for (const close of closers) close();
      this._agentToolClosers.delete(runId);
    }
    this._agentToolForwarders.delete(runId);
  }

  private static _stringifyAgentToolValue(value: unknown): string | null {
    if (value === undefined) return null;
    const json = JSON.stringify(value);
    return json === undefined ? null : json;
  }

  private static _parseAgentToolValue(value: string | null): unknown {
    if (value === null) return undefined;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private static _extractLatestAssistantText(
    messages: readonly UIMessage[]
  ): string | undefined {
    const message = [...messages]
      .reverse()
      .find((candidate) => candidate.role === "assistant");
    if (!message) return undefined;

    const text = message.parts
      .filter((part): part is TextUIPart => part.type === "text")
      .map((part) => part.text)
      .join("");
    return text.length > 0 ? text : undefined;
  }

  /**
   * Persist messages and trigger `onChatMessage()` for a new response.
   *
   * Waits for any active chat turn to finish before starting, so scheduled
   * or programmatic messages never overlap an in-flight stream.
   *
   * Pass a function to derive the next message list from the latest
   * persisted `this.messages` when the turn actually starts. This avoids
   * stale baselines when multiple `saveMessages()` calls queue up behind
   * active work:
   *
   * ```ts
   * await this.saveMessages((messages) => [...messages, syntheticMessage]);
   * ```
   *
   * Pass `options.signal` to cancel the turn from outside without knowing
   * the internally-generated request id. The signal is linked to the
   * registry's controller for this turn — when it aborts, the inference
   * loop's signal aborts and the result reports `status: "aborted"`.
   * Pre-aborted signals short-circuit before any model work runs.
   *
   * Returns `{ requestId, status }` where `status` is `"completed"` when
   * the turn ran, `"skipped"` when the chat was cleared, or `"aborted"`
   * when an external signal cancelled it mid-stream.
   */
  async saveMessages(
    messages:
      | UIMessage[]
      | ((
          currentMessages: readonly UIMessage[]
        ) => UIMessage[] | Promise<UIMessage[]>),
    options?: SaveMessagesOptions
  ): Promise<SaveMessagesResult> {
    const requestId = nanoid();
    const clientTools = this._lastClientTools;
    const body = this._lastBody;
    const epoch = this._turnQueue.generation;
    let status: SaveMessagesResult["status"] = "completed";
    let wasAborted = false;

    await this._runExclusiveChatTurn(
      requestId,
      async () => {
        const resolvedMessages =
          typeof messages === "function"
            ? await messages(this.messages)
            : messages;

        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        await this.persistMessages(resolvedMessages);

        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        wasAborted = await this._runProgrammaticChatTurn(
          requestId,
          clientTools,
          body,
          options?.signal
        );
      },
      { epoch }
    );

    if (this._turnQueue.generation !== epoch && status === "completed") {
      status = "skipped";
    } else if (wasAborted && status === "completed") {
      status = "aborted";
    }

    return { requestId, status };
  }

  /**
   * Trigger a continuation of the last assistant message without inserting
   * a new user message. The LLM sees the full conversation (including the
   * partial assistant response) and generates a continuation that appends
   * to the same message.
   *
   * This uses `continuation: true` in `_reply`, which clones the last
   * assistant message and appends new parts to it — the same mechanism
   * used by tool auto-continuation.
   *
   * Returns early if there is no assistant message to continue from.
   *
   * Pass `options.signal` to cancel the continuation from outside —
   * matches the {@link saveMessages} contract.
   */
  protected async continueLastTurn(
    body?: Record<string, unknown>,
    options?: SaveMessagesOptions
  ): Promise<SaveMessagesResult> {
    if (!this._findLastAssistantMessage()) {
      return { requestId: "", status: "skipped" };
    }

    const requestId = nanoid();
    const clientTools = this._lastClientTools;
    const resolvedBody = body ?? this._lastBody;
    const epoch = this._turnQueue.generation;
    let status: SaveMessagesResult["status"] = "completed";
    let wasAborted = false;

    await this._runExclusiveChatTurn(
      requestId,
      async () => {
        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        this._setRequestContext(clientTools, resolvedBody);

        const turnBody = async () => {
          await this._tryCatchChat(async () => {
            return agentContext.run(
              {
                agent: this,
                connection: undefined,
                request: undefined,
                email: undefined
              },
              async () => {
                const abortSignal = this._abortRegistry.getSignal(requestId);
                const detachExternal = this._abortRegistry.linkExternal(
                  requestId,
                  options?.signal
                );
                try {
                  const response = await this.onChatMessage(() => {}, {
                    requestId,
                    abortSignal,
                    clientTools,
                    body: resolvedBody,
                    continuation: true
                  });

                  if (response) {
                    await this._reply(requestId, response, [], {
                      continuation: true,
                      chatMessageId: requestId
                    });
                  }
                } finally {
                  if (abortSignal?.aborted) wasAborted = true;
                  detachExternal();
                  this._abortRegistry.remove(requestId);
                }
              }
            );
          });
        };

        if (this.chatRecovery) {
          await this.runFiber(
            `${(this.constructor as typeof AIChatAgent).CHAT_FIBER_NAME}:${requestId}`,
            async () => {
              await turnBody();
            }
          );
        } else {
          await turnBody();
        }
      },
      { epoch }
    );

    if (this._turnQueue.generation !== epoch && status === "completed") {
      status = "skipped";
    } else if (wasAborted && status === "completed") {
      status = "aborted";
    }

    return { requestId, status };
  }

  // ── Chat recovery via fibers ──────────────────────────────────────

  /**
   * Context passed to `onChatRecovery` when an interrupted chat stream
   * is detected after DO restart.
   */
  static readonly CHAT_FIBER_NAME = "__cf_internal_chat_turn";

  /**
   * Intercept internal chat fibers before they reach the user's
   * `onFiberRecovered` hook. Maps to `onChatRecovery`.
   * @internal
   */
  protected override async _handleInternalFiberRecovery(
    ctx: FiberRecoveryContext
  ): Promise<boolean> {
    const chatPrefix =
      (this.constructor as typeof AIChatAgent).CHAT_FIBER_NAME + ":";
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
      lastClientTools: this._lastClientTools,
      createdAt: ctx.createdAt
    });

    // Only persist and complete if the stream is still active. The ACK
    // handler (client reconnect → replayChunks) may have already persisted
    // the orphaned stream and completed it before fiber recovery runs.
    // Without this guard, _persistOrphanedStream runs twice on the same
    // chunks, doubling the assistant message's parts.
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
      const targetId = this._findLastAssistantMessage()?.id;
      await this.schedule(
        0,
        "_chatRecoveryContinue",
        targetId ? { targetAssistantId: targetId } : undefined,
        { idempotent: true }
      );
    }

    return true;
  }

  /**
   * Called when an interrupted chat stream is detected after restart.
   * Return options to control recovery:
   *
   * - `{}` (default): persist partial response + schedule continuation
   * - `{ continue: false }`: persist but don't continue
   * - `{ persist: false, continue: false }`: handle everything yourself
   *
   * `ctx.recoveryData` contains any data checkpointed via `this.stash()`
   * during streaming (e.g., OpenAI `responseId`).
   */
  protected async onChatRecovery(
    // oxlint-disable-next-line @typescript-eslint/no-unused-vars -- overridable hook
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
        "[AIChatAgent] _chatRecoveryContinue timed out waiting for stable state, skipping continuation"
      );
      return;
    }

    const targetId = data?.targetAssistantId;
    if (targetId && this._findLastAssistantMessage()?.id !== targetId) {
      return;
    }

    await this.continueLastTurn();
  }

  /**
   * Extract partial text and parts from stored stream chunks.
   */
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
        // Skip malformed chunk bodies
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

  async persistMessages(
    messages: UIMessage[],
    excludeBroadcastIds: string[] = [],
    /** @internal */
    options?: { _deleteStaleRows?: boolean }
  ) {
    const mergedMessages = reconcileMessages(messages, this.messages, (msg) =>
      this._sanitizeMessageForPersistence(msg)
    );

    // Persist only new or changed messages (incremental persistence).
    // Compares serialized JSON against a cache of last-persisted versions.
    for (const message of mergedMessages) {
      const sanitizedMessage = this._sanitizeMessageForPersistence(message);
      const resolved = resolveToolMergeId(sanitizedMessage, this.messages);
      const safe = this._enforceRowSizeLimit(resolved);
      const json = JSON.stringify(safe);

      // Skip SQL write if the message is identical to what's already persisted
      if (this._persistedMessageCache.get(safe.id) === json) {
        continue;
      }

      this.sql`
        insert into cf_ai_chat_agent_messages (id, message)
        values (${safe.id}, ${json})
        on conflict(id) do update set message = excluded.message
      `;
      this._persistedMessageCache.set(safe.id, json);
    }

    // Reconcile: delete DB rows not present in the incoming message set.
    // Only safe when the incoming set is a subset of the server state
    // (e.g. regenerate() trims the last assistant message). When the
    // client appends new messages (IDs unknown to the server), it may
    // not have the full history, so deleting "missing" rows would
    // destroy server-generated assistant messages the client hasn't
    // seen yet.
    // This MUST use mergedMessages (post-merge IDs) because
    // reconcileMessages can remap client IDs to server IDs.
    if (options?._deleteStaleRows) {
      const serverIds = new Set(this.messages.map((m) => m.id));
      const isSubsetOfServer = mergedMessages.every((m) => serverIds.has(m.id));

      if (isSubsetOfServer) {
        const keepIds = new Set(mergedMessages.map((m) => m.id));
        const allDbRows =
          this.sql<{ id: string }>`
            select id from cf_ai_chat_agent_messages
          ` || [];
        for (const row of allDbRows) {
          if (!keepIds.has(row.id)) {
            this.sql`
              delete from cf_ai_chat_agent_messages where id = ${row.id}
            `;
            this._persistedMessageCache.delete(row.id);
          }
        }
      }
    }

    // Enforce maxPersistedMessages: delete oldest messages if over the limit
    if (this.maxPersistedMessages != null) {
      this._enforceMaxPersistedMessages();
    }

    // refresh in-memory messages
    const persisted = this._loadMessagesFromDb();
    this.messages = autoTransformMessages(persisted);
    this._broadcastChatMessage(
      {
        messages: mergedMessages,
        type: MessageType.CF_AGENT_CHAT_MESSAGES
      },
      excludeBroadcastIds
    );
  }

  /**
   * Finds an existing assistant message that contains a tool part with the given toolCallId.
   * Used to detect when a tool result should update an existing message rather than
   * creating a new one.
   *
   * @param toolCallId - The tool call ID to search for
   * @returns The existing message if found, undefined otherwise
   */
  private _findMessageByToolCallId(toolCallId: string): UIMessage | undefined {
    for (const msg of this.messages) {
      if (msg.role !== "assistant") continue;

      for (const part of msg.parts) {
        if ("toolCallId" in part && part.toolCallId === toolCallId) {
          return msg;
        }
      }
    }
    return undefined;
  }

  private _findLastAssistantMessage(): UIMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "assistant") {
        return this.messages[i];
      }
    }

    return undefined;
  }

  private _createStreamingAssistantMessage(continuation: boolean): UIMessage {
    if (continuation) {
      const lastAssistant = this._findLastAssistantMessage();
      if (lastAssistant) {
        return structuredClone(lastAssistant);
      }
    }

    return {
      id: `assistant_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      role: "assistant",
      parts: []
    };
  }

  /**
   * Sanitizes a message for persistence by removing ephemeral provider-specific
   * data that should not be stored or sent back in subsequent requests.
   *
   * Pipeline:
   *
   * 1. **Strip OpenAI ephemeral fields**: The AI SDK's @ai-sdk/openai provider
   *    (v2.0.x+) defaults to using OpenAI's Responses API which assigns unique
   *    itemIds and reasoningEncryptedContent to message parts. When persisted
   *    and sent back, OpenAI rejects duplicate itemIds.
   *
   * 2. **Truncate provider-executed tool payloads**: Server-side tool
   *    executions (e.g. Anthropic code_execution, text_editor) can produce
   *    200KB+ payloads in `input` and `output`. These are truncated since the
   *    model has already consumed the results.
   *
   * 3. **Filter truly empty reasoning parts**: After stripping, reasoning parts
   *    with no text and no remaining providerMetadata are removed. Parts that
   *    still carry providerMetadata (e.g. Anthropic's redacted_thinking blocks
   *    with providerMetadata.anthropic.redactedData) are preserved, as they
   *    contain data required for round-tripping with the provider API.
   *
   * 4. **User hook**: Calls the overridable `sanitizeMessageForPersistence()`
   *    method, allowing subclasses to apply custom transformations.
   *
   * @param message - The message to sanitize
   * @returns A new message with ephemeral provider data removed
   */
  private _sanitizeMessageForPersistence(message: UIMessage): UIMessage {
    // Base sanitization: strip OpenAI ephemeral fields + filter empty reasoning parts
    const baseSanitized = sanitizeMessage(message);

    // ai-chat-specific: truncate large payloads in provider-executed tool parts
    const parts = baseSanitized.parts.map((part) =>
      AIChatAgent._truncateProviderExecutedToolPayloads(part)
    ) as UIMessage["parts"];

    // Run user-overridable hook last
    return this.sanitizeMessageForPersistence({
      ...baseSanitized,
      parts
    });
  }

  /**
   * Truncates large string values in `input` and `output` of tool parts that
   * were executed server-side by the provider (e.g. Anthropic code_execution,
   * text_editor). These payloads can be 200KB+ and are dead weight once the
   * model has consumed the result.
   *
   * Anthropic web tools are excluded because their outputs are replayed on
   * subsequent turns. Within other tool payloads, opaque encrypted fields are
   * always preserved verbatim.
   */
  private static _truncateProviderExecutedToolPayloads<
    T extends UIMessage["parts"][number]
  >(part: T): T {
    const record = part as Record<string, unknown>;
    if (!record.providerExecuted) return part;
    if (AIChatAgent._shouldPreserveProviderToolPayload(record)) return part;

    const result = { ...record };

    if (result.input !== undefined) {
      result.input = AIChatAgent._truncateLargeStrings(result.input);
    }
    if (result.output !== undefined) {
      result.output = AIChatAgent._truncateLargeStrings(result.output);
    }

    return result as T;
  }

  /**
   * Recursively walks a value and truncates any string exceeding
   * `PROVIDER_TOOL_MAX_STRING_LENGTH`, appending a size marker.
   *
   * The total output (content + marker) is kept within the threshold so
   * re-running this function on already-truncated data is a no-op. Strings
   * under opaque encrypted keys are preserved verbatim.
   */
  private static _truncateLargeStrings(
    value: unknown,
    preserveOpaqueStrings = false
  ): unknown {
    if (typeof value === "string") {
      if (preserveOpaqueStrings) return value;
      if (value.length > PROVIDER_TOOL_MAX_STRING_LENGTH) {
        const marker = `… [truncated, original length: ${value.length}]`;
        const contentLength = Math.max(
          0,
          PROVIDER_TOOL_MAX_STRING_LENGTH - marker.length
        );
        return value.slice(0, contentLength) + marker;
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((v) =>
        AIChatAgent._truncateLargeStrings(v, preserveOpaqueStrings)
      );
    }
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = AIChatAgent._truncateLargeStrings(
          v,
          preserveOpaqueStrings || AIChatAgent._isOpaqueReplayFieldKey(k)
        );
      }
      return result;
    }
    return value;
  }

  private static _shouldPreserveProviderToolPayload(
    part: Record<string, unknown>
  ): boolean {
    const toolName = AIChatAgent._getToolNameFromPart(part);
    return toolName === "web_search" || toolName === "web_fetch";
  }

  private static _getToolNameFromPart(
    part: Record<string, unknown>
  ): string | undefined {
    if (typeof part.toolName === "string") {
      return part.toolName;
    }

    if (typeof part.type === "string" && part.type.startsWith("tool-")) {
      return part.type.slice("tool-".length);
    }

    return undefined;
  }

  private static _isOpaqueReplayFieldKey(key: string): boolean {
    return key.startsWith(PROVIDER_TOOL_OPAQUE_STRING_KEY_PREFIX);
  }

  /**
   * Deletes oldest messages from SQLite when the count exceeds maxPersistedMessages.
   * Called after each persist to keep storage bounded.
   */
  private _enforceMaxPersistedMessages() {
    if (this.maxPersistedMessages == null) return;

    const countResult = this.sql<{ cnt: number }>`
      select count(*) as cnt from cf_ai_chat_agent_messages
    `;
    const count = countResult?.[0]?.cnt ?? 0;

    if (count <= this.maxPersistedMessages) return;

    const excess = count - this.maxPersistedMessages;

    // Delete the oldest messages (by created_at)
    // Also remove them from the persistence cache
    const toDelete = this.sql<{ id: string }>`
      select id from cf_ai_chat_agent_messages 
      order by created_at asc 
      limit ${excess}
    `;

    if (toDelete && toDelete.length > 0) {
      for (const row of toDelete) {
        this.sql`delete from cf_ai_chat_agent_messages where id = ${row.id}`;
        this._persistedMessageCache.delete(row.id);
      }
    }
  }

  /**
   * Enforces SQLite row size limits by compacting tool outputs and text parts
   * when a serialized message exceeds the safety threshold (1.8MB).
   *
   * Only fires in pathological cases (extremely large tool outputs or text).
   * Returns the message unchanged if it fits within limits.
   *
   * Compaction strategy:
   * 1. Compact tool outputs over 1KB (replace with LLM-friendly summary)
   * 2. If still too big, truncate text parts from oldest to newest
   * 3. Add metadata so clients can detect compaction
   *
   * @param message - The message to check
   * @returns The message, compacted if necessary
   */
  private _enforceRowSizeLimit(message: UIMessage): UIMessage {
    let json = JSON.stringify(message);
    let size = chatByteLength(json);
    if (size <= ROW_MAX_BYTES) return message;

    if (message.role !== "assistant") {
      // Non-assistant messages (user/system) are harder to compact safely.
      // Truncate the entire message JSON as a last resort.
      console.warn(
        `[AIChatAgent] Non-assistant message ${message.id} is ${size} bytes, ` +
          `exceeds row limit. Truncating text parts.`
      );
      return this._truncateTextParts(message);
    }

    console.warn(
      `[AIChatAgent] Message ${message.id} is ${size} bytes, ` +
        `compacting tool outputs to fit SQLite row limit`
    );

    // Pass 1: compact tool outputs
    const compactedToolCallIds: string[] = [];
    const compactedParts = message.parts.map((part) => {
      if (
        "output" in part &&
        "toolCallId" in part &&
        "state" in part &&
        part.state === "output-available"
      ) {
        const outputJson = JSON.stringify((part as { output: unknown }).output);
        if (outputJson.length > 1000) {
          compactedToolCallIds.push(part.toolCallId as string);
          return {
            ...part,
            output:
              "This tool output was too large to persist in storage " +
              `(${outputJson.length} bytes). ` +
              "If the user asks about this data, suggest re-running the tool. " +
              `Preview: ${outputJson.slice(0, 500)}...`
          };
        }
      }
      return part;
    }) as UIMessage["parts"];

    let result: UIMessage = {
      ...message,
      parts: compactedParts
    };

    if (compactedToolCallIds.length > 0) {
      result.metadata = {
        ...(result.metadata ?? {}),
        compactedToolOutputs: compactedToolCallIds
      };
    }

    // Check if tool compaction was enough
    json = JSON.stringify(result);
    size = chatByteLength(json);
    if (size <= ROW_MAX_BYTES) return result;

    // Pass 2: truncate text parts
    console.warn(
      `[AIChatAgent] Message ${message.id} still ${size} bytes after tool compaction, truncating text parts`
    );
    return this._truncateTextParts(result);
  }

  /**
   * Truncates text parts in a message to fit within the row size limit.
   * Truncates from the first text part forward, keeping the last text part
   * as intact as possible (it is usually the most relevant).
   */
  private _truncateTextParts(message: UIMessage): UIMessage {
    const compactedTextPartIndices: number[] = [];
    const parts = [...message.parts];

    // Truncate text parts from oldest to newest until we fit
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.type === "text" && "text" in part) {
        const text = (part as { text: string }).text;
        if (text.length > 1000) {
          compactedTextPartIndices.push(i);
          parts[i] = {
            ...part,
            text:
              `[Text truncated for storage (${text.length} chars). ` +
              `First 500 chars: ${text.slice(0, 500)}...]`
          } as UIMessage["parts"][number];

          // Check if we fit now
          const candidate = { ...message, parts };
          if (chatByteLength(JSON.stringify(candidate)) <= ROW_MAX_BYTES) {
            break;
          }
        }
      }
    }

    const result: UIMessage = { ...message, parts };
    if (compactedTextPartIndices.length > 0) {
      result.metadata = {
        ...(result.metadata ?? {}),
        compactedTextParts: compactedTextPartIndices
      };
    }
    return result;
  }

  /**
   * Shared helper for finding a tool part by toolCallId and applying an update.
   * Handles both streaming (in-memory) and persisted (SQLite) messages.
   *
   * Checks _streamingMessage first (tool results/approvals can arrive while
   * the AI is still streaming), then retries persisted messages with backoff
   * in case streaming completes between attempts.
   *
   * `applyUpdate` may return its argument by reference (or `{ ...part }`
   * with no semantic changes) to signal an idempotent no-op — this is
   * detected via `_isToolPartUnchanged` and short-circuits the SQLite
   * write and `MESSAGE_UPDATED` broadcast.
   *
   * @param toolCallId - The tool call ID to find
   * @param callerName - Name for log messages (e.g. "_applyToolResult")
   * @param matchStates - Which tool part states to match
   * @param applyUpdate - Mutation to apply to the matched part (streaming: in-place, persisted: spread)
   * @returns true if the update was applied (or matched as an idempotent
   *   no-op), false if no matching part was found
   */
  private async _findAndUpdateToolPart(
    toolCallId: string,
    callerName: string,
    matchStates: string[],
    applyUpdate: (part: Record<string, unknown>) => Record<string, unknown>
  ): Promise<boolean> {
    // Find the message containing this tool call.
    // Check streaming message first (in-memory, not yet persisted), then
    // retry persisted messages with backoff.
    let message: UIMessage | undefined;

    if (this._streamingMessage) {
      for (const part of this._streamingMessage.parts) {
        if ("toolCallId" in part && part.toolCallId === toolCallId) {
          message = this._streamingMessage;
          break;
        }
      }
    }

    if (!message) {
      for (let attempt = 0; attempt < 10; attempt++) {
        message = this._findMessageByToolCallId(toolCallId);
        if (message) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    if (!message) {
      console.warn(
        `[AIChatAgent] ${callerName}: Could not find message with toolCallId ${toolCallId} after retries`
      );
      return false;
    }

    const isStreamingMessage = message === this._streamingMessage;
    // `wasFound` tracks whether any matching part was processed (real
    // change OR idempotent no-op). `hasRealChange` tracks whether any
    // apply actually mutated state. Tracking both separately matters
    // when a (legacy) message somehow contains duplicate tool parts for
    // the same toolCallId — we must still persist if any of them
    // produced a real change, even if another was an idempotent no-op.
    let wasFound = false;
    let hasRealChange = false;

    if (isStreamingMessage) {
      // Update in place -- the message will be persisted when streaming completes
      for (const part of message.parts) {
        if (
          "toolCallId" in part &&
          part.toolCallId === toolCallId &&
          "state" in part &&
          matchStates.includes(part.state as string)
        ) {
          wasFound = true;
          const applied = applyUpdate(part as Record<string, unknown>);
          if (
            !AIChatAgent._isToolPartUnchanged(
              part as Record<string, unknown>,
              applied
            )
          ) {
            Object.assign(part, applied);
            hasRealChange = true;
          }
          break;
        }
      }
    } else {
      // For persisted messages, create updated parts immutably
      const updatedParts = message.parts.map((part) => {
        if (
          "toolCallId" in part &&
          part.toolCallId === toolCallId &&
          "state" in part &&
          matchStates.includes(part.state as string)
        ) {
          wasFound = true;
          const applied = applyUpdate(part as Record<string, unknown>);
          if (
            AIChatAgent._isToolPartUnchanged(
              part as Record<string, unknown>,
              applied
            )
          ) {
            return part;
          }
          hasRealChange = true;
          return applied;
        }
        return part;
      }) as UIMessage["parts"];

      if (hasRealChange) {
        const updatedMessage: UIMessage = this._sanitizeMessageForPersistence({
          ...message,
          parts: updatedParts
        });
        const safe = this._enforceRowSizeLimit(updatedMessage);
        const json = JSON.stringify(safe);

        this.sql`
          update cf_ai_chat_agent_messages 
          set message = ${json}
          where id = ${message.id}
        `;
        this._persistedMessageCache.set(message.id, json);

        const persisted = this._loadMessagesFromDb();
        this.messages = autoTransformMessages(persisted);
      }
    }

    if (!wasFound) {
      console.warn(
        `[AIChatAgent] ${callerName}: Tool part with toolCallId ${toolCallId} not in expected state (expected: ${matchStates.join("|")})`
      );
      return false;
    }

    // Idempotent no-op: caller asked us to apply something we'd already
    // applied (e.g. a duplicate cf_agent_tool_result, or a cross-tab
    // re-delivery). Skip the broadcast — clients are already in the
    // correct state and a redundant MESSAGE_UPDATED would just churn UI.
    if (!hasRealChange) {
      return true;
    }

    // Broadcast the update to all clients.
    // For persisted messages, re-fetch the latest state from this.messages.
    // For streaming messages, broadcast the in-memory snapshot so clients
    // get immediate confirmation that the tool result/approval was applied.
    if (isStreamingMessage) {
      this._broadcastChatMessage({
        type: MessageType.CF_AGENT_MESSAGE_UPDATED,
        message
      });
    } else {
      const broadcastMessage = this._findMessageByToolCallId(toolCallId);
      if (broadcastMessage) {
        this._broadcastChatMessage({
          type: MessageType.CF_AGENT_MESSAGE_UPDATED,
          message: broadcastMessage
        });
      }
    }

    return true;
  }

  /**
   * Returns true if `applied` is the same reference as `original`, or if
   * the two have identical state-relevant fields. Used by
   * `_findAndUpdateToolPart` to detect idempotent re-applies and skip
   * SQLite writes plus `MESSAGE_UPDATED` broadcasts.
   */
  private static _isToolPartUnchanged(
    original: Record<string, unknown>,
    applied: Record<string, unknown>
  ): boolean {
    if (applied === original) return true;
    if (applied.state !== original.state) return false;
    // For terminal output states, the only fields the apply functions
    // touch are output / errorText / preliminary. Compare via JSON so
    // structurally equal outputs (the common idempotent case) compare
    // equal regardless of reference identity.
    if (
      applied.state === "output-available" ||
      applied.state === "output-error"
    ) {
      return (
        JSON.stringify(applied.output) === JSON.stringify(original.output) &&
        applied.errorText === original.errorText &&
        applied.preliminary === original.preliminary
      );
    }
    if (applied.state === "output-denied") {
      return true;
    }
    if (
      applied.state === "approval-responded" ||
      applied.state === "approval-requested"
    ) {
      return (
        JSON.stringify(applied.approval) === JSON.stringify(original.approval)
      );
    }
    return false;
  }

  /**
   * Applies a tool result to an existing assistant message.
   * This is used when the client sends CF_AGENT_TOOL_RESULT for client-side tools.
   * The server is the source of truth, so we update the message here and broadcast
   * the update to all clients.
   *
   * `output-available` and `output-error` are accepted as valid starting
   * states for *idempotent* re-application — duplicate WS frames, second
   * tabs re-running the same tool, and provider-replay round-trips all
   * become silent no-ops rather than a warn + skipped update. The first
   * applied terminal result wins; subsequent results carrying *different*
   * data are also dropped (preserving the existing "first write wins"
   * contract — see `client-tool-duplicate-message.test.ts`). See issue
   * #1404.
   *
   * @param toolCallId - The tool call ID this result is for
   * @param _toolName - The name of the tool (unused, kept for API compat)
   * @param output - The output from the tool execution
   * @param overrideState - Optional state override ("output-error" to signal denial/failure)
   * @param errorText - Error message when overrideState is "output-error"
   * @returns true if the result was applied, false if the message was not found
   */
  private async _applyToolResult(
    toolCallId: string,
    _toolName: string,
    output: unknown,
    overrideState?: "output-error",
    errorText?: string
  ): Promise<boolean> {
    return this._findAndUpdateToolPart(
      toolCallId,
      "_applyToolResult",
      [
        "input-available",
        "approval-requested",
        "approval-responded",
        // Idempotent re-apply: if the part is already terminal, the apply
        // function below returns the part by reference. _findAndUpdateToolPart
        // detects that and skips the persist + broadcast (and the warn).
        "output-available",
        "output-error",
        "output-denied"
      ],
      (part) => {
        // Once a tool part has reached a terminal state, the first applied
        // result wins. Don't overwrite with conflicting data, and don't
        // emit a redundant MESSAGE_UPDATED for a matching re-apply.
        if (
          part.state === "output-available" ||
          part.state === "output-error" ||
          part.state === "output-denied"
        ) {
          return part;
        }
        if (overrideState === "output-error") {
          return {
            ...part,
            state: "output-error",
            errorText: errorText ?? "Tool execution denied by user"
          };
        }
        return {
          ...part,
          state: "output-available",
          output,
          preliminary: false
        };
      }
    );
  }

  private async _streamSSEReply(
    id: string,
    streamId: string,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    message: UIMessage,
    streamCompleted: { value: boolean },
    continuation = false,
    abortSignal?: AbortSignal
  ): Promise<"completed" | "aborted"> {
    streamCompleted.value = false;

    // During continuation, the first text-start and reasoning-start from the
    // model should merge into existing parts (from the cloned message) rather
    // than creating new blocks. Track whether we've already resumed each type.
    let continuationTextResumed = false;
    let continuationReasoningResumed = false;

    // Cancel the reader when the abort signal fires (e.g. client pressed stop).
    // This ensures we stop broadcasting chunks even if the underlying stream
    // hasn't been connected to the abort signal (e.g. user forgot to pass it
    // to streamText).
    if (abortSignal && !abortSignal.aborted) {
      abortSignal.addEventListener(
        "abort",
        () => {
          reader.cancel().catch(() => {});
        },
        { once: true }
      );
    }

    while (true) {
      if (abortSignal?.aborted) break;
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch (readError) {
        if (abortSignal?.aborted) break;
        throw readError;
      }
      const { done, value } = readResult;
      if (done) {
        // reader.cancel() resolves read() with { done: true } — check abort
        if (abortSignal?.aborted) break;
        this._completeStream(streamId);
        streamCompleted.value = true;
        this._broadcastChatMessage({
          body: "",
          done: true,
          id,
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
          ...(continuation && { continuation: true })
        });
        return "completed";
      }

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          try {
            const data: UIMessageChunk = JSON.parse(line.slice(6));

            // During continuation, merge into existing parts rather than
            // creating new blocks:
            // - text-start: suppressed only when the last text part has
            //   state "streaming" (interrupted mid-generation). Parts with
            //   state "done" or no state create new blocks as usual (e.g.
            //   tool auto-continuation).
            // - reasoning-start: suppressed when resuming an interrupted
            //   assistant turn (an existing reasoning part is still streaming,
            //   or the message has progressed to a still-streaming text part).
            //   Completed reasoning blocks from earlier tool-continuation steps
            //   must not swallow new continuation reasoning, otherwise the
            //   streamed reasoning block disappears when the final persisted
            //   message replaces the live stream.
            let skipServerApply = false;
            if (continuation) {
              if (!continuationTextResumed && data.type === "text-start") {
                for (let k = message.parts.length - 1; k >= 0; k--) {
                  const part = message.parts[k];
                  if (part.type === "text") {
                    if (
                      "state" in part &&
                      (part as { state: string }).state === "streaming"
                    ) {
                      continuationTextResumed = true;
                    }
                    break;
                  }
                }
                if (continuationTextResumed) continue;
              }
              if (
                !continuationReasoningResumed &&
                data.type === "reasoning-start"
              ) {
                for (let k = message.parts.length - 1; k >= 0; k--) {
                  const part = message.parts[k];
                  if (part.type === "text") {
                    if (
                      "state" in part &&
                      (part as { state: string }).state === "streaming"
                    ) {
                      continuationReasoningResumed = true;
                    }
                    break;
                  }
                  if (part.type === "reasoning") {
                    if (
                      "state" in part &&
                      (part as { state: string }).state === "streaming"
                    ) {
                      continuationReasoningResumed = true;
                    }
                    break;
                  }
                }
                // For interrupted continuations, keep appending to the cloned
                // reasoning part but still forward reasoning-start to the
                // client. AI SDK v6 requires reasoning-start before any
                // reasoning-delta in the stream processor's active-part
                // registry.
                skipServerApply = continuationReasoningResumed;
              }
            }

            // Drop replay chunks before applying or broadcasting them.
            //
            // Some providers (notably the OpenAI Responses API) re-emit
            // prior tool calls as a fresh `tool-input-start` →
            // `tool-input-delta` → `tool-input-available` sequence
            // carrying the *same* `toolCallId` during continuation
            // streams. AI SDK v6's `updateToolPart` finds an existing
            // part by toolCallId and mutates it in place, which
            // visibly regresses an `output-available` part back to
            // `input-streaming`/`input-available` on the client
            // (issue #1404).
            //
            // `applyChunkToParts` handles the server-side cloned
            // streaming message safely (it's idempotent for these
            // chunk types), but we must also stop these chunks from
            // reaching the client-side AI SDK, where the in-place
            // mutation would corrupt a resolved tool part.
            //
            // `tool-output-available` is not filtered: its in-place
            // update sets state and output to the values the part
            // already has when the replay matches, so it's
            // semantically a no-op on the client too.
            if (isReplayChunk(message.parts, data as StreamChunkData)) {
              continue;
            }

            // Delegate message building to the shared parser.
            // It handles: text, reasoning, file, source, tool lifecycle,
            // step boundaries — all the part types needed for UIMessage.
            const handled = skipServerApply
              ? true
              : applyChunkToParts(message.parts, data);

            // When a tool enters approval-requested state, the stream is
            // paused waiting for user approval. Persist the streaming message
            // immediately so the approval UI survives page refresh. Without
            // this, a refresh would reload from SQLite where the tool part
            // is still in input-available state, showing "Running..." instead
            // of the Approve/Reject buttons.
            if (
              data.type === "tool-approval-request" &&
              this._streamingMessage
            ) {
              // Persist directly to SQLite without broadcasting.
              // The client already has this data from the SSE stream —
              // broadcasting would cause the approval UI to render twice.
              // We only need the SQL write so the state survives page refresh.
              const snapshot: UIMessage = {
                ...this._streamingMessage,
                parts: [...this._streamingMessage.parts]
              };
              const sanitized = this._sanitizeMessageForPersistence(snapshot);
              const json = JSON.stringify(sanitized);
              this.sql`
                INSERT INTO cf_ai_chat_agent_messages (id, message)
                VALUES (${sanitized.id}, ${json})
                ON CONFLICT(id) DO UPDATE SET message = excluded.message
              `;
              // Track that we persisted early so stream completion can update
              // in place rather than appending a duplicate.
              this._approvalPersistedMessageId = sanitized.id;
            }

            // Cross-message tool output fallback:
            // When a tool with needsApproval is approved, the continuation
            // stream emits tool-output-available/tool-output-error for a
            // tool call that lives in a *previous* assistant message.
            // applyChunkToParts only searches the current message's parts,
            // so the update is silently skipped. Fall back to searching
            // this.messages and update the persisted message directly.
            // Note: checked independently of `handled` — applyChunkToParts
            // returns true for recognized chunk types even when it cannot
            // find the target part, so `handled` is not a reliable signal.
            //
            // `output-available` and `output-error` are accepted as
            // starting states for idempotent re-application. Some
            // providers (notably the OpenAI Responses API) replay the
            // entire prior tool round-trip during continuations — the
            // replay's tool-output-available carries the same output the
            // part already has, so the apply functions below short-circuit
            // to a no-op via reference equality (issue #1404).
            if (
              (data.type === "tool-output-available" ||
                data.type === "tool-output-error") &&
              data.toolCallId
            ) {
              const foundInCurrentMessage = message.parts.some(
                (p) => "toolCallId" in p && p.toolCallId === data.toolCallId
              );
              if (!foundInCurrentMessage) {
                if (data.type === "tool-output-available") {
                  this._findAndUpdateToolPart(
                    data.toolCallId,
                    "_streamSSEReply",
                    [
                      "input-available",
                      "input-streaming",
                      "approval-responded",
                      "approval-requested",
                      "output-available",
                      "output-error",
                      "output-denied"
                    ],
                    (part) => {
                      // First-write-wins: a chunk arriving for a tool
                      // that's already terminal is a provider replay.
                      // Never overwrite a resolved tool's output.
                      if (
                        part.state === "output-available" ||
                        part.state === "output-error" ||
                        part.state === "output-denied"
                      ) {
                        return part;
                      }
                      return {
                        ...part,
                        state: "output-available",
                        output: data.output,
                        ...(data.preliminary !== undefined && {
                          preliminary: data.preliminary
                        })
                      };
                    }
                  );
                } else {
                  this._findAndUpdateToolPart(
                    data.toolCallId,
                    "_streamSSEReply",
                    [
                      "input-available",
                      "input-streaming",
                      "approval-responded",
                      "approval-requested",
                      "output-available",
                      "output-error",
                      "output-denied"
                    ],
                    (part) => {
                      if (
                        part.state === "output-available" ||
                        part.state === "output-error" ||
                        part.state === "output-denied"
                      ) {
                        return part;
                      }
                      return {
                        ...part,
                        state: "output-error",
                        errorText: data.errorText
                      };
                    }
                  );
                }
              }
            }

            // Handle server-specific chunk types not covered by the shared parser
            if (!handled) {
              switch (data.type) {
                case "start": {
                  if (data.messageId != null && !continuation) {
                    message.id = data.messageId;
                  }
                  if (data.messageMetadata != null) {
                    message.metadata = message.metadata
                      ? { ...message.metadata, ...data.messageMetadata }
                      : data.messageMetadata;
                  }
                  break;
                }
                case "finish":
                case "message-metadata": {
                  if (data.messageMetadata != null) {
                    message.metadata = message.metadata
                      ? { ...message.metadata, ...data.messageMetadata }
                      : data.messageMetadata;
                  }
                  break;
                }
                case "finish-step": {
                  // No-op for message building (shared parser handles step-start)
                  break;
                }
                case "error": {
                  this._broadcastChatMessage({
                    error: true,
                    body: data.errorText ?? JSON.stringify(data),
                    done: false,
                    id,
                    type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
                  });
                  break;
                }
              }
            }

            // Rewrite chunks before storing and broadcasting:
            // 1. Strip messageId from continuation start chunks so clients
            //    reuse the existing assistant message (#1229).
            // 2. Convert the internal "finish" event's finishReason into the
            //    UIMessageStreamPart messageMetadata format (#677).
            let eventToSend: unknown = data;
            if (continuation && data.type === "start" && "messageId" in data) {
              const { messageId: _, ...rest } = data as {
                messageId: unknown;
                [key: string]: unknown;
              };
              eventToSend = rest;
            }
            if (data.type === "finish" && "finishReason" in data) {
              const { finishReason, ...rest } = data as {
                finishReason: string;
                [key: string]: unknown;
              };
              eventToSend = {
                ...rest,
                type: "finish",
                messageMetadata: { finishReason }
              };
            }

            // Store chunk for replay and broadcast to clients
            const chunkBody = JSON.stringify(eventToSend);
            this._storeStreamChunk(streamId, chunkBody);
            this._broadcastChatMessage({
              body: chunkBody,
              done: false,
              id,
              type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
              ...(continuation && { continuation: true })
            });
          } catch (_error) {
            // Skip malformed JSON lines silently
          }
        }
      }
    }

    // If we exited due to abort, send a done signal so clients know the stream ended
    if (!streamCompleted.value) {
      this._completeStream(streamId);
      streamCompleted.value = true;
      this._broadcastChatMessage({
        body: "",
        done: true,
        id,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        ...(continuation && { continuation: true })
      });
      return "aborted";
    }

    return "completed";
  }

  // Handle plain text responses (e.g., from generateText)
  private async _sendPlaintextReply(
    id: string,
    streamId: string,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    message: UIMessage,
    streamCompleted: { value: boolean },
    continuation = false,
    abortSignal?: AbortSignal
  ): Promise<"completed" | "aborted"> {
    // During continuation, if the last text part was still streaming
    // (interrupted mid-generation), reuse it so the resumed content
    // stays in the same block.
    let textPart: TextUIPart | undefined;
    if (continuation) {
      for (let k = message.parts.length - 1; k >= 0; k--) {
        const part = message.parts[k];
        if (part.type === "text") {
          if (
            "state" in part &&
            (part as { state: string }).state === "streaming"
          ) {
            textPart = part as TextUIPart;
          }
          break;
        }
      }
    }

    if (textPart) {
      // Skip broadcasting text-start — the client already has this part
    } else {
      // if not AI SDK SSE format, we need to inject text-start and text-end events ourselves
      this._broadcastTextEvent(
        streamId,
        { type: "text-start", id },
        continuation
      );

      // Use a single text part and accumulate into it, so the persisted message
      // has one text part regardless of how many network chunks the response spans.
      textPart = { type: "text", text: "", state: "streaming" };
      message.parts.push(textPart);
    }

    // Cancel the reader when the abort signal fires
    if (abortSignal && !abortSignal.aborted) {
      abortSignal.addEventListener(
        "abort",
        () => {
          reader.cancel().catch(() => {});
        },
        { once: true }
      );
    }

    while (true) {
      if (abortSignal?.aborted) break;
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch (readError) {
        if (abortSignal?.aborted) break;
        throw readError;
      }
      const { done, value } = readResult;
      if (done) {
        // reader.cancel() resolves read() with { done: true } — check abort
        if (abortSignal?.aborted) break;
        textPart.state = "done";

        this._broadcastTextEvent(
          streamId,
          { type: "text-end", id },
          continuation
        );

        // Mark the stream as completed
        this._completeStream(streamId);
        streamCompleted.value = true;
        // Send final completion signal
        this._broadcastChatMessage({
          body: "",
          done: true,
          id,
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
          ...(continuation && { continuation: true })
        });
        return "completed";
      }

      const chunk = decoder.decode(value);

      // Accumulate into the single text part to preserve exact formatting
      if (chunk.length > 0) {
        textPart.text += chunk;
        this._broadcastTextEvent(
          streamId,
          { type: "text-delta", id, delta: chunk },
          continuation
        );
      }
    }

    // If we exited due to abort, send a done signal so clients know the stream ended
    if (!streamCompleted.value) {
      textPart.state = "done";
      this._broadcastTextEvent(
        streamId,
        { type: "text-end", id },
        continuation
      );
      this._completeStream(streamId);
      streamCompleted.value = true;
      this._broadcastChatMessage({
        body: "",
        done: true,
        id,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        ...(continuation && { continuation: true })
      });
      return "aborted";
    }

    return "completed";
  }

  /**
   * Applies a tool approval response from the client, updating the persisted message.
   * This is called when the client sends CF_AGENT_TOOL_APPROVAL for tools with needsApproval.
   *
   * - approved=true transitions to approval-responded
   * - approved=false transitions to output-denied so convertToModelMessages
   *   emits a tool_result for providers (e.g. Anthropic) that require it.
   *
   * @param toolCallId - The tool call ID this approval is for
   * @param approved - Whether the tool execution was approved
   * @returns true if the approval was applied, false if the message was not found
   */
  private async _applyToolApproval(
    toolCallId: string,
    approved: boolean
  ): Promise<boolean> {
    return this._findAndUpdateToolPart(
      toolCallId,
      "_applyToolApproval",
      ["input-available", "approval-requested"],
      (part) => ({
        ...part,
        state: approved ? "approval-responded" : "output-denied",
        // Merge with existing approval data to preserve the id field.
        // convertToModelMessages needs approval.id to produce a valid
        // tool-approval-request content part with approvalId.
        approval: {
          ...(part.approval as Record<string, unknown> | undefined),
          approved
        }
      })
    );
  }

  private async _reply(
    id: string,
    response: Response,
    excludeBroadcastIds: string[] = [],
    options: { continuation?: boolean; chatMessageId?: string } = {}
  ) {
    const { continuation = false, chatMessageId } = options;
    // Look up the abort signal for this request so we can cancel the reader
    // loop if the client sends a cancel message. This is a safety net —
    // users should also pass abortSignal to streamText for proper cancellation.
    const abortSignal = chatMessageId
      ? this._abortRegistry.getExistingSignal(chatMessageId)
      : undefined;

    // Keep the DO alive during streaming to prevent idle eviction
    return this.keepAliveWhile(() =>
      this._tryCatchChat(async () => {
        if (!response.body) {
          // Send empty response if no body
          this._clearPendingAutoContinuation(true);
          this._broadcastChatMessage({
            body: "",
            done: true,
            id,
            type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
            ...(continuation && { continuation: true })
          });
          this._activateDeferredAutoContinuation();
          return;
        }

        // Start tracking this stream for resumability
        const streamId = this._startStream(id);

        const reader = response.body.getReader();

        // Parsing state adapted from:
        // https://github.com/vercel/ai/blob/main/packages/ai/src/ui-message-stream/ui-message-chunks.ts#L295
        const message = this._createStreamingAssistantMessage(continuation);
        // Track the streaming message so tool results can be applied before persistence
        this._streamingMessage = message;

        // Determine response format based on content-type
        const contentType = response.headers.get("content-type") || "";
        const isSSE = contentType.includes("text/event-stream"); // AI SDK v5 SSE format
        const streamCompleted = { value: false };
        let streamEndStatus: "completed" | "aborted" | "error" = "completed";
        // Capture before try so it's available after finally.
        // _approvalPersistedMessageId is set inside _streamSSEReply when a
        // tool enters approval-requested state and the message is persisted early.
        let earlyPersistedId: string | null = null;

        try {
          if (isSSE) {
            // AI SDK v5 SSE format
            streamEndStatus = await this._streamSSEReply(
              id,
              streamId,
              reader,
              message,
              streamCompleted,
              continuation,
              abortSignal
            );
          } else {
            streamEndStatus = await this._sendPlaintextReply(
              id,
              streamId,
              reader,
              message,
              streamCompleted,
              continuation,
              abortSignal
            );
          }
        } catch (error) {
          // Mark stream as error if not already completed
          if (!streamCompleted.value) {
            this._markStreamError(streamId);
            // Notify clients of the error
            this._broadcastChatMessage({
              body: error instanceof Error ? error.message : "Stream error",
              done: true,
              error: true,
              id,
              type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
              ...(continuation && { continuation: true })
            });
            this._emit("message:error", {
              error: error instanceof Error ? error.message : String(error)
            });

            this._pendingChatResponseResults.push({
              message,
              requestId: id,
              continuation,
              status: "error",
              error: error instanceof Error ? error.message : String(error)
            });
          }
          throw error;
        } finally {
          reader.releaseLock();

          // Always clear the streaming message reference, even on error.
          this._streamingMessage = null;
          // Capture and clear early-persist tracking. The persistence block
          // after the finally uses the local to update in place.
          earlyPersistedId = this._approvalPersistedMessageId;
          this._approvalPersistedMessageId = null;

          // Framework-level cleanup: always remove abort controller.
          // Only emit observability on success (not on error path).
          if (chatMessageId) {
            this._abortRegistry.remove(chatMessageId);
            if (streamCompleted.value) {
              this._emit("message:response");
            }
          }
        }

        if (message.parts.length > 0) {
          if (earlyPersistedId) {
            // Message already exists in this.messages from the early persist.
            // Update it in place with the final streaming state.
            const persistedMessage: UIMessage = {
              ...message,
              id: earlyPersistedId
            };
            const existingIdx = this.messages.findIndex(
              (msg) => msg.id === earlyPersistedId
            );
            const updatedMessages = [...this.messages];

            if (existingIdx >= 0) {
              updatedMessages[existingIdx] = persistedMessage;
            } else {
              updatedMessages.push(persistedMessage);
            }

            await this.persistMessages(updatedMessages, excludeBroadcastIds);
          } else if (continuation) {
            const existingIdx = this.messages.findIndex(
              (msg) => msg.id === message.id
            );
            if (existingIdx >= 0) {
              const updatedMessages = [...this.messages];
              updatedMessages[existingIdx] = message;
              await this.persistMessages(updatedMessages, excludeBroadcastIds);
            } else {
              // No assistant message to append to, create new one
              await this.persistMessages(
                [...this.messages, message],
                excludeBroadcastIds
              );
            }
          } else {
            await this.persistMessages(
              [...this.messages, message],
              excludeBroadcastIds
            );
          }
        }

        this._pendingChatResponseResults.push({
          message,
          requestId: id,
          continuation,
          status: streamEndStatus
        });
      })
    );
  }

  /**
   * When the DO is destroyed, cancel all pending requests and clean up resources
   */
  async destroy() {
    this._abortRegistry.destroyAll();
    this._resumableStream.destroy();
    await super.destroy();
  }
}
