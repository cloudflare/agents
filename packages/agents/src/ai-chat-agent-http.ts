import type {
  UIMessage as ChatMessage,
  StreamTextOnFinishCallback,
  ToolSet
} from "ai";
import { Agent, type AgentContext } from "./";
import { autoTransformMessages } from "./ai-chat-v5-migration";

const decoder = new TextDecoder();

/**
 * HTTP-based AI Chat Agent with reusable streams support
 * Drops WebSocket dependency in favor of HTTP requests for better AI SDK compatibility
 * @template Env Environment type containing bindings
 * @template State State type for the agent
 * @template Message Message type extending ChatMessage
 */
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
      content: string;
      position: number;
      completed: boolean;
      timestamp: number;
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
      content text not null,
      position integer not null,
      completed integer not null default 0,
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

    // Automatic migration following AI SDK patterns
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
    const body = (await request.json()) as { messages?: Message[] };
    const { messages: incomingMessages } = body;

    if (!Array.isArray(incomingMessages)) {
      return new Response(
        JSON.stringify({ error: "Messages must be an array" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    // Transform and persist incoming messages
    const transformedMessages = autoTransformMessages(
      incomingMessages
    ) as Message[];
    await this.persistMessages(transformedMessages);

    // Generate stream ID for this conversation
    const streamId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    // Call the user-defined chat message handler
    const response = await this.onChatMessage(
      async (_finishResult) => {
        // Mark stream as completed
        this._markStreamCompleted(streamId);
      },
      { streamId }
    );

    if (!response) {
      return new Response(JSON.stringify({ error: "No response generated" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Initialize stream state
    this._initializeStream(streamId);

    // Return streaming response with resumable stream headers
    const headers = new Headers(response.headers);
    headers.set("X-Stream-Id", streamId);
    headers.set("X-Resumable", "true");

    return new Response(this._createResumableStream(response, streamId), {
      status: response.status,
      headers
    });
  }

  /**
   * Handle GET /stream/{streamId} - Resume interrupted stream
   */
  private async _handleResumeStream(streamId: string): Promise<Response> {
    const streamState = this.sql`
      select * from cf_ai_http_chat_streams 
      where stream_id = ${streamId}
    `[0] as
      | { content: string; position: number; completed: number }
      | undefined;

    if (!streamState) {
      return new Response(JSON.stringify({ error: "Stream not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    const { content, position, completed } = streamState;

    if (completed) {
      // Stream is completed, return remaining content
      const remainingContent = content.slice(position);
      return new Response(remainingContent, {
        headers: {
          "Content-Type": "text/plain",
          "X-Stream-Id": streamId,
          "X-Stream-Complete": "true"
        }
      });
    }

    // Stream is still active, return current content and continue streaming
    const currentContent = content.slice(position);
    return new Response(currentContent, {
      headers: {
        "Content-Type": "text/plain",
        "X-Stream-Id": streamId,
        "X-Stream-Position": position.toString()
      }
    });
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
   * Initialize stream state for resumable streaming
   */
  private _initializeStream(streamId: string): void {
    this._activeStreams.set(streamId, {
      content: "",
      position: 0,
      completed: false,
      timestamp: Date.now()
    });

    this.sql`
      insert into cf_ai_http_chat_streams (stream_id, content, position, completed)
      values (${streamId}, '', 0, 0)
    `;
  }

  /**
   * Create a resumable stream that persists content as it's generated
   */
  private _createResumableStream(
    response: Response,
    streamId: string
  ): ReadableStream {
    if (!response.body) {
      return new ReadableStream({
        start(controller) {
          controller.close();
        }
      });
    }

    const reader = response.body.getReader();
    let fullResponseText = "";
    let persistenceCounter = 0;
    const PERSISTENCE_INTERVAL = 100; // Persist every 100 characters

    // Bind methods to maintain context
    const markStreamCompleted = this._markStreamCompleted.bind(this);
    const persistStreamState = this._persistStreamState.bind(this);

    return new ReadableStream({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              // Mark stream as completed and persist final state
              markStreamCompleted(streamId, fullResponseText);
              controller.close();
              break;
            }

            const chunk = decoder.decode(value);
            fullResponseText += chunk;
            persistenceCounter += chunk.length;

            // Persist stream state periodically
            if (persistenceCounter >= PERSISTENCE_INTERVAL) {
              persistStreamState(streamId, fullResponseText);
              persistenceCounter = 0;
            }

            // Forward chunk to client
            controller.enqueue(value);
          }
        } catch (error) {
          console.error("[AIHttpChatAgent] Stream error:", error);
          controller.error(error);
        } finally {
          reader.releaseLock();
        }
      }
    });
  }

  /**
   * Persist stream state to database
   */
  private _persistStreamState(streamId: string, content: string): void {
    const streamState = this._activeStreams.get(streamId);
    if (streamState) {
      streamState.content = content;
      streamState.position = content.length;
      streamState.timestamp = Date.now();
    }

    this.sql`
      update cf_ai_http_chat_streams 
      set content = ${content}, position = ${content.length}, updated_at = current_timestamp
      where stream_id = ${streamId}
    `;
  }

  /**
   * Mark stream as completed
   */
  private _markStreamCompleted(streamId: string, finalContent?: string): void {
    const streamState = this._activeStreams.get(streamId);
    if (streamState) {
      if (finalContent) {
        streamState.content = finalContent;
        streamState.position = finalContent.length;
      }
      streamState.completed = true;
      streamState.timestamp = Date.now();
    }

    const content = finalContent || streamState?.content || "";
    this.sql`
      update cf_ai_http_chat_streams 
      set content = ${content}, position = ${content.length}, completed = 1, updated_at = current_timestamp
      where stream_id = ${streamId}
    `;

    // Clean up from memory after completion
    setTimeout(() => {
      this._activeStreams.delete(streamId);
    }, 5000); // Keep in memory for 5 seconds after completion
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
