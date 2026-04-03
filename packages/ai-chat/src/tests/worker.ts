import {
  AIChatAgent,
  type ChatResponseResult,
  type OnChatMessageOptions,
  type SaveMessagesResult
} from "../";
import type {
  UIMessage as ChatMessage,
  StreamTextOnFinishCallback,
  ToolSet
} from "ai";
import { getCurrentAgent, routeAgentRequest } from "agents";
import { MessageType, type OutgoingMessage } from "../types";
import type { ClientToolSchema } from "../";
import { ResumableStream } from "agents/chat";
import {
  withDurableChat,
  type ChatRecoveryContext,
  type ChatRecoveryOptions
} from "../experimental/forever";

// Type helper for tool call parts - extracts from ChatMessage parts
type TestToolCallPart = Extract<
  ChatMessage["parts"][number],
  { type: `tool-${string}` }
>;

function makeSSEChunkResponse(chunks: ReadonlyArray<Record<string, unknown>>) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" }
  });
}

export type Env = {
  TestChatAgent: DurableObjectNamespace<TestChatAgent>;
  CustomSanitizeAgent: DurableObjectNamespace<CustomSanitizeAgent>;
  AgentWithSuperCall: DurableObjectNamespace<AgentWithSuperCall>;
  AgentWithoutSuperCall: DurableObjectNamespace<AgentWithoutSuperCall>;
  SlowStreamAgent: DurableObjectNamespace<SlowStreamAgent>;
  ResponseAgent: DurableObjectNamespace<ResponseAgent>;
  ResponseContinuationAgent: DurableObjectNamespace<ResponseContinuationAgent>;
  ResponseThrowingAgent: DurableObjectNamespace<ResponseThrowingAgent>;
  ResponseSaveMessagesAgent: DurableObjectNamespace<ResponseSaveMessagesAgent>;
  LatestMessageConcurrencyAgent: DurableObjectNamespace<LatestMessageConcurrencyAgent>;
  MergeMessageConcurrencyAgent: DurableObjectNamespace<MergeMessageConcurrencyAgent>;
  DropMessageConcurrencyAgent: DurableObjectNamespace<DropMessageConcurrencyAgent>;
  DebounceMessageConcurrencyAgent: DurableObjectNamespace<DebounceMessageConcurrencyAgent>;
  InvalidDebounceMessageConcurrencyAgent: DurableObjectNamespace<InvalidDebounceMessageConcurrencyAgent>;
  MissingDebounceMessageConcurrencyAgent: DurableObjectNamespace<MissingDebounceMessageConcurrencyAgent>;
  WaitMcpTrueAgent: DurableObjectNamespace<WaitMcpTrueAgent>;
  WaitMcpTimeoutAgent: DurableObjectNamespace<WaitMcpTimeoutAgent>;
  WaitMcpFalseAgent: DurableObjectNamespace<WaitMcpFalseAgent>;
  DurableChatTestAgent: DurableObjectNamespace<DurableChatTestAgent>;
};

export class TestChatAgent extends AIChatAgent<Env> {
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

    const delayMs =
      typeof options?.body?.delayMs === "number" ? options.body.delayMs : 0;

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const chainedContinuationResponse =
      this._getChainedContinuationRegressionResponse();
    if (chainedContinuationResponse) {
      return chainedContinuationResponse;
    }

    const lastAssistant = [...this.messages]
      .reverse()
      .find((message) => message.role === "assistant");

    if (
      options?.body?.emptyContinuationResponse === true &&
      lastAssistant?.parts.some(
        (part) =>
          part.type.startsWith("tool-") &&
          "state" in part &&
          part.state === "output-available"
      )
    ) {
      return new Response(null);
    }

    if (options?.body?.sseWithMessageId === true) {
      return makeSSEChunkResponse([
        { type: "start", messageId: `fresh-msg-${Date.now()}` },
        { type: "text-start", id: "sse-t" },
        { type: "text-delta", id: "sse-t", delta: "SSE reply" },
        { type: "text-end", id: "sse-t" },
        { type: "finish" }
      ]);
    }

    // Simple echo response for testing
    return new Response("Hello from chat agent!", {
      headers: { "Content-Type": "text/plain" }
    });
  }

  private _getChainedContinuationRegressionResponse(): Response | undefined {
    const lastAssistant = [...this.messages]
      .reverse()
      .find((message) => message.role === "assistant");

    if (!lastAssistant) {
      return undefined;
    }

    const readWorkflowPart = this._findToolPart(
      lastAssistant,
      "call_read_workflow_regression"
    );
    const editWorkflowPart = this._findToolPart(
      lastAssistant,
      "call_edit_workflow_regression"
    );

    if (
      readWorkflowPart?.state === "output-available" &&
      editWorkflowPart === undefined
    ) {
      return makeSSEChunkResponse([
        { type: "start-step" },
        { type: "text-start", id: "txt-approval-step" },
        {
          type: "text-delta",
          id: "txt-approval-step",
          delta: "Reviewing workflow edits now."
        },
        { type: "text-end", id: "txt-approval-step" },
        {
          type: "tool-input-available",
          toolCallId: "call_edit_workflow_regression",
          toolName: "editWorkflow",
          input: { patch: "set retries=3" }
        },
        {
          type: "tool-approval-request",
          toolCallId: "call_edit_workflow_regression",
          approvalId: "approval_edit_workflow_regression"
        }
      ]);
    }

    if (editWorkflowPart?.state === "approval-responded") {
      return makeSSEChunkResponse([
        { type: "start-step" },
        {
          type: "tool-output-available",
          toolCallId: "call_edit_workflow_regression",
          output: { applied: true }
        },
        { type: "text-start", id: "txt-final-step" },
        {
          type: "text-delta",
          id: "txt-final-step",
          delta: "Workflow edit approved and applied."
        },
        { type: "text-end", id: "txt-final-step" }
      ]);
    }

    return undefined;
  }

  private _findToolPart(
    message: ChatMessage,
    toolCallId: string
  ): TestToolCallPart | undefined {
    return message.parts.find(
      (part): part is TestToolCallPart =>
        "toolCallId" in part && part.toolCallId === toolCallId
    );
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

  hasPendingInteractionForTest(): boolean {
    return this.hasPendingInteraction();
  }

  waitUntilStableForTest(options?: { timeout?: number }): Promise<boolean> {
    return this.waitUntilStable(options);
  }

  resetTurnStateForTest(): void {
    this.resetTurnState();
  }

  isChatTurnActiveForTest(): boolean {
    return (
      this as unknown as { isChatTurnActive(): boolean }
    ).isChatTurnActive();
  }

  async waitForIdleForTest(): Promise<void> {
    await (this as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
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

  async testPersistApprovalRequest(messageId: string, toolName: string) {
    const toolApprovalPart: TestToolCallPart = {
      type: `tool-${toolName}`,
      toolCallId: `call_${messageId}`,
      state: "approval-requested",
      input: { location: "London" },
      approval: { id: `approval_${messageId}` }
    };

    const messageWithApprovalRequest: ChatMessage = {
      id: messageId,
      role: "assistant",
      parts: [toolApprovalPart] as ChatMessage["parts"]
    };
    await this.persistMessages([messageWithApprovalRequest]);
    return messageWithApprovalRequest;
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
   * Simulate DO hibernation wake by reinitializing the ResumableStream.
   * The new instance calls restore() which reads from SQLite and sets
   * _activeStreamId, but _isLive remains false (no live LLM reader).
   * This mimics the DO constructor running after eviction.
   */
  testSimulateHibernationWake(): void {
    this._resumableStream = new ResumableStream(this.sql.bind(this));
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
 * Test agent that overrides sanitizeMessageForPersistence to strip custom data.
 * Used to verify the user-overridable hook runs after built-in sanitization.
 */
export class CustomSanitizeAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    return new Response("ok");
  }

  protected sanitizeMessageForPersistence(message: ChatMessage): ChatMessage {
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (
          "output" in part &&
          part.output != null &&
          typeof part.output === "object" &&
          "content" in (part.output as Record<string, unknown>)
        ) {
          return {
            ...part,
            output: {
              ...(part.output as Record<string, unknown>),
              content: "[custom-redacted]"
            }
          };
        }
        return part;
      }) as ChatMessage["parts"]
    };
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
}

/**
 * Test agent that streams chunks slowly, useful for testing cancel/abort.
 *
 * Control via request body fields:
 * - `format`: "sse" | "plaintext" (default: "plaintext")
 * - `useAbortSignal`: boolean — whether to connect abortSignal to the stream
 * - `responseDelayMs`: delay before returning the response (default: 0)
 * - `chunkCount`: number of chunks to emit (default: 20)
 * - `chunkDelayMs`: delay between chunks in ms (default: 50)
 */
export class SlowStreamAgent extends AIChatAgent<Env> {
  private _startedRequestIds: string[] = [];
  private _requestStartTimes = new Map<string, number>();
  private _chatResponseResults: ChatResponseResult[] = [];

  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    if (options?.requestId) {
      this._startedRequestIds.push(options.requestId);
      this._requestStartTimes.set(options.requestId, Date.now());
    }

    const body = options?.body as
      | {
          format?: string;
          useAbortSignal?: boolean;
          responseDelayMs?: number;
          chunkCount?: number;
          chunkDelayMs?: number;
        }
      | undefined;
    const format = body?.format ?? "plaintext";
    const useAbortSignal = body?.useAbortSignal ?? false;
    const responseDelayMs = body?.responseDelayMs ?? 0;
    const chunkCount = body?.chunkCount ?? 20;
    const chunkDelayMs = body?.chunkDelayMs ?? 50;
    const abortSignal = useAbortSignal ? options?.abortSignal : undefined;

    if (responseDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
    }

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

  getStartedRequestIds(): string[] {
    return [...this._startedRequestIds];
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

  getRequestStartTime(requestId: string): number | null {
    return this._requestStartTimes.get(requestId) ?? null;
  }

  isChatTurnActiveForTest(): boolean {
    return (
      this as unknown as { isChatTurnActive(): boolean }
    ).isChatTurnActive();
  }

  async waitForIdleForTest(): Promise<boolean> {
    await (this as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
    return true;
  }

  waitUntilStableForTest(options?: { timeout?: number }): Promise<boolean> {
    return this.waitUntilStable(options);
  }

  abortActiveTurnForTest(): boolean {
    return (
      this as unknown as { abortActiveTurn(): boolean }
    ).abortActiveTurn();
  }

  resetTurnStateForTest(): void {
    this.resetTurnState();
  }

  async saveSyntheticUserMessage(text: string): Promise<void> {
    const message: ChatMessage = {
      id: `saved-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text }]
    };

    await this.saveMessages([...this.messages, message]);
  }

  setTestBody(body: Record<string, unknown>): void {
    (this as unknown as { _lastBody: Record<string, unknown> })._lastBody =
      body;
  }

  async enqueueSyntheticUserMessage(
    text: string,
    options?: {
      body?: Record<string, unknown>;
    }
  ): Promise<SaveMessagesResult> {
    if (options?.body) {
      this.setTestBody(options.body);
    }
    return this.saveMessages((messages) => [
      ...messages,
      {
        id: `enqueued-${crypto.randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text }]
      }
    ]);
  }

  async enqueueSyntheticUserMessagesInOrder(
    messages: Array<{
      text: string;
      body?: Record<string, unknown>;
    }>
  ): Promise<SaveMessagesResult[]> {
    return Promise.all(
      messages.map((message) =>
        this.enqueueSyntheticUserMessage(message.text, {
          body: message.body
        })
      )
    );
  }

  getPersistedUserTexts(): string[] {
    return this.getPersistedMessages()
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "text" ? [part.text] : []
        )
      );
  }

  protected async onChatResponse(result: ChatResponseResult) {
    this._chatResponseResults.push(result);
  }

  getChatResponseResults(): ChatResponseResult[] {
    return [...this._chatResponseResults];
  }

  async persistToolCallMessage(
    messageId: string,
    toolCallId: string,
    toolName: string
  ): Promise<void> {
    await this.persistMessages([
      ...this.messages,
      {
        id: messageId,
        role: "assistant",
        parts: [
          {
            type: `tool-${toolName}`,
            toolCallId,
            state: "input-available",
            input: { test: true }
          }
        ]
      } as ChatMessage
    ]);
  }

  getMessageCount(): number {
    const result = this.sql<{ cnt: number }>`
      select count(*) as cnt from cf_ai_chat_agent_messages
    `;
    return result?.[0]?.cnt ?? 0;
  }
}

/**
 * Test agent that records onChatResponse calls for verification.
 * Uses slow streaming so tests can cancel/abort mid-stream.
 */
export class ResponseAgent extends AIChatAgent<Env> {
  private _responseResults: ChatResponseResult[] = [];

  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    const body = options?.body as
      | {
          format?: string;
          chunkCount?: number;
          chunkDelayMs?: number;
          throwError?: boolean;
          useAbortSignal?: boolean;
        }
      | undefined;

    const format = body?.format ?? "plaintext";
    const chunkCount = body?.chunkCount ?? 3;
    const chunkDelayMs = body?.chunkDelayMs ?? 10;
    const throwError = body?.throwError ?? false;
    const useAbortSignal = body?.useAbortSignal ?? false;
    const abortSignal = useAbortSignal ? options?.abortSignal : undefined;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async pull(controller) {
        for (let i = 0; i < chunkCount; i++) {
          if (abortSignal?.aborted) {
            controller.close();
            return;
          }
          if (chunkDelayMs > 0) {
            await new Promise((r) => setTimeout(r, chunkDelayMs));
          }
          if (abortSignal?.aborted) {
            controller.close();
            return;
          }

          if (throwError && i === Math.floor(chunkCount / 2)) {
            throw new Error("Simulated stream error");
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

  protected async onChatResponse(result: ChatResponseResult) {
    this._responseResults.push(result);
  }

  getChatResponseResults(): ChatResponseResult[] {
    return [...this._responseResults];
  }

  clearChatResponseResults(): void {
    this._responseResults = [];
  }

  async saveSyntheticUserMessage(text: string): Promise<void> {
    const message: ChatMessage = {
      id: `saved-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text }]
    };
    await this.saveMessages([...this.messages, message]);
  }

  async waitForIdleForTest(): Promise<void> {
    await (this as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
  }

  getPersistedMessages(): ChatMessage[] {
    return (
      this.sql`select * from cf_ai_chat_agent_messages order by created_at` ||
      []
    ).map((row) => JSON.parse(row.message as string));
  }
}

/**
 * Test agent that records onChatResponse and supports tool continuation.
 * Used to verify onChatResponse fires with continuation=true after auto-continue.
 */
export class ResponseContinuationAgent extends AIChatAgent<Env> {
  private _responseResults: ChatResponseResult[] = [];

  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
    _options?: OnChatMessageOptions
  ) {
    return new Response("Continuation response", {
      headers: { "Content-Type": "text/plain" }
    });
  }

  protected async onChatResponse(result: ChatResponseResult) {
    this._responseResults.push(result);
  }

  getChatResponseResults(): ChatResponseResult[] {
    return [...this._responseResults];
  }

  getPersistedMessages(): ChatMessage[] {
    return (
      this.sql`select * from cf_ai_chat_agent_messages order by created_at` ||
      []
    ).map((row) => JSON.parse(row.message as string));
  }
}

/**
 * Test agent whose onChatResponse throws — verifies the framework handles it
 * gracefully without breaking the stream or masking the original error.
 */
export class ResponseThrowingAgent extends AIChatAgent<Env> {
  private _streamCompleted = false;

  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    const throwError = (options?.body as { throwError?: boolean } | undefined)
      ?.throwError;

    if (throwError) {
      const stream = new ReadableStream({
        pull() {
          throw new Error("Stream-level error");
        }
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/plain" }
      });
    }

    return new Response("Success response", {
      headers: { "Content-Type": "text/plain" }
    });
  }

  protected async onChatResponse(_result: ChatResponseResult) {
    this._streamCompleted = true;
    throw new Error("onChatResponse hook crashed");
  }

  getStreamCompleted(): boolean {
    return this._streamCompleted;
  }

  getPersistedMessages(): ChatMessage[] {
    return (
      this.sql`select * from cf_ai_chat_agent_messages order by created_at` ||
      []
    ).map((row) => JSON.parse(row.message as string));
  }
}

/**
 * Test agent that calls saveMessages from inside onChatResponse.
 * Uses a queue of messages to process sequentially — each onChatResponse
 * picks the next item and calls saveMessages, relying on the framework's
 * drain loop to fire onChatResponse again for the inner turn's result.
 */
export class ResponseSaveMessagesAgent extends AIChatAgent<Env> {
  private _responseResults: ChatResponseResult[] = [];
  private _messageQueue: string[] = [];

  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
    _options?: OnChatMessageOptions
  ) {
    return new Response("Agent reply", {
      headers: { "Content-Type": "text/plain" }
    });
  }

  protected async onChatResponse(result: ChatResponseResult) {
    this._responseResults.push(result);

    if (this._messageQueue.length > 0) {
      const text = this._messageQueue.shift()!;
      const followUp: ChatMessage = {
        id: `followup-${crypto.randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text }]
      };
      await this.saveMessages([...this.messages, followUp]);
    }
  }

  enqueueMessages(messages: string[]): void {
    this._messageQueue.push(...messages);
  }

  getChatResponseResults(): ChatResponseResult[] {
    return [...this._responseResults];
  }

  async waitForIdleForTest(): Promise<void> {
    await (this as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
  }

  getPersistedMessages(): ChatMessage[] {
    return (
      this.sql`select * from cf_ai_chat_agent_messages order by created_at` ||
      []
    ).map((row) => JSON.parse(row.message as string));
  }
}

export class LatestMessageConcurrencyAgent extends SlowStreamAgent {
  messageConcurrency = "latest" as const;
}

export class MergeMessageConcurrencyAgent extends SlowStreamAgent {
  messageConcurrency = "merge" as const;
}

export class DropMessageConcurrencyAgent extends SlowStreamAgent {
  messageConcurrency = "drop" as const;
}

export class DebounceMessageConcurrencyAgent extends SlowStreamAgent {
  messageConcurrency = {
    strategy: "debounce",
    debounceMs: 80
  } as const;
}

export class InvalidDebounceMessageConcurrencyAgent extends SlowStreamAgent {
  messageConcurrency = {
    strategy: "debounce",
    debounceMs: Number.NaN
  } as const;
}

export class MissingDebounceMessageConcurrencyAgent extends SlowStreamAgent {
  messageConcurrency = {
    strategy: "debounce"
  } as const;
}

// Test agents for waitForMcpConnections config
export class WaitMcpTrueAgent extends AIChatAgent<Env> {
  waitForMcpConnections = true as const;

  async onChatMessage() {
    const tools = this.mcp.getAITools();
    return new Response(
      JSON.stringify({ toolCount: Object.keys(tools).length }),
      { headers: { "Content-Type": "text/plain" } }
    );
  }
}

export class WaitMcpTimeoutAgent extends AIChatAgent<Env> {
  waitForMcpConnections = { timeout: 1000 };

  async onChatMessage() {
    const tools = this.mcp.getAITools();
    return new Response(
      JSON.stringify({ toolCount: Object.keys(tools).length }),
      { headers: { "Content-Type": "text/plain" } }
    );
  }
}

export class WaitMcpFalseAgent extends AIChatAgent<Env> {
  waitForMcpConnections = false as const;

  async onChatMessage() {
    const tools = this.mcp.getAITools();
    return new Response(
      JSON.stringify({ toolCount: Object.keys(tools).length }),
      { headers: { "Content-Type": "text/plain" } }
    );
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

// ── DurableChatTestAgent (withDurableChat mixin) ─────────────────────

const DurableChatBase = withDurableChat(AIChatAgent);

export class DurableChatTestAgent extends DurableChatBase<Env> {
  recoveryContexts: ChatRecoveryContext[] = [];
  recoveryOverride: ChatRecoveryOptions | null = null;
  onChatMessageCallCount = 0;

  async onChatMessage() {
    this.onChatMessageCallCount++;
    return makeSSEChunkResponse([
      { type: "text-start" },
      { type: "text-delta", delta: "Continued response." },
      { type: "text-end" },
      { type: "finish" }
    ]);
  }

  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    this.recoveryContexts.push(ctx);
    if (this.recoveryOverride) return this.recoveryOverride;
    return {};
  }

  getRecoveryContexts(): ChatRecoveryContext[] {
    return this.recoveryContexts;
  }

  setRecoveryOverride(options: ChatRecoveryOptions): void {
    this.recoveryOverride = options;
  }

  getPersistedMessages(): ChatMessage[] {
    return (
      this.sql`select * from cf_ai_chat_agent_messages order by created_at` ||
      []
    ).map((row) => JSON.parse(row.message as string));
  }

  getPartialText(streamId?: string) {
    return this.getPartialStreamText(streamId);
  }

  async callContinueLastTurn(
    body?: Record<string, unknown>
  ): Promise<{ requestId: string; status: string }> {
    return this.continueLastTurn(body);
  }

  getOnChatMessageCallCount(): number {
    return this.onChatMessageCallCount;
  }

  async waitForIdleForTest(): Promise<void> {
    await (this as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
  }

  async triggerInterruptedStreamCheck(): Promise<void> {
    await this.checkInterruptedStream();
  }

  insertInterruptedStream(
    streamId: string,
    requestId: string,
    chunks: Array<{ body: string; index: number }>,
    ageMs = 0
  ): void {
    const createdAt = Date.now() - ageMs;
    this.sql`
      insert into cf_ai_chat_stream_metadata (id, request_id, status, created_at)
      values (${streamId}, ${requestId}, 'streaming', ${createdAt})
    `;
    for (const chunk of chunks) {
      const id = `chunk-${streamId}-${chunk.index}`;
      this.sql`
        insert into cf_ai_chat_stream_chunks (id, stream_id, body, chunk_index, created_at)
        values (${id}, ${streamId}, ${chunk.body}, ${chunk.index}, ${createdAt})
      `;
    }
    this._resumableStream.restore();
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
