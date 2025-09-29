import type {
  UIMessage as ChatMessage,
  StreamTextOnFinishCallback,
  ToolSet
} from "ai";
import { nanoid } from "nanoid";
import type { AgentContext } from "./";

interface StreamStateRow {
  stream_id: string;
  seq: number;
  fetching: number;
  completed: number;
  created_at?: string;
  updated_at?: string;
  headers?: string;
}

interface TextDeltaRow {
  stream_id: string;
  seq: number;
  text_delta: string;
  created_at?: string;
}

interface StreamStatusRow {
  seq: number;
  fetching: number;
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
      upstreamReader?: ReadableStreamDefaultReader<Uint8Array>; // Reader for upstream response
      timestamp: number;
      readers: Set<
        WritableStreamDefaultWriter | ReadableStreamDefaultController
      >; // Active readers/writers
    }
  >;

  private ctx: AgentContext;
  private sql: <T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) => T[];

  constructor(
    ctx: AgentContext,
    sql: <T = Record<string, string | number | boolean | null>>(
      strings: TemplateStringsArray,
      ...values: (string | number | boolean | null)[]
    ) => T[]
  ) {
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

    // Initialize stream text deltas table
    this.sql`create table if not exists cf_ai_http_chat_text_deltas (
      stream_id text not null,
      seq integer not null,
      text_delta text not null,
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
    const state = this._activeStreams.get(streamId);
    if (state) {
      try {
        await state.upstreamReader?.cancel();
      } catch {}
    }

    this._markStreamCompleted(streamId);

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
      select seq, fetching, completed, created_at, updated_at from cf_ai_http_chat_streams 
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
        position: streamState.seq,
        completed: Boolean(streamState.completed),
        createdAt: streamState.created_at,
        updatedAt: streamState.updated_at
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  /**
   * Clear all streams and text deltas
   */
  async clearStreams(): Promise<void> {
    this.sql`delete from cf_ai_http_chat_streams`;
    this.sql`delete from cf_ai_http_chat_text_deltas`;
    this._activeStreams.clear();
  }

  /**
   * Destroy all resumable streaming
   * Should be called during Agent destruction
   */
  async destroy(): Promise<void> {
    // Clear in-memory state first
    this._activeStreams.clear();

    // Drop all tables
    this.sql`DROP TABLE IF EXISTS cf_ai_http_chat_streams`;
    this.sql`DROP TABLE IF EXISTS cf_ai_http_chat_text_deltas`;
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
      delete from cf_ai_http_chat_text_deltas 
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

      // Headers are captured and handled in the response stream

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

    streamState.upstreamReader = reader;

    let assistantMessageText = "";
    const assistantMessageId = `assistant_${nanoid()}`;
    let buffer = "";

    let completedNaturally = false;
    try {
      while (true) {
        // Check if stream was completed by onFinish callback
        const currentState = this._activeStreams.get(streamId);
        if (currentState?.completed) {
          // Ensure database state is synchronized
          try {
            this.sql`
              update cf_ai_http_chat_streams
              set fetching = 0, completed = 1, updated_at = current_timestamp
              where stream_id = ${streamId}
            `;
          } catch (sqlError) {
            console.error(
              `[ResumableStreamManager] Error syncing completion state for ${streamId}:`,
              sqlError
            );
          }

          completedNaturally = true;
          break;
        }

        const { done, value } = await reader.read();
        if (done) {
          completedNaturally = true;
          break;
        }

        // Parse SSE chunk for text content first
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

                // Store the parsed text delta
                try {
                  const seqResult = this.sql`
                    update cf_ai_http_chat_streams
                    set seq = seq + 1, updated_at = current_timestamp
                    where stream_id = ${streamId}
                    returning seq
                  `;

                  const seq = Number(seqResult[0]?.seq) || streamState.seq++;

                  this.sql`
                    insert into cf_ai_http_chat_text_deltas (stream_id, seq, text_delta)
                    values (${streamId}, ${seq}, ${data.delta})
                  `;

                  streamState.seq = seq + 1;
                } catch (sqlError) {
                  console.error(
                    `[ResumableStreamManager] SQL error storing text delta for ${streamId}:`,
                    sqlError
                  );
                }
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
      // Clear the upstream reader reference
      const currentState = this._activeStreams.get(streamId);
      if (currentState) {
        currentState.upstreamReader = undefined;
      }
      // Only mark as completed if stream finished naturally, not if interrupted
      if (completedNaturally) {
        this._markStreamCompleted(streamId);
      } else {
        // Stream was interrupted - update fetching state but don't mark as completed
        if (currentState && !currentState.completed) {
          currentState.fetching = false;
        }
        try {
          this.sql`
            update cf_ai_http_chat_streams
            set fetching = 0, updated_at = current_timestamp
            where stream_id = ${streamId}
          `;
        } catch (sqlError) {
          console.error(
            `[ResumableStreamManager] Error updating fetching state for ${streamId}:`,
            sqlError
          );
        }
      }
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
      return new Response(JSON.stringify({ error: "Stream not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
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
        // 1. Replay stored text deltas
        await this.ctx.blockConcurrencyWhile(async () => {
          const textDeltas = this.sql`
            select seq, text_delta from cf_ai_http_chat_text_deltas
            where stream_id = ${streamId}
            order by seq asc
          ` as unknown as Pick<TextDeltaRow, "seq" | "text_delta">[];

          for (const row of textDeltas) {
            // Reconstruct SSE format from stored text delta
            const sseData = {
              type: "text-delta",
              delta: row.text_delta
            };
            const sseChunk = `data: ${JSON.stringify(sseData)}\n\n`;
            const bytes = new TextEncoder().encode(sseChunk);
            await writer.write(bytes);
            lastSeenSeq = row.seq;
          }
        });

        // 2. Check if stream is truly complete by verifying both in-memory and database state
        const currentState = this._activeStreams.get(streamId);

        // Get the latest database state to ensure consistency
        const dbState = this.sql`
          select fetching, completed from cf_ai_http_chat_streams
          where stream_id = ${streamId}
        `[0] as unknown as
          | Pick<StreamStateRow, "fetching" | "completed">
          | undefined;

        const isStillFetching =
          currentState?.fetching || dbState?.fetching === 1;
        const isCompleted = currentState?.completed && dbState?.completed === 1;

        if (isStillFetching && !isCompleted) {
          // Stream is still active, join as live reader
          if (currentState) {
            currentState.readers.add(writer);
          }
          await this._backfillGaps(streamId, writer, lastSeenSeq + 1);
        } else {
          // Stream is complete, close writer
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
    headers["X-Stream-Complete"] = String(Boolean(dbState?.completed));

    // Include messages in header if requested
    if (includeMessages) {
      try {
        headers["X-Messages"] = encodeURIComponent(JSON.stringify(messages));
      } catch (e) {
        console.error("Failed to add messages to header:", e);
      }
    }

    return new Response(toClient, { headers });
  }

  /**
   * Backfill any text deltas that were written while this writer was joining
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
        select seq, text_delta from cf_ai_http_chat_text_deltas
        where stream_id = ${streamId} and seq >= ${cursor} and seq < ${streamState.seq}
        order by seq asc
      ` as unknown as Pick<TextDeltaRow, "seq" | "text_delta">[];

      for (const row of gaps) {
        try {
          // Reconstruct SSE format from stored text delta
          const sseData = {
            type: "text-delta",
            delta: row.text_delta
          };
          const sseChunk = `data: ${JSON.stringify(sseData)}\n\n`;
          const bytes = new TextEncoder().encode(sseChunk);
          await writer.write(bytes);
          cursor = row.seq + 1;
        } catch {
          // Writer closed
          return;
        }
      }

      // Check if more text deltas arrived while we were backfilling
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

    // Update database state with error handling
    try {
      this.sql`
        update cf_ai_http_chat_streams
        set fetching = 0, completed = 1, updated_at = current_timestamp
        where stream_id = ${streamId}
      `;
    } catch (sqlError) {
      console.error(
        `[ResumableStreamManager] Error marking stream ${streamId} completed:`,
        sqlError
      );
      // Stream is still marked as completed in memory even if SQL fails
    }

    // Clean up from memory after some time
    setTimeout(() => {
      this._activeStreams.delete(streamId);
    }, 60000); // Keep in memory for 1 minute after completion
  }
}
