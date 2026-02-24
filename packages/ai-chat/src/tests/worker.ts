import { AIChatAgent, type OnChatMessageOptions } from "../";
import type {
  UIMessage as ChatMessage,
  StreamTextOnFinishCallback,
  ToolSet
} from "ai";
import { getCurrentAgent, routeAgentRequest } from "agents";
import { MessageType, type OutgoingMessage } from "../types";
import type { ClientToolSchema } from "../";

// Type helper for tool call parts - extracts from ChatMessage parts
type TestToolCallPart = Extract<
  ChatMessage["parts"][number],
  { type: `tool-${string}` }
>;

export type Env = {
  TestChatAgent: DurableObjectNamespace<TestChatAgent>;
  AgentWithSuperCall: DurableObjectNamespace<AgentWithSuperCall>;
  AgentWithoutSuperCall: DurableObjectNamespace<AgentWithoutSuperCall>;
  SlowStreamAgent: DurableObjectNamespace<SlowStreamAgent>;
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
  // Store captured body from onChatMessage options for testing
  private _capturedBody: Record<string, unknown> | undefined = undefined;
  // Store captured clientTools from onChatMessage options for testing
  private _capturedClientTools: ClientToolSchema[] | undefined = undefined;
  // Store captured requestId from onChatMessage options for testing
  private _capturedRequestId: string | undefined = undefined;

  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    // Capture the body, clientTools, and requestId from options for testing
    this._capturedBody = options?.body;
    this._capturedClientTools = options?.clientTools;
    this._capturedRequestId = options?.requestId;

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

  getCapturedContext(): {
    hasAgent: boolean;
    hasConnection: boolean;
    connectionId: string | undefined;
  } | null {
    return this._capturedContext;
  }

  getNestedContext(): {
    hasAgent: boolean;
    hasConnection: boolean;
    connectionId: string | undefined;
  } | null {
    return this._nestedContext;
  }

  clearCapturedContext(): void {
    this._capturedContext = null;
    this._nestedContext = null;
    this._capturedBody = undefined;
    this._capturedClientTools = undefined;
    this._capturedRequestId = undefined;
  }

  getCapturedBody(): Record<string, unknown> | undefined {
    return this._capturedBody;
  }

  getCapturedClientTools(): ClientToolSchema[] | undefined {
    return this._capturedClientTools;
  }

  getCapturedRequestId(): string | undefined {
    return this._capturedRequestId;
  }

  getPersistedMessages(): ChatMessage[] {
    const rawMessages = (
      this.sql`select * from cf_ai_chat_agent_messages order by created_at` ||
      []
    ).map((row) => {
      return JSON.parse(row.message as string);
    });
    return rawMessages;
  }

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

  testStartStream(requestId: string): string {
    return this._startStream(requestId);
  }

  testStoreStreamChunk(streamId: string, body: string): void {
    this._storeStreamChunk(streamId, body);
  }

  testBroadcastLiveChunk(
    requestId: string,
    streamId: string,
    body: string
  ): void {
    this._storeStreamChunk(streamId, body);
    const message: OutgoingMessage = {
      body,
      done: false,
      id: requestId,
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
    };
    (
      this as unknown as {
        _broadcastChatMessage: (
          msg: OutgoingMessage,
          exclude?: string[]
        ) => void;
      }
    )._broadcastChatMessage(message);
  }

  testFlushChunkBuffer(): void {
    this._flushChunkBuffer();
  }

  testCompleteStream(streamId: string): void {
    this._completeStream(streamId);
  }

  testMarkStreamError(streamId: string): void {
    this._markStreamError(streamId);
  }

  getActiveStreamId(): string | null {
    return this._activeStreamId;
  }

  getActiveRequestId(): string | null {
    return this._activeRequestId;
  }

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

  getStreamMetadata(
    streamId: string
  ): { status: string; request_id: string } | null {
    const result = this.sql<{ status: string; request_id: string }>`
      select status, request_id from cf_ai_chat_stream_metadata 
      where id = ${streamId}
    `;
    return result && result.length > 0 ? result[0] : null;
  }

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

  testInsertOldErroredStream(
    streamId: string,
    requestId: string,
    ageMs: number
  ): void {
    const createdAt = Date.now() - ageMs;
    const completedAt = createdAt + 1000;
    this.sql`
      insert into cf_ai_chat_stream_metadata (id, request_id, status, created_at, completed_at)
      values (${streamId}, ${requestId}, 'error', ${createdAt}, ${completedAt})
    `;
  }

  testRestoreActiveStream(): void {
    this._restoreActiveStream();
  }

  testTriggerStreamCleanup(): void {
    // Force the cleanup interval to 0 so the next completeStream triggers it
    // We do this by starting and immediately completing a dummy stream
    const dummyId = this._startStream("cleanup-trigger");
    this._completeStream(dummyId);
  }

  /**
   * Insert a raw JSON string as a message directly into SQLite.
   * Used to test validation of malformed/corrupt messages.
   */
  insertRawMessage(rowId: string, rawJson: string): void {
    this.sql`
      insert into cf_ai_chat_agent_messages (id, message)
      values (${rowId}, ${rawJson})
    `;
  }

  setMaxPersistedMessages(max: number | null): void {
    this.maxPersistedMessages = max ?? undefined;
  }

  getMessageCount(): number {
    const result = this.sql<{ cnt: number }>`
      select count(*) as cnt from cf_ai_chat_agent_messages
    `;
    return result?.[0]?.cnt ?? 0;
  }

  /**
   * Returns the number of active abort controllers.
   * Used to verify that cleanup happens after stream completion.
   * If controllers leak, this count grows with each request.
   */
  getAbortControllerCount(): number {
    return (
      this as unknown as {
        _chatMessageAbortControllers: Map<string, unknown>;
      }
    )._chatMessageAbortControllers.size;
  }
}

/**
 * Test agent that streams chunks slowly, useful for testing cancel/abort.
 *
 * Control via request body fields:
 * - `format`: "sse" | "plaintext" (default: "plaintext")
 * - `useAbortSignal`: boolean — whether to connect abortSignal to the stream
 * - `chunkCount`: number of chunks to emit (default: 20)
 * - `chunkDelayMs`: delay between chunks in ms (default: 50)
 */
export class SlowStreamAgent extends AIChatAgent<Env> {
  observability = undefined;

  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    const body = options?.body as
      | {
          format?: string;
          useAbortSignal?: boolean;
          chunkCount?: number;
          chunkDelayMs?: number;
        }
      | undefined;
    const format = body?.format ?? "plaintext";
    const useAbortSignal = body?.useAbortSignal ?? false;
    const chunkCount = body?.chunkCount ?? 20;
    const chunkDelayMs = body?.chunkDelayMs ?? 50;
    const abortSignal = useAbortSignal ? options?.abortSignal : undefined;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async pull(controller) {
        for (let i = 0; i < chunkCount; i++) {
          if (abortSignal?.aborted) {
            controller.close();
            return;
          }
          await new Promise((r) => setTimeout(r, chunkDelayMs));
          if (abortSignal?.aborted) {
            controller.close();
            return;
          }
          if (format === "sse") {
            const chunk = JSON.stringify({
              type: "text-delta",
              textDelta: `chunk-${i} `
            });
            controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
          } else {
            controller.enqueue(encoder.encode(`chunk-${i} `));
          }
        }
        if (format === "sse") {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        controller.close();
      }
    });

    const contentType = format === "sse" ? "text/event-stream" : "text/plain";
    return new Response(stream, {
      headers: { "Content-Type": contentType }
    });
  }

  getAbortControllerCount(): number {
    return (
      this as unknown as {
        _chatMessageAbortControllers: Map<string, unknown>;
      }
    )._chatMessageAbortControllers.size;
  }
}

// Test agent that overrides onRequest and calls super.onRequest()
export class AgentWithSuperCall extends AIChatAgent<Env> {
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/custom-route")) {
      return new Response("custom route");
    }
    return super.onRequest(request);
  }

  async onChatMessage() {
    return new Response("chat response");
  }
}

// Test agent that overrides onRequest WITHOUT calling super.onRequest()
export class AgentWithoutSuperCall extends AIChatAgent<Env> {
  async onRequest(_request: Request): Promise<Response> {
    return new Response("custom only");
  }

  async onChatMessage() {
    return new Response("chat response");
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
