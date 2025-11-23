import type { Agent, QueueItem } from "./index";
import { nanoid } from "nanoid";

export type ResumableMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
};

export type ResumableStreamChunk = {
  id: string;
  streamId: string;
  content: string;
  index: number;
  createdAt: number;
};

export type ResumableStreamMetadata = {
  id: string;
  messageId: string;
  status: "streaming" | "completed" | "error";
  totalChunks: number;
  createdAt: number;
  completedAt?: number;
  error?: string;
};

export type GenerateAIResponseOptions = {
  messages: ResumableMessage[];
  streamId: string;
  messageId: string;
  processChunk: (content: string, index?: number) => Promise<void>;
};

/**
 * Manager for implementing resumable streaming with automatic reconnection
 * and history replay. Handles message persistence, stream chunk storage,
 * and state synchronization.
 */
export interface ResumableStreamState {
  messages: ResumableMessage[];
  activeStreamId: string | null;
  [key: string]: unknown;
}

export interface ResumableStreamAgent<
  Env = unknown,
  State extends ResumableStreamState = ResumableStreamState
> extends Agent<Env, State> {
  generateAIResponse(options: GenerateAIResponseOptions): Promise<string>;
  _rsm_generateResponse(
    payload: { userMessageId: string; streamId: string },
    queueItem?: QueueItem
  ): Promise<void>;
}

export class ResumableStreamManager<
  Env = unknown,
  State extends ResumableStreamState = ResumableStreamState
> {
  constructor(
    private agent: ResumableStreamAgent<Env, State>,
    private ctx: DurableObjectState
  ) {}

  private sanitizeError(_error: unknown): string {
    return "An error occurred while processing your request";
  }

  async initializeTables() {
    await this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    await this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS stream_chunks (
        id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        content TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(stream_id, chunk_index)
      )
    `);

    await this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS stream_metadata (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        total_chunks INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT
      )
    `);

    await this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_stream_chunks_stream_id
      ON stream_chunks(stream_id, chunk_index)
    `);
  }

  /**
   * Load all messages from storage
   * @returns Array of messages
   */
  async loadMessages(): Promise<ResumableMessage[]> {
    const cursor = await this.ctx.storage.sql.exec(
      "SELECT id, role, content, created_at FROM messages ORDER BY created_at ASC"
    );

    const messages: ResumableMessage[] = [];
    for (const row of cursor.toArray()) {
      messages.push({
        id: row.id as string,
        role: row.role as "user" | "assistant",
        content: row.content as string,
        createdAt: row.created_at as number
      });
    }

    return messages;
  }

  /**
   * Load messages and sync them to agent state.
   * Call this in your agent's onStart() method after initializing tables.
   */
  async loadAndSyncMessages() {
    const messages = await this.loadMessages();
    this.agent.setState({ ...this.agent.state, messages });
  }

  /**
   * Send a message and queue AI response generation
   *
   * @param content - The user's message content
   * @returns Message ID and stream ID
   */
  async sendMessage(
    content: string
  ): Promise<{ messageId: string; streamId: string }> {
    const userMessageId = nanoid();
    const createdAt = Date.now();
    console.log("📝 Saving user message:", content);

    // Save user message
    await this.ctx.storage.sql.exec(
      "INSERT INTO messages (id, role, content, created_at) VALUES (?, ?, ?, ?)",
      userMessageId,
      "user",
      content,
      createdAt
    );

    // Add user message to state incrementally
    const newMessage: ResumableMessage = {
      id: userMessageId,
      role: "user",
      content,
      createdAt
    };

    this.agent.setState({
      ...this.agent.state,
      messages: [...(this.agent.state.messages || []), newMessage]
    });

    console.log(
      "✅ User message saved, total messages:",
      this.agent.state.messages.length
    );

    // Queue the response as a background task
    const streamId = nanoid();
    console.log("🔄 Queueing AI response generation with streamId:", streamId);

    await this.agent.queue("_rsm_generateResponse", {
      userMessageId,
      streamId
    });

    return { messageId: userMessageId, streamId };
  }

  /**
   * The agent must implement a method called `generateAIResponse` that accepts
   * GenerateAIResponseOptions and returns a Promise<string>.
   */
  async generateResponseCallback(payload: {
    userMessageId: string;
    streamId: string;
  }) {
    console.log(
      "🤖 Starting AI response generation for streamId:",
      payload.streamId
    );
    const { streamId } = payload;
    const assistantMessageId = nanoid();

    try {
      // Create stream metadata
      await this.ctx.storage.sql.exec(
        "INSERT INTO stream_metadata (id, message_id, status, total_chunks, created_at) VALUES (?, ?, ?, ?, ?)",
        streamId,
        assistantMessageId,
        "streaming",
        0,
        Date.now()
      );

      // Update agent state with active stream ID
      this.agent.setState({
        ...this.agent.state,
        activeStreamId: streamId
      });

      // Broadcast stream start
      this.broadcastStreamStart(streamId, assistantMessageId);

      // Load current messages
      const messages = await this.loadMessages();

      // Generate AI response using agent's implementation
      let chunkIndex = 0;
      const fullContent = await this.agent.generateAIResponse({
        messages,
        streamId,
        messageId: assistantMessageId,
        processChunk: async (content: string, index?: number) => {
          const idx = index ?? chunkIndex++;
          // Broadcast immediately
          this.broadcastStreamChunk(streamId, assistantMessageId, content, idx);
          // Save asynchronously
          await this.saveStreamChunk(streamId, content, idx);
        }
      });

      // Save complete message
      const createdAt = Date.now();
      await this.ctx.storage.sql.exec(
        "INSERT INTO messages (id, role, content, created_at) VALUES (?, ?, ?, ?)",
        assistantMessageId,
        "assistant",
        fullContent,
        createdAt
      );

      // Update stream metadata
      await this.ctx.storage.sql.exec(
        "UPDATE stream_metadata SET status = ?, completed_at = ? WHERE id = ?",
        "completed",
        Date.now(),
        streamId
      );

      // Add new message to state and clear active stream ID
      const newMessage: ResumableMessage = {
        id: assistantMessageId,
        role: "assistant",
        content: fullContent,
        createdAt
      };

      this.agent.setState({
        ...this.agent.state,
        messages: [...(this.agent.state.messages || []), newMessage],
        activeStreamId: null
      });

      // Broadcast stream completion
      this.broadcastStreamComplete(streamId, assistantMessageId, fullContent);
    } catch (error) {
      console.error("Error generating response:", error);

      // Update stream metadata with error
      await this.ctx.storage.sql.exec(
        "UPDATE stream_metadata SET status = ?, error = ?, completed_at = ? WHERE id = ?",
        "error",
        error instanceof Error ? error.message : "Unknown error",
        Date.now(),
        streamId
      );

      // Clear active stream ID from agent state
      this.agent.setState({
        ...this.agent.state,
        activeStreamId: null
      });

      // Broadcast error
      this.broadcastStreamError(streamId, error);
    }
  }

  /**
   * Save a stream chunk to storage and update metadata
   */
  private async saveStreamChunk(
    streamId: string,
    content: string,
    index: number
  ) {
    const chunkId = nanoid();

    await this.ctx.storage.sql.exec(
      "INSERT INTO stream_chunks (id, stream_id, content, chunk_index, created_at) VALUES (?, ?, ?, ?, ?)",
      chunkId,
      streamId,
      content,
      index,
      Date.now()
    );

    // Update total chunks count
    await this.ctx.storage.sql.exec(
      "UPDATE stream_metadata SET total_chunks = ? WHERE id = ?",
      index + 1,
      streamId
    );
  }

  /**
   * Broadcast stream start event to all connected clients
   */
  private broadcastStreamStart(streamId: string, messageId: string) {
    this.agent.broadcast(
      JSON.stringify({
        type: "stream_start",
        data: { streamId, messageId }
      })
    );
  }

  /**
   * Broadcast a stream chunk to all connected clients
   */
  private broadcastStreamChunk(
    streamId: string,
    messageId: string,
    chunk: string,
    index: number
  ) {
    this.agent.broadcast(
      JSON.stringify({
        type: "stream_chunk",
        data: {
          streamId,
          messageId,
          chunk,
          index
        }
      })
    );
  }

  /**
   * Broadcast stream completion to all connected clients
   */
  private broadcastStreamComplete(
    streamId: string,
    messageId: string,
    content: string
  ) {
    this.agent.broadcast(
      JSON.stringify({
        type: "stream_complete",
        data: {
          streamId,
          messageId,
          content
        }
      })
    );
  }

  /**
   * Broadcast stream error to all connected clients
   */
  private broadcastStreamError(streamId: string, error: unknown) {
    this.agent.broadcast(
      JSON.stringify({
        type: "stream_error",
        data: {
          streamId,
          error: this.sanitizeError(error)
        }
      })
    );
  }

  /**
   * Get stream history for resuming after reconnection
   *
   * @param streamId - ID of the stream to retrieve
   * @returns Stream chunks and metadata
   */
  async getStreamHistory(streamId: string): Promise<{
    chunks: ResumableStreamChunk[];
    metadata: ResumableStreamMetadata | null;
  }> {
    // Get stream metadata
    const metadataCursor = await this.ctx.storage.sql.exec(
      "SELECT id, message_id, status, total_chunks, created_at, completed_at, error FROM stream_metadata WHERE id = ?",
      streamId
    );

    const metadataRow = metadataCursor.toArray()[0];
    const metadata: ResumableStreamMetadata | null = metadataRow
      ? {
          id: metadataRow.id as string,
          messageId: metadataRow.message_id as string,
          status: metadataRow.status as "streaming" | "completed" | "error",
          totalChunks: metadataRow.total_chunks as number,
          createdAt: metadataRow.created_at as number,
          completedAt: metadataRow.completed_at as number | undefined,
          error: metadataRow.error as string | undefined
        }
      : null;

    // Get stream chunks
    const chunksCursor = await this.ctx.storage.sql.exec(
      "SELECT id, stream_id, content, chunk_index, created_at FROM stream_chunks WHERE stream_id = ? ORDER BY chunk_index ASC",
      streamId
    );

    const chunks: ResumableStreamChunk[] = chunksCursor
      .toArray()
      .map((row) => ({
        id: row.id as string,
        streamId: row.stream_id as string,
        content: row.content as string,
        index: row.chunk_index as number,
        createdAt: row.created_at as number
      }));

    return { chunks, metadata };
  }

  /**
   * Clear all message history and streams
   */
  async clearHistory() {
    await this.ctx.storage.sql.exec("DELETE FROM messages");
    await this.ctx.storage.sql.exec("DELETE FROM stream_chunks");
    await this.ctx.storage.sql.exec("DELETE FROM stream_metadata");
  }

  /**
   * Clean up old completed stream chunks to prevent database growth
   *
   * @param olderThanMs - Remove chunks from streams completed longer than this (in milliseconds)
   * @returns Number of streams cleaned up
   */
  async cleanupOldStreams(
    olderThanMs: number = 7 * 24 * 60 * 60 * 1000
  ): Promise<number> {
    const cutoffTime = Date.now() - olderThanMs;

    // Get IDs of old completed streams
    const oldStreamsCursor = await this.ctx.storage.sql.exec(
      "SELECT id FROM stream_metadata WHERE status = 'completed' AND completed_at < ?",
      cutoffTime
    );

    const oldStreamIds = oldStreamsCursor
      .toArray()
      .map((row) => row.id as string);

    if (oldStreamIds.length === 0) {
      return 0;
    }

    // Delete chunks for old streams
    const placeholders = oldStreamIds.map(() => "?").join(",");
    await this.ctx.storage.sql.exec(
      `DELETE FROM stream_chunks WHERE stream_id IN (${placeholders})`,
      ...oldStreamIds
    );

    // Delete metadata for old streams
    await this.ctx.storage.sql.exec(
      `DELETE FROM stream_metadata WHERE id IN (${placeholders})`,
      ...oldStreamIds
    );

    return oldStreamIds.length;
  }
}
