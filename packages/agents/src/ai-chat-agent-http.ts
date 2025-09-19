import type {
  UIMessage as ChatMessage,
  StreamTextOnFinishCallback,
  ToolSet
} from "ai";
import { Agent, type AgentContext } from "./";
import { autoTransformMessages } from "./ai-chat-v5-migration";

const decoder = new TextDecoder();

export class AIHttpChatAgent<
  Env = unknown,
  State = unknown,
  Message extends ChatMessage = ChatMessage
> extends Agent<Env, State> {
  /** Array of chat messages for the current conversation */
  messages: Message[];

  /** Map of stream IDs to their current state for resumable streams */
  private _activeStreams: Map<
    string,
    {
      seq: number; // Current chunk sequence number
      fetching: boolean; // Is upstream still fetching?
      completed: boolean;
      timestamp: number;
      readers: Set<
        WritableStreamDefaultWriter | ReadableStreamDefaultController
      >; // Active readers/writers
    }
  >;

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    // Initialize message storage table
    this.sql`create table if not exists cf_ai_http_chat_messages (
      id text primary key,
      message text not null,
      created_at datetime default current_timestamp
    )`;

    // Initialize stream state table for resumable streams
    this.sql`create table if not exists cf_ai_http_chat_streams (
      stream_id text primary key,
      seq integer not null default 0,
      fetching integer not null default 0,
      completed integer not null default 0,
      created_at datetime default current_timestamp,
      updated_at datetime default current_timestamp
    )`;

    // Initialize stream chunks table
    this.sql`create table if not exists cf_ai_http_chat_chunks (
      stream_id text not null,
      seq integer not null,
      chunk blob not null,
      created_at datetime default current_timestamp,
      primary key (stream_id, seq)
    )`;

    // Initialize assistant messages table for accumulated text
    this.sql`create table if not exists cf_ai_http_chat_assistant_messages (
      stream_id text primary key,
      content text not null,
      message_id text not null,
      created_at datetime default current_timestamp,
      updated_at datetime default current_timestamp
    )`;

    // Load messages and automatically transform them to v5 format
    const rawMessages = (
      this
        .sql`select * from cf_ai_http_chat_messages order by created_at asc` ||
      []
    ).map((row) => {
      return JSON.parse(row.message as string);
    });
    this.messages = autoTransformMessages(rawMessages) as Message[];
    this._activeStreams = new Map();
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      // GET /messages - Retrieve message history with pagination
      if (pathname.endsWith("/messages") && request.method === "GET") {
        return this._handleGetMessages(request);
      }

      // POST /chat - Send message and get streaming response
      if (pathname.endsWith("/chat") && request.method === "POST") {
        return this._handlePostChat(request);
      }

      // GET /stream/{streamId} - Resume interrupted stream
      if (pathname.includes("/stream/") && request.method === "GET") {
        const streamId = pathname.split("/stream/")[1];
        return this._handleResumeStream(streamId);
      }

      // POST /stream/{streamId}/cancel - Cancel active stream
      if (
        pathname.includes("/stream/") &&
        pathname.endsWith("/cancel") &&
        request.method === "POST"
      ) {
        const streamId = pathname.split("/stream/")[1].replace("/cancel", "");
        return this._handleCancelStream(streamId);
      }

      // GET /stream/{streamId}/status - Get stream status
      if (
        pathname.includes("/stream/") &&
        pathname.endsWith("/status") &&
        request.method === "GET"
      ) {
        const streamId = pathname.split("/stream/")[1].replace("/status", "");
        return this._handleStreamStatus(streamId);
      }

      // DELETE /messages - Clear message history
      if (pathname.endsWith("/messages") && request.method === "DELETE") {
        return this._handleClearMessages();
      }

      return super.onRequest(request);
    } catch (error) {
      console.error("[AIHttpChatAgent] Request error:", error);
      return new Response(
        JSON.stringify({
          error: "Internal server error",
          message: error instanceof Error ? error.message : String(error)
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
  }

  /**
   * Handle GET /messages - Retrieve paginated message history
   */
  private async _handleGetMessages(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const limit = Math.min(
      parseInt(url.searchParams.get("limit") || "50"),
      100
    );
    const offset = parseInt(url.searchParams.get("offset") || "0");

    const messages = (
      this.sql`select * from cf_ai_http_chat_messages 
               order by created_at asc 
               limit ${limit} offset ${offset}` || []
    ).map((row) => {
      return JSON.parse(row.message as string);
    });

    const countResult = this
      .sql`select count(*) as count from cf_ai_http_chat_messages`;
    const totalCount = (countResult[0] as { count: number }).count;

    return new Response(
      JSON.stringify({
        messages: autoTransformMessages(messages),
        pagination: {
          limit,
          offset,
          total: totalCount,
          hasMore: offset + limit < totalCount
        }
      }),
      {
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  /**
   * Handle POST /chat - Send message and get streaming response
   */
  private async _handlePostChat(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      messages?: Message[];
      streamId?: string;
      includeMessages?: boolean;
    };
    const {
      messages: incomingMessages,
      streamId: requestStreamId,
      includeMessages
    } = body;

    if (!Array.isArray(incomingMessages)) {
      return new Response(
        JSON.stringify({ error: "Messages must be an array" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    // Transform and persist incoming messages (if not resuming)
    if (incomingMessages.length > 0) {
      const transformedMessages = autoTransformMessages(
        incomingMessages
      ) as Message[];
      await this.persistMessages(transformedMessages);
    }

    // Generate or reuse stream ID
    let streamId =
      requestStreamId ||
      `stream_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    // Check if this stream already exists and is active
    let streamState = this._activeStreams.get(streamId);
    if (!streamState) {
      const dbState = this.sql`
        select * from cf_ai_http_chat_streams
        where stream_id = ${streamId}
      `[0] as { seq: number; fetching: number; completed: number } | undefined;

      if (dbState) {
        streamState = {
          seq: dbState.seq,
          fetching: Boolean(dbState.fetching),
          completed: Boolean(dbState.completed),
          timestamp: Date.now(),
          readers: new Set()
        };
        this._activeStreams.set(streamId, streamState);
      }
    }

    // Start upstream fetch once (in background) if not already fetching
    if (!streamState || (!streamState.fetching && !streamState.completed)) {
      await this.ctx.blockConcurrencyWhile(async () => {
        streamState = this._activeStreams.get(streamId);
        if (streamState?.fetching || streamState?.completed) {
          return;
        }

        // Initialize stream state
        this._activeStreams.set(streamId, {
          seq: 0,
          fetching: true,
          completed: false,
          timestamp: Date.now(),
          readers: new Set()
        });

        // Initialize in database
        this.sql`
          insert into cf_ai_http_chat_streams (stream_id, seq, fetching, completed)
          values (${streamId}, 0, 1, 0)
          on conflict(stream_id) do update set
            fetching = 1,
            updated_at = current_timestamp
        `;

        // Start upstream fetch in background using waitUntil
        this.ctx.waitUntil(this._startUpstreamFetch(streamId));
      });
    }

    // Create response stream for this client
    return this._createClientStream(streamId, includeMessages);
  }

  /**
   * Handle GET /stream/{streamId} - Resume interrupted stream
   */
  private async _handleResumeStream(streamId: string): Promise<Response> {
    // Check if stream exists in database
    const streamState = this.sql`
      select * from cf_ai_http_chat_streams
      where stream_id = ${streamId}
    `[0] as { seq: number; fetching: number; completed: number } | undefined;

    if (!streamState) {
      return new Response(JSON.stringify({ error: "Stream not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    // a new client stream that will replay stored chunks and join live if still fetching
    return this._createClientStream(streamId);
  }

  /**
   * Handle POST /stream/{streamId}/cancel - Cancel active stream
   */
  private async _handleCancelStream(streamId: string): Promise<Response> {
    // Mark stream as completed to stop further processing
    this.sql`
      update cf_ai_http_chat_streams 
      set completed = 1, updated_at = current_timestamp
      where stream_id = ${streamId}
    `;

    this._activeStreams.delete(streamId);

    return new Response(
      JSON.stringify({ success: true, message: "Stream cancelled" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  /**
   * Handle GET /stream/{streamId}/status - Get stream status
   */
  private async _handleStreamStatus(streamId: string): Promise<Response> {
    const streamState = this.sql`
      select * from cf_ai_http_chat_streams 
      where stream_id = ${streamId}
    `[0] as
      | {
          content: string;
          position: number;
          completed: number;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!streamState) {
      return new Response(JSON.stringify({ error: "Stream not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(
      JSON.stringify({
        streamId,
        position: streamState.position,
        contentLength: streamState.content.length,
        completed: Boolean(streamState.completed),
        createdAt: streamState.created_at,
        updatedAt: streamState.updated_at
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  /**
   * Handle DELETE /messages - Clear message history
   */
  private async _handleClearMessages(): Promise<Response> {
    this.sql`delete from cf_ai_http_chat_messages`;
    this.sql`delete from cf_ai_http_chat_streams`;
    this.messages = [] as Message[];
    this._activeStreams.clear();

    return new Response(
      JSON.stringify({ success: true, message: "Messages cleared" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  /**
   * Start upstream fetch in background
   */
  private async _startUpstreamFetch(streamId: string): Promise<void> {
    const response = await this.onChatMessage(
      async (_finishResult) => {
        // Mark stream as completed
        this._markStreamCompleted(streamId);
      },
      { streamId }
    );

    if (!response || !response.body) {
      this._markStreamCompleted(streamId);
      return;
    }

    // Store response headers
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    this.sql`
      update cf_ai_http_chat_streams
      set headers = ${JSON.stringify(headers)}
      where stream_id = ${streamId}
    `;

    // Process the upstream response
    await this._pipeUpstream(response, streamId);
  }

  /**
   * Pipe upstream response and store chunks
   */
  private async _pipeUpstream(
    response: Response,
    streamId: string
  ): Promise<void> {
    if (!response.body) return;

    const reader = response.body.getReader();
    const streamState = this._activeStreams.get(streamId);
    if (!streamState) return;

    let assistantMessageText = "";
    let assistantMessageId = `assistant_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Store raw chunk with sequence number
        const seq = streamState.seq++;
        const chunkBase64 = btoa(String.fromCharCode(...value));
        this.sql`
          insert into cf_ai_http_chat_chunks (stream_id, seq, chunk)
          values (${streamId}, ${seq}, ${chunkBase64})
        `;

        // Update sequence in stream state
        this.sql`
          update cf_ai_http_chat_streams
          set seq = ${streamState.seq}, updated_at = current_timestamp
          where stream_id = ${streamId}
        `;

        // Parse for assistant message content
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim() === "") continue;
          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6);
            if (dataStr === "[DONE]") continue;
            try {
              const data = JSON.parse(dataStr);
              if (data.type === "text-delta" && data.delta) {
                assistantMessageText += data.delta;
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }

        // Broadcast to all active readers (writers)
        for (const writer of streamState.readers) {
          try {
            if (writer instanceof WritableStreamDefaultWriter) {
              writer.write(value);
            } else {
              // Legacy support for ReadableStreamDefaultController
              (writer as any).enqueue(value);
            }
          } catch (e) {
            // Reader might be closed
            streamState.readers.delete(writer);
          }
        }
      }

      // Save assistant message if we collected any text
      if (assistantMessageText) {
        const assistantMessage: Message = {
          id: assistantMessageId,
          role: "assistant",
          parts: [{ type: "text", text: assistantMessageText }]
        } as unknown as Message;

        await this.persistMessages([...this.messages, assistantMessage]);

        // Store accumulated assistant message for quick resume
        this.sql`
          insert into cf_ai_http_chat_assistant_messages (stream_id, content, message_id)
          values (${streamId}, ${assistantMessageText}, ${assistantMessageId})
        `;
      }
    } finally {
      // Mark stream as completed
      streamState.fetching = false;
      streamState.completed = true;

      this.sql`
        update cf_ai_http_chat_streams
        set fetching = 0, completed = 1, updated_at = current_timestamp
        where stream_id = ${streamId}
      `;

      // Close all readers/writers
      for (const readerOrWriter of streamState.readers) {
        try {
          if (readerOrWriter instanceof WritableStreamDefaultWriter) {
            readerOrWriter.close();
          } else {
            (readerOrWriter as any).close();
          }
        } catch {}
      }
      streamState.readers.clear();
    }
  }

  /**
   * Create client stream that replays stored chunks and joins live if active
   */
  private _createClientStream(
    streamId: string,
    includeMessages = false
  ): Response {
    // Load from database (single source of truth)
    const dbState = this.sql`
      select * from cf_ai_http_chat_streams
      where stream_id = ${streamId}
    `[0] as { seq: number; fetching: number; completed: number } | undefined;

    if (!dbState) {
      return new Response("Stream not found", { status: 404 });
    }

    // Get or create in-memory state for active readers tracking
    let streamState = this._activeStreams.get(streamId);
    if (!streamState) {
      streamState = {
        seq: dbState.seq,
        fetching: Boolean(dbState.fetching),
        completed: Boolean(dbState.completed),
        timestamp: Date.now(),
        readers: new Set()
      };
      this._activeStreams.set(streamId, streamState);
    }

    // Create a TransformStream for this client
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // Fork the readable stream for cleanup monitoring
    const [toClient, toDrain] = readable.tee();

    // Track writer's last seen sequence
    let lastSeenSeq = -1;

    // Replay stored chunks and setup live streaming
    (async () => {
      try {
        // 1. Replay stored chunks with concurrency control
        await this.ctx.blockConcurrencyWhile(async () => {
          const chunks = this.sql`
            select seq, chunk from cf_ai_http_chat_chunks
            where stream_id = ${streamId}
            order by seq asc
          `;

          for (const row of chunks) {
            // Decode base64 back to Uint8Array
            const chunkBase64 = row.chunk as string;
            const binaryString = atob(chunkBase64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            await writer.write(bytes);
            lastSeenSeq = row.seq as number;
          }
        });

        // 2. If still fetching, add to live readers
        const currentState = this._activeStreams.get(streamId);
        if (currentState?.fetching) {
          currentState.readers.add(writer);
          await this._backfillGaps(streamId, writer, lastSeenSeq + 1);
        } else {
          // Stream is complete
          await writer.close();
        }
      } catch (error) {
        console.error("Error in client stream:", error);
        try {
          await writer.close();
        } catch {}
      }
    })();

    // Clean up writer when client disconnects
    toDrain.pipeTo(new WritableStream()).catch(() => {
      const state = this._activeStreams.get(streamId);
      if (state) {
        state.readers.delete(writer);
      }
    });

    // Set standard SSE headers
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    };

    // Add stream metadata headers
    headers["X-Stream-Id"] = streamId;
    headers["X-Resumable"] = "true";

    // Include messages in header if requested
    if (includeMessages) {
      try {
        const messages = this.messages;
        // Use base64 encoding to avoid header encoding issues
        headers["X-Messages"] = encodeURIComponent(JSON.stringify(messages));

        // Include accumulated assistant message if exists
        const assistantMsg = this.sql`
          select content, message_id from cf_ai_http_chat_assistant_messages
          where stream_id = ${streamId}
        `[0] as { content: string; message_id: string } | undefined;

        if (assistantMsg) {
          headers["X-Assistant-Content"] = encodeURIComponent(
            assistantMsg.content
          );
          headers["X-Assistant-Id"] = assistantMsg.message_id;
        }
      } catch (e) {
        console.error("Failed to add messages to header:", e);
      }
    }

    return new Response(toClient, { headers });
  }

  /**
   * Backfill any chunks that were written while this writer was joining
   */
  private async _backfillGaps(
    streamId: string,
    writer: WritableStreamDefaultWriter,
    startSeq: number
  ): Promise<void> {
    const streamState = this._activeStreams.get(streamId);
    if (!streamState) return;

    let cursor = startSeq;
    while (cursor < streamState.seq) {
      const gaps = this.sql`
        select seq, chunk from cf_ai_http_chat_chunks
        where stream_id = ${streamId} and seq >= ${cursor} and seq < ${streamState.seq}
        order by seq asc
      `;

      for (const row of gaps) {
        try {
          const chunkBase64 = row.chunk as string;
          const binaryString = atob(chunkBase64);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          await writer.write(bytes);
          cursor = (row.seq as number) + 1;
        } catch {
          // Writer closed
          return;
        }
      }

      // Check if more chunks arrived while we were backfilling
      if (cursor >= streamState.seq) break;
    }
  }

  /**
   * Mark stream as completed
   */
  private _markStreamCompleted(streamId: string): void {
    const streamState = this._activeStreams.get(streamId);
    if (streamState) {
      streamState.fetching = false;
      streamState.completed = true;
      streamState.timestamp = Date.now();

      // Close all readers/writers
      for (const readerOrWriter of streamState.readers) {
        try {
          if (readerOrWriter instanceof WritableStreamDefaultWriter) {
            readerOrWriter.close();
          } else {
            (readerOrWriter as any).close();
          }
        } catch {}
      }
      streamState.readers.clear();
    }

    this.sql`
      update cf_ai_http_chat_streams
      set fetching = 0, completed = 1, updated_at = current_timestamp
      where stream_id = ${streamId}
    `;

    // Clean up from memory after some time
    setTimeout(() => {
      this._activeStreams.delete(streamId);
    }, 60000); // Keep in memory for 1 minute after completion
  }

  /**
   * Handle incoming chat messages and generate a response
   * @param onFinish Callback to be called when the response is finished
   * @param options.streamId The stream ID for resumable streaming
   * @returns Response to send to the client or undefined
   */
  async onChatMessage(
    // biome-ignore lint/correctness/noUnusedFunctionParameters: overridden later
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    // biome-ignore lint/correctness/noUnusedFunctionParameters: overridden later
    options?: { streamId?: string }
  ): Promise<Response | undefined> {
    throw new Error(
      "Received a chat message, override onChatMessage and return a Response to send to the client"
    );
  }

  /**
   * Save messages following AI SDK patterns
   * @param messages Chat messages to save
   */
  async saveMessages(messages: Message[]) {
    await this.persistMessages(messages);
  }

  /**
   * Persist messages to database
   * @param messages Messages to persist
   */
  async persistMessages(messages: Message[]) {
    // Clear existing messages and insert new ones
    this.sql`delete from cf_ai_http_chat_messages`;

    for (const message of messages) {
      this.sql`
        insert into cf_ai_http_chat_messages (id, message) 
        values (${message.id}, ${JSON.stringify(message)})
      `;
    }

    this.messages = messages;
  }

  /**
   * Clean up old completed streams (call periodically)
   */
  async cleanupOldStreams(maxAgeHours: number = 24): Promise<void> {
    const cutoffTime = new Date(
      Date.now() - maxAgeHours * 60 * 60 * 1000
    ).toISOString();

    this.sql`
      delete from cf_ai_http_chat_streams 
      where completed = 1 and updated_at < ${cutoffTime}
    `;
  }
}
