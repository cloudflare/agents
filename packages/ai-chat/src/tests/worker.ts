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
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryExhaustedContext,
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
  StuckAgentToolChild: DurableObjectNamespace<StuckAgentToolChild>;
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
  private _chatMessageCallCount = 0;

  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    this._chatMessageCallCount++;
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

    const continuationStreamError = options?.body?.continuationStreamError;
    if (options?.continuation && typeof continuationStreamError === "string") {
      const delayMs =
        typeof options.body?.continuationStreamErrorDelayMs === "number"
          ? options.body.continuationStreamErrorDelayMs
          : 25;
      return makeDelayedSSEChunkResponse(
        [
          { type: "start" },
          { type: "error", errorText: continuationStreamError }
        ],
        delayMs,
        options.abortSignal
      );
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

  setTestBody(body: Record<string, unknown>): void {
    (this as unknown as { _lastBody: Record<string, unknown> })._lastBody =
      body;
    (
      this as unknown as { _persistRequestContext(): void }
    )._persistRequestContext();
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

  getChatMessageCallCountForTest(): number {
    return this._chatMessageCallCount;
  }

  getContinuationStateForTest(): {
    hasPending: boolean;
    hasDeferred: boolean;
    activeRequestId: string | null;
    activeConnectionId: string | null;
  } {
    const continuation = (
      this as unknown as {
        _continuation: {
          pending: unknown;
          deferred: unknown;
          activeRequestId: string | null;
          activeConnectionId: string | null;
        };
      }
    )._continuation;

    return {
      hasPending: continuation.pending !== null,
      hasDeferred: continuation.deferred !== null,
      activeRequestId: continuation.activeRequestId,
      activeConnectionId: continuation.activeConnectionId
    };
  }

  getLatestStreamStatusForTest(): string | null {
    const rows = this.sql<{ status: string }>`
      select status
      from cf_ai_chat_stream_metadata
      order by created_at desc
      limit 1
    `;
    return rows[0]?.status ?? null;
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

  /**
   * Drives two overlapping read-modify-write applies through the
   * interaction-apply queue (#1649). Each apply reads a shared counter, yields
   * across an async gap, then writes `read + 1`. Without serialization both
   * read 0 before either writes, so the result is 1 (one update clobbered).
   * With serialization the second apply waits for the first, yielding 2.
   */
  async testInteractionApplySerialization(): Promise<number> {
    let shared = 0;
    const rmw = (gapMs: number) => async () => {
      const read = shared;
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      shared = read + 1;
      return true;
    };
    const first = this._enqueueInteractionApply(rmw(30));
    const second = this._enqueueInteractionApply(rmw(0));
    await Promise.all([first, second]);
    return shared;
  }

  // Resumable streaming test helpers

  testStartStream(requestId: string): string {
    return this._startStream(requestId);
  }

  async testStoreStreamChunk(streamId: string, body: string): Promise<void> {
    await this._storeStreamChunk(streamId, body);
  }

  async testBroadcastLiveChunk(
    requestId: string,
    streamId: string,
    body: string
  ): Promise<void> {
    await this._storeStreamChunk(streamId, body);
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
    // Delegate to ResumableStream so tests see the same unpacked, per-chunk
    // view that production consumers get (packed segment rows are expanded).
    return this._resumableStream.getStreamChunks(streamId);
  }

  /** Raw count of stored rows for a stream (packed segments count as 1 each). */
  getStreamChunkRowCount(streamId: string): number {
    const result = this.sql<{ cnt: number }>`
      select count(*) as cnt from cf_ai_chat_stream_chunks
      where stream_id = ${streamId}
    `;
    return result?.[0]?.cnt ?? 0;
  }

  /**
   * Seed legacy one-row-per-chunk records (the pre-packing storage format) so
   * tests can verify backward-compatible unpacking of older data.
   */
  insertLegacyChunkRows(
    streamId: string,
    requestId: string,
    bodies: string[]
  ): void {
    const now = Date.now();
    this.sql`
      insert into cf_ai_chat_stream_metadata (id, request_id, status, created_at)
      values (${streamId}, ${requestId}, 'completed', ${now})
    `;
    bodies.forEach((body, index) => {
      this.sql`
        insert into cf_ai_chat_stream_chunks (id, stream_id, body, chunk_index, created_at)
        values (${`${streamId}-${index}`}, ${streamId}, ${body}, ${index}, ${now})
      `;
    });
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
          streamError?: string;
          throwError?: boolean;
        }
      | undefined;
    const format = body?.format ?? "plaintext";
    const useAbortSignal = body?.useAbortSignal ?? false;
    const responseDelayMs = body?.responseDelayMs ?? 0;
    const chunkCount = body?.chunkCount ?? 20;
    const chunkDelayMs = body?.chunkDelayMs ?? 50;
    const streamError = body?.streamError;
    const throwError = body?.throwError ?? false;
    const abortSignal = useAbortSignal ? options?.abortSignal : undefined;

    if (responseDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async pull(controller) {
        if (format === "sse" && streamError) {
          const chunk = JSON.stringify({
            type: "error",
            errorText: streamError
          });
          controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
          controller.close();
          return;
        }
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
          streamError?: string;
          useAbortSignal?: boolean;
        }
      | undefined;

    const format = body?.format ?? "plaintext";
    const chunkCount = body?.chunkCount ?? 3;
    const chunkDelayMs = body?.chunkDelayMs ?? 10;
    const throwError = body?.throwError ?? false;
    const streamError = body?.streamError;
    const useAbortSignal = body?.useAbortSignal ?? false;
    const abortSignal = useAbortSignal ? options?.abortSignal : undefined;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async pull(controller) {
        if (format === "sse" && streamError) {
          const chunk = JSON.stringify({
            type: "error",
            errorText: streamError
          });
          controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
          controller.close();
          return;
        }
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
  override chatRecovery: ChatRecoveryConfig = true;
  recoveryContexts: ChatRecoveryContext[] = [];
  exhaustedContexts: ChatRecoveryExhaustedContext[] = [];
  recoveryOverride: ChatRecoveryOptions | null = null;
  onChatMessageCallCount = 0;
  onChatMessageBodies: Array<Record<string, unknown> | undefined> = [];
  onChatMessageClientTools: Array<ClientToolSchema[] | undefined> = [];
  includeReasoningInResponse = false;
  private _stashData: unknown = null;
  private _stashResult: { success: boolean; error?: string } | null = null;

  async onChatMessage(
    _onFinish?: unknown,
    ctx?: {
      body?: Record<string, unknown>;
      clientTools?: ClientToolSchema[];
    }
  ) {
    this.onChatMessageCallCount++;
    this.onChatMessageBodies.push(ctx?.body);
    this.onChatMessageClientTools.push(ctx?.clientTools);

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

    if (this._emitStreamError) {
      // Surface a terminal stream error (the way a provider 500 arrives as an
      // SSE `error` part). The turn resolves with status "error".
      return makeSSEChunkResponse([
        { type: "start" },
        { type: "error", errorText: this._emitStreamError }
      ]);
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

  private _emitStreamError: string | null = null;

  setStashData(data: unknown): void {
    this._stashData = data;
  }

  getStashResult(): { success: boolean; error?: string } | null {
    return this._stashResult;
  }

  setIncludeReasoning(value: boolean): void {
    this.includeReasoningInResponse = value;
  }

  recoveryShouldThrow = false;
  onExhaustedCalls = 0;
  private _simulateSupersededIsolate = false;

  /**
   * Simulate the recovery continuation alarm firing on a SUPERSEDED isolate:
   * the first storage op throws the catchable
   * `Durable Object reset because its code was updated.` for the whole
   * invocation. Used to reproduce the scheduled-callback abandonment path that
   * #1615's `_beginChatRecoveryIncident` progress logic cannot reach.
   */
  _supersededThrows = 0;

  override async _chatRecoveryContinue(
    ...args: Parameters<AIChatAgent<Env>["_chatRecoveryContinue"]>
  ): Promise<void> {
    if (this._simulateSupersededIsolate) {
      this._supersededThrows += 1;
      throw new Error("Durable Object reset because its code was updated.");
    }
    return super._chatRecoveryContinue(...args);
  }

  setSimulateSupersededIsolateForTest(value: boolean): void {
    this._simulateSupersededIsolate = value;
  }

  getSupersededThrowsForTest(): number {
    return this._supersededThrows;
  }

  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    this.recoveryContexts.push(ctx);
    if (this.recoveryShouldThrow) {
      throw new Error("onChatRecovery boom");
    }
    if (this.recoveryOverride) return this.recoveryOverride;
    return {};
  }

  getRecoveryContexts(): ChatRecoveryContext[] {
    return this.recoveryContexts;
  }

  setRecoveryOverride(options: ChatRecoveryOptions): void {
    this.recoveryOverride = options;
  }

  setRecoveryShouldThrowForTest(shouldThrow: boolean): void {
    this.recoveryShouldThrow = shouldThrow;
  }

  /** Configure recovery with a built-in `shouldKeepRecovering` predicate.
   *  Functions can't cross the RPC boundary, so this sets the predicate in-DO
   *  rather than accepting one through `setChatRecoveryConfigForTest`. */
  setShouldKeepRecoveringForTest(keepRecovering: boolean): void {
    this.chatRecovery = { shouldKeepRecovering: () => keepRecovering };
  }

  enableThrowingOnExhaustedForTest(
    maxAttempts: number,
    terminalMessage: string
  ): void {
    this.onExhaustedCalls = 0;
    this.chatRecovery = {
      maxAttempts,
      terminalMessage,
      onExhausted: () => {
        this.onExhaustedCalls++;
        throw new Error("onExhausted boom");
      }
    };
  }

  getOnExhaustedCallsForTest(): number {
    return this.onExhaustedCalls;
  }

  /** Capture the `onExhausted` context for assertions (instead of throwing). */
  enableExhaustedCaptureForTest(
    maxAttempts: number,
    terminalMessage?: string
  ): void {
    this.exhaustedContexts = [];
    this.chatRecovery = {
      maxAttempts,
      ...(terminalMessage ? { terminalMessage } : {}),
      onExhausted: (exhaustedCtx) => {
        this.exhaustedContexts.push(exhaustedCtx);
      }
    };
  }

  getExhaustedContextsForTest(): ChatRecoveryExhaustedContext[] {
    return this.exhaustedContexts;
  }

  setChatRecoveryConfigForTest(config: ChatRecoveryConfig): void {
    this.chatRecovery = config;
  }

  /** Stream content (which advances progress at production time) then re-persist
   *  the same orphan, reading the recovery-progress counter at each step.
   *  Proves progress advances on new content but NOT on a reconnect/recovery
   *  re-persist (#1637 reconnect-immunity). */
  async probeProgressReconnectImmunityForTest(): Promise<{
    start: number;
    afterFlush: number;
    afterPersist: number;
  }> {
    const self = this as unknown as {
      _resumableStream: { start(id: string): string };
      _storeStreamChunk(streamId: string, body: string): Promise<void>;
      _persistOrphanedStream(streamId: string): Promise<void>;
    };
    const read = async (): Promise<number> =>
      (await this.ctx.storage.get<number>("cf:chat-recovery:progress")) ?? 0;

    const start = await read();
    const streamId = self._resumableStream.start("req-progress-immunity");
    await self._storeStreamChunk(
      streamId,
      JSON.stringify({ type: "text-start", id: "t" })
    );
    await self._storeStreamChunk(
      streamId,
      JSON.stringify({
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "x",
        input: {}
      })
    );
    await self._storeStreamChunk(
      streamId,
      JSON.stringify({
        type: "tool-output-available",
        toolCallId: "tc1",
        output: { ok: true }
      })
    );
    const afterFlush = await read();

    // A recovery/reconnect persist of the same already-streamed content must
    // NOT be miscounted as new forward progress.
    await self._persistOrphanedStream(streamId);
    const afterPersist = await read();

    return { start, afterFlush, afterPersist };
  }

  async beginIncidentForTest(input: {
    requestId: string;
    recoveryRootRequestId?: string | null;
    latestUserMessageId?: string | null;
    recoveryKind: "retry" | "continue";
    nowMs?: number;
  }): Promise<{
    incidentId: string;
    attempt: number;
    exhausted: boolean;
    reason?: string;
  }> {
    const self = this as unknown as {
      _beginChatRecoveryIncident(i: typeof input): Promise<{
        incident: { incidentId: string; attempt: number; reason?: string };
        exhausted: boolean;
      }>;
    };
    const { incident, exhausted } =
      await self._beginChatRecoveryIncident(input);
    return {
      incidentId: incident.incidentId,
      attempt: incident.attempt,
      exhausted,
      reason: incident.reason
    };
  }

  /** Push an incident's `lastAttemptAt` back so a subsequent real-time recovery
   *  isn't collapsed by alarm-debounce (#1637). */
  async ageIncidentForTest(incidentId: string, ms: number): Promise<void> {
    const key = `cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`;
    const inc = await this.ctx.storage.get<{ lastAttemptAt: number }>(key);
    if (!inc) return;
    inc.lastAttemptAt -= ms;
    await this.ctx.storage.put(key, inc);
  }

  async updateIncidentForTest(
    incidentId: string,
    status: string,
    reason?: string
  ): Promise<void> {
    await (
      this as unknown as {
        _updateChatRecoveryIncident(
          id: string,
          status: string,
          reason?: string
        ): Promise<void>;
      }
    )._updateChatRecoveryIncident(incidentId, status, reason);
  }

  async seedIncidentForTest(incident: {
    incidentId: string;
    requestId: string;
    recoveryKind: "retry" | "continue";
    attempt: number;
    maxAttempts: number;
    status: string;
    firstSeenAt: number;
    lastAttemptAt: number;
    lastProgressAt?: number;
    progress?: number;
    workBaseline?: number;
  }): Promise<void> {
    await this.ctx.storage.put(
      `cf:chat-recovery:incident:${encodeURIComponent(incident.incidentId)}`,
      incident
    );
  }

  async getChatRecoveryIncidentsForTest(): Promise<unknown[]> {
    const entries = await this.ctx.storage.list({
      prefix: "cf:chat-recovery:incident:"
    });
    return [...entries.values()];
  }

  private _forceStableTimeout = false;

  setForceStableTimeoutForTest(value: boolean): void {
    this._forceStableTimeout = value;
  }

  override async waitUntilStable(options?: {
    timeout?: number;
  }): Promise<boolean> {
    if (this._forceStableTimeout) return false;
    return super.waitUntilStable(options);
  }

  async runChatRecoveryContinueDirectForTest(
    data: Record<string, unknown>
  ): Promise<void> {
    await super._chatRecoveryContinue(
      data as Parameters<AIChatAgent<Env>["_chatRecoveryContinue"]>[0]
    );
  }

  async runChatRecoveryRetryDirectForTest(
    data: Record<string, unknown>
  ): Promise<void> {
    await super._chatRecoveryRetry(
      data as Parameters<AIChatAgent<Env>["_chatRecoveryRetry"]>[0]
    );
  }

  /** Simulate the not-yet-deleted one-shot row `alarm()` is executing. */
  async preScheduleRecoveryContinueForTest(
    data: Record<string, unknown>
  ): Promise<void> {
    await this.schedule(60, "_chatRecoveryContinue", data, {
      idempotent: false
    });
  }

  /** Retry-path twin of {@link preScheduleRecoveryContinueForTest}. */
  async preScheduleRecoveryRetryForTest(
    data: Record<string, unknown>
  ): Promise<void> {
    await this.schedule(60, "_chatRecoveryRetry", data, {
      idempotent: false
    });
  }

  async getChatRecoveringForTest(): Promise<{ requestId?: string } | null> {
    return (
      (await this.ctx.storage.get<{ requestId?: string }>(
        "cf:chat:recovering"
      )) ?? null
    );
  }

  /** Read the durable terminal record (#1645) so tests can assert it is
   *  recorded on exhaustion and cleared once a later turn succeeds. */
  async getPendingChatTerminalForTest(): Promise<{
    requestId: string;
    body: string;
  } | null> {
    return (
      (await this.ctx.storage.get<{ requestId: string; body: string }>(
        "cf:chat:last-terminal"
      )) ?? null
    );
  }

  /** Drive a successful turn purely server-side (no client request), the way
   *  an app's own code would via `saveMessages`. Used to verify that a
   *  succeeding programmatic turn supersedes a stale terminal record (#1645). */
  async driveSuccessfulTurnForTest(): Promise<SaveMessagesResult["status"]> {
    const result = await this.saveMessages([
      {
        id: `u-${crypto.randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text: "hello" }]
      }
    ]);
    return result.status;
  }

  /** Drive an ABORTED turn purely server-side (no client request), via a
   *  pre-aborted external signal — the stream loop breaks immediately and the
   *  pushed `ChatResponseResult.status` is `"aborted"`. Used to verify that an
   *  aborted programmatic turn also supersedes a stale terminal record (#1645),
   *  not just a completed one. */
  async driveAbortedTurnForTest(): Promise<SaveMessagesResult["status"]> {
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    const result = await this.saveMessages(
      [
        {
          id: `u-${crypto.randomUUID()}`,
          role: "user",
          parts: [{ type: "text", text: "hello" }]
        }
      ],
      { signal: controller.signal }
    );
    return result.status;
  }

  /** Drive a turn that ends in a terminal (non-recovered) stream error — the
   *  way a provider 500 arrives as an SSE `error` part. Used to verify the
   *  error is durably recorded so it replays to a reconnecting client (#1645),
   *  matching Think. Returns the resulting status (`"error"`). */
  async driveErroredTurnForTest(
    message: string
  ): Promise<SaveMessagesResult["status"]> {
    this._emitStreamError = message;
    try {
      const result = await this.saveMessages([
        {
          id: `u-${crypto.randomUUID()}`,
          role: "user",
          parts: [{ type: "text", text: "hello" }]
        }
      ]);
      return result.status;
    } finally {
      this._emitStreamError = null;
    }
  }

  async getIncidentForTest(incidentId: string): Promise<{
    attempt: number;
    status: string;
    reason?: string;
  } | null> {
    const incident = await this.ctx.storage.get<{
      attempt: number;
      status: string;
      reason?: string;
    }>(`cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`);
    return incident
      ? {
          attempt: incident.attempt,
          status: incident.status,
          reason: incident.reason
        }
      : null;
  }

  /**
   * Simulate forward recovery progress by persisting one assistant message
   * (what `_persistOrphanedStream` does after a partial). Used to exercise the
   * progress-aware attempt-budget reset in `_beginChatRecoveryIncident`.
   */
  async addAssistantMessageForTest(id: string): Promise<void> {
    const message = {
      id,
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "progress" }]
    };
    this.messages = [...this.messages, message];
    await this.persistMessages(this.messages);
  }

  /** Persist an assistant message parked on a tool's `input-available` orphan,
   *  to exercise the pending-CLIENT-interaction recovery exemption. The tool is
   *  treated as client-resolvable only if its name was registered via
   *  `setRequestContextForTest`. */
  async persistPendingToolCallForTest(
    messageId: string,
    toolName: string
  ): Promise<void> {
    await this.persistMessages([
      {
        id: messageId,
        role: "assistant" as const,
        parts: [
          {
            type: `tool-${toolName}`,
            toolCallId: `call_${messageId}`,
            state: "input-available",
            input: {}
          }
        ] as ChatMessage["parts"]
      }
    ]);
  }

  /** Simulate recovery forward progress: advance the durable progress counter
   *  exactly as `_persistOrphanedStream` does when it materializes a non-empty
   *  partial. The recovery budget keys off this counter (not the live message
   *  count), so this is how a test marks "the turn advanced". */
  async bumpRecoveryProgressForTest(): Promise<void> {
    const self = this as unknown as {
      _bumpChatRecoveryProgress(): Promise<void>;
    };
    await self._bumpChatRecoveryProgress();
  }

  /** Simulate a parent re-attach that forwards `chunks` of a child's stream by
   *  driving the real `_forwardAgentToolStream` over a synthetic child stream.
   *  The in-memory throttle is reset first so this models a fresh post-restart
   *  isolate. Returns the durable recovery-progress counter before/after so a
   *  test can assert forwarding child output credits the PARENT's progress
   *  marker (N9) — and that a SILENT child (chunks = 0) does NOT. */
  async forwardChildStreamProgressForTest(chunks: number): Promise<{
    start: number;
    after: number;
  }> {
    const self = this as unknown as {
      _forwardAgentToolStream(
        stream: ReadableStream<{ body: string }>,
        parentToolCallId: string | undefined,
        runId: string,
        sequence: number
      ): Promise<number>;
      _lastAgentToolStreamProgressAt: number;
    };
    self._lastAgentToolStreamProgressAt = 0;
    const read = async (): Promise<number> =>
      (await this.ctx.storage.get<number>("cf:chat-recovery:progress")) ?? 0;
    const start = await read();
    const bodies = Array.from({ length: chunks }, (_, i) => ({
      body: `chunk-${i}`
    }));
    const stream = new ReadableStream<{ body: string }>({
      start(controller) {
        for (const b of bodies) controller.enqueue(b);
        controller.close();
      }
    });
    await self._forwardAgentToolStream(stream, undefined, "n9-probe-run", 1);
    const after = await read();
    return { start, after };
  }

  /** Simulate compaction collapsing the transcript by dropping all assistant
   *  messages from the live cache. Used to prove the recovery progress signal
   *  is compaction-immune (#1628). */
  async dropAssistantMessagesForTest(): Promise<void> {
    this.messages = this.messages.filter((m) => m.role !== "assistant");
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

  async runRecoveryRetryForTest(options?: {
    targetUserId?: string;
    lastBody?: Record<string, unknown>;
    lastClientTools?: ClientToolSchema[];
  }): Promise<void> {
    await this._chatRecoveryRetry(options);
  }

  async runScheduledRecoveryRetryForTest(): Promise<void> {
    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM cf_agents_schedules
      WHERE callback = '_chatRecoveryRetry'
      ORDER BY time ASC
      LIMIT 1
    `;
    if (!rows[0]) return;
    await this._chatRecoveryRetry(
      JSON.parse(rows[0].payload) as {
        targetUserId?: string;
        lastBody?: Record<string, unknown>;
        lastClientTools?: ClientToolSchema[];
      }
    );
  }

  async runScheduledRecoveryContinueForTest(): Promise<void> {
    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM cf_agents_schedules
      WHERE callback = '_chatRecoveryContinue'
      ORDER BY time ASC
      LIMIT 1
    `;
    if (!rows[0]) return;
    await this._chatRecoveryContinue(
      JSON.parse(rows[0].payload) as {
        targetAssistantId?: string;
        lastBody?: Record<string, unknown> | null;
        lastClientTools?: ClientToolSchema[] | null;
      }
    );
  }

  setRequestContextForTest(
    body?: Record<string, unknown>,
    clientTools?: ClientToolSchema[]
  ): void {
    this._lastBody = body;
    this._lastClientTools = clientTools;
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

  getOnChatMessageBodies(): Array<Record<string, unknown> | undefined> {
    return this.onChatMessageBodies;
  }

  getOnChatMessageClientTools(): Array<ClientToolSchema[] | undefined> {
    return this.onChatMessageClientTools;
  }

  getScheduleCountForCallback(callback: string): number {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_schedules
      WHERE callback = ${callback}
    `;
    return rows[0]?.count ?? 0;
  }

  getRunFiberCountForTest(): number {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    return rows[0]?.count ?? 0;
  }

  /**
   * Run the real DO alarm handler (schedule dispatch + one-shot row delete).
   * Swallows a thrown alarm the way the platform does — workerd absorbs a
   * rejected alarm and retries it later under the at-least-once guarantee — so
   * tests can inspect the post-alarm state.
   */
  async runAlarmForTest(): Promise<void> {
    try {
      await (this as unknown as { alarm(): Promise<void> }).alarm();
    } catch {
      // Platform absorbs and retries; intentionally swallowed for inspection.
    }
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

    const options =
      (await this.onChatRecovery({
        incidentId: `test:${requestId}`,
        recoveryRootRequestId: requestId,
        attempt: 1,
        maxAttempts: 6,
        recoveryKind: "continue",
        streamId,
        requestId,
        partialText: partial.text,
        partialParts: partial.parts as ChatRecoveryContext["partialParts"],
        recoveryData: null,
        messages: [...this.messages],
        lastBody: this._lastBody,
        lastClientTools: this._lastClientTools,
        createdAt
      })) ?? {};

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
    const id = `fiber-${crypto.randomUUID()}`;
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
   * Regression seam for issue #1406: simulates the internal chat fiber
   * wrapper throwing before it invokes its callback (e.g. SQLite error
   * inserting the fiber row). Verifies that the external-signal listener
   * attached by `linkExternal` is still detached and the registry entry is
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

    type RunFiberWithStashWrapper = (
      name: string,
      fn: unknown,
      options: unknown
    ) => Promise<unknown>;
    const fiberMethods = this as unknown as {
      _runFiberWithStashWrapper: RunFiberWithStashWrapper;
    };
    const originalRunFiberWithStashWrapper =
      fiberMethods._runFiberWithStashWrapper.bind(
        this
      ) as RunFiberWithStashWrapper;
    fiberMethods._runFiberWithStashWrapper = (() => {
      throw new Error("simulated runFiber failure");
    }) as RunFiberWithStashWrapper;

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
      fiberMethods._runFiberWithStashWrapper = originalRunFiberWithStashWrapper;
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

  private _readChildRunStatusForTest(runId: string): string | null {
    const rows = this.sql<{ status: string }>`
      SELECT status FROM cf_ai_chat_agent_tool_runs WHERE run_id = ${runId}
    `;
    return rows[0]?.status ?? null;
  }

  /**
   * P1 (#1630): a child facet evicted mid agent-tool run strands its
   * `cf_ai_chat_agent_tool_runs` row `running`. Its own durable chat-recovery
   * settles the turn OUTSIDE `startAgentToolRun`'s finalizer, so the `finally`
   * of BOTH recovery entrypoints must reconcile the stranded row — otherwise a
   * re-attached parent waits out a full no-progress window for an already-
   * settled child. Drives each entrypoint into a benign no-op path (no real
   * inference) that still runs its `finally`, and asserts the row finalized:
   * `completed` when a recovered assistant turn exists, else `error`.
   */
  async reconcileStaleChildRunViaRecoveryForTest(
    path: "continue" | "retry",
    withAssistantTurn: boolean
  ): Promise<{ before: string | null; after: string | null }> {
    if (withAssistantTurn) {
      // Persist a settled assistant turn directly (no streaming) so the
      // reconcile recognises a recovered turn. `persistMessages` writes the
      // message store without opening a resumable stream — a real recovered
      // turn's stream is already closed before its `finally` reconcile runs, so
      // this matches that settled state (a streamed seed would leave the stream
      // "active" with no client to ACK it in a headless test, and the reconcile
      // correctly defers while a stream is active).
      await this.persistMessages([
        {
          id: `seed-user-${crypto.randomUUID()}`,
          role: "user",
          parts: [{ type: "text", text: "seed prompt" }]
        },
        {
          id: `seed-assistant-${crypto.randomUUID()}`,
          role: "assistant",
          parts: [{ type: "text", text: "recovered answer" }]
        }
      ]);
    }
    const runId = crypto.randomUUID();
    // The child-run table (`cf_ai_chat_agent_tool_runs`) is created in the
    // AIChatAgent constructor, so strand a `running` row with no live abort
    // controller — exactly the post-eviction shape the reconcile repairs. A
    // valid `input_json` is required because the completed branch re-derives
    // output via `getAgentToolOutput(input, ...)`, which this child reads.
    this.sql`
      INSERT INTO cf_ai_chat_agent_tool_runs (run_id, status, input_json, started_at)
      VALUES (${runId}, 'running', ${JSON.stringify({ prompt: "recovered" })}, ${Date.now()})
    `;
    const before = this._readChildRunStatusForTest(runId);
    const recovery = this as unknown as {
      _chatRecoveryContinue(d?: { targetAssistantId?: string }): Promise<void>;
      _chatRecoveryRetry(d?: Record<string, never>): Promise<void>;
    };
    if (path === "continue") {
      // A non-leaf `targetAssistantId` → benign "conversation_changed" skip
      // that still reaches the `finally`.
      await recovery._chatRecoveryContinue({
        targetAssistantId: "no-such-leaf"
      });
    } else {
      // A non-user leaf (or empty transcript) → benign "no_unanswered_user_
      // message" skip that still reaches the `finally`.
      await recovery._chatRecoveryRetry({});
    }
    return { before, after: this._readChildRunStatusForTest(runId) };
  }

  /**
   * P4 (#1630): `cancelAgentToolRun` must abort not just the original in-isolate
   * run but any in-flight chat-recovery turn driving this child facet — which
   * runs outside `startAgentToolRun` and registers a request controller in the
   * `AbortRegistry` — so a torn-down child stops grinding instead of finishing
   * an orphaned recovered turn. Registers a request signal exactly as a live
   * turn does, then asserts cancel aborts it and seals the row `aborted`.
   */
  async cancelAgentToolRunAbortsRecoveryForTest(): Promise<{
    abortedBefore: boolean;
    abortedAfter: boolean;
    childStatus: string | null;
  }> {
    const runId = crypto.randomUUID();
    this.sql`
      INSERT INTO cf_ai_chat_agent_tool_runs (run_id, status, started_at)
      VALUES (${runId}, 'running', ${Date.now()})
    `;
    const signal = (
      this as unknown as {
        _abortRegistry: { getSignal(id: string): AbortSignal | undefined };
      }
    )._abortRegistry.getSignal("recovered-request");
    const abortedBefore = signal?.aborted ?? false;
    await this.cancelAgentToolRun(runId, "parent gave up re-attaching");
    return {
      abortedBefore,
      abortedAfter: signal?.aborted ?? false,
      childStatus: this._readChildRunStatusForTest(runId)
    };
  }
}

export class StuckAgentToolChild extends Agent<Env> {
  override async _cf_initAsFacet(
    _name: string,
    _parentPath: ReadonlyArray<{ className: string; name: string }> = [],
    _identityName = _name
  ): Promise<void> {
    await new Promise<void>(() => {
      // Intentionally never resolves: simulates a child facet wedged in startup.
    });
  }

  async startAgentToolRun(): Promise<AgentToolRunInspection> {
    throw new Error("stuck child should never start");
  }

  async cancelAgentToolRun(): Promise<void> {}

  async inspectAgentToolRun(): Promise<AgentToolRunInspection | null> {
    throw new Error("stuck child should never be inspected");
  }

  async getAgentToolChunks(): Promise<AgentToolStoredChunk[]> {
    return [];
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
    childInspectionTimeoutMs?: number;
    reattachTimeoutMs?: number;
  }): Promise<Array<() => Promise<void>>> {
    return (
      this as unknown as {
        _reconcileAgentToolRuns(options?: {
          deferFinishHooks?: boolean;
          childInspectionTimeoutMs?: number;
          reattachTimeoutMs?: number;
        }): Promise<Array<() => Promise<void>>>;
      }
    )._reconcileAgentToolRuns(options);
  }

  private async scheduleAgentToolRunRecoveryForTest(options?: {
    childInspectionTimeoutMs?: number;
  }): Promise<void> {
    await (
      this as unknown as {
        _scheduleAgentToolRunRecovery(options?: {
          childInspectionTimeoutMs?: number;
        }): Promise<void>;
      }
    )._scheduleAgentToolRunRecovery(options);
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

  /**
   * A still-running child that reaches terminal *during* the parent's bounded
   * re-attach window: reconciliation should tail it to terminal and finalize
   * the parent row `completed` instead of abandoning it `interrupted` (#1630).
   */
  async reconcileRunningChildForTest(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    status: string | null;
  }> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    // Short delay: still running when reconciliation starts, then terminal a
    // moment later — within the generous re-attach budget.
    const started = await child.startAgentToolRun(
      { ...input, delayMs: input.delayMs ?? 200 },
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
    await this.reconcileAgentToolRunsForTest({ reattachTimeoutMs: 30_000 });

    return {
      events: this.events,
      finishes: this.finishes,
      status: this.getParentAgentToolStatusForTest(runId)
    };
  }

  /**
   * A tail-able child whose turn never reaches terminal: reconciliation must
   * re-attach, tail until the bounded re-attach budget is spent, then seal the
   * parent row `interrupted` so a genuinely hung child can never block recovery
   * forever (#1630). A small budget threaded through the seam keeps it fast.
   */
  async reattachStuckTailableChildForTest(
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    elapsedMs: number;
    status: string | null;
  }> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    const started = await child.startAgentToolRun(
      { prompt: "stuck tailable child", delayMs: 60_000 },
      { runId }
    );
    this.insertRecoverableParentRunForTest(
      runId,
      "AIChatAgentToolChild",
      "stuck tailable child",
      started.startedAt
    );

    this.events = [];
    this.finishes = [];
    const startedAt = Date.now();
    try {
      await this.reconcileAgentToolRunsForTest({ reattachTimeoutMs: 200 });
    } finally {
      await child.cancelAgentToolRun(runId, "test cleanup");
    }
    return {
      events: this.events,
      finishes: this.finishes,
      elapsedMs: Date.now() - startedAt,
      status: this.getParentAgentToolStatusForTest(runId)
    };
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

  async reconcileStuckChildWithTimeoutForTest(
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    elapsedMs: number;
    status: string | null;
  }> {
    this.insertRecoverableParentRunForTest(
      runId,
      "StuckAgentToolChild",
      "stuck child",
      Date.now()
    );

    this.events = [];
    this.finishes = [];
    const startedAt = Date.now();
    await this.reconcileAgentToolRunsForTest({ childInspectionTimeoutMs: 10 });
    return {
      events: this.events,
      finishes: this.finishes,
      elapsedMs: Date.now() - startedAt,
      status: this.getParentAgentToolStatusForTest(runId)
    };
  }

  async scheduleStuckChildRecoveryForTest(
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    status: string | null;
  }> {
    this.insertRecoverableParentRunForTest(
      runId,
      "StuckAgentToolChild",
      "scheduled stuck child",
      Date.now()
    );

    this.events = [];
    this.finishes = [];
    await this.scheduleAgentToolRunRecoveryForTest({
      childInspectionTimeoutMs: 10
    });
    return {
      events: this.events,
      finishes: this.finishes,
      status: this.getParentAgentToolStatusForTest(runId)
    };
  }

  async scheduleStuckChildRecoveryTwiceForTest(
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    status: string | null;
  }> {
    this.insertRecoverableParentRunForTest(
      runId,
      "StuckAgentToolChild",
      "single flight stuck child",
      Date.now()
    );

    this.events = [];
    this.finishes = [];
    const first = this.scheduleAgentToolRunRecoveryForTest({
      childInspectionTimeoutMs: 10
    });
    const second = this.scheduleAgentToolRunRecoveryForTest({
      childInspectionTimeoutMs: 10
    });
    await Promise.all([first, second]);
    return {
      events: this.events,
      finishes: this.finishes,
      status: this.getParentAgentToolStatusForTest(runId)
    };
  }

  getParentAgentToolStatusForTest(runId: string): string | null {
    const rows = this.sql<{ status: string }>`
      SELECT status FROM cf_agent_tool_runs WHERE run_id = ${runId} LIMIT 1
    `;
    return rows[0]?.status ?? null;
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

    type BroadcastStoredChunksFromAdapter = (
      adapter: unknown,
      row: unknown,
      sequence: number,
      replay?: true,
      connection?: unknown
    ) => Promise<number>;
    const self = this as unknown as {
      _broadcastAgentToolStoredChunksFromAdapter: BroadcastStoredChunksFromAdapter;
    };
    const original = self._broadcastAgentToolStoredChunksFromAdapter.bind(
      this
    ) as BroadcastStoredChunksFromAdapter;
    self._broadcastAgentToolStoredChunksFromAdapter = async () => {
      throw new Error("test replay failure");
    };
    try {
      await this.reconcileAgentToolRunsForTest();
    } finally {
      self._broadcastAgentToolStoredChunksFromAdapter = original;
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

  // P1/P4 (#1630): the child-side seams must run on the child AS A FACET of this
  // parent (its `cf_agent_tool_child_runs` table only has SQL when created via
  // `subAgent`, not when addressed standalone), so route through the parent.
  async childReconcileStaleRunViaRecoveryForTest(
    path: "continue" | "retry",
    withAssistantTurn: boolean
  ): Promise<{ before: string | null; after: string | null }> {
    const child = await this.subAgent(
      AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.reconcileStaleChildRunViaRecoveryForTest(
      path,
      withAssistantTurn
    );
  }

  async childCancelAgentToolRunAbortsRecoveryForTest(): Promise<{
    abortedBefore: boolean;
    abortedAfter: boolean;
    childStatus: string | null;
  }> {
    const child = await this.subAgent(
      AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.cancelAgentToolRunAbortsRecoveryForTest();
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
