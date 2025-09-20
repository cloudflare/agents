import type {
  UIMessage as ChatMessage,
  StreamTextOnFinishCallback,
  ToolSet
} from "ai";
import type { AgentContext } from "./";

type SqlQueryFunction = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

interface StreamStateRow {
  stream_id: string;
  seq: number;
  fetching: number;
  completed: number;
  created_at?: string;
  updated_at?: string;
  headers?: string;
}

interface ChunkRow {
  stream_id: string;
  seq: number;
  chunk: string;
  created_at?: string;
}

interface StreamStatusRow {
  content: string;
  position: number;
  completed: number;
  created_at: string;
  updated_at: string;
}

const decoder = new TextDecoder();

export class ResumableStreamManager<Message extends ChatMessage = ChatMessage> {
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

  private ctx: AgentContext;
  private sql: SqlQueryFunction;

  constructor(ctx: AgentContext, sql: SqlQueryFunction) {
    this.ctx = ctx;
    this.sql = sql;
    this._activeStreams = new Map();
    this._initializeTables();
  }

  /**
   * Initialize database tables for resumable streaming
   */
  private _initializeTables(): void {
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
  }

  /**
   * Start a new resumable stream
   */
  async startStream(
    streamId: string,
    onChatMessage: (
      onFinish: StreamTextOnFinishCallback<ToolSet>,
      options?: { streamId?: string }
    ) => Promise<Response | undefined>,
    persistMessages: (messages: Message[]) => Promise<void>,
    messages: Message[],
    includeMessages = false
  ): Promise<Response> {
    // Generate random stream ID if not provided
    const actualStreamId = streamId || crypto.randomUUID();

    // Check if this stream already exists and is active
    let streamState = this._activeStreams.get(actualStreamId);
    if (!streamState) {
      const dbState = this.sql`
        select * from cf_ai_http_chat_streams
        where stream_id = ${actualStreamId}
      `[0] as unknown as StreamStateRow | undefined;

      if (dbState) {
        console.log(
          `[ResumableStreamManager] Found existing DB state for ${actualStreamId}:`,
          dbState
        );
        streamState = {
          seq: dbState.seq,
          fetching: Boolean(dbState.fetching),
          completed: Boolean(dbState.completed),
          timestamp: Date.now(),
          readers: new Set()
        };
        this._activeStreams.set(actualStreamId, streamState);
      }
    }

    // Start upstream fetch once (in background) if not already fetching
    if (!streamState || (!streamState.fetching && !streamState.completed)) {
      console.log(
        `[ResumableStreamManager] Need to start upstream fetch for ${actualStreamId}`
      );

      await this.ctx.blockConcurrencyWhile(async () => {
        streamState = this._activeStreams.get(actualStreamId);
        if (streamState?.fetching || streamState?.completed) {
          console.log(
            `[ResumableStreamManager] Stream ${actualStreamId} already fetching/completed, skipping`
          );
          return;
        }

        console.log(
          `[ResumableStreamManager] Initializing stream state for ${actualStreamId}`
        );

        // Initialize stream state
        this._activeStreams.set(actualStreamId, {
          seq: 0,
          fetching: true,
          completed: false,
          timestamp: Date.now(),
          readers: new Set()
        });

        // Initialize in database
        this.sql`
          insert into cf_ai_http_chat_streams (stream_id, seq, fetching, completed)
          values (${actualStreamId}, 0, 1, 0)
          on conflict(stream_id) do update set
            fetching = 1,
            updated_at = current_timestamp
        `;

        console.log(
          `[ResumableStreamManager] Starting upstream fetch in background for ${actualStreamId}`
        );

        // Start upstream fetch in background using waitUntil
        this.ctx.waitUntil(
          this._startUpstreamFetch(
            actualStreamId,
            onChatMessage,
            persistMessages,
            messages
          )
        );
      });
    }

    console.log(
      `[ResumableStreamManager] Creating client stream for ${actualStreamId}`
    );

    // Create response stream for this client
    return this._createClientStream(actualStreamId, messages, includeMessages);
  }

  /**
   * Resume an interrupted stream
   */
  async resumeStream(streamId: string, messages: Message[]): Promise<Response> {
    // Check if stream exists in database
    const streamState = this.sql`
      select * from cf_ai_http_chat_streams
      where stream_id = ${streamId}
    `[0] as unknown as StreamStateRow | undefined;

    if (!streamState) {
      return new Response(JSON.stringify({ error: "Stream not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Create a new client stream that will replay stored chunks and join live if still fetching
    return this._createClientStream(streamId, messages);
  }

  /**
   * Cancel an active stream
   */
  async cancelStream(streamId: string): Promise<Response> {
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
   * Get stream status
   */
  async getStreamStatus(streamId: string): Promise<Response> {
    const streamState = this.sql`
      select * from cf_ai_http_chat_streams 
      where stream_id = ${streamId}
    `[0] as unknown as StreamStatusRow | undefined;

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
   * Clear all streams and chunks
   */
  async clearStreams(): Promise<void> {
    this.sql`delete from cf_ai_http_chat_streams`;
    this.sql`delete from cf_ai_http_chat_chunks`;
    this._activeStreams.clear();
  }

  /**
   * Clean up old completed streams (call periodically)
   */
  async cleanupOldStreams(maxAgeHours = 24): Promise<void> {
    const cutoffTime = new Date(
      Date.now() - maxAgeHours * 60 * 60 * 1000
    ).toISOString();

    this.sql`
      delete from cf_ai_http_chat_streams 
      where completed = 1 and updated_at < ${cutoffTime}
    `;

    this.sql`
      delete from cf_ai_http_chat_chunks 
      where stream_id in (
        select stream_id from cf_ai_http_chat_streams 
        where completed = 1 and updated_at < ${cutoffTime}
      )
    `;
  }

  /**
   * Start upstream fetch in background
   */
  private async _startUpstreamFetch(
    streamId: string,
    onChatMessage: (
      onFinish: StreamTextOnFinishCallback<ToolSet>,
      options?: { streamId?: string }
    ) => Promise<Response | undefined>,
    persistMessages: (messages: Message[]) => Promise<void>,
    messages: Message[]
  ): Promise<void> {
    try {
      console.log(
        `[ResumableStreamManager] Starting upstream fetch for stream ${streamId}`
      );

      const response = await onChatMessage(
        async () => {
          // Mark stream as completed
          console.log(`[ResumableStreamManager] Stream ${streamId} finished`);
          this._markStreamCompleted(streamId);
        },
        { streamId }
      );

      console.log(
        "[ResumableStreamManager] onChatMessage response:",
        !!response,
        !!response?.body
      );

      if (!response || !response.body) {
        console.log(
          `[ResumableStreamManager] No response or body for stream ${streamId}, marking completed`
        );
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

      console.log(
        `[ResumableStreamManager] Starting to pipe upstream response for stream ${streamId}`
      );

      // Process the upstream response
      await this._pipeUpstream(response, streamId, persistMessages, messages);
    } catch (error) {
      console.error(
        `[ResumableStreamManager] Error in upstream fetch for stream ${streamId}:`,
        error
      );
      this._markStreamCompleted(streamId);
    }
  }

  /**
   * Pipe upstream response and store chunks
   */
  private async _pipeUpstream(
    response: Response,
    streamId: string,
    persistMessages: (messages: Message[]) => Promise<void>,
    messages: Message[]
  ): Promise<void> {
    if (!response.body) return;

    const reader = response.body.getReader();
    const streamState = this._activeStreams.get(streamId);
    if (!streamState) return;

    let assistantMessageText = "";
    const assistantMessageId = `assistant_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
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
            } catch {
              // Ignore parse errors
            }
          }
        }

        // Broadcast to all active readers (writers)
        for (const readerOrWriter of streamState.readers) {
          try {
            if (readerOrWriter instanceof WritableStreamDefaultWriter) {
              readerOrWriter.write(value);
            } else {
              // Handle ReadableStreamDefaultController
              if (
                "enqueue" in readerOrWriter &&
                typeof readerOrWriter.enqueue === "function"
              ) {
                readerOrWriter.enqueue(value);
              }
            }
          } catch {
            // Reader might be closed
            streamState.readers.delete(readerOrWriter);
          }
        }
      }

      // Save assistant message if we collected any text
      if (assistantMessageText) {
        // Create assistant message with proper typing
        const assistantMessage = {
          id: assistantMessageId,
          role: "assistant" as const,
          parts: [{ type: "text" as const, text: assistantMessageText }]
        } as Message;

        await persistMessages([...messages, assistantMessage]);
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
            // Handle ReadableStreamDefaultController
            if (
              "close" in readerOrWriter &&
              typeof readerOrWriter.close === "function"
            ) {
              readerOrWriter.close();
            }
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
    messages: Message[],
    includeMessages = false
  ): Response {
    console.log(
      `[ResumableStreamManager] Creating client stream for ${streamId}`
    );

    const dbState = this.sql`
      select * from cf_ai_http_chat_streams
      where stream_id = ${streamId}
    `[0] as unknown as StreamStateRow | undefined;

    console.log(`[ResumableStreamManager] DB state for ${streamId}:`, dbState);

    if (!dbState) {
      console.log(`[ResumableStreamManager] No DB state found for ${streamId}`);
      return new Response("Stream not found", { status: 404 });
    }

    let streamState = this._activeStreams.get(streamId);
    if (!streamState) {
      console.log(
        `[ResumableStreamManager] Creating new in-memory state for ${streamId}`
      );
      streamState = {
        seq: dbState.seq,
        fetching: Boolean(dbState.fetching),
        completed: Boolean(dbState.completed),
        timestamp: Date.now(),
        readers: new Set()
      };
      this._activeStreams.set(streamId, streamState);
    }

    console.log(`[ResumableStreamManager] Stream state for ${streamId}:`, {
      seq: streamState.seq,
      fetching: streamState.fetching,
      completed: streamState.completed,
      readersCount: streamState.readers.size
    });

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
          ` as unknown as Pick<ChunkRow, "seq" | "chunk">[];

          for (const row of chunks) {
            // Decode base64 back to Uint8Array
            const chunkBase64 = row.chunk;
            const binaryString = atob(chunkBase64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            await writer.write(bytes);
            lastSeenSeq = row.seq;
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
        // Use base64 encoding to avoid header encoding issues
        headers["X-Messages"] = encodeURIComponent(JSON.stringify(messages));

        // Note: Assistant message content is delivered through the stream itself
        // No need to duplicate it in headers since it's already available via persistMessages()
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
      ` as unknown as Pick<ChunkRow, "seq" | "chunk">[];

      for (const row of gaps) {
        try {
          const chunkBase64 = row.chunk;
          const binaryString = atob(chunkBase64);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          await writer.write(bytes);
          cursor = row.seq + 1;
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
            // Handle ReadableStreamDefaultController
            if (
              "close" in readerOrWriter &&
              typeof readerOrWriter.close === "function"
            ) {
              readerOrWriter.close();
            }
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
}
