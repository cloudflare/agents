import { AIChatAgent } from "../";
import type { UIMessage as ChatMessage } from "ai";
import { callable, getCurrentAgent, routeAgentRequest } from "agents";

// Type helper for tool call parts - extracts from ChatMessage parts
type TestToolCallPart = Extract<
  ChatMessage["parts"][number],
  { type: `tool-${string}` }
>;

export type Env = {
  TestChatAgent: DurableObjectNamespace<TestChatAgent>;
};

export class TestChatAgent extends AIChatAgent<Env> {
  observability = undefined;
  // Store captured context for testing
  private _capturedContext: {
    hasAgent: boolean;
    hasConnection: boolean;
    connectionId: string | undefined;
  } | null = null;
  // Store context captured from nested async function (simulates tool execute)
  private _nestedContext: {
    hasAgent: boolean;
    hasConnection: boolean;
    connectionId: string | undefined;
  } | null = null;

  async onChatMessage() {
    // Capture getCurrentAgent() context for testing
    const { agent, connection } = getCurrentAgent();
    this._capturedContext = {
      hasAgent: agent !== undefined,
      hasConnection: connection !== undefined,
      connectionId: connection?.id
    };

    // Simulate what happens inside a tool's execute function:
    // It's a nested async function called from within onChatMessage
    await this._simulateToolExecute();

    // Simple echo response for testing
    return new Response("Hello from chat agent!", {
      headers: { "Content-Type": "text/plain" }
    });
  }

  // This simulates an AI SDK tool's execute function being called
  private async _simulateToolExecute(): Promise<void> {
    // Add a small delay to ensure we're in a new microtask (like real tool execution)
    await Promise.resolve();

    // Capture context inside the "tool execute" function
    const { agent, connection } = getCurrentAgent();
    this._nestedContext = {
      hasAgent: agent !== undefined,
      hasConnection: connection !== undefined,
      connectionId: connection?.id
    };
  }

  @callable()
  getCapturedContext(): {
    hasAgent: boolean;
    hasConnection: boolean;
    connectionId: string | undefined;
  } | null {
    return this._capturedContext;
  }

  @callable()
  getNestedContext(): {
    hasAgent: boolean;
    hasConnection: boolean;
    connectionId: string | undefined;
  } | null {
    return this._nestedContext;
  }

  @callable()
  clearCapturedContext(): void {
    this._capturedContext = null;
    this._nestedContext = null;
  }

  @callable()
  getPersistedMessages(): ChatMessage[] {
    const rawMessages = (
      this.sql`select * from cf_ai_chat_agent_messages order by created_at` ||
      []
    ).map((row) => {
      return JSON.parse(row.message as string);
    });
    return rawMessages;
  }

  @callable()
  async testPersistToolCall(messageId: string, toolName: string) {
    const toolCallPart: TestToolCallPart = {
      type: `tool-${toolName}`,
      toolCallId: `call_${messageId}`,
      state: "input-available",
      input: { location: "London" }
    };

    const messageWithToolCall: ChatMessage = {
      id: messageId,
      role: "assistant",
      parts: [toolCallPart] as ChatMessage["parts"]
    };
    await this.persistMessages([messageWithToolCall]);
    return messageWithToolCall;
  }

  @callable()
  async testPersistToolResult(
    messageId: string,
    toolName: string,
    output: string
  ) {
    const toolResultPart: TestToolCallPart = {
      type: `tool-${toolName}`,
      toolCallId: `call_${messageId}`,
      state: "output-available",
      input: { location: "London" },
      output
    };

    const messageWithToolOutput: ChatMessage = {
      id: messageId,
      role: "assistant",
      parts: [toolResultPart] as ChatMessage["parts"]
    };
    await this.persistMessages([messageWithToolOutput]);
    return messageWithToolOutput;
  }

  // Resumable streaming test helpers

  @callable()
  testStartStream(requestId: string): string {
    return this._startStream(requestId);
  }

  @callable()
  testStoreStreamChunk(streamId: string, body: string): void {
    this._storeStreamChunk(streamId, body);
  }

  @callable()
  testFlushChunkBuffer(): void {
    this._flushChunkBuffer();
  }

  @callable()
  testCompleteStream(streamId: string): void {
    this._completeStream(streamId);
  }

  @callable()
  testMarkStreamError(streamId: string): void {
    this._markStreamError(streamId);
  }

  @callable()
  getActiveStreamId(): string | null {
    return this._activeStreamId;
  }

  @callable()
  getActiveRequestId(): string | null {
    return this._activeRequestId;
  }

  @callable()
  getStreamChunks(
    streamId: string
  ): Array<{ body: string; chunk_index: number }> {
    return (
      this.sql<{ body: string; chunk_index: number }>`
        select body, chunk_index from cf_ai_chat_stream_chunks 
        where stream_id = ${streamId} 
        order by chunk_index asc
      ` || []
    );
  }

  @callable()
  getStreamMetadata(
    streamId: string
  ): { status: string; request_id: string } | null {
    const result = this.sql<{ status: string; request_id: string }>`
      select status, request_id from cf_ai_chat_stream_metadata 
      where id = ${streamId}
    `;
    return result && result.length > 0 ? result[0] : null;
  }

  @callable()
  getAllStreamMetadata(): Array<{
    id: string;
    status: string;
    request_id: string;
    created_at: number;
  }> {
    return (
      this.sql<{
        id: string;
        status: string;
        request_id: string;
        created_at: number;
      }>`select id, status, request_id, created_at from cf_ai_chat_stream_metadata` ||
      []
    );
  }

  @callable()
  testInsertStaleStream(
    streamId: string,
    requestId: string,
    ageMs: number
  ): void {
    const createdAt = Date.now() - ageMs;
    this.sql`
      insert into cf_ai_chat_stream_metadata (id, request_id, status, created_at)
      values (${streamId}, ${requestId}, 'streaming', ${createdAt})
    `;
  }

  @callable()
  testRestoreActiveStream(): void {
    this._restoreActiveStream();
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/500") {
      return new Response("Internal Server Error", { status: 500 });
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },

  async email(
    _message: ForwardableEmailMessage,
    _env: Env,
    _ctx: ExecutionContext
  ) {
    // Bring this in when we write tests for the complete email handler flow
  }
};
