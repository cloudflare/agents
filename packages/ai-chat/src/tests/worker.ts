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
import { Agent, getCurrentAgent, routeAgentRequest } from "agents";
import { MessageType, type OutgoingMessage } from "../types";
import type {
  AgentToolEventMessage,
  AgentToolLifecycleResult,
  AgentToolRunInfo,
  AgentToolRunInspection,
  AgentToolStoredChunk,
  RunAgentToolResult
} from "agents";
import type {
  ClientToolSchema,
  ChatRecoveryContext,
  ChatRecoveryOptions
} from "../";
import { ResumableStream } from "agents/chat";

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
  ChatRecoveryTestAgent: DurableObjectNamespace<ChatRecoveryTestAgent>;
  NonChatRecoveryTestAgent: DurableObjectNamespace<NonChatRecoveryTestAgent>;
  RecoveryThrowingAgent: DurableObjectNamespace<RecoveryThrowingAgent>;
  RecoverySlowStreamAgent: DurableObjectNamespace<RecoverySlowStreamAgent>;
  AIChatAgentToolParent: DurableObjectNamespace<AIChatAgentToolParent>;
  AIChatAgentToolChild: DurableObjectNamespace<AIChatAgentToolChild>;
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

    if (
      options?.continuation === true &&
      options.body?.reasoningContinuation === true
    ) {
      const chunks = [
        { type: "start" },
        { type: "reasoning-start", id: "reasoning_issue_1480" },
        {
          type: "reasoning-delta",
          id: "reasoning_issue_1480",
          delta: "continuation reasoning"
        },
        { type: "reasoning-end", id: "reasoning_issue_1480" },
        { type: "text-start", id: "text_issue_1480" },
        {
          type: "text-delta",
          id: "text_issue_1480",
          delta: "continuation answer"
        },
        { type: "text-end", id: "text_issue_1480" },
        { type: "finish" }
      ];

      if (options.body.delayContinuationChunks === true) {
        return makeDelayedSSEChunkResponse(chunks, 100);
      }

      return makeSSEChunkResponse(chunks);
    }

    // Issue #1404: simulate the OpenAI Responses API "provider replay"
    // pattern. When asked to continue after a tool result, some providers
    // re-emit the prior tool call (start + delta + available) plus the
    // result that was just supplied. Without the issue #1404 fix this
    // would visibly regress the AI SDK's tool part state on the client.
    if (
      options?.body?.replayPriorToolCall === true &&
      lastAssistant?.parts.some(
        (part) =>
          "toolCallId" in part &&
          part.toolCallId === options.body?.replayToolCallId &&
          "state" in part &&
          part.state === "output-available"
      )
    ) {
      const toolCallId = options.body.replayToolCallId as string;
      const toolName = options.body.replayToolName as string;
      const replayInput = options.body.replayInput;
      const replayOutput = options.body.replayOutput;
      return makeSSEChunkResponse([
        { type: "start" },
        { type: "start-step" },
        { type: "tool-input-start", toolCallId, toolName },
        { type: "tool-input-delta", toolCallId, input: {} },
        {
          type: "tool-input-available",
          toolCallId,
          toolName,
          input: replayInput
        },
        { type: "tool-output-available", toolCallId, output: replayOutput },
        { type: "finish-step" },
        { type: "finish", finishReason: "tool-calls" }
      ]);
    }

    // Simple echo response for testing
    return new Response("Hello from chat agent!", {
      headers: { "Content-Type": "text/plain" }
    });
  }

  // Test helper: directly invoke the protected _applyToolResult so tests
  // can exercise the idempotency branch without scheduling an
  // auto-continuation (issue #1404).
  async testApplyToolResult(
    toolCallId: string,
    toolName: string,
    output: unknown,
    overrideState?: "output-error",
    errorText?: string
  ): Promise<boolean> {
    return (
      this as unknown as {
        _applyToolResult(
          toolCallId: string,
          toolName: string,
          output: unknown,
          overrideState?: "output-error",
          errorText?: string
        ): Promise<boolean>;
      }
    )._applyToolResult(toolCallId, toolName, output, overrideState, errorText);
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
        _abortRegistry: { size: number };
      }
    )._abortRegistry.size;
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
        _abortRegistry: { size: number };
      }
    )._abortRegistry.size;
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

  /**
   * Number of *overlapping* submits the agent has observed past
   * `_getSubmitConcurrencyDecision` — i.e. submits that arrived while a
   * turn was already queued or in-flight under `latest` / `merge` /
   * `debounce` concurrency policies. The very first submit on an empty
   * queue is NOT counted (it isn't overlapping with anything), nor are
   * submits under `queue` / `drop` policies or `regenerate-message`
   * triggers.
   *
   * Used as a deterministic barrier in concurrency tests to wait for the
   * agent to have registered every overlapping submit before asserting
   * on which turns ran — otherwise assertions race the DO's
   * webSocketMessage dispatch under CPU pressure and can observe
   * intermediate state where the most recent submit hasn't yet bumped
   * `_latestOverlappingSubmitSequence`.
   *
   * Returns `_latestOverlappingSubmitSequence`, which equals the total
   * count of overlapping submits observed so far.
   */
  getOverlappingSubmitCountForTest(): number {
    return (
      this as unknown as {
        _submitConcurrency: { overlappingSubmitCount: number };
      }
    )._submitConcurrency.overlappingSubmitCount;
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

  // ── External AbortSignal seams (issue #1406) ─────────────────────
  //
  // AbortSignal can't cross the DurableObject RPC boundary, so each
  // scenario is constructed inside the DO and surfaces just the
  // resulting `SaveMessagesResult` to the test runner.

  async testSaveMessagesWithSignal(
    text: string,
    options: {
      preAbort?: boolean;
      abortAfterMs?: number;
      abortAfterCompletion?: boolean;
      body?: Record<string, unknown>;
    }
  ): Promise<SaveMessagesResult> {
    if (options.body) this.setTestBody(options.body);
    const controller = new AbortController();
    if (options.preAbort) {
      controller.abort(new Error("pre-aborted"));
    } else if (
      typeof options.abortAfterMs === "number" &&
      !options.abortAfterCompletion
    ) {
      const ms = options.abortAfterMs;
      setTimeout(() => controller.abort(new Error("mid-stream abort")), ms);
    }

    const result = await this.saveMessages(
      [
        ...this.messages,
        {
          id: `signal-${crypto.randomUUID()}`,
          role: "user",
          parts: [{ type: "text", text }]
        }
      ],
      { signal: controller.signal }
    );

    if (options.abortAfterCompletion) {
      controller.abort(new Error("post-completion abort"));
    }
    return result;
  }

  async testContinueLastTurnWithSignal(options: {
    preAbort?: boolean;
    abortAfterMs?: number;
    body?: Record<string, unknown>;
  }): Promise<SaveMessagesResult> {
    const controller = new AbortController();
    if (options.preAbort) {
      controller.abort(new Error("pre-aborted"));
    } else if (typeof options.abortAfterMs === "number") {
      const ms = options.abortAfterMs;
      setTimeout(() => controller.abort(new Error("mid-stream abort")), ms);
    }

    return (
      this as unknown as {
        continueLastTurn(
          body?: Record<string, unknown>,
          options?: { signal?: AbortSignal }
        ): Promise<SaveMessagesResult>;
      }
    ).continueLastTurn(options.body, { signal: controller.signal });
  }

  async testSaveMessagesCancelledByAbortAllRequests(
    text: string,
    cancelAfterMs: number,
    body?: Record<string, unknown>
  ): Promise<SaveMessagesResult> {
    if (body) this.setTestBody(body);
    setTimeout(() => {
      (this as unknown as { abortAllRequests(): void }).abortAllRequests();
    }, cancelAfterMs);

    return this.saveMessages([
      ...this.messages,
      {
        id: `public-abort-${crypto.randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text }]
      }
    ]);
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

// ── ChatRecoveryTestAgent (chat recovery) ─────────────────────────────

export class ChatRecoveryTestAgent extends AIChatAgent<Env> {
  override chatRecovery = true;
  recoveryContexts: ChatRecoveryContext[] = [];
  recoveryOverride: ChatRecoveryOptions | null = null;
  onChatMessageCallCount = 0;
  includeReasoningInResponse = false;
  private _stashData: unknown = null;
  private _stashResult: { success: boolean; error?: string } | null = null;

  async onChatMessage() {
    this.onChatMessageCallCount++;

    if (this._stashData !== null) {
      try {
        this.stash(this._stashData);
        this._stashResult = { success: true };
      } catch (e) {
        this._stashResult = {
          success: false,
          error: e instanceof Error ? e.message : String(e)
        };
      }
    }

    const chunks: Array<Record<string, unknown>> = [];
    if (this.includeReasoningInResponse) {
      chunks.push(
        { type: "reasoning-start" },
        { type: "reasoning-delta", delta: "Thinking about continuation." },
        { type: "reasoning-end" }
      );
    }
    chunks.push(
      { type: "text-start" },
      { type: "text-delta", delta: "Continued response." },
      { type: "text-end" },
      { type: "finish" }
    );
    return makeSSEChunkResponse(chunks);
  }

  setStashData(data: unknown): void {
    this._stashData = data;
  }

  getStashResult(): { success: boolean; error?: string } | null {
    return this._stashResult;
  }

  setIncludeReasoning(value: boolean): void {
    this.includeReasoningInResponse = value;
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
    const id = streamId ?? this._resumableStream.activeStreamId ?? undefined;
    if (!id) return { text: "", parts: [] };
    return (
      this as unknown as {
        _getPartialStreamText(id: string): {
          text: string;
          parts: unknown[];
        };
      }
    )._getPartialStreamText(id);
  }

  async callContinueLastTurn(
    body?: Record<string, unknown>
  ): Promise<{ requestId: string; status: string }> {
    return this.continueLastTurn(body);
  }

  async saveSyntheticUserMessage(
    text: string
  ): Promise<{ requestId: string; status: string }> {
    return this.saveMessages((messages) => [
      ...messages,
      {
        id: `synth-${crypto.randomUUID()}`,
        role: "user" as const,
        parts: [{ type: "text" as const, text }]
      }
    ]);
  }

  getOnChatMessageCallCount(): number {
    return this.onChatMessageCallCount;
  }

  async waitForIdleForTest(): Promise<void> {
    await (this as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
  }

  async triggerInterruptedStreamCheck(): Promise<void> {
    if (
      !this._resumableStream.hasActiveStream() ||
      this._resumableStream.isLive
    ) {
      return;
    }

    const streamId = this._resumableStream.activeStreamId!;
    const requestId = this._resumableStream.activeRequestId ?? "";

    const partial = this.getPartialText(streamId);

    const metadataRows = this.sql<{ created_at: number }>`
      select created_at from cf_ai_chat_stream_metadata where id = ${streamId}
    `;
    const createdAt = metadataRows[0]?.created_at ?? Date.now();

    const options = await this.onChatRecovery({
      streamId,
      requestId,
      partialText: partial.text,
      partialParts: partial.parts as ChatRecoveryContext["partialParts"],
      recoveryData: null,
      messages: [...this.messages],
      lastBody: this._lastBody,
      lastClientTools: this._lastClientTools,
      createdAt
    });

    if (options.persist !== false) {
      this._persistOrphanedStream(streamId);
    }

    this._resumableStream.complete(streamId);

    if (options.continue !== false) {
      const targetId = this.messages
        .slice()
        .reverse()
        .find((m) => m.role === "assistant")?.id;
      await this.schedule(
        0,
        "_chatRecoveryContinue",
        targetId ? { targetAssistantId: targetId } : undefined,
        { idempotent: true }
      );
    }
  }

  async insertInterruptedFiber(
    name: string,
    snapshot?: unknown
  ): Promise<void> {
    const id = `fiber-${Date.now()}`;
    this.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${id}, ${name}, ${snapshot ? JSON.stringify(snapshot) : null}, ${Date.now()})
    `;
  }

  async triggerFiberRecovery(): Promise<void> {
    await (
      this as unknown as { _checkRunFibers(): Promise<void> }
    )._checkRunFibers();
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

  getActiveFibers(): Array<{ id: string; name: string }> {
    return (
      this.sql<{ id: string; name: string }>`
        SELECT id, name FROM cf_agents_runs
      ` || []
    );
  }
}

// ── NonChatRecoveryTestAgent (same output as ChatRecoveryTestAgent, chatRecovery=false) ──

export class NonChatRecoveryTestAgent extends AIChatAgent<Env> {
  recoveryContexts: ChatRecoveryContext[] = [];
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
    return {};
  }

  getRecoveryContexts(): ChatRecoveryContext[] {
    return this.recoveryContexts;
  }

  getPersistedMessages(): ChatMessage[] {
    return (
      this.sql`select * from cf_ai_chat_agent_messages order by created_at` ||
      []
    ).map((row) => JSON.parse(row.message as string));
  }

  getOnChatMessageCallCount(): number {
    return this.onChatMessageCallCount;
  }

  getActiveFibers(): Array<{ id: string; name: string }> {
    return (
      this.sql<{ id: string; name: string }>`
        SELECT id, name FROM cf_agents_runs
      ` || []
    );
  }

  async callContinueLastTurn(
    body?: Record<string, unknown>
  ): Promise<{ requestId: string; status: string }> {
    return this.continueLastTurn(body);
  }

  async waitForIdleForTest(): Promise<void> {
    await (this as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
  }
}

// ── RecoveryThrowingAgent (chatRecovery=true, onChatMessage can throw) ──

export class RecoveryThrowingAgent extends AIChatAgent<Env> {
  override chatRecovery = true;
  private _shouldThrow = false;
  onChatMessageCallCount = 0;

  async onChatMessage() {
    this.onChatMessageCallCount++;
    if (this._shouldThrow) {
      throw new Error("Simulated onChatMessage error");
    }
    return makeSSEChunkResponse([
      { type: "text-start" },
      { type: "text-delta", delta: "Success response." },
      { type: "text-end" },
      { type: "finish" }
    ]);
  }

  setShouldThrow(value: boolean): void {
    this._shouldThrow = value;
  }

  getOnChatMessageCallCount(): number {
    return this.onChatMessageCallCount;
  }

  getPersistedMessages(): ChatMessage[] {
    return (
      this.sql`select * from cf_ai_chat_agent_messages order by created_at` ||
      []
    ).map((row) => JSON.parse(row.message as string));
  }

  getActiveFibers(): Array<{ id: string; name: string }> {
    return (
      this.sql<{ id: string; name: string }>`
        SELECT id, name FROM cf_agents_runs
      ` || []
    );
  }

  getAbortControllerCount(): number {
    return (
      this as unknown as {
        _abortRegistry: { size: number };
      }
    )._abortRegistry.size;
  }

  async waitForIdleForTest(): Promise<void> {
    await (this as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
  }
}

// ── RecoverySlowStreamAgent (SlowStreamAgent with chatRecovery=true) ──

export class RecoverySlowStreamAgent extends SlowStreamAgent {
  override chatRecovery = true;

  getActiveFibers(): Array<{ id: string; name: string }> {
    return (
      this.sql<{ id: string; name: string }>`
        SELECT id, name FROM cf_agents_runs
      ` || []
    );
  }

  /**
   * Regression seam for issue #1406: simulates `runFiber` throwing
   * before it invokes its callback (e.g. SQLite error inserting the
   * fiber row). Verifies that the external-signal listener attached
   * by `linkExternal` is still detached and the registry entry is
   * still removed even when the fiber start path fails.
   */
  async testSaveMessagesWithRunFiberFailure(text: string): Promise<{
    threw: boolean;
    abortRegistrySize: number;
    listenerRemovedFromExternal: boolean;
  }> {
    const controller = new AbortController();
    const signal = controller.signal;

    let attached = 0;
    let removed = 0;
    type AddListener = typeof signal.addEventListener;
    type RemoveListener = typeof signal.removeEventListener;
    const originalAdd = signal.addEventListener.bind(signal) as AddListener;
    const originalRemove = signal.removeEventListener.bind(
      signal
    ) as RemoveListener;
    signal.addEventListener = ((
      type: Parameters<AddListener>[0],
      listener: Parameters<AddListener>[1],
      options?: Parameters<AddListener>[2]
    ) => {
      if (type === "abort") attached++;
      (originalAdd as (...args: unknown[]) => void)(type, listener, options);
    }) as AddListener;
    signal.removeEventListener = ((
      type: Parameters<RemoveListener>[0],
      listener: Parameters<RemoveListener>[1],
      options?: Parameters<RemoveListener>[2]
    ) => {
      if (type === "abort") removed++;
      (originalRemove as (...args: unknown[]) => void)(type, listener, options);
    }) as RemoveListener;

    type RunFiber = RecoverySlowStreamAgent["runFiber"];
    const originalRunFiber = this.runFiber.bind(this) as RunFiber;
    (this as unknown as { runFiber: RunFiber }).runFiber = (async () => {
      throw new Error("simulated runFiber failure");
    }) as RunFiber;

    let threw = false;
    try {
      await this.saveMessages(
        [
          ...this.messages,
          {
            id: `runfiber-fail-${crypto.randomUUID()}`,
            role: "user",
            parts: [{ type: "text", text }]
          }
        ],
        { signal }
      );
    } catch {
      threw = true;
    } finally {
      (this as unknown as { runFiber: RunFiber }).runFiber = originalRunFiber;
    }

    return {
      threw,
      abortRegistrySize: this.getAbortControllerCount(),
      listenerRemovedFromExternal: attached > 0 && attached === removed
    };
  }
}

function delayWithAbort(ms: number, signal?: AbortSignal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason);

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function makeDelayedSSEChunkResponse(
  chunks: ReadonlyArray<Record<string, unknown>>,
  delayMs: number,
  signal?: AbortSignal
) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (const chunk of chunks) {
          await delayWithAbort(delayMs, signal);
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
          );
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        if (signal?.aborted) {
          controller.close();
        } else {
          controller.error(error);
        }
      }
    },
    cancel() {}
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" }
  });
}

type AgentToolInput = {
  prompt: string;
  delayMs?: number;
  chunkDelayMs?: number;
  structured?: boolean;
  streamError?: string;
};

export class AIChatAgentToolChild extends AIChatAgent<Env> {
  override formatAgentToolInput(
    input: AgentToolInput,
    request: { runId: string }
  ): ChatMessage {
    return {
      id: `tool-input-${request.runId}`,
      role: "user",
      parts: [{ type: "text", text: input.prompt }]
    };
  }

  protected override getAgentToolOutput(
    request: { runId: string; input: AgentToolInput },
    messagesAfterStart: readonly ChatMessage[]
  ): unknown {
    if (request.input.structured) {
      return {
        handledPrompt: request.input.prompt,
        messageCount: messagesAfterStart.length
      };
    }
    return super.getAgentToolOutput(request, messagesAfterStart);
  }

  protected override getAgentToolSummary(
    request: { runId: string; input: AgentToolInput },
    output: unknown,
    messagesAfterStart: readonly ChatMessage[]
  ): string {
    if (request.input.structured) {
      return `structured:${request.input.prompt}`;
    }
    return super.getAgentToolSummary(request, output, messagesAfterStart);
  }

  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    const input = options?.body?.agentToolInput as AgentToolInput | undefined;
    const lastUser = [...this.messages]
      .reverse()
      .find((message) => message.role === "user");
    const prompt =
      lastUser?.parts
        .filter(
          (part): part is { type: "text"; text: string } => part.type === "text"
        )
        .map((part) => part.text)
        .join("") ?? "";

    const bodyText = `AIChat child handled: ${prompt}`;
    await delayWithAbort(Number(input?.delayMs ?? 0), options?.abortSignal);
    if (input?.streamError) {
      return makeDelayedSSEChunkResponse(
        [{ type: "error", errorText: input.streamError }],
        Number(input?.chunkDelayMs ?? 0),
        options?.abortSignal
      );
    }

    return makeDelayedSSEChunkResponse(
      [
        { type: "text-start" },
        { type: "text-delta", delta: bodyText.slice(0, 22) },
        { type: "text-delta", delta: bodyText.slice(22) },
        { type: "text-end" },
        { type: "finish" }
      ],
      Number(input?.chunkDelayMs ?? 0),
      options?.abortSignal
    );
  }

  listMessagesForTest(): ChatMessage[] {
    return this.messages;
  }
}

type AgentToolFinishForTest = {
  run: AgentToolRunInfo;
  result: AgentToolLifecycleResult;
};

export class AIChatAgentToolParent extends Agent<Env> {
  private events: AgentToolEventMessage[] = [];
  private finishes: AgentToolFinishForTest[] = [];
  private finishRunIdsToThrow = new Set<string>();
  private lifecycleOrder: string[] = [];

  override broadcast(
    msg: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void {
    if (typeof msg === "string") {
      try {
        const parsed = JSON.parse(msg) as AgentToolEventMessage;
        if (parsed.type === "agent-tool-event") {
          this.events.push(parsed);
        }
      } catch {
        // Ignore non-agent-tool frames.
      }
    }
    super.broadcast(msg, without);
  }

  override async onAgentToolFinish(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    this.finishes.push({ run, result });
    this.lifecycleOrder.push(`finish:${run.runId}`);
    if (this.finishRunIdsToThrow.has(run.runId)) {
      throw new Error(`finish failed for ${run.runId}`);
    }
  }

  async runChild(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<RunAgentToolResult> {
    this.events = [];
    this.finishes = [];
    return this.runAgentTool(AIChatAgentToolChild, {
      runId,
      parentToolCallId: "test-tool-call",
      input,
      inputPreview: input.prompt
    });
  }

  async runChildWithDelayedAbort(
    input: AgentToolInput,
    abortAfterMs: number,
    runId = crypto.randomUUID()
  ): Promise<RunAgentToolResult> {
    this.events = [];
    const controller = new AbortController();
    const timeout =
      abortAfterMs > 0
        ? setTimeout(() => controller.abort("test abort"), abortAfterMs)
        : undefined;
    if (abortAfterMs <= 0) controller.abort("test abort");
    try {
      return await this.runAgentTool(AIChatAgentToolChild, {
        runId,
        parentToolCallId: "test-tool-call",
        input,
        signal: controller.signal
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  getEventsForTest(): AgentToolEventMessage[] {
    return this.events;
  }

  getFinishesForTest(): AgentToolFinishForTest[] {
    return this.finishes;
  }

  private insertRecoverableParentRunForTest(
    runId: string,
    agentType: string,
    inputPreview: string,
    startedAt: number,
    status: "starting" | "running" = "running"
  ): void {
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, input_preview,
        input_redacted, status, display_metadata, display_order, started_at
      ) VALUES (
        ${runId}, 'test-tool-call', ${agentType},
        ${JSON.stringify(inputPreview)}, 1, ${status},
        ${JSON.stringify({ name: "test child" })}, 0, ${startedAt}
      )
    `;
  }

  private async waitForTerminalInspectionForTest(
    child: {
      inspectAgentToolRun(
        runId: string
      ): Promise<AgentToolRunInspection | null>;
    },
    runId: string
  ): Promise<AgentToolRunInspection> {
    let inspection = await child.inspectAgentToolRun(runId);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (
        inspection &&
        inspection.status !== "running" &&
        inspection.status !== "starting"
      ) {
        return inspection;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      inspection = await child.inspectAgentToolRun(runId);
    }
    throw new Error("Timed out waiting for child agent-tool completion");
  }

  private async prepareCompletedChildForRecoveryTest(
    input: AgentToolInput,
    runId: string
  ): Promise<AgentToolRunInspection> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    const started = await child.startAgentToolRun(input, { runId });
    this.insertRecoverableParentRunForTest(
      runId,
      "AIChatAgentToolChild",
      input.prompt,
      started.startedAt
    );
    return this.waitForTerminalInspectionForTest(child, runId);
  }

  private async reconcileAgentToolRunsForTest(options?: {
    deferFinishHooks?: boolean;
  }): Promise<Array<() => Promise<void>>> {
    return (
      this as unknown as {
        _reconcileAgentToolRuns(options?: {
          deferFinishHooks?: boolean;
        }): Promise<Array<() => Promise<void>>>;
      }
    )._reconcileAgentToolRuns(options);
  }

  private async runDeferredAgentToolFinishHooksForTest(
    hooks: Array<() => Promise<void>>
  ): Promise<void> {
    await (
      this as unknown as {
        _runDeferredAgentToolFinishHooks(
          hooks: Array<() => Promise<void>>
        ): Promise<void>;
      }
    )._runDeferredAgentToolFinishHooks(hooks);
  }

  async reconcileCompletedChildForTest(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    inspection: AgentToolRunInspection;
  }> {
    const inspection = await this.prepareCompletedChildForRecoveryTest(
      input,
      runId
    );
    this.events = [];
    this.finishes = [];
    await this.reconcileAgentToolRunsForTest();

    return { events: this.events, finishes: this.finishes, inspection };
  }

  async reconcileRunningChildForTest(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
  }> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    const started = await child.startAgentToolRun(
      { ...input, delayMs: input.delayMs ?? 10_000 },
      { runId }
    );
    this.insertRecoverableParentRunForTest(
      runId,
      "AIChatAgentToolChild",
      input.prompt,
      started.startedAt
    );

    this.events = [];
    this.finishes = [];
    try {
      await this.reconcileAgentToolRunsForTest();
    } finally {
      await child.cancelAgentToolRun(runId, "test cleanup");
    }

    return { events: this.events, finishes: this.finishes };
  }

  async reconcileMissingChildForTest(runId = crypto.randomUUID()): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
  }> {
    this.insertRecoverableParentRunForTest(
      runId,
      "MissingAgentToolChild",
      "missing child",
      Date.now()
    );

    this.events = [];
    this.finishes = [];
    await this.reconcileAgentToolRunsForTest();

    return { events: this.events, finishes: this.finishes };
  }

  async reconcileCompletedChildWithDeferredFinishForTest(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    finishesBeforeDrain: number;
    lifecycleOrder: string[];
  }> {
    await this.prepareCompletedChildForRecoveryTest(input, runId);
    this.events = [];
    this.finishes = [];
    this.lifecycleOrder = [];

    const hooks = await this.reconcileAgentToolRunsForTest({
      deferFinishHooks: true
    });
    const finishesBeforeDrain = this.finishes.length;
    this.lifecycleOrder.push("after-on-start");
    await this.runDeferredAgentToolFinishHooksForTest(hooks);

    return {
      events: this.events,
      finishes: this.finishes,
      finishesBeforeDrain,
      lifecycleOrder: this.lifecycleOrder
    };
  }

  async reconcileCompletedChildWithFailedStartupForTest(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    deferredHookCount: number;
    lifecycleOrder: string[];
  }> {
    await this.prepareCompletedChildForRecoveryTest(input, runId);
    this.events = [];
    this.finishes = [];
    this.lifecycleOrder = [];

    const hooks = await this.reconcileAgentToolRunsForTest({
      deferFinishHooks: true
    });

    try {
      this.lifecycleOrder.push("on-start-error");
      throw new Error("test startup failure");
    } catch {
      // Mirrors the Agent startup contract: recovered finish hooks are only
      // drained after successful user startup.
    }

    return {
      events: this.events,
      finishes: this.finishes,
      deferredHookCount: hooks.length,
      lifecycleOrder: this.lifecycleOrder
    };
  }

  async reconcileCompletedChildWithReplayFailureForTest(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
  }> {
    await this.prepareCompletedChildForRecoveryTest(input, runId);
    this.events = [];
    this.finishes = [];

    type BroadcastStoredChunks = (
      row: unknown,
      sequence: number,
      replay?: true,
      connection?: unknown
    ) => Promise<number>;
    const self = this as unknown as {
      _broadcastAgentToolStoredChunks: BroadcastStoredChunks;
    };
    const original = self._broadcastAgentToolStoredChunks.bind(
      this
    ) as BroadcastStoredChunks;
    self._broadcastAgentToolStoredChunks = async () => {
      throw new Error("test replay failure");
    };
    try {
      await this.reconcileAgentToolRunsForTest();
    } finally {
      self._broadcastAgentToolStoredChunks = original;
    }

    return { events: this.events, finishes: this.finishes };
  }

  async reconcileTwoCompletedChildrenWithThrowingFinishForTest(): Promise<{
    finishes: AgentToolFinishForTest[];
    lifecycleOrder: string[];
  }> {
    const firstRunId = crypto.randomUUID();
    const secondRunId = crypto.randomUUID();
    await this.prepareCompletedChildForRecoveryTest(
      { prompt: "first recovered child" },
      firstRunId
    );
    await this.prepareCompletedChildForRecoveryTest(
      { prompt: "second recovered child" },
      secondRunId
    );

    this.events = [];
    this.finishes = [];
    this.lifecycleOrder = [];
    this.finishRunIdsToThrow = new Set([firstRunId]);
    const hooks = await this.reconcileAgentToolRunsForTest({
      deferFinishHooks: true
    });
    await this.runDeferredAgentToolFinishHooksForTest(hooks);
    this.finishRunIdsToThrow.clear();

    return { finishes: this.finishes, lifecycleOrder: this.lifecycleOrder };
  }

  async inspectChild(runId: string): Promise<AgentToolRunInspection | null> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    return child.inspectAgentToolRun(runId);
  }

  async getChildChunks(
    runId: string,
    afterSequence?: number
  ): Promise<AgentToolStoredChunk[]> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    return child.getAgentToolChunks(runId, { afterSequence });
  }

  async getChildMessages(runId: string): Promise<ChatMessage[]> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    return child.listMessagesForTest();
  }

  async startAndCancelChild(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<AgentToolRunInspection | null> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    await child.startAgentToolRun(input, { runId });
    await child.cancelAgentToolRun(runId, "test abort");
    return child.inspectAgentToolRun(runId);
  }

  async runChildWithTrackedAbortListener(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<{
    result: RunAgentToolResult;
    abortListenerAdded: number;
    abortListenerRemoved: number;
  }> {
    const controller = new AbortController();
    const signal = controller.signal;

    let abortListenerAdded = 0;
    let abortListenerRemoved = 0;
    type AddListener = typeof signal.addEventListener;
    type RemoveListener = typeof signal.removeEventListener;
    const originalAdd = signal.addEventListener.bind(signal) as AddListener;
    const originalRemove = signal.removeEventListener.bind(
      signal
    ) as RemoveListener;

    signal.addEventListener = ((
      type: Parameters<AddListener>[0],
      listener: Parameters<AddListener>[1],
      options?: Parameters<AddListener>[2]
    ) => {
      if (type === "abort") abortListenerAdded++;
      (originalAdd as (...args: unknown[]) => void)(type, listener, options);
    }) as AddListener;
    signal.removeEventListener = ((
      type: Parameters<RemoveListener>[0],
      listener: Parameters<RemoveListener>[1],
      options?: Parameters<RemoveListener>[2]
    ) => {
      if (type === "abort") abortListenerRemoved++;
      (originalRemove as (...args: unknown[]) => void)(type, listener, options);
    }) as RemoveListener;

    const result = await this.runAgentTool(AIChatAgentToolChild, {
      runId,
      parentToolCallId: "test-tool-call",
      input,
      signal
    });

    return { result, abortListenerAdded, abortListenerRemoved };
  }

  async testPreAbortedForwardStreamReleasesReaderLock(): Promise<boolean> {
    type ForwardAgentToolStream = (
      stream: ReadableStream<AgentToolStoredChunk>,
      parentToolCallId: string | undefined,
      runId: string,
      sequence: number,
      signal?: AbortSignal
    ) => Promise<number>;
    const stream = new ReadableStream<AgentToolStoredChunk>();
    const controller = new AbortController();
    controller.abort("already aborted");

    await (
      this as unknown as { _forwardAgentToolStream: ForwardAgentToolStream }
    )._forwardAgentToolStream(
      stream,
      "test-tool-call",
      crypto.randomUUID(),
      1,
      controller.signal
    );

    const reader = stream.getReader();
    reader.releaseLock();
    return true;
  }

  async forwardMalformedAgentToolStreamForTest(): Promise<
    AgentToolEventMessage[]
  > {
    type ForwardAgentToolStream = (
      stream: ReadableStream<AgentToolStoredChunk>,
      parentToolCallId: string | undefined,
      runId: string,
      sequence: number,
      signal?: AbortSignal
    ) => Promise<number>;
    this.events = [];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              JSON.stringify({ sequence: 0, body: "first good frame" }),
              "{malformed json}",
              JSON.stringify({ sequence: 1, body: 42 }),
              JSON.stringify({ sequence: 2, body: "second good frame" })
            ].join("\n")
          )
        );
        controller.close();
      }
    });

    await (
      this as unknown as { _forwardAgentToolStream: ForwardAgentToolStream }
    )._forwardAgentToolStream(
      stream as unknown as ReadableStream<AgentToolStoredChunk>,
      "test-tool-call",
      crypto.randomUUID(),
      1
    );

    return this.events;
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
