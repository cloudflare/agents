import type {
  UIMessage as ChatMessage,
  DynamicToolUIPart,
  JSONSchema7,
  ProviderMetadata,
  ReasoningUIPart,
  StreamTextOnFinishCallback,
  TextUIPart,
  Tool,
  ToolSet,
  ToolUIPart,
  UIMessageChunk
} from "ai";
import { tool, jsonSchema } from "ai";
import {
  Agent,
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
import { nanoid } from "nanoid";

import { agentContext } from "agents/internal_context";

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

/** Number of chunks to buffer before flushing to SQLite */
const CHUNK_BUFFER_SIZE = 10;
/** Maximum buffer size to prevent memory issues on rapid reconnections */
const CHUNK_BUFFER_MAX_SIZE = 100;
/** Maximum age for a "streaming" stream before considering it stale (ms) - 5 minutes */
const STREAM_STALE_THRESHOLD_MS = 5 * 60 * 1000;
/** Default cleanup interval for old streams (ms) - every 10 minutes */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
/** Default age threshold for cleaning up completed streams (ms) - 24 hours */
const CLEANUP_AGE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

const decoder = new TextDecoder();

/**
 * Stored stream chunk for resumable streaming
 */
type StreamChunk = {
  id: string;
  stream_id: string;
  body: string;
  chunk_index: number;
  created_at: number;
};

/**
 * Stream metadata for tracking active streams
 */
type StreamMetadata = {
  id: string;
  request_id: string;
  status: "streaming" | "completed" | "error";
  created_at: number;
  completed_at: number | null;
};

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
   * Currently active stream ID for resumable streaming.
   * Stored in memory for quick access; persisted in stream_metadata table.
   * @internal Protected for testing purposes.
   */
  protected _activeStreamId: string | null = null;

  /**
   * Request ID associated with the active stream.
   * @internal Protected for testing purposes.
   */
  protected _activeRequestId: string | null = null;

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
   * Current chunk index for the active stream
   */
  private _streamChunkIndex = 0;

  /**
   * Buffer for stream chunks pending write to SQLite.
   * Chunks are batched and flushed when buffer reaches CHUNK_BUFFER_SIZE.
   */
  private _chunkBuffer: Array<{
    id: string;
    streamId: string;
    body: string;
    index: number;
  }> = [];

  /**
   * Lock to prevent concurrent flush operations
   */
  private _isFlushingChunks = false;

  /**
   * Timestamp of the last cleanup operation for old streams
   */
  private _lastCleanupTime = 0;

  /** Array of chat messages for the current conversation */
  messages: ChatMessage[];

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.sql`create table if not exists cf_ai_chat_agent_messages (
      id text primary key,
      message text not null,
      created_at datetime default current_timestamp
    )`;

    // Create tables for automatic resumable streaming
    this.sql`create table if not exists cf_ai_chat_stream_chunks (
      id text primary key,
      stream_id text not null,
      body text not null,
      chunk_index integer not null,
      created_at integer not null
    )`;

    this.sql`create table if not exists cf_ai_chat_stream_metadata (
      id text primary key,
      request_id text not null,
      status text not null,
      created_at integer not null,
      completed_at integer
    )`;

    this.sql`create index if not exists idx_stream_chunks_stream_id 
      on cf_ai_chat_stream_chunks(stream_id, chunk_index)`;

    // Load messages and automatically transform them to v5 format
    const rawMessages = this._loadMessagesFromDb();

    // Automatic migration following https://jhak.im/blog/ai-sdk-migration-handling-previously-saved-messages
    this.messages = autoTransformMessages(rawMessages);

    this._chatMessageAbortControllers = new Map();

    // Check for any active streams from a previous session
    this._restoreActiveStream();
    const _onConnect = this.onConnect.bind(this);
    this.onConnect = async (connection: Connection, ctx: ConnectionContext) => {
      // Notify client about active streams that can be resumed
      if (this._activeStreamId) {
        this._notifyStreamResuming(connection);
      }
      // Call consumer's onConnect
      return _onConnect(connection, ctx);
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
          const parsed = JSON.parse(body as string);
          const { messages, clientTools } = parsed as {
            messages: ChatMessage[];
            clientTools?: ClientToolSchema[];
          };

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
                    this._removeAbortController(chatMessageId);

                    this.observability?.emit(
                      {
                        displayMessage: "Chat message response",
                        id: data.id,
                        payload: {},
                        timestamp: Date.now(),
                        type: "message:response"
                      },
                      this.ctx
                    );
                  },
                  {
                    abortSignal,
                    clientTools
                  }
                );

                if (response) {
                  await this._reply(data.id, response, [connection.id]);
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
          this.sql`delete from cf_ai_chat_stream_chunks`;
          this.sql`delete from cf_ai_chat_stream_metadata`;
          this._activeStreamId = null;
          this._activeRequestId = null;
          this._streamChunkIndex = 0;
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

        // Handle stream resume acknowledgment
        if (data.type === MessageType.CF_AGENT_STREAM_RESUME_ACK) {
          if (
            this._activeStreamId &&
            this._activeRequestId &&
            this._activeRequestId === data.id
          ) {
            this._sendStreamChunks(
              connection,
              this._activeStreamId,
              this._activeRequestId
            );
          }
          return;
        }

        // Handle client-side tool result
        if (data.type === MessageType.CF_AGENT_TOOL_RESULT) {
          const { toolCallId, toolName, output, autoContinue } = data;

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
                    // If no promise, wait a bit for the stream to finish
                    await new Promise((resolve) => setTimeout(resolve, 500));
                  }
                };

                waitForStream().then(() => {
                  const continuationId = nanoid();
                  const abortSignal = this._getAbortSignal(continuationId);

                  this._tryCatchChat(async () => {
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
                            this._removeAbortController(continuationId);

                            this.observability?.emit(
                              {
                                displayMessage:
                                  "Chat message response (tool continuation)",
                                id: continuationId,
                                payload: {},
                                timestamp: Date.now(),
                                type: "message:response"
                              },
                              this.ctx
                            );
                          },
                          {
                            abortSignal
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
                            { continuation: true }
                          );
                        }
                      }
                    );
                  });
                });
              }
            }
          );
          return;
        }
      }

      // Forward unhandled messages to consumer's onMessage
      return _onMessage(connection, message);
    };
  }

  /**
   * Restore active stream state if the agent was restarted during streaming.
   * Called during construction to recover any interrupted streams.
   * Validates stream freshness to avoid sending stale resume notifications.
   * @internal Protected for testing purposes.
   */
  protected _restoreActiveStream() {
    const activeStreams = this.sql<StreamMetadata>`
      select * from cf_ai_chat_stream_metadata 
      where status = 'streaming' 
      order by created_at desc 
      limit 1
    `;

    if (activeStreams && activeStreams.length > 0) {
      const stream = activeStreams[0];
      const streamAge = Date.now() - stream.created_at;

      // Check if stream is stale; delete to free storage
      if (streamAge > STREAM_STALE_THRESHOLD_MS) {
        this
          .sql`delete from cf_ai_chat_stream_chunks where stream_id = ${stream.id}`;
        this
          .sql`delete from cf_ai_chat_stream_metadata where id = ${stream.id}`;
        console.warn(
          `[AIChatAgent] Deleted stale stream ${stream.id} (age: ${Math.round(streamAge / 1000)}s)`
        );
        return;
      }

      this._activeStreamId = stream.id;
      this._activeRequestId = stream.request_id;

      // Get the last chunk index
      const lastChunk = this.sql<{ max_index: number }>`
        select max(chunk_index) as max_index 
        from cf_ai_chat_stream_chunks 
        where stream_id = ${this._activeStreamId}
      `;
      this._streamChunkIndex =
        lastChunk && lastChunk[0]?.max_index != null
          ? lastChunk[0].max_index + 1
          : 0;
    }
  }

  /**
   * Notify a connection about an active stream that can be resumed.
   * The client should respond with CF_AGENT_STREAM_RESUME_ACK to receive chunks.
   * Uses in-memory state for request ID - no extra DB lookup needed.
   * @param connection - The WebSocket connection to notify
   */
  private _notifyStreamResuming(connection: Connection) {
    if (!this._activeStreamId || !this._activeRequestId) {
      return;
    }

    // Notify client - they will send ACK when ready
    connection.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUMING,
        id: this._activeRequestId
      })
    );
  }

  /**
   * Send stream chunks to a connection after receiving ACK.
   * @param connection - The WebSocket connection
   * @param streamId - The stream to replay
   * @param requestId - The original request ID
   */
  private _sendStreamChunks(
    connection: Connection,
    streamId: string,
    requestId: string
  ) {
    // Flush any pending chunks first to ensure we have the latest
    this._flushChunkBuffer();

    const chunks = this.sql<StreamChunk>`
      select * from cf_ai_chat_stream_chunks 
      where stream_id = ${streamId} 
      order by chunk_index asc
    `;

    // Send all stored chunks
    for (const chunk of chunks || []) {
      connection.send(
        JSON.stringify({
          body: chunk.body,
          done: false,
          id: requestId,
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
        })
      );
    }

    // If the stream is no longer active (completed), send done signal
    // We track active state in memory, no need to query DB
    if (this._activeStreamId !== streamId) {
      connection.send(
        JSON.stringify({
          body: "",
          done: true,
          id: requestId,
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
        })
      );
    }
  }

  /**
   * Buffer a stream chunk for batch write to SQLite.
   * @param streamId - The stream this chunk belongs to
   * @param body - The serialized chunk body
   * @internal Protected for testing purposes.
   */
  protected _storeStreamChunk(streamId: string, body: string) {
    // Force flush if buffer is at max to prevent memory issues
    if (this._chunkBuffer.length >= CHUNK_BUFFER_MAX_SIZE) {
      this._flushChunkBuffer();
    }

    this._chunkBuffer.push({
      id: nanoid(),
      streamId,
      body,
      index: this._streamChunkIndex
    });
    this._streamChunkIndex++;

    // Flush when buffer reaches threshold
    if (this._chunkBuffer.length >= CHUNK_BUFFER_SIZE) {
      this._flushChunkBuffer();
    }
  }

  /**
   * Flush buffered chunks to SQLite in a single batch.
   * Uses a lock to prevent concurrent flush operations.
   * @internal Protected for testing purposes.
   */
  protected _flushChunkBuffer() {
    // Prevent concurrent flushes
    if (this._isFlushingChunks || this._chunkBuffer.length === 0) {
      return;
    }

    this._isFlushingChunks = true;
    try {
      const chunks = this._chunkBuffer;
      this._chunkBuffer = [];

      // Batch insert all chunks
      const now = Date.now();
      for (const chunk of chunks) {
        this.sql`
          insert into cf_ai_chat_stream_chunks (id, stream_id, body, chunk_index, created_at)
          values (${chunk.id}, ${chunk.streamId}, ${chunk.body}, ${chunk.index}, ${now})
        `;
      }
    } finally {
      this._isFlushingChunks = false;
    }
  }

  /**
   * Start tracking a new stream for resumable streaming.
   * Creates metadata entry in SQLite and sets up tracking state.
   * @param requestId - The unique ID of the chat request
   * @returns The generated stream ID
   * @internal Protected for testing purposes.
   */
  protected _startStream(requestId: string): string {
    // Flush any pending chunks from previous streams to prevent mixing
    this._flushChunkBuffer();

    const streamId = nanoid();
    this._activeStreamId = streamId;
    this._activeRequestId = requestId;
    this._streamChunkIndex = 0;

    this.sql`
      insert into cf_ai_chat_stream_metadata (id, request_id, status, created_at)
      values (${streamId}, ${requestId}, 'streaming', ${Date.now()})
    `;

    return streamId;
  }

  /**
   * Mark a stream as completed and flush any pending chunks.
   * @param streamId - The stream to mark as completed
   * @internal Protected for testing purposes.
   */
  protected _completeStream(streamId: string) {
    // Flush any pending chunks before completing
    this._flushChunkBuffer();

    this.sql`
      update cf_ai_chat_stream_metadata 
      set status = 'completed', completed_at = ${Date.now()} 
      where id = ${streamId}
    `;
    this._activeStreamId = null;
    this._activeRequestId = null;
    this._streamChunkIndex = 0;

    // Periodically clean up old streams (not on every completion)
    this._maybeCleanupOldStreams();
  }

  /**
   * Clean up old completed streams if enough time has passed since last cleanup.
   * This prevents database growth while avoiding cleanup overhead on every stream completion.
   */
  private _maybeCleanupOldStreams() {
    const now = Date.now();
    if (now - this._lastCleanupTime < CLEANUP_INTERVAL_MS) {
      return;
    }
    this._lastCleanupTime = now;

    const cutoff = now - CLEANUP_AGE_THRESHOLD_MS;
    this.sql`
      delete from cf_ai_chat_stream_chunks 
      where stream_id in (
        select id from cf_ai_chat_stream_metadata 
        where status = 'completed' and completed_at < ${cutoff}
      )
    `;
    this.sql`
      delete from cf_ai_chat_stream_metadata 
      where status = 'completed' and completed_at < ${cutoff}
    `;
  }

  private _broadcastChatMessage(message: OutgoingMessage, exclude?: string[]) {
    this.broadcast(JSON.stringify(message), exclude);
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
    return rows
      .map((row) => {
        try {
          return JSON.parse(row.message as string);
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
    // biome-ignore lint/correctness/noUnusedFunctionParameters: overridden later
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    // biome-ignore lint/correctness/noUnusedFunctionParameters: overridden later
    options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    throw new Error(
      "recieved a chat message, override onChatMessage and return a Response to send to the client"
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

    // Persist the merged messages
    for (const message of mergedMessages) {
      // Strip OpenAI item IDs to prevent "Duplicate item found" errors
      // when using the OpenAI Responses API. These IDs are assigned by OpenAI
      // and if sent back in subsequent requests, cause duplicate detection.
      const sanitizedMessage = this._sanitizeMessageForPersistence(message);
      const messageToSave = this._resolveMessageForToolMerge(sanitizedMessage);
      this.sql`
        insert into cf_ai_chat_agent_messages (id, message)
        values (${messageToSave.id}, ${JSON.stringify(messageToSave)})
        on conflict(id) do update set message = excluded.message
      `;
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
        part.state === "output-available"
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
   * Applies a tool result to an existing assistant message.
   * This is used when the client sends CF_AGENT_TOOL_RESULT for client-side tools.
   * The server is the source of truth, so we update the message here and broadcast
   * the update to all clients.
   *
   * @param toolCallId - The tool call ID this result is for
   * @param toolName - The name of the tool
   * @param output - The output from the tool execution
   * @returns true if the result was applied, false if the message was not found
   */
  private async _applyToolResult(
    toolCallId: string,
    _toolName: string,
    output: unknown
  ): Promise<boolean> {
    // Find the message with this tool call
    // First check the currently streaming message
    let message: ChatMessage | undefined;

    // Check streaming message first
    if (this._streamingMessage) {
      for (const part of this._streamingMessage.parts) {
        if ("toolCallId" in part && part.toolCallId === toolCallId) {
          message = this._streamingMessage;
          break;
        }
      }
    }

    // If not found in streaming message, retry persisted messages
    if (!message) {
      for (let attempt = 0; attempt < 10; attempt++) {
        message = this._findMessageByToolCallId(toolCallId);
        if (message) break;
        // Wait 100ms before retrying
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    if (!message) {
      // The tool result will be included when
      // the client sends the follow-up message via sendMessage().
      console.warn(
        `[AIChatAgent] _applyToolResult: Could not find message with toolCallId ${toolCallId} after retries`
      );
      return false;
    }

    // Check if this is the streaming message (not yet persisted)
    const isStreamingMessage = message === this._streamingMessage;

    // Update the tool part with the output
    let updated = false;
    if (isStreamingMessage) {
      // Update in place - the message will be persisted when streaming completes
      for (const part of message.parts) {
        if (
          "toolCallId" in part &&
          part.toolCallId === toolCallId &&
          "state" in part &&
          part.state === "input-available"
        ) {
          (part as { state: string; output?: unknown }).state =
            "output-available";
          (part as { state: string; output?: unknown }).output = output;
          updated = true;
          break;
        }
      }
    } else {
      // For persisted messages, create updated parts
      const updatedParts = message.parts.map((part) => {
        if (
          "toolCallId" in part &&
          part.toolCallId === toolCallId &&
          "state" in part &&
          part.state === "input-available"
        ) {
          updated = true;
          return {
            ...part,
            state: "output-available" as const,
            output
          };
        }
        return part;
      }) as ChatMessage["parts"];

      if (updated) {
        // Create the updated message and strip OpenAI item IDs
        const updatedMessage: ChatMessage = this._sanitizeMessageForPersistence(
          {
            ...message,
            parts: updatedParts
          }
        );

        // Persist the updated message
        this.sql`
          update cf_ai_chat_agent_messages 
          set message = ${JSON.stringify(updatedMessage)}
          where id = ${message.id}
        `;

        // Reload messages to update in-memory state
        const persisted = this._loadMessagesFromDb();
        this.messages = autoTransformMessages(persisted);
      }
    }

    if (!updated) {
      console.warn(
        `[AIChatAgent] _applyToolResult: Tool part with toolCallId ${toolCallId} not in input-available state`
      );
      return false;
    }

    // Broadcast the update to all clients (only for persisted messages)
    // For streaming messages, the update will be included when persisted
    if (!isStreamingMessage) {
      // Re-fetch the message for broadcast since we modified it
      const broadcastMessage = this._findMessageByToolCallId(toolCallId);
      if (broadcastMessage) {
        this._broadcastChatMessage({
          type: MessageType.CF_AGENT_MESSAGE_UPDATED,
          message: broadcastMessage
        });
      }
    }

    // Note: We don't automatically continue the conversation here.
    // The client is responsible for sending a follow-up request if needed.
    // This avoids re-entering onChatMessage with unexpected state.

    return true;
  }

  private async _reply(
    id: string,
    response: Response,
    excludeBroadcastIds: string[] = [],
    options: { continuation?: boolean } = {}
  ) {
    const { continuation = false } = options;

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

      /* Lazy loading ai sdk, because putting it in module scope is
       * causing issues with startup time.
       * The only place it's used is in _reply, which only matters after
       * a chat message is received.
       * So it's safe to delay loading it until a chat message is received.
       */
      const { getToolName, isToolUIPart, parsePartialJson } =
        await import("ai");

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
      let activeTextParts: Record<string, TextUIPart> = {};
      let activeReasoningParts: Record<string, ReasoningUIPart> = {};
      const partialToolCalls: Record<
        string,
        { text: string; index: number; toolName: string; dynamic?: boolean }
      > = {};

      function updateDynamicToolPart(
        options: {
          toolName: string;
          toolCallId: string;
          providerExecuted?: boolean;
        } & (
          | {
              state: "input-streaming";
              input: unknown;
            }
          | {
              state: "input-available";
              input: unknown;
              providerMetadata?: ProviderMetadata;
            }
          | {
              state: "output-available";
              input: unknown;
              output: unknown;
              preliminary: boolean | undefined;
            }
          | {
              state: "output-error";
              input: unknown;
              errorText: string;
              providerMetadata?: ProviderMetadata;
            }
        )
      ) {
        const part = message.parts.find(
          (part) =>
            part.type === "dynamic-tool" &&
            part.toolCallId === options.toolCallId
        ) as DynamicToolUIPart | undefined;

        const anyOptions = options as Record<string, unknown>;
        const anyPart = part as Record<string, unknown>;

        if (part != null) {
          part.state = options.state;
          anyPart.toolName = options.toolName;
          anyPart.input = anyOptions.input;
          anyPart.output = anyOptions.output;
          anyPart.errorText = anyOptions.errorText;
          anyPart.rawInput = anyOptions.rawInput ?? anyPart.rawInput;
          anyPart.preliminary = anyOptions.preliminary;

          if (
            anyOptions.providerMetadata != null &&
            part.state === "input-available"
          ) {
            part.callProviderMetadata =
              anyOptions.providerMetadata as ProviderMetadata;
          }
        } else {
          message.parts.push({
            type: "dynamic-tool",
            toolName: options.toolName,
            toolCallId: options.toolCallId,
            state: options.state,
            input: anyOptions.input,
            output: anyOptions.output,
            errorText: anyOptions.errorText,
            preliminary: anyOptions.preliminary,
            ...(anyOptions.providerMetadata != null
              ? { callProviderMetadata: anyOptions.providerMetadata }
              : {})
          } as DynamicToolUIPart);
        }
      }

      function updateToolPart(
        options: {
          toolName: string;
          toolCallId: string;
          providerExecuted?: boolean;
        } & (
          | {
              state: "input-streaming";
              input: unknown;
              providerExecuted?: boolean;
            }
          | {
              state: "input-available";
              input: unknown;
              providerExecuted?: boolean;
              providerMetadata?: ProviderMetadata;
            }
          | {
              state: "output-available";
              input: unknown;
              output: unknown;
              providerExecuted?: boolean;
              preliminary?: boolean;
            }
          | {
              state: "output-error";
              input: unknown;
              rawInput?: unknown;
              errorText: string;
              providerExecuted?: boolean;
              providerMetadata?: ProviderMetadata;
            }
        )
      ) {
        const part = message.parts.find(
          (part) =>
            isToolUIPart(part) &&
            (part as ToolUIPart).toolCallId === options.toolCallId
        ) as ToolUIPart | undefined;

        const anyOptions = options as Record<string, unknown>;
        const anyPart = part as Record<string, unknown>;

        if (part != null) {
          part.state = options.state;
          anyPart.input = anyOptions.input;
          anyPart.output = anyOptions.output;
          anyPart.errorText = anyOptions.errorText;
          anyPart.rawInput = anyOptions.rawInput;
          anyPart.preliminary = anyOptions.preliminary;

          // once providerExecuted is set, it stays for streaming
          anyPart.providerExecuted =
            anyOptions.providerExecuted ?? part.providerExecuted;

          if (
            anyOptions.providerMetadata != null &&
            part.state === "input-available"
          ) {
            part.callProviderMetadata =
              anyOptions.providerMetadata as ProviderMetadata;
          }
        } else {
          message.parts.push({
            type: `tool-${options.toolName}`,
            toolCallId: options.toolCallId,
            state: options.state,
            input: anyOptions.input,
            output: anyOptions.output,
            rawInput: anyOptions.rawInput,
            errorText: anyOptions.errorText,
            providerExecuted: anyOptions.providerExecuted,
            preliminary: anyOptions.preliminary,
            ...(anyOptions.providerMetadata != null
              ? { callProviderMetadata: anyOptions.providerMetadata }
              : {})
          } as ToolUIPart);
        }
      }

      async function updateMessageMetadata(metadata: unknown) {
        if (metadata != null) {
          const mergedMetadata =
            message.metadata != null
              ? { ...message.metadata, ...metadata } // TODO: do proper merging
              : metadata;

          message.metadata = mergedMetadata;
        }
      }

      // Determine response format based on content-type
      const contentType = response.headers.get("content-type") || "";
      const isSSE = contentType.includes("text/event-stream"); // AI SDK v5 SSE format

      // if not AI SDK SSE format, we need to inject text-start and text-end events ourselves
      if (!isSSE) {
        this._broadcastTextEvent(
          streamId,
          { type: "text-start", id },
          continuation
        );
      }

      let streamCompleted = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (!isSSE) {
              this._broadcastTextEvent(
                streamId,
                { type: "text-end", id },
                continuation
              );
            }

            // Mark the stream as completed
            this._completeStream(streamId);
            streamCompleted = true;
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

          // After streaming is complete, persist the complete assistant's response
          if (isSSE) {
            // Parse AI SDK v5 SSE format and extract text deltas
            const lines = chunk.split("\n");
            for (const line of lines) {
              if (line.startsWith("data: ") && line !== "data: [DONE]") {
                try {
                  const data: UIMessageChunk = JSON.parse(line.slice(6)); // Remove 'data: ' prefix
                  switch (data.type) {
                    case "text-start": {
                      const textPart: TextUIPart = {
                        type: "text",
                        text: "",
                        providerMetadata: data.providerMetadata,
                        state: "streaming"
                      };
                      activeTextParts[data.id] = textPart;
                      message.parts.push(textPart);
                      break;
                    }

                    case "text-delta": {
                      const textPart = activeTextParts[data.id];
                      textPart.text += data.delta;
                      textPart.providerMetadata =
                        data.providerMetadata ?? textPart.providerMetadata;
                      break;
                    }

                    case "text-end": {
                      const textPart = activeTextParts[data.id];
                      textPart.state = "done";
                      textPart.providerMetadata =
                        data.providerMetadata ?? textPart.providerMetadata;
                      delete activeTextParts[data.id];
                      break;
                    }

                    case "reasoning-start": {
                      const reasoningPart: ReasoningUIPart = {
                        type: "reasoning",
                        text: "",
                        providerMetadata: data.providerMetadata,
                        state: "streaming"
                      };
                      activeReasoningParts[data.id] = reasoningPart;
                      message.parts.push(reasoningPart);
                      break;
                    }

                    case "reasoning-delta": {
                      const reasoningPart = activeReasoningParts[data.id];
                      reasoningPart.text += data.delta;
                      reasoningPart.providerMetadata =
                        data.providerMetadata ?? reasoningPart.providerMetadata;
                      break;
                    }

                    case "reasoning-end": {
                      const reasoningPart = activeReasoningParts[data.id];
                      reasoningPart.providerMetadata =
                        data.providerMetadata ?? reasoningPart.providerMetadata;
                      reasoningPart.state = "done";
                      delete activeReasoningParts[data.id];

                      break;
                    }

                    case "file": {
                      message.parts.push({
                        type: "file",
                        mediaType: data.mediaType,
                        url: data.url
                      });

                      break;
                    }

                    case "source-url": {
                      message.parts.push({
                        type: "source-url",
                        sourceId: data.sourceId,
                        url: data.url,
                        title: data.title,
                        providerMetadata: data.providerMetadata
                      });

                      break;
                    }

                    case "source-document": {
                      message.parts.push({
                        type: "source-document",
                        sourceId: data.sourceId,
                        mediaType: data.mediaType,
                        title: data.title,
                        filename: data.filename,
                        providerMetadata: data.providerMetadata
                      });

                      break;
                    }

                    case "tool-input-start": {
                      const toolInvocations =
                        message.parts.filter(isToolUIPart);

                      // add the partial tool call to the map
                      partialToolCalls[data.toolCallId] = {
                        text: "",
                        toolName: data.toolName,
                        index: toolInvocations.length,
                        dynamic: data.dynamic
                      };

                      if (data.dynamic) {
                        updateDynamicToolPart({
                          toolCallId: data.toolCallId,
                          toolName: data.toolName,
                          state: "input-streaming",
                          input: undefined
                        });
                      } else {
                        updateToolPart({
                          toolCallId: data.toolCallId,
                          toolName: data.toolName,
                          state: "input-streaming",
                          input: undefined
                        });
                      }

                      break;
                    }

                    case "tool-input-delta": {
                      const partialToolCall = partialToolCalls[data.toolCallId];

                      partialToolCall.text += data.inputTextDelta;

                      const partialArgsResult = await parsePartialJson(
                        partialToolCall.text
                      );
                      const partialArgs = (
                        partialArgsResult as { value: Record<string, unknown> }
                      ).value;

                      if (partialToolCall.dynamic) {
                        updateDynamicToolPart({
                          toolCallId: data.toolCallId,
                          toolName: partialToolCall.toolName,
                          state: "input-streaming",
                          input: partialArgs
                        });
                      } else {
                        updateToolPart({
                          toolCallId: data.toolCallId,
                          toolName: partialToolCall.toolName,
                          state: "input-streaming",
                          input: partialArgs
                        });
                      }

                      break;
                    }

                    case "tool-input-available": {
                      if (data.dynamic) {
                        updateDynamicToolPart({
                          toolCallId: data.toolCallId,
                          toolName: data.toolName,
                          state: "input-available",
                          input: data.input,
                          providerMetadata: data.providerMetadata
                        });
                      } else {
                        updateToolPart({
                          toolCallId: data.toolCallId,
                          toolName: data.toolName,
                          state: "input-available",
                          input: data.input,
                          providerExecuted: data.providerExecuted,
                          providerMetadata: data.providerMetadata
                        });
                      }

                      // TODO: Do we want to expose onToolCall?

                      // invoke the onToolCall callback if it exists. This is blocking.
                      // In the future we should make this non-blocking, which
                      // requires additional state management for error handling etc.
                      // Skip calling onToolCall for provider-executed tools since they are already executed
                      // if (onToolCall && !data.providerExecuted) {
                      //   await onToolCall({
                      //     toolCall: data
                      //   });
                      // }
                      break;
                    }

                    case "tool-input-error": {
                      if (data.dynamic) {
                        updateDynamicToolPart({
                          toolCallId: data.toolCallId,
                          toolName: data.toolName,
                          state: "output-error",
                          input: data.input,
                          errorText: data.errorText,
                          providerMetadata: data.providerMetadata
                        });
                      } else {
                        updateToolPart({
                          toolCallId: data.toolCallId,
                          toolName: data.toolName,
                          state: "output-error",
                          input: undefined,
                          rawInput: data.input,
                          errorText: data.errorText,
                          providerExecuted: data.providerExecuted,
                          providerMetadata: data.providerMetadata
                        });
                      }

                      break;
                    }

                    case "tool-output-available": {
                      if (data.dynamic) {
                        const toolInvocations = message.parts.filter(
                          (part) => part.type === "dynamic-tool"
                        ) as DynamicToolUIPart[];

                        const toolInvocation = toolInvocations.find(
                          (invocation) =>
                            invocation.toolCallId === data.toolCallId
                        );

                        if (!toolInvocation)
                          throw new Error("Tool invocation not found");

                        updateDynamicToolPart({
                          toolCallId: data.toolCallId,
                          toolName: toolInvocation.toolName,
                          state: "output-available",
                          input: toolInvocation.input,
                          output: data.output,
                          preliminary: data.preliminary
                        });
                      } else {
                        const toolInvocations = message.parts.filter(
                          isToolUIPart
                        ) as ToolUIPart[];

                        const toolInvocation = toolInvocations.find(
                          (invocation) =>
                            invocation.toolCallId === data.toolCallId
                        );

                        if (!toolInvocation)
                          throw new Error("Tool invocation not found");

                        updateToolPart({
                          toolCallId: data.toolCallId,
                          toolName: getToolName(toolInvocation),
                          state: "output-available",
                          input: toolInvocation.input,
                          output: data.output,
                          providerExecuted: data.providerExecuted,
                          preliminary: data.preliminary
                        });
                      }

                      break;
                    }

                    case "tool-output-error": {
                      if (data.dynamic) {
                        const toolInvocations = message.parts.filter(
                          (part) => part.type === "dynamic-tool"
                        ) as DynamicToolUIPart[];

                        const toolInvocation = toolInvocations.find(
                          (invocation) =>
                            invocation.toolCallId === data.toolCallId
                        );

                        if (!toolInvocation)
                          throw new Error("Tool invocation not found");

                        updateDynamicToolPart({
                          toolCallId: data.toolCallId,
                          toolName: toolInvocation.toolName,
                          state: "output-error",
                          input: toolInvocation.input,
                          errorText: data.errorText
                        });
                      } else {
                        const toolInvocations = message.parts.filter(
                          isToolUIPart
                        ) as ToolUIPart[];

                        const toolInvocation = toolInvocations.find(
                          (invocation) =>
                            invocation.toolCallId === data.toolCallId
                        );

                        if (!toolInvocation)
                          throw new Error("Tool invocation not found");
                        updateToolPart({
                          toolCallId: data.toolCallId,
                          toolName: getToolName(toolInvocation),
                          state: "output-error",
                          input: toolInvocation.input,
                          rawInput:
                            "rawInput" in toolInvocation
                              ? toolInvocation.rawInput
                              : undefined,
                          errorText: data.errorText
                        });
                      }

                      break;
                    }

                    case "start-step": {
                      // add a step boundary part to the message
                      message.parts.push({ type: "step-start" });
                      break;
                    }

                    case "finish-step": {
                      // reset the current text and reasoning parts
                      activeTextParts = {};
                      activeReasoningParts = {};
                      break;
                    }

                    case "start": {
                      if (data.messageId != null) {
                        message.id = data.messageId;
                      }

                      await updateMessageMetadata(data.messageMetadata);

                      break;
                    }

                    case "finish": {
                      await updateMessageMetadata(data.messageMetadata);
                      break;
                    }

                    case "message-metadata": {
                      await updateMessageMetadata(data.messageMetadata);
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
                    // Do we want to handle data parts?
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

                  // Store chunk for replay on reconnection
                  const chunkBody = JSON.stringify(eventToSend);
                  this._storeStreamChunk(streamId, chunkBody);

                  // Forward the converted event to the client
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
          } else {
            // Handle plain text responses (e.g., from generateText)
            // Treat the entire chunk as a text delta to preserve exact formatting
            if (chunk.length > 0) {
              message.parts.push({ type: "text", text: chunk });
              this._broadcastTextEvent(
                streamId,
                { type: "text-delta", id, delta: chunk },
                continuation
              );
            }
          }
        }
      } catch (error) {
        // Mark stream as error if not already completed
        if (!streamCompleted) {
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

      // Clear the streaming message reference and resolve completion promise
      this._streamingMessage = null;
      if (this._streamCompletionResolve) {
        this._streamCompletionResolve();
        this._streamCompletionResolve = null;
        this._streamCompletionPromise = null;
      }
    });
  }

  /**
   * Mark a stream as errored and clean up state.
   * @param streamId - The stream to mark as errored
   * @internal Protected for testing purposes.
   */
  protected _markStreamError(streamId: string) {
    // Flush any pending chunks before marking error
    this._flushChunkBuffer();

    this.sql`
      update cf_ai_chat_stream_metadata 
      set status = 'error', completed_at = ${Date.now()} 
      where id = ${streamId}
    `;
    this._activeStreamId = null;
    this._activeRequestId = null;
    this._streamChunkIndex = 0;
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

    // Flush any remaining chunks before cleanup
    this._flushChunkBuffer();

    // Clean up stream tables
    this.sql`drop table if exists cf_ai_chat_stream_chunks`;
    this.sql`drop table if exists cf_ai_chat_stream_metadata`;

    // Clear active stream state
    this._activeStreamId = null;
    this._activeRequestId = null;

    await super.destroy();
  }
}
