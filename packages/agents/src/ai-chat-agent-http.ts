import type {
  UIMessage as ChatMessage,
  StreamTextOnFinishCallback,
  ToolSet
} from "ai";
import { Agent, type AgentContext } from "./";
import { autoTransformMessages } from "./ai-chat-v5-migration";
import { ResumableStreamManager } from "./resumable-stream-manager";

export class AIHttpChatAgent<
  Env = unknown,
  State = unknown,
  Message extends ChatMessage = ChatMessage
> extends Agent<Env, State> {
  /** Array of chat messages for the current conversation */
  messages: Message[];

  /** Resumable stream manager for handling stream persistence and resumption */
  private _streamManager: ResumableStreamManager<Message>;

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    // Initialize message storage table
    this.sql`create table if not exists cf_ai_http_chat_messages (
      id text primary key,
      message text not null,
      created_at datetime default current_timestamp
    )`;

    // Initialize resumable stream manager
    this._streamManager = new ResumableStreamManager<Message>(ctx, this.sql);

    // Load messages and automatically transform them to v5 format
    const rawMessages = (
      this
        .sql`select * from cf_ai_http_chat_messages order by created_at asc` ||
      []
    ).map((row) => {
      return JSON.parse(row.message as string);
    });

    this.messages = autoTransformMessages(rawMessages) as Message[];
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
      Number.parseInt(url.searchParams.get("limit") || "50", 10),
      100
    );
    const offset = Number.parseInt(url.searchParams.get("offset") || "0", 10);

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
    const streamId =
      requestStreamId ||
      `stream_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    // Delegate to stream manager
    return this._streamManager.startStream(
      streamId,
      this.onChatMessage.bind(this),
      this.persistMessages.bind(this),
      this.messages,
      includeMessages
    );
  }

  /**
   * Handle GET /stream/{streamId} - Resume interrupted stream
   */
  private async _handleResumeStream(streamId: string): Promise<Response> {
    return this._streamManager.resumeStream(streamId, this.messages);
  }

  /**
   * Handle POST /stream/{streamId}/cancel - Cancel active stream
   */
  private async _handleCancelStream(streamId: string): Promise<Response> {
    return this._streamManager.cancelStream(streamId);
  }

  /**
   * Handle GET /stream/{streamId}/status - Get stream status
   */
  private async _handleStreamStatus(streamId: string): Promise<Response> {
    return this._streamManager.getStreamStatus(streamId);
  }

  /**
   * Handle DELETE /messages - Clear message history
   */
  private async _handleClearMessages(): Promise<Response> {
    this.sql`delete from cf_ai_http_chat_messages`;
    this.messages = [] as Message[];
    await this._streamManager.clearStreams();

    return new Response(
      JSON.stringify({ success: true, message: "Messages cleared" }),
      { headers: { "Content-Type": "application/json" } }
    );
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
  async cleanupOldStreams(maxAgeHours = 24): Promise<void> {
    await this._streamManager.cleanupOldStreams(maxAgeHours);
  }
}
