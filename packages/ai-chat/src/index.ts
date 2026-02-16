import type {
  UIMessage as ChatMessage,
  JSONSchema7,
  ProviderMetadata,
  ReasoningUIPart,
  StreamTextOnFinishCallback,
  TextUIPart,
  Tool,
  ToolSet,
  UIMessageChunk
} from "ai";
import { tool, jsonSchema } from "ai";
import {
  Agent,
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext,
  type AgentContext,
  type Connection,
  type ConnectionContext,
  type WSMessage
} from "agents";

import {
  MessageType,
  type IncomingMessage,
  type OutgoingMessage
} from "./types";
import { autoTransformMessages } from "./ai-chat-v5-migration";
import { applyChunkToParts } from "./message-builder";
import { ResumableStream } from "./resumable-stream";
import { nanoid } from "nanoid";

/** Shared encoder for UTF-8 byte length measurement */
const textEncoder = new TextEncoder();

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
function isValidMessageStructure(msg: unknown): msg is ChatMessage {
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
 * One-shot deprecation warnings (warns once per key per session).
 */
const _deprecationWarnings = new Set<string>();
function warnDeprecated(id: string, message: string) {
  if (!_deprecationWarnings.has(id)) {
    _deprecationWarnings.add(id);
    console.warn(`[@cloudflare/ai-chat] Deprecated: ${message}`);
  }
}

/**
 * Schema for a client-defined tool sent from the browser.
 * These tools are executed on the client, not the server.
 *
 * Note: Uses `parameters` (JSONSchema7) rather than AI SDK's `inputSchema` (FlexibleSchema)
 * because this is the wire format. Zod schemas cannot be serialized.
 *
 * @deprecated Define tools on the server using `tool()` from "ai" instead.
 * For tools that need client-side execution, omit the `execute` function
 * and handle them via the `onToolCall` callback in `useAgentChat`.
 */
export type ClientToolSchema = {
  /** Unique name for the tool */
  name: string;
  /** Human-readable description of what the tool does */
  description?: Tool["description"];
  /** JSON Schema defining the tool's input parameters */
  parameters?: JSONSchema7;
};

/**
 * Options passed to the onChatMessage handler.
 */
export type OnChatMessageOptions = {
  /** AbortSignal for cancelling the request */
  abortSignal?: AbortSignal;
  /**
   * Tool schemas sent from the client for dynamic tool registration.
   * These represent tools that will be executed on the client side.
   * Use `createToolsFromClientSchemas()` to convert these to AI SDK tool format.
   *
   * @deprecated Define tools on the server instead. Use `onToolCall` callback
   * in `useAgentChat` for client-side execution.
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
};

/**
 * Converts client tool schemas to AI SDK tool format.
 *
 * These tools have no `execute` function - when the AI model calls them,
 * the tool call is sent back to the client for execution.
 *
 * @param clientTools - Array of tool schemas from the client
 * @returns Record of AI SDK tools that can be spread into your tools object
 *
 * @deprecated Define tools on the server using `tool()` from "ai" instead.
 * For tools that need client-side execution, omit the `execute` function
 * and handle them via the `onToolCall` callback in `useAgentChat`.
 *
 * @example
 * ```typescript
 * // Server: Define tool without execute
 * const tools = {
 *   getLocation: tool({
 *     description: "Get user's location",
 *     inputSchema: z.object({})
 *     // No execute = client must handle
 *   })
 * };
 *
 * // Client: Handle in onToolCall
 * useAgentChat({
 *   onToolCall: async ({ toolCall, addToolOutput }) => {
 *     if (toolCall.toolName === 'getLocation') {
 *       const pos = await navigator.geolocation.getCurrentPosition();
 *       addToolOutput({ toolCallId: toolCall.toolCallId, output: pos });
 *     }
 *   }
 * });
 * ```
 */
export function createToolsFromClientSchemas(
  clientTools?: ClientToolSchema[]
): ToolSet {
  warnDeprecated(
    "createToolsFromClientSchemas",
    "createToolsFromClientSchemas() is deprecated. Define tools on the server using tool() from 'ai' and handle client execution via onToolCall in useAgentChat. Will be removed in the next major version."
  );

  if (!clientTools || clientTools.length === 0) {
    return {};
  }

  // Check for duplicate tool names
  const seenNames = new Set<string>();
  for (const t of clientTools) {
    if (seenNames.has(t.name)) {
      console.warn(
        `[createToolsFromClientSchemas] Duplicate tool name "${t.name}" found. Later definitions will override earlier ones.`
      );
    }
    seenNames.add(t.name);
  }

  return Object.fromEntries(
    clientTools.map((t) => [
      t.name,
      tool({
        description: t.description ?? "",
        inputSchema: jsonSchema(t.parameters ?? { type: "object" })
        // No execute function = tool call is sent back to client
      })
    ])
  );
}

const decoder = new TextDecoder();

/**
 * Extension of Agent with built-in chat capabilities
 * @template Env Environment type containing bindings
 */
export class AIChatAgent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown
> extends Agent<Env, State> {
  /**
   * Map of message `id`s to `AbortController`s
   * useful to propagate request cancellation signals for any external calls made by the agent
   */
  private _chatMessageAbortControllers: Map<string, AbortController>;

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
  private _streamingMessage: ChatMessage | null = null;

  /**
   * Promise that resolves when the current stream completes.
   * Used to wait for message persistence before continuing after tool results.
   * @internal
   */
  private _streamCompletionPromise: Promise<void> | null = null;
  private _streamCompletionResolve: (() => void) | null = null;

  /**
   * Set of connection IDs that are pending stream resume.
   * These connections have received CF_AGENT_STREAM_RESUMING but haven't sent ACK yet.
   * They should be excluded from live stream broadcasts until they ACK.
   * @internal
   */
  private _pendingResumeConnections: Set<string> = new Set();

  /**
   * Client tool schemas from the most recent chat request.
   * Stored so they can be passed to onChatMessage during tool continuations.
   * @internal
   */
  private _lastClientTools: ClientToolSchema[] | undefined;

  /**
   * Custom body data from the most recent chat request.
   * Stored so it can be passed to onChatMessage during tool continuations.
   * @internal
   */
  private _lastBody: Record<string, unknown> | undefined;

  /**
   * Cache of last-persisted JSON for each message ID.
   * Used for incremental persistence: skip SQL writes for unchanged messages.
   * Lost on hibernation, repopulated from SQLite on wake.
   * @internal
   */
  private _persistedMessageCache: Map<string, string> = new Map();

  /** Maximum serialized message size before compaction (bytes). 1.8MB with headroom below SQLite's 2MB limit. */
  private static ROW_MAX_BYTES = 1_800_000;

  /** Measure UTF-8 byte length of a string (accurate for SQLite row limits). */
  private static _byteLength(s: string): number {
    return textEncoder.encode(s).byteLength;
  }

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

  /** Array of chat messages for the current conversation */
  messages: ChatMessage[];

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

    this._chatMessageAbortControllers = new Map();
    const _onConnect = this.onConnect.bind(this);
    this.onConnect = async (connection: Connection, ctx: ConnectionContext) => {
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
      // Call consumer's onClose
      return _onClose(connection, code, reason, wasClean);
    };

    // Wrap onMessage
    const _onMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
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

          const { messages, clientTools, ...customBody } = parsed as {
            messages: ChatMessage[];
            clientTools?: ClientToolSchema[];
            [key: string]: unknown;
          };

          // Store client tools and body for use during tool continuations
          this._lastClientTools = clientTools?.length ? clientTools : undefined;
          this._lastBody =
            Object.keys(customBody).length > 0 ? customBody : undefined;
          this._persistRequestContext();

          // Automatically transform any incoming messages
          const transformedMessages = autoTransformMessages(messages);

          this._broadcastChatMessage(
            {
              messages: transformedMessages,
              type: MessageType.CF_AGENT_CHAT_MESSAGES
            },
            [connection.id]
          );

          await this.persistMessages(transformedMessages, [connection.id]);

          this.observability?.emit(
            {
              displayMessage: "Chat message request",
              id: data.id,
              payload: {},
              timestamp: Date.now(),
              type: "message:request"
            },
            this.ctx
          );

          const chatMessageId = data.id;
          const abortSignal = this._getAbortSignal(chatMessageId);

          return this._tryCatchChat(async () => {
            // Wrap in agentContext.run() to propagate connection context to onChatMessage
            // This ensures getCurrentAgent() returns the connection inside tool execute functions
            return agentContext.run(
              { agent: this, connection, request: undefined, email: undefined },
              async () => {
                const response = await this.onChatMessage(
                  async (_finishResult) => {
                    // User-provided hook. Cleanup is now handled by _reply,
                    // so this is optional for the user to pass to streamText.
                  },
                  {
                    abortSignal,
                    clientTools,
                    body: this._lastBody
                  }
                );

                if (response) {
                  await this._reply(data.id, response, [connection.id], {
                    chatMessageId
                  });
                } else {
                  console.warn(
                    `[AIChatAgent] onChatMessage returned no response for chatMessageId: ${chatMessageId}`
                  );
                  this._broadcastChatMessage(
                    {
                      body: "No response was generated by the agent.",
                      done: true,
                      id: data.id,
                      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
                    },
                    [connection.id]
                  );
                }
              }
            );
          });
        }

        // Handle clear chat
        if (data.type === MessageType.CF_AGENT_CHAT_CLEAR) {
          this._destroyAbortControllers();
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
          this._cancelChatRequest(data.id);
          return;
        }

        // Handle client-initiated stream resume request.
        // The client sends this after its message handler is registered,
        // avoiding the race condition where CF_AGENT_STREAM_RESUMING sent
        // in onConnect arrives before the client's handler is ready.
        if (data.type === MessageType.CF_AGENT_STREAM_RESUME_REQUEST) {
          if (this._resumableStream.hasActiveStream()) {
            this._notifyStreamResuming(connection);
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
            this._resumableStream.replayChunks(
              connection,
              this._resumableStream.activeRequestId
            );
          }
          return;
        }

        // Handle client-side tool result
        if (data.type === MessageType.CF_AGENT_TOOL_RESULT) {
          const { toolCallId, toolName, output, autoContinue, clientTools } =
            data;

          // Update cached client tools so subsequent continuations use the latest schemas
          if (clientTools?.length) {
            this._lastClientTools = clientTools as ClientToolSchema[];
            this._persistRequestContext();
          }

          // Apply the tool result
          this._applyToolResult(toolCallId, toolName, output).then(
            (applied) => {
              // Only auto-continue if client requested it (opt-in behavior)
              // This mimics server-executed tool behavior where the LLM
              // automatically continues after seeing tool results
              if (applied && autoContinue) {
                // Wait for the original stream to complete and message to be persisted
                // before calling onChatMessage, so this.messages includes the tool result
                const waitForStream = async () => {
                  if (this._streamCompletionPromise) {
                    await this._streamCompletionPromise;
                  } else {
                    // TODO: The completion promise can be null if the stream finished
                    // before the tool result arrived (race between stream end and tool
                    // apply). The 500ms fallback is a pragmatic workaround — consider
                    // a more deterministic signal (e.g. always setting the promise).
                    await new Promise((resolve) => setTimeout(resolve, 500));
                  }
                };

                waitForStream()
                  .then(() => {
                    const continuationId = nanoid();
                    const abortSignal = this._getAbortSignal(continuationId);

                    return this._tryCatchChat(async () => {
                      return agentContext.run(
                        {
                          agent: this,
                          connection,
                          request: undefined,
                          email: undefined
                        },
                        async () => {
                          const response = await this.onChatMessage(
                            async (_finishResult) => {
                              // User-provided hook. Cleanup handled by _reply.
                            },
                            {
                              abortSignal,
                              clientTools: clientTools ?? this._lastClientTools,
                              body: this._lastBody
                            }
                          );

                          if (response) {
                            // Pass continuation flag to merge parts into last assistant message
                            // Note: We pass an empty excludeBroadcastIds array because the sender
                            // NEEDS to receive the continuation stream. Unlike regular chat requests
                            // where aiFetch handles the response, tool continuations have no listener
                            // waiting - the client relies on the broadcast.
                            await this._reply(
                              continuationId,
                              response,
                              [], // Don't exclude sender - they need the continuation
                              {
                                continuation: true,
                                chatMessageId: continuationId
                              }
                            );
                          }
                        }
                      );
                    });
                  })
                  .catch((error) => {
                    console.error(
                      "[AIChatAgent] Tool continuation failed:",
                      error
                    );
                  });
              }
            }
          );
          return;
        }

        // Handle client-side tool approval response
        if (data.type === MessageType.CF_AGENT_TOOL_APPROVAL) {
          const { toolCallId, approved, autoContinue } = data;
          this._applyToolApproval(toolCallId, approved).then((applied) => {
            // Only auto-continue if approved AND client requested it
            if (applied && approved && autoContinue) {
              const waitForStream = async () => {
                if (this._streamCompletionPromise) {
                  await this._streamCompletionPromise;
                } else {
                  await new Promise((resolve) => setTimeout(resolve, 500));
                }
              };

              waitForStream()
                .then(() => {
                  const continuationId = nanoid();
                  const abortSignal = this._getAbortSignal(continuationId);

                  return this._tryCatchChat(async () => {
                    return agentContext.run(
                      {
                        agent: this,
                        connection,
                        request: undefined,
                        email: undefined
                      },
                      async () => {
                        const response = await this.onChatMessage(
                          async (_finishResult) => {},
                          {
                            abortSignal,
                            clientTools: this._lastClientTools,
                            body: this._lastBody
                          }
                        );

                        if (response) {
                          await this._reply(continuationId, response, [], {
                            continuation: true,
                            chatMessageId: continuationId
                          });
                        }
                      }
                    );
                  });
                })
                .catch((error) => {
                  console.error(
                    "[AIChatAgent] Tool approval continuation failed:",
                    error
                  );
                });
            }
          });
          return;
        }
      }

      // Forward unhandled messages to consumer's onMessage
      return _onMessage(connection, message);
    };
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

    // Add connection to pending set - they'll be excluded from live broadcasts
    // until they send ACK to receive the full stream replay
    this._pendingResumeConnections.add(connection.id);

    // Notify client - they will send ACK when ready
    connection.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUMING,
        id: this._resumableStream.activeRequestId
      })
    );
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
    return this._resumableStream.start(requestId);
  }

  /** @internal Delegate to _resumableStream */
  protected _completeStream(streamId: string) {
    this._resumableStream.complete(streamId);
    this._pendingResumeConnections.clear();
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

  private _loadMessagesFromDb(): ChatMessage[] {
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
          const parsed = JSON.parse(messageStr) as ChatMessage;

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
      .filter((msg): msg is ChatMessage => msg !== null);
  }

  override async onRequest(request: Request): Promise<Response> {
    return this._tryCatchChat(async () => {
      const url = new URL(request.url);

      if (url.pathname.endsWith("/get-messages")) {
        const messages = this._loadMessagesFromDb();
        return Response.json(messages);
      }

      return super.onRequest(request);
    });
  }

  private async _tryCatchChat<T>(fn: () => T | Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      throw this.onError(e);
    }
  }

  /**
   * Handle incoming chat messages and generate a response
   * @param onFinish Callback to be called when the response is finished
   * @param options Options including abort signal and client-defined tools
   * @returns Response to send to the client or undefined
   */
  async onChatMessage(
    // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
    options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    throw new Error(
      "received a chat message, override onChatMessage and return a Response to send to the client"
    );
  }

  /**
   * Save messages on the server side
   * @param messages Chat messages to save
   */
  async saveMessages(messages: ChatMessage[]) {
    await this.persistMessages(messages);
    await this._tryCatchChat(async () => {
      const response = await this.onChatMessage(() => {});
      if (response) this._reply(crypto.randomUUID(), response);
    });
  }

  async persistMessages(
    messages: ChatMessage[],
    excludeBroadcastIds: string[] = []
  ) {
    // Merge incoming messages with existing server state to preserve tool outputs.
    // This is critical for client-side tools: the client sends messages without
    // tool outputs, but the server has them via _applyToolResult.
    const mergedMessages = this._mergeIncomingWithServerState(messages);

    // Persist only new or changed messages (incremental persistence).
    // Compares serialized JSON against a cache of last-persisted versions.
    for (const message of mergedMessages) {
      const sanitizedMessage = this._sanitizeMessageForPersistence(message);
      const resolved = this._resolveMessageForToolMerge(sanitizedMessage);
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
   * Merges incoming messages with existing server state.
   * This preserves tool outputs that the server has (via _applyToolResult)
   * but the client doesn't have yet.
   *
   * @param incomingMessages - Messages from the client
   * @returns Messages with server's tool outputs preserved
   */
  private _mergeIncomingWithServerState(
    incomingMessages: ChatMessage[]
  ): ChatMessage[] {
    // Build a map of toolCallId -> output from existing server messages
    const serverToolOutputs = new Map<string, unknown>();
    for (const msg of this.messages) {
      if (msg.role !== "assistant") continue;
      for (const part of msg.parts) {
        if (
          "toolCallId" in part &&
          "state" in part &&
          part.state === "output-available" &&
          "output" in part
        ) {
          serverToolOutputs.set(
            part.toolCallId as string,
            (part as { output: unknown }).output
          );
        }
      }
    }

    // If server has no tool outputs, return incoming messages as-is
    if (serverToolOutputs.size === 0) {
      return incomingMessages;
    }

    // Merge server's tool outputs into incoming messages
    return incomingMessages.map((msg) => {
      if (msg.role !== "assistant") return msg;

      let hasChanges = false;
      const updatedParts = msg.parts.map((part) => {
        // If this is a tool part in input-available state and server has the output
        if (
          "toolCallId" in part &&
          "state" in part &&
          part.state === "input-available" &&
          serverToolOutputs.has(part.toolCallId as string)
        ) {
          hasChanges = true;
          return {
            ...part,
            state: "output-available" as const,
            output: serverToolOutputs.get(part.toolCallId as string)
          };
        }
        return part;
      }) as ChatMessage["parts"];

      return hasChanges ? { ...msg, parts: updatedParts } : msg;
    });
  }

  /**
   * Resolves a message for persistence, handling tool result merging.
   * If the message contains tool parts with output-available state, checks if there's
   * an existing message with the same toolCallId that should be updated instead of
   * creating a duplicate. This prevents the "Duplicate item found" error from OpenAI
   * when client-side tool results arrive in a new request.
   *
   * @param message - The message to potentially merge
   * @returns The message with the correct ID (either original or merged)
   */
  private _resolveMessageForToolMerge(message: ChatMessage): ChatMessage {
    if (message.role !== "assistant") {
      return message;
    }

    // Check if this message has tool parts with output-available state
    for (const part of message.parts) {
      if (
        "toolCallId" in part &&
        "state" in part &&
        (part.state === "output-available" ||
          part.state === "approval-responded" ||
          part.state === "approval-requested")
      ) {
        const toolCallId = part.toolCallId as string;

        // Look for an existing message with this toolCallId in input-available state
        const existingMessage = this._findMessageByToolCallId(toolCallId);
        if (existingMessage && existingMessage.id !== message.id) {
          // Found a match - merge by using the existing message's ID
          // This ensures the SQL upsert updates the existing row
          return {
            ...message,
            id: existingMessage.id
          };
        }
      }
    }

    return message;
  }

  /**
   * Finds an existing assistant message that contains a tool part with the given toolCallId.
   * Used to detect when a tool result should update an existing message rather than
   * creating a new one.
   *
   * @param toolCallId - The tool call ID to search for
   * @returns The existing message if found, undefined otherwise
   */
  private _findMessageByToolCallId(
    toolCallId: string
  ): ChatMessage | undefined {
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

  /**
   * Sanitizes a message for persistence by removing ephemeral provider-specific
   * data that should not be stored or sent back in subsequent requests.
   *
   * This handles two issues with the OpenAI Responses API:
   *
   * 1. **Duplicate item IDs**: The AI SDK's @ai-sdk/openai provider (v2.0.x+)
   *    defaults to using OpenAI's Responses API which assigns unique itemIds
   *    to each message part. When these IDs are persisted and sent back,
   *    OpenAI rejects them as duplicates.
   *
   * 2. **Empty reasoning parts**: OpenAI may return reasoning parts with empty
   *    text and encrypted content. These cause "Non-OpenAI reasoning parts are
   *    not supported" warnings when sent back via convertToModelMessages().
   *
   * @param message - The message to sanitize
   * @returns A new message with ephemeral provider data removed
   */
  private _sanitizeMessageForPersistence(message: ChatMessage): ChatMessage {
    // First, filter out empty reasoning parts (they have no useful content)
    const filteredParts = message.parts.filter((part) => {
      if (part.type === "reasoning") {
        const reasoningPart = part as ReasoningUIPart;
        // Remove reasoning parts that have no text content
        // These are typically placeholders with only encrypted content
        if (!reasoningPart.text || reasoningPart.text.trim() === "") {
          return false;
        }
      }
      return true;
    });

    // Then sanitize remaining parts by stripping OpenAI-specific ephemeral data
    const sanitizedParts = filteredParts.map((part) => {
      let sanitizedPart = part;

      // Strip providerMetadata.openai.itemId and reasoningEncryptedContent
      if (
        "providerMetadata" in sanitizedPart &&
        sanitizedPart.providerMetadata &&
        typeof sanitizedPart.providerMetadata === "object" &&
        "openai" in sanitizedPart.providerMetadata
      ) {
        sanitizedPart = this._stripOpenAIMetadata(
          sanitizedPart,
          "providerMetadata"
        );
      }

      // Also check callProviderMetadata for tool parts
      if (
        "callProviderMetadata" in sanitizedPart &&
        sanitizedPart.callProviderMetadata &&
        typeof sanitizedPart.callProviderMetadata === "object" &&
        "openai" in sanitizedPart.callProviderMetadata
      ) {
        sanitizedPart = this._stripOpenAIMetadata(
          sanitizedPart,
          "callProviderMetadata"
        );
      }

      return sanitizedPart;
    }) as ChatMessage["parts"];

    return { ...message, parts: sanitizedParts };
  }

  /**
   * Helper to strip OpenAI-specific ephemeral fields from a metadata object.
   * Removes itemId and reasoningEncryptedContent while preserving other fields.
   */
  private _stripOpenAIMetadata<T extends ChatMessage["parts"][number]>(
    part: T,
    metadataKey: "providerMetadata" | "callProviderMetadata"
  ): T {
    const metadata = (part as Record<string, unknown>)[metadataKey] as {
      openai?: Record<string, unknown>;
      [key: string]: unknown;
    };

    if (!metadata?.openai) return part;

    const openaiMeta = metadata.openai;

    // Remove ephemeral fields: itemId and reasoningEncryptedContent
    const {
      itemId: _itemId,
      reasoningEncryptedContent: _rec,
      ...restOpenai
    } = openaiMeta;

    // Determine what to keep
    const hasOtherOpenaiFields = Object.keys(restOpenai).length > 0;
    const { openai: _openai, ...restMetadata } = metadata;

    let newMetadata: ProviderMetadata | undefined;
    if (hasOtherOpenaiFields) {
      newMetadata = {
        ...restMetadata,
        openai: restOpenai
      } as ProviderMetadata;
    } else if (Object.keys(restMetadata).length > 0) {
      newMetadata = restMetadata as ProviderMetadata;
    }

    // Create new part without the old metadata
    const { [metadataKey]: _oldMeta, ...restPart } = part as Record<
      string,
      unknown
    >;

    if (newMetadata) {
      return { ...restPart, [metadataKey]: newMetadata } as T;
    }
    return restPart as T;
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
  private _enforceRowSizeLimit(message: ChatMessage): ChatMessage {
    let json = JSON.stringify(message);
    let size = AIChatAgent._byteLength(json);
    if (size <= AIChatAgent.ROW_MAX_BYTES) return message;

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
    }) as ChatMessage["parts"];

    let result: ChatMessage = {
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
    size = AIChatAgent._byteLength(json);
    if (size <= AIChatAgent.ROW_MAX_BYTES) return result;

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
  private _truncateTextParts(message: ChatMessage): ChatMessage {
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
          } as ChatMessage["parts"][number];

          // Check if we fit now
          const candidate = { ...message, parts };
          if (
            AIChatAgent._byteLength(JSON.stringify(candidate)) <=
            AIChatAgent.ROW_MAX_BYTES
          ) {
            break;
          }
        }
      }
    }

    const result: ChatMessage = { ...message, parts };
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
   * @param toolCallId - The tool call ID to find
   * @param callerName - Name for log messages (e.g. "_applyToolResult")
   * @param matchStates - Which tool part states to match
   * @param applyUpdate - Mutation to apply to the matched part (streaming: in-place, persisted: spread)
   * @returns true if the update was applied, false if not found or state didn't match
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
    let message: ChatMessage | undefined;

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
    let updated = false;

    if (isStreamingMessage) {
      // Update in place -- the message will be persisted when streaming completes
      for (const part of message.parts) {
        if (
          "toolCallId" in part &&
          part.toolCallId === toolCallId &&
          "state" in part &&
          matchStates.includes(part.state as string)
        ) {
          const applied = applyUpdate(part as Record<string, unknown>);
          Object.assign(part, applied);
          updated = true;
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
          updated = true;
          return applyUpdate(part as Record<string, unknown>);
        }
        return part;
      }) as ChatMessage["parts"];

      if (updated) {
        const updatedMessage: ChatMessage = this._sanitizeMessageForPersistence(
          { ...message, parts: updatedParts }
        );
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

    if (!updated) {
      console.warn(
        `[AIChatAgent] ${callerName}: Tool part with toolCallId ${toolCallId} not in expected state (expected: ${matchStates.join("|")})`
      );
      return false;
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
   * Applies a tool result to an existing assistant message.
   * This is used when the client sends CF_AGENT_TOOL_RESULT for client-side tools.
   * The server is the source of truth, so we update the message here and broadcast
   * the update to all clients.
   *
   * @param toolCallId - The tool call ID this result is for
   * @param _toolName - The name of the tool (unused, kept for API compat)
   * @param output - The output from the tool execution
   * @returns true if the result was applied, false if the message was not found
   */
  private async _applyToolResult(
    toolCallId: string,
    _toolName: string,
    output: unknown
  ): Promise<boolean> {
    return this._findAndUpdateToolPart(
      toolCallId,
      "_applyToolResult",
      ["input-available"],
      (part) => ({
        ...part,
        state: "output-available",
        output,
        preliminary: false
      })
    );
  }

  private async _streamSSEReply(
    id: string,
    streamId: string,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    message: ChatMessage,
    streamCompleted: { value: boolean },
    continuation = false
  ) {
    streamCompleted.value = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        this._completeStream(streamId);
        streamCompleted.value = true;
        this._broadcastChatMessage({
          body: "",
          done: true,
          id,
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
          ...(continuation && { continuation: true })
        });
        break;
      }

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          try {
            const data: UIMessageChunk = JSON.parse(line.slice(6));

            // Delegate message building to the shared parser.
            // It handles: text, reasoning, file, source, tool lifecycle,
            // step boundaries — all the part types needed for UIMessage.
            const handled = applyChunkToParts(message.parts, data);

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
                      "approval-requested"
                    ],
                    (part) => ({
                      ...part,
                      state: "output-available",
                      output: data.output,
                      ...(data.preliminary !== undefined && {
                        preliminary: data.preliminary
                      })
                    })
                  );
                } else {
                  this._findAndUpdateToolPart(
                    data.toolCallId,
                    "_streamSSEReply",
                    [
                      "input-available",
                      "input-streaming",
                      "approval-responded",
                      "approval-requested"
                    ],
                    (part) => ({
                      ...part,
                      state: "output-error",
                      errorText: data.errorText
                    })
                  );
                }
              }
            }

            // Handle server-specific chunk types not covered by the shared parser
            if (!handled) {
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

            // Convert internal AI SDK stream events to valid UIMessageStreamPart format.
            // The "finish" event with "finishReason" is an internal LanguageModelV3StreamPart,
            // not a UIMessageStreamPart (which expects "messageMetadata" instead).
            // See: https://github.com/cloudflare/agents/issues/677
            let eventToSend: unknown = data;
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
  }

  // Handle plain text responses (e.g., from generateText)
  private async _sendPlaintextReply(
    id: string,
    streamId: string,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    message: ChatMessage,
    streamCompleted: { value: boolean },
    continuation = false
  ) {
    // if not AI SDK SSE format, we need to inject text-start and text-end events ourselves
    this._broadcastTextEvent(
      streamId,
      { type: "text-start", id },
      continuation
    );

    // Use a single text part and accumulate into it, so the persisted message
    // has one text part regardless of how many network chunks the response spans.
    const textPart: TextUIPart = { type: "text", text: "", state: "streaming" };
    message.parts.push(textPart);

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
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
        break;
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
  }

  /**
   * Applies a tool approval response from the client, updating the persisted message.
   * This is called when the client sends CF_AGENT_TOOL_APPROVAL for tools with needsApproval.
   * Updates the tool part state from input-available/approval-requested to approval-responded.
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
        state: "approval-responded",
        approval: { approved }
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

    return this._tryCatchChat(async () => {
      if (!response.body) {
        // Send empty response if no body
        this._broadcastChatMessage({
          body: "",
          done: true,
          id,
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
          ...(continuation && { continuation: true })
        });
        return;
      }

      // Start tracking this stream for resumability
      const streamId = this._startStream(id);

      const reader = response.body.getReader();

      // Parsing state adapted from:
      // https://github.com/vercel/ai/blob/main/packages/ai/src/ui-message-stream/ui-message-chunks.ts#L295
      const message: ChatMessage = {
        id: `assistant_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`, // default
        role: "assistant",
        parts: []
      };
      // Track the streaming message so tool results can be applied before persistence
      this._streamingMessage = message;
      // Set up completion promise for tool continuation to wait on
      this._streamCompletionPromise = new Promise((resolve) => {
        this._streamCompletionResolve = resolve;
      });

      // Determine response format based on content-type
      const contentType = response.headers.get("content-type") || "";
      const isSSE = contentType.includes("text/event-stream"); // AI SDK v5 SSE format
      const streamCompleted = { value: false };

      try {
        if (isSSE) {
          // AI SDK v5 SSE format
          await this._streamSSEReply(
            id,
            streamId,
            reader,
            message,
            streamCompleted,
            continuation
          );
        } else {
          await this._sendPlaintextReply(
            id,
            streamId,
            reader,
            message,
            streamCompleted,
            continuation
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
        }
        throw error;
      } finally {
        reader.releaseLock();

        // Always clear the streaming message reference and resolve completion
        // promise, even on error. Without this, tool continuations waiting on
        // _streamCompletionPromise would hang forever after a stream error.
        this._streamingMessage = null;
        if (this._streamCompletionResolve) {
          this._streamCompletionResolve();
          this._streamCompletionResolve = null;
          this._streamCompletionPromise = null;
        }

        // Framework-level cleanup: always remove abort controller.
        // Only emit observability on success (not on error path).
        if (chatMessageId) {
          this._removeAbortController(chatMessageId);
          if (streamCompleted.value) {
            this.observability?.emit(
              {
                displayMessage: continuation
                  ? "Chat message response (tool continuation)"
                  : "Chat message response",
                id: chatMessageId,
                payload: {},
                timestamp: Date.now(),
                type: "message:response"
              },
              this.ctx
            );
          }
        }
      }

      if (message.parts.length > 0) {
        if (continuation) {
          // Find the last assistant message and append parts to it
          let lastAssistantIdx = -1;
          for (let i = this.messages.length - 1; i >= 0; i--) {
            if (this.messages[i].role === "assistant") {
              lastAssistantIdx = i;
              break;
            }
          }
          if (lastAssistantIdx >= 0) {
            const lastAssistant = this.messages[lastAssistantIdx];
            const mergedMessage: ChatMessage = {
              ...lastAssistant,
              parts: [...lastAssistant.parts, ...message.parts]
            };
            const updatedMessages = [...this.messages];
            updatedMessages[lastAssistantIdx] = mergedMessage;
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
    });
  }

  /**
   * For the given message id, look up its associated AbortController
   * If the AbortController does not exist, create and store one in memory
   *
   * returns the AbortSignal associated with the AbortController
   */
  private _getAbortSignal(id: string): AbortSignal | undefined {
    // Defensive check, since we're coercing message types at the moment
    if (typeof id !== "string") {
      return undefined;
    }

    if (!this._chatMessageAbortControllers.has(id)) {
      this._chatMessageAbortControllers.set(id, new AbortController());
    }

    return this._chatMessageAbortControllers.get(id)?.signal;
  }

  /**
   * Remove an abort controller from the cache of pending message responses
   */
  private _removeAbortController(id: string) {
    this._chatMessageAbortControllers.delete(id);
  }

  /**
   * Propagate an abort signal for any requests associated with the given message id
   */
  private _cancelChatRequest(id: string) {
    if (this._chatMessageAbortControllers.has(id)) {
      const abortController = this._chatMessageAbortControllers.get(id);
      abortController?.abort();
    }
  }

  /**
   * Abort all pending requests and clear the cache of AbortControllers
   */
  private _destroyAbortControllers() {
    for (const controller of this._chatMessageAbortControllers.values()) {
      controller?.abort();
    }
    this._chatMessageAbortControllers.clear();
  }

  /**
   * When the DO is destroyed, cancel all pending requests and clean up resources
   */
  async destroy() {
    this._destroyAbortControllers();
    this._resumableStream.destroy();
    await super.destroy();
  }
}
