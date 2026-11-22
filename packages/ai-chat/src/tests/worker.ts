import {
  AIChatAgent,
  type ChatResponseResult,
  type OnChatMessageOptions,
  type SaveMessagesResult
} from "../";
import type {
  UIMessage as ChatMessage,
  GenerateTextOnFinishCallback,
  ToolSet
} from "ai";
import {
  Agent,
  type AgentContext,
  getAgentByName,
  getCurrentAgent,
  routeAgentRequest
} from "agents";
import { MessageType, type OutgoingMessage } from "../types";
import type {
  Connection,
  WSMessage,
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
import {
  CHAT_RECOVERY_TASK_NAME,
  ResumableStream,
  chatRecoveryTaskRunOptions,
  toolResultUpdate,
  type ChatTurns,
  type ToolPartUpdate
} from "agents/chat";

// Type helper for tool call parts - extracts from ChatMessage parts
type TestToolCallPart = Extract<
  ChatMessage["parts"][number],
  { type: `tool-${string}` }
>;

/**
 * Leave an interrupted turn the way production leaves one. A chat turn
 * (`CHAT_FIBER_NAME:<requestId>`) is a chat-turn Task run whose closure died
 * with its isolate, plus the snapshot it stored; anything else is a fiber
 * row. A restart replays the run as Tasks does any unfinished run, and
 * {@link recoverInterruptedTurnsForTest} replays it at once.
 */
async function insertInterruptedTurnForTest(
  agent: AIChatAgent,
  storage: DurableObjectStorage,
  name: string,
  snapshot?: unknown
): Promise<void> {
  const prefix = `${AIChatAgent.CHAT_FIBER_NAME}:`;
  if (!name.startsWith(prefix)) {
    agent.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${`fiber-${crypto.randomUUID()}`}, ${name},
              ${snapshot ? JSON.stringify(snapshot) : null}, ${Date.now()})
    `;
    return;
  }
  const nonce = crypto.randomUUID();
  const runId = `chat_${nonce}`;
  const requestId = name.slice(prefix.length);
  if (snapshot) {
    await storage.put(`__cf_chat_turn_snapshot:${runId}`, snapshot);
  }
  // Make sure the Tasks tables exist before writing a row into them.
  await agent.tasks.get(runId);
  const now = Date.now();
  agent.sql`
    INSERT INTO cf_agents_task_runs
      (run_id, definition, input, state, metadata, idempotency_key, retain,
       attempt, next_at, cancel_requested, created_at, updated_at)
    VALUES
      (${runId}, ${AIChatAgent.CHAT_FIBER_NAME},
       ${JSON.stringify({ requestId, continuation: false, nonce })}, 'pending',
       ${JSON.stringify({ requestId })}, NULL, 0, 0, ${now}, 0, ${now}, ${now})
  `;
}

/**
 * Replay what {@link insertInterruptedTurnForTest} left, as a wake does: each
 * unfinished chat-turn Task run runs again with no live closure, which hands
 * its turn to chat recovery, then the fiber scan recovers fiber rows.
 */
async function recoverInterruptedTurnsForTest(
  agent: AIChatAgent
): Promise<void> {
  const runs = agent.sql<{ run_id: string; input: string; metadata: string }>`
    SELECT run_id, input, metadata FROM cf_agents_task_runs
    WHERE definition = ${AIChatAgent.CHAT_FIBER_NAME} AND state = 'pending'
    ORDER BY created_at
  `;
  for (const run of runs) {
    // Accepted again under its id, so this invocation runs it.
    agent.sql`DELETE FROM cf_agents_task_runs WHERE run_id = ${run.run_id}`;
    await agent.tasks.__DO_NOT_USE_WILL_BREAK__runAttached(
      AIChatAgent.CHAT_FIBER_NAME,
      JSON.parse(run.input),
      { runId: run.run_id, retain: false, metadata: JSON.parse(run.metadata) }
    );
  }
  await (
    agent as unknown as { _checkRunFibers(): Promise<void> }
  )._checkRunFibers();
}

/** The STORED rows, reassembled from their continuation rows. */
async function persistedMessages(agent: AIChatAgent): Promise<ChatMessage[]> {
  const history = await agent.sessions.session().getHistory();
  return history as ChatMessage[];
}

const sessionChangeCounters = new WeakMap<AIChatAgent, { count: number }>();

/**
 * Count of Sessions change-feed events seen by this instance. Arming is lazy
 * and idempotent: the first read subscribes and returns 0.
 */
function sessionChangeEventCount(agent: AIChatAgent): number {
  const existing = sessionChangeCounters.get(agent);
  if (existing) return existing.count;
  const counter = { count: 0 };
  sessionChangeCounters.set(agent, counter);
  agent.sessions.subscribe(() => {
    counter.count++;
  });
  return counter.count;
}

async function persistedMessageCount(agent: AIChatAgent): Promise<number> {
  return (await agent.sessions.session().getHistory()).length;
}

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

/**
 * An SSE response that streams a partial assistant turn (start + a text delta)
 * and then HANGS — the stream never closes and never emits another chunk. Used
 * to exercise the `chatStreamStallTimeoutMs` inactivity watchdog (#1626): the
 * gap after the last delta trips the watchdog, which aborts the turn into
 * bounded recovery.
 */
function makeHangingSSEResponse() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of [
        { type: "start" },
        { type: "text-start" },
        { type: "text-delta", delta: "partial before stall" }
      ]) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
        );
      }
      // Intentionally never enqueue more or close: a hung provider.
    },
    cancel() {}
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" }
  });
}

export type FailingReaderPrelude =
  | "partial"
  | "approval"
  | "start-only"
  | "none";

/**
 * An SSE response whose reader throws `errorMessage` after `prelude`, the way
 * a dropped platform connection surfaces mid-stream (#1964).
 */
function makeFailingSSEResponse(
  errorMessage: string,
  prelude: FailingReaderPrelude = "partial",
  responseHeaders?: Record<string, string>
) {
  const encoder = new TextEncoder();
  const chunks = {
    partial: [
      { type: "start" },
      { type: "text-start" },
      { type: "text-delta", delta: "partial before failure" }
    ],
    approval: [
      { type: "start" },
      {
        type: "tool-input-available",
        toolCallId: "call-approval",
        toolName: "deleteFile",
        input: { path: "notes.txt" }
      },
      {
        type: "tool-approval-request",
        approvalId: "approval-1",
        toolCallId: "call-approval"
      }
    ],
    "start-only": [{ type: "start" }],
    none: []
  }[prelude];
  const stream = new ReadableStream({
    async pull(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      // A provider error carries its response headers (AI SDK
      // `APICallError.responseHeaders`).
      controller.error(
        responseHeaders
          ? Object.assign(new Error(errorMessage), { responseHeaders })
          : new Error(errorMessage)
      );
    }
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" }
  });
}

export type Env = {
  TestChatAgent: DurableObjectNamespace<TestChatAgent>;
  CustomSanitizeAgent: DurableObjectNamespace<CustomSanitizeAgent>;
  OverridingPersistAgent: DurableObjectNamespace<OverridingPersistAgent>;
  OverridingPersistMergeAgent: DurableObjectNamespace<OverridingPersistMergeAgent>;
  AgentWithSuperCall: DurableObjectNamespace<AgentWithSuperCall>;
  AgentWithoutSuperCall: DurableObjectNamespace<AgentWithoutSuperCall>;
  LogOnlyOnErrorAgent: DurableObjectNamespace<LogOnlyOnErrorAgent>;
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
  AsyncStartAdmissionAgent: DurableObjectNamespace<AsyncStartAdmissionAgent>;
  AIChatAgentToolParent: DurableObjectNamespace<AIChatAgentToolParent>;
  AIChatAgentToolChild: DurableObjectNamespace<AIChatAgentToolChild>;
  StuckAgentToolChild: DurableObjectNamespace<StuckAgentToolChild>;
};

export class TestChatAgent extends AIChatAgent<Env> {
  /**
   * Stand in for a child restarted mid-run (#2298): a persisted in-flight
   * agent-tool run with empty in-memory state, rebound to a recovery turn's
   * request id, whose chunk is then broadcast.
   */
  broadcastRecoveredAgentToolChunkForTest(
    eventDelivery: "full" | "terminal"
  ): void {
    this.sql`
      insert into cf_ai_chat_agent_tool_runs
        (run_id, request_id, status, started_at, event_delivery)
      values (${crypto.randomUUID()}, 'pre-restart', 'running', ${Date.now()},
        ${eventDelivery === "terminal" ? "terminal" : null})
    `;
    this["_agentToolRuns"].rebind("recovered-request", "pre-restart");
    this.broadcast(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        id: "recovered-request",
        body: JSON.stringify({ type: "text-delta", id: "t", delta: "hi" }),
        done: false
      })
    );
  }
  /** Messages the chat protocol left to the app's `onMessage`. */
  private _forwardedMessages: string[] = [];

  override onMessage(_connection: Connection, message: WSMessage): void {
    if (typeof message === "string") this._forwardedMessages.push(message);
  }

  forwardedMessagesForTest(): string[] {
    return this._forwardedMessages;
  }

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
  private _failedFirstContinuation = false;
  private _releaseHeldTurnQueue: (() => void) | null = null;

  private _fallbackOnFailedContinuation = false;
  private _handlingResponse = false;
  private _reentrantResponseHooks = 0;
  private _responseStatuses: string[] = [];

  /**
   * Make `onChatResponse` answer a failed continuation with a fallback
   * message through `saveMessages`, the way an app would.
   */
  setFallbackOnFailedContinuationForTest(value: boolean): void {
    this._fallbackOnFailedContinuation = value;
  }

  responseHookReportForTest(): { statuses: string[]; reentrant: number } {
    return {
      statuses: this._responseStatuses,
      reentrant: this._reentrantResponseHooks
    };
  }

  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    if (this._handlingResponse) this._reentrantResponseHooks++;
    this._handlingResponse = true;
    try {
      this._responseStatuses.push(
        `${result.continuation ? "continuation" : "turn"}:${result.status}`
      );
      if (
        this._fallbackOnFailedContinuation &&
        result.continuation &&
        result.status === "error"
      ) {
        this._fallbackOnFailedContinuation = false;
        this.setTestBody({});
        await this.saveMessages([
          ...this.messages,
          {
            id: "fallback-question",
            role: "user",
            parts: [{ type: "text", text: "Try again without the tool" }]
          }
        ]);
      }
    } finally {
      this._handlingResponse = false;
    }
  }

  /** Put a turn that does nothing at the front of the queue until released. */
  holdTurnQueueForTest(): void {
    const held = new Promise<void>((resolve) => {
      this._releaseHeldTurnQueue = resolve;
    });
    void (
      this as unknown as {
        _turnQueue: {
          enqueue(id: string, fn: () => Promise<void>): Promise<unknown>;
        };
      }
    )._turnQueue.enqueue("held-for-test", () => held);
  }

  releaseTurnQueueForTest(): void {
    this._releaseHeldTurnQueue?.();
    this._releaseHeldTurnQueue = null;
  }

  /** The request id of the continuation waiting to run, if any. */
  pendingContinuationRequestIdForTest(): string | null {
    return (
      (
        this as unknown as {
          _continuation: { pending: { requestId: string } | null };
        }
      )._continuation.pending?.requestId ?? null
    );
  }

  private _persistDelayForTest: {
    role: "user" | "assistant";
    ms: number;
  } | null = null;

  /**
   * Make `persistMessages` wait before it writes when the last message has
   * `role`, the way an app's override that awaits before `super` does.
   */
  setPersistDelayForTest(role: "user" | "assistant", ms: number): void {
    this._persistDelayForTest = { role, ms };
  }

  /** `saveMessages` with one more user message; returns the status. */
  async saveUserMessageForTest(text: string): Promise<string> {
    const result = await this.saveMessages([
      ...this.messages,
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text }]
      }
    ]);
    return result.status;
  }

  private _laterNoteForTest: { ms: number } | null = null;

  /**
   * Make the next `persistMessages` of a user message start work that
   * stores a note `ms` later, the way an override's fire-and-forget does.
   */
  storeNoteLaterFromPersistForTest(ms: number): void {
    this._laterNoteForTest = { ms };
  }

  override async persistMessages(
    messages: ChatMessage[],
    excludeBroadcastIds: string[] = [],
    options?: { _deleteStaleRows?: boolean }
  ) {
    const later = this._laterNoteForTest;
    if (later && messages.at(-1)?.role === "user") {
      this._laterNoteForTest = null;
      setTimeout(() => {
        void this.persistMessages([
          ...this.messages,
          {
            id: "note-later",
            role: "assistant",
            parts: [{ type: "text", text: "Stored later." }]
          }
        ]);
      }, later.ms);
    }
    const wait = this._persistDelayForTest;
    if (wait && messages.at(-1)?.role === wait.role) {
      await new Promise((resolve) => setTimeout(resolve, wait.ms));
    }
    return super.persistMessages(messages, excludeBroadcastIds, options);
  }

  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    this._chatMessageCallCount++;
    // What the model request would hold: tool calls with no result.
    this._unansweredAtModelCall = this.messages.flatMap((message) =>
      message.parts.flatMap((part) => {
        const record = part as { toolCallId?: string; state?: string };
        return record.toolCallId &&
          (record.state === "input-available" ||
            record.state === "approval-requested")
          ? [record.toolCallId]
          : [];
      })
    );
    // Assistant messages the model request would end a turn of in reasoning.
    this._endsInReasoningAtModelCall = this.messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          message.parts.at(-1)?.type === "reasoning"
      )
      .map((message) => message.id);
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

    // Every continuation fails before it produces a response.
    if (
      options?.continuation === true &&
      options.body?.failContinuations === true
    ) {
      throw new Error("The model is unavailable");
    }

    // The first continuation fails before it produces a response.
    if (
      options?.continuation === true &&
      options.body?.failFirstContinuation === true &&
      !this._failedFirstContinuation
    ) {
      this._failedFirstContinuation = true;
      throw new Error("The model is unavailable");
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

    // A turn that ends on a client tool call. The continuation that answers
    // its result falls through to the plain reply.
    if (options?.body?.clientToolCall === true && !options.continuation) {
      return makeSSEChunkResponse([
        { type: "start" },
        {
          type: "tool-input-available",
          toolCallId: "call-turn",
          toolName: "testTool",
          input: {}
        },
        { type: "finish" }
      ]);
    }

    // A server tool starts running and its stream never finishes: only a
    // stop, a stall or an eviction ends it.
    if (options?.body?.serverToolThenHang === true) {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of [
              { type: "start" },
              {
                type: "tool-input-available",
                toolCallId: "call-server-hang",
                toolName: "slowServerTool",
                input: {}
              }
            ]) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
              );
            }
          },
          cancel() {}
        }),
        { headers: { "Content-Type": "text/event-stream" } }
      );
    }

    // The reply writes text, then the model's reasoning, and never
    // finishes: only a stop, a stall or an eviction ends it.
    if (options?.body?.reasoningThenHang === true) {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            // `hangIn` picks where the reply hangs: in its reasoning with
            // no text before it, or in the middle of its text.
            const hangIn = options?.body?.hangIn;
            const text = [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "Partial answer" }
            ];
            const reasoning = [
              { type: "reasoning-start", id: "r" },
              { type: "reasoning-delta", id: "r", delta: "Let me think" },
              { type: "reasoning-end", id: "r" }
            ];
            for (const chunk of [
              { type: "start" },
              { type: "start-step" },
              ...(hangIn === "reasoning"
                ? reasoning
                : hangIn === "text"
                  ? text
                  : [...text, { type: "text-end", id: "t" }, ...reasoning])
            ]) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
              );
            }
          },
          cancel() {}
        }),
        { headers: { "Content-Type": "text/event-stream" } }
      );
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

    // A custom stream that emits the approval request before the canonical
    // tool input, with no input deltas (#1872).
    if (options?.body?.lateToolInput === true) {
      return makeSSEChunkResponse([
        { type: "start" },
        {
          type: "tool-input-start",
          toolCallId: "call-late-input",
          toolName: "deleteFile"
        },
        {
          type: "tool-approval-request",
          toolCallId: "call-late-input",
          approvalId: "approval-late-input"
        },
        {
          type: "tool-input-available",
          toolCallId: "call-late-input",
          toolName: "deleteFile",
          input: { path: "notes.txt" }
        },
        { type: "finish" }
      ]);
    }

    // Mirrors the common provider (e.g. Workers AI) that emits a `start`
    // chunk WITHOUT a messageId, so the server must stamp its allocated id.
    if (options?.body?.sseWithoutMessageId === true) {
      return makeSSEChunkResponse([
        { type: "start" },
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

    // A hand-written stream that carries a client tool call and the answer
    // in one step: no `start-step` between them, finish reason `stop`.
    if (
      options?.body?.answerInSameStepAsToolCall === true &&
      !options.continuation
    ) {
      return makeDelayedSSEChunkResponse(
        [
          { type: "start" },
          {
            type: "tool-input-available",
            toolCallId: "call_same_step",
            toolName: "fastClientTool",
            input: {}
          },
          { type: "text-start", id: "text_same_step" },
          {
            type: "text-delta",
            id: "text_same_step",
            delta: "Here is the answer."
          },
          { type: "text-end", id: "text_same_step" },
          { type: "finish", finishReason: "stop" }
        ],
        75,
        options.abortSignal
      );
    }

    // Reproduce a client-tool result that round-trips while the original
    // multi-step stream is still active, followed by a final assistant step and
    // a normal stop. A second auto-continuation would be stale.
    if (options?.body?.consumeClientToolResultWithinStream === true) {
      if (options.continuation) {
        return new Response("Unexpected stale continuation");
      }
      return makeDelayedSSEChunkResponse(
        [
          { type: "start" },
          { type: "start-step" },
          {
            type: "tool-input-available",
            toolCallId: "call_consumed_within_stream",
            toolName: "fastClientTool",
            input: {}
          },
          { type: "finish-step" },
          { type: "start-step" },
          { type: "text-start", id: "text_after_client_tool" },
          {
            type: "text-delta",
            id: "text_after_client_tool",
            delta: "The tool result was handled."
          },
          { type: "text-end", id: "text_after_client_tool" },
          { type: "finish-step" },
          { type: "finish", finishReason: "stop" }
        ],
        75,
        options.abortSignal
      );
    }

    // A stop with a sibling tool call still unanswered: the continuation opted
    // into by the first result must survive until the sibling answers.
    if (options?.body?.stopWithPendingSibling === true) {
      if (options.continuation) {
        return makeSSEChunkResponse([
          { type: "start" },
          { type: "start-step" },
          { type: "text-start", id: "text_after_batch" },
          { type: "text-delta", id: "text_after_batch", delta: "Both done." },
          { type: "text-end", id: "text_after_batch" },
          { type: "finish-step" },
          { type: "finish", finishReason: "stop" }
        ]);
      }
      return makeDelayedSSEChunkResponse(
        [
          { type: "start" },
          { type: "start-step" },
          {
            type: "tool-input-available",
            toolCallId: "call_sibling_a",
            toolName: "fastClientTool",
            input: {}
          },
          {
            type: "tool-input-available",
            toolCallId: "call_sibling_b",
            toolName: "fastClientTool",
            input: {}
          },
          { type: "text-start", id: "text_with_pending_sibling" },
          {
            type: "text-delta",
            id: "text_with_pending_sibling",
            delta: "Waiting on the tools."
          },
          { type: "text-end", id: "text_with_pending_sibling" },
          { type: "finish-step" },
          { type: "finish", finishReason: "stop" }
        ],
        75,
        options.abortSignal
      );
    }

    // Companion control: when the stream stops at the tool call, the result has
    // not yet been consumed and stream finalization must still re-arm it.
    if (options?.body?.finishWithUnconsumedClientTool === true) {
      if (options.continuation) {
        return new Response("Expected tool continuation");
      }
      return makeDelayedSSEChunkResponse(
        [
          { type: "start" },
          { type: "start-step" },
          {
            type: "tool-input-available",
            toolCallId: "call_unconsumed_at_stream_end",
            toolName: "fastClientTool",
            input: {}
          },
          { type: "finish-step" },
          { type: "finish", finishReason: "tool-calls" }
        ],
        75,
        options.abortSignal
      );
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

  // Test helper: apply a tool result the way the tool-result handler does,
  // with no auto-continuation, so tests can exercise the idempotency branch
  // (issue #1404).
  async testApplyToolResult(
    toolCallId: string,
    toolName: string,
    output: unknown,
    overrideState?: "output-error",
    errorText?: string
  ): Promise<boolean> {
    const self = this as unknown as {
      _applyToolPartUpdate(
        update: ToolPartUpdate
      ): Promise<{ status: "changed" | "unchanged" | "missing" }>;
      _turns: {
        applyInteraction(
          apply: () => Promise<unknown>,
          autoContinue: boolean,
          spec: () => never,
          enqueue: (run: () => Promise<boolean>) => Promise<boolean>
        ): Promise<boolean>;
      };
    };
    void toolName;
    return self._turns.applyInteraction(
      () =>
        self._applyToolPartUpdate(
          toolResultUpdate(toolCallId, output, overrideState, errorText)
        ),
      false,
      () => {
        throw new Error("no continuation without autoContinue");
      },
      (run) => this._enqueueInteractionApply(run)
    );
  }

  /** How many applies went through the overridable enqueue hook. */
  private _interactionAppliesSeen = 0;

  getInteractionAppliesSeenForTest(): number {
    return this._interactionAppliesSeen;
  }

  protected override _enqueueInteractionApply(
    apply: () => Promise<boolean>
  ): Promise<boolean> {
    this._interactionAppliesSeen++;
    return super._enqueueInteractionApply(apply);
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

  waitUntilStableForTest(options?: { timeout?: number }): Promise<boolean> {
    return this.waitUntilStable(options);
  }

  setTestBody(body: Record<string, unknown>): void {
    const context = (
      this as unknown as {
        _requestContext: { body: typeof body; persist(): void };
      }
    )._requestContext;
    context.body = body;
    context.persist();
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

  abortAllRequestsForTest(): void {
    this.abortAllRequests();
  }

  private _unansweredAtModelCall: string[] = [];

  private _endsInReasoningAtModelCall: string[] = [];

  /** Assistant messages that ended in reasoning when the model was called. */
  getEndsInReasoningAtModelCallForTest(): string[] {
    return this._endsInReasoningAtModelCall;
  }

  /** The client tools stored for later turns. */
  getStoredClientToolsForTest(): ClientToolSchema[] | undefined {
    return this._lastClientTools;
  }

  /** Store client tools as a request that sent them would. */
  setClientToolsForTest(clientTools: ClientToolSchema[]): void {
    this._lastClientTools = clientTools;
  }

  /** Tool calls with no result in the transcript the last turn's model saw. */
  getUnansweredAtModelCallForTest(): string[] {
    return this._unansweredAtModelCall;
  }

  hasPendingInteractionForTest(): boolean {
    return this.hasPendingInteraction();
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
    return this._resumableStream.getAllStreamMetadata()[0]?.status ?? null;
  }

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
  }

  async getMessagesForTest(): Promise<ChatMessage[]> {
    // `this.messages` hydrates in `onStart`; native RPC bypasses fetch, so a
    // freshly woken object has to start the lifecycle before reading it.
    await this.__unsafe_ensureInitialized();
    return this.messages as ChatMessage[];
  }

  /**
   * Count of Sessions change-feed events. An unchanged row writes nothing and
   * dispatches no event, so this is the observable no-op signal.
   */
  sessionChangeEventCountForTest(): number {
    return sessionChangeEventCount(this);
  }

  /** Continuation rows the store currently holds for this object. */
  continuationRowCountForTest(): number {
    return Number(
      this.ctx.storage.sql
        .exec("SELECT COUNT(*) AS count FROM cf_agents_session_message_chunks")
        .one().count
    );
  }

  async clearSessionForTest(): Promise<void> {
    await this.sessions.session().clearMessages();
    this.messages = [];
  }

  seedLegacyMessagesForTest(): void {
    this.sql`
      CREATE TABLE cf_ai_chat_agent_messages (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    this.sql`
      INSERT INTO cf_ai_chat_agent_messages (id, message, created_at)
      VALUES (
        'legacy-v4',
        ${JSON.stringify({ id: "legacy-v4", role: "user", content: "old format" })},
        '2026-01-01 00:00:00'
      )
    `;
    this.sql`
      INSERT INTO cf_ai_chat_agent_messages (id, message, created_at)
      VALUES (
        'legacy-v5',
        ${JSON.stringify({ id: "legacy-v5", role: "assistant", parts: [{ type: "text", text: "new format" }] })},
        '2026-01-01 00:00:01'
      )
    `;
  }

  legacyMessageTableNamesForTest(): string[] {
    return this.ctx.storage.sql
      .exec(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'cf_ai_chat_agent_messages%'
         ORDER BY name`
      )
      .toArray()
      .map((row) => String(row.name));
  }

  /**
   * Drive the `detached: { notify }` completion hook directly (the warm-path /
   * backbone delivery is exercised elsewhere). Called `times` times to prove the
   * deterministic message id collapses re-delivery to a single injected turn.
   */
  async notifyDetachedFinishForTest(options?: {
    runId?: string;
    notifySource?: string;
    status?: AgentToolLifecycleResult["status"];
    times?: number;
  }): Promise<void> {
    const runId = options?.runId ?? "detached-notify-run";
    const status = options?.status ?? "completed";
    const internals = this as unknown as {
      _cfDetachedNotifyFinish(
        run: AgentToolRunInfo,
        result: AgentToolLifecycleResult
      ): Promise<void>;
    };
    for (let i = 0; i < (options?.times ?? 1); i++) {
      await internals._cfDetachedNotifyFinish(
        {
          runId,
          agentType: "Researcher",
          status,
          inputPreview: "detached topic",
          displayOrder: 0,
          startedAt: Date.now(),
          ...(options?.notifySource !== undefined && {
            notifySource: options.notifySource
          })
        },
        { status, summary: "detached summary" }
      );
    }
  }

  /**
   * Drive the `detached: { onMilestones }` hook directly. Called `times` times to
   * prove the deterministic message id collapses warm-path + reconcile delivery
   * to a single injected message.
   */
  async notifyDetachedMilestoneForTest(options?: {
    runId?: string;
    name?: string;
    notifySource?: string;
    times?: number;
    mode?: "react" | "narrate";
  }): Promise<void> {
    const runId = options?.runId ?? "detached-milestone-run";
    const name = options?.name ?? "sources-gathered";
    const mode = options?.mode ?? "narrate";
    const internals = this as unknown as {
      _deliverDetachedMilestone(
        run: AgentToolRunInfo,
        milestone: {
          name: string;
          sequence: number;
          at: number;
          data?: unknown;
        },
        mode: "react" | "narrate"
      ): Promise<void>;
    };
    for (let i = 0; i < (options?.times ?? 2); i++) {
      await internals._deliverDetachedMilestone(
        {
          runId,
          agentType: "Researcher",
          status: "running",
          inputPreview: "detached topic",
          displayOrder: 0,
          startedAt: Date.now(),
          ...(options?.notifySource !== undefined && {
            notifySource: options.notifySource
          })
        },
        { name, sequence: 0, at: Date.now(), data: { sources: 2 } },
        mode
      );
    }
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

  testStartStream(
    requestId: string,
    options?: { messageId?: string; continuation?: boolean }
  ): string {
    return this._startStream(requestId, options);
  }

  async testStoreStreamChunk(
    streamId: string,
    body: string
  ): Promise<number | undefined> {
    return this._storeStreamChunk(streamId, body);
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
    this._resumableStream.flushBuffer();
  }

  testCompleteStream(streamId: string): void {
    this._completeStream(streamId);
  }

  testMarkStreamError(streamId: string): void {
    this._markStreamError(streamId);
  }

  getActiveStreamId(): string | null {
    return this._resumableStream.activeStreamId;
  }

  getActiveRequestId(): string | null {
    return this._resumableStream.activeRequestId;
  }

  getStreamChunks(
    streamId: string
  ): Array<{ body: string; chunk_index: number }> {
    // Delegate to ResumableStream so tests see the same unpacked, per-chunk
    // view that production consumers get (packed segment rows are expanded).
    return this._resumableStream.getStreamChunks(streamId);
  }

  /**
   * Number of stored segments for a stream (packed segments count as 1
   * each): the appended-segment cursor, read from the block log's tail.
   * Blocks pack many segments into one row, so a row count no longer
   * reflects how the adapter batched its writes.
   */
  getStreamChunkRowCount(streamId: string): number {
    const result = this.sql<{ cnt: number | null }>`
      select max(seq_to) as cnt from cf_agents_stream_blocks
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
      insert into cf_agents_streams
        (stream_id, state, tag, metadata, chunk_count, created_at, updated_at, closed_at)
      values (${streamId}, 'completed', ${requestId}, ${JSON.stringify({ cfChat: 1 })},
              ${bodies.length}, ${now}, ${now}, ${now})
    `;
    if (bodies.length > 0) {
      this.sql`
        insert into cf_agents_stream_blocks
          (stream_id, block, seq_from, seq_to, body, created_at, updated_at)
        values (${streamId}, 0, 0, ${bodies.length},
                ${bodies.map((b) => JSON.stringify(b)).join(",")}, ${now}, ${now})
      `;
    }
  }

  getStreamMetadata(
    streamId: string
  ): { status: string; request_id: string } | null {
    return this._resumableStream.getStreamMetadata(streamId);
  }

  /**
   * Stream metadata captured at stream start, keyed by request id. The rows
   * themselves are discarded as soon as the turn's message persists, so a
   * test that wants to see what the live path recorded reads it here.
   */
  private _startedStreams = new Map<
    string,
    { id: string; message_id: string | null }
  >();

  protected override _startStream(
    requestId: string,
    options: { messageId?: string; continuation?: boolean } = {}
  ): string {
    const streamId = super._startStream(requestId, options);
    this._startedStreams.set(requestId, {
      id: streamId,
      message_id: this._resumableStream.getStreamMessageId(streamId)
    });
    return streamId;
  }

  getStartedStreamMetadata(
    requestId: string
  ): { id: string; message_id: string | null } | null {
    return this._startedStreams.get(requestId) ?? null;
  }

  getAllStreamMetadata(): Array<{
    id: string;
    status: string;
    request_id: string;
    created_at: number;
    message_id: string | null;
  }> {
    return this._resumableStream.getAllStreamMetadata();
  }

  testInsertStaleStream(
    streamId: string,
    requestId: string,
    ageMs: number
  ): void {
    this._resumableStream.insertStaleStream(streamId, requestId, ageMs);
  }

  /** Append a chunk to a stream dated `ageMs` in the past (last-activity sweep). */
  testInsertStreamChunkAt(streamId: string, ageMs: number): void {
    this._resumableStream.insertChunkAt(streamId, '{"type":"text"}', ageMs);
  }

  testInsertOldErroredStream(
    streamId: string,
    requestId: string,
    ageMs: number
  ): void {
    const createdAt = Date.now() - ageMs;
    const completedAt = createdAt + 1000;
    this.sql`
      insert into cf_agents_streams
        (stream_id, state, tag, metadata, chunk_count, created_at, updated_at, closed_at)
      values (${streamId}, 'errored', ${requestId}, ${JSON.stringify({ cfChat: 1 })},
              0, ${createdAt}, ${completedAt}, ${completedAt})
    `;
  }

  testRestoreActiveStream(): void {
    this._resumableStream.restore();
  }

  /** Reclaim leftover chat streams now, as the next stream start would. */
  testReclaimStreams(nowMs?: number): number {
    return this._resumableStream.reclaim(nowMs);
  }

  /** Number of pending stream-cleanup schedules (always 0: none are armed). */
  testCountStreamCleanupSchedules(): number {
    return this.getSchedules().filter(
      (s) => s.callback === "_cleanupStreamBuffers"
    ).length;
  }

  /**
   * Simulate DO hibernation wake by reinitializing the ResumableStream.
   * The new instance calls restore() which reads from SQLite and sets
   * _activeStreamId, but _isLive remains false (no live LLM reader).
   * This mimics the DO constructor running after eviction.
   */
  testSimulateHibernationWake(): void {
    this._resumableStream = new ResumableStream(
      this.streams,
      this.sql.bind(this)
    );
  }

  /**
   * Insert a raw JSON string as a message directly into SQLite.
   * Used to test validation of malformed/corrupt messages.
   */
  async insertRawMessage(rowId: string, rawJson: string): Promise<void> {
    const parentId =
      (await this.sessions.session().getLatestLeaf())?.id ?? null;
    this.sql`
      INSERT INTO cf_agents_session_messages
        (id, session_id, seq, parent_id, role, content, token_estimate,
         created_at)
      VALUES (
        ${rowId}, '',
        (SELECT COALESCE(MAX(seq), 0) + 1
         FROM cf_agents_session_messages WHERE session_id = ''),
        ${parentId}, 'user', ${rawJson}, 0, ${Date.now()}
      )
    `;
  }

  setMaxPersistedMessages(max: number | null): void {
    this.maxPersistedMessages = max ?? undefined;
  }

  getMessageCount(): Promise<number> {
    return persistedMessageCount(this);
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
/**
 * A subclass that overrides `persistMessages` the way application code
 * does: extra side effects, then `super` with only the messages. The
 * cutover must still reach the session write — the finished turn leaves no
 * stream row behind — even though the override forwards no third argument.
 */
export class OverridingPersistAgent extends TestChatAgent {
  private _persistOverrideCalls = 0;

  override async persistMessages(
    messages: ChatMessage[],
    excludeBroadcastIds: string[] = []
  ) {
    this._persistOverrideCalls++;
    await super.persistMessages(messages, excludeBroadcastIds);
  }

  getPersistOverrideCalls(): number {
    return this._persistOverrideCalls;
  }
}

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

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
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
  /** Reset this agent's isolate, as an eviction or a deploy does. */
  async resetIsolateForTest(): Promise<void> {
    this.ctx.abort("test: forced reset");
  }

  /** The admission records, as `ChatTurns` stores them. */
  /** The next admission record write fails, as SQLite's row limit would. */
  failNextAdmissionForTest(): void {
    const { admissions } = (this as unknown as { _turns: ChatTurns })._turns;
    const store = (
      admissions as unknown as {
        host: { store: { add: (...args: unknown[]) => void } };
      }
    ).host.store;
    const add = store.add;
    store.add = () => {
      store.add = add;
      throw new Error("SQLITE_TOOBIG: string or blob too big");
    };
  }

  /** Make every admission record `ms` older, as a long wait would. */
  ageAdmissionsForTest(ms: number): void {
    this
      .sql`UPDATE cf_agents_chat_admissions SET created_at = created_at - ${ms}`;
  }

  getAdmissionsForTest(): Array<{ requestId: string; stopped: boolean }> {
    try {
      return this.sql<{ request_id: string; stopped: number }>`
        SELECT request_id, stopped FROM cf_agents_chat_admissions ORDER BY seq
      `.map((row) => ({
        requestId: row.request_id,
        stopped: row.stopped === 1
      }));
    } catch {
      return [];
    }
  }

  /**
   * Write an admission record by hand: the record a reset leaves when it
   * lands between a turn's fiber and the record's delete.
   */
  seedAdmissionForTest(requestId: string, messageIds: string[]): void {
    const { admissions } = (this as unknown as { _turns: ChatTurns })._turns;
    admissions?.admit({
      requestId,
      messages: messageIds.map((id) => ({ id, role: "user", parts: [] })),
      afterUserId: null,
      decision: { strategy: null, overlapping: false, debounceUntilMs: null },
      payload: { trigger: "submit-message", body: {}, clientTools: undefined }
    });
    admissions?.live.delete(requestId);
  }

  /** The messages waiting requests hold, not stored yet. */
  getQueuedMessageIdsForTest(): string[] {
    return [
      ...(this as unknown as { _turns: ChatTurns })._turns.queuedMessageIds()
    ];
  }

  /** The transcript each `onChatMessage` call in this isolate saw. */
  getTranscriptsSeenForTest(): string[][] {
    return this._transcriptsSeen;
  }

  /** The body later turns run with. */
  getStoredBodyForTest(): Record<string, unknown> | undefined {
    return this._lastBody;
  }

  private _startedRequestIds: string[] = [];
  /** The transcript each `onChatMessage` call saw, by message id. */
  private _transcriptsSeen: string[][] = [];
  private _requestStartTimes = new Map<string, number>();
  private _chatResponseResults: ChatResponseResult[] = [];

  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    this._transcriptsSeen.push(this.messages.map((message) => message.id));
    if (options?.requestId) {
      this._startedRequestIds.push(options.requestId);
      this._requestStartTimes.set(options.requestId, Date.now());
      this._requestBodies.set(options.requestId, options.body);
    }

    const body = options?.body as
      | {
          format?: string;
          useAbortSignal?: boolean;
          responseDelayMs?: number;
          chunkCount?: number;
          chunkDelayMs?: number;
          streamError?: string;
          /** Emit this many text-delta chunks before the in-band error (#1575). */
          errorAfterChunks?: number;
          throwError?: boolean;
        }
      | undefined;
    const format = body?.format ?? "plaintext";
    const useAbortSignal = body?.useAbortSignal ?? false;
    const responseDelayMs = body?.responseDelayMs ?? 0;
    const chunkCount = body?.chunkCount ?? 20;
    const chunkDelayMs = body?.chunkDelayMs ?? 50;
    const streamError = body?.streamError;
    const errorAfterChunks = body?.errorAfterChunks ?? 0;
    const throwError = body?.throwError ?? false;
    const abortSignal = useAbortSignal ? options?.abortSignal : undefined;

    const failOnAbort = (options?.body as { failOnAbort?: string } | undefined)
      ?.failOnAbort;
    if (failOnAbort) {
      // Behaves like app code that passes the turn's signal on: when the
      // signal aborts, the pending work fails with the signal's reason.
      const signal = options?.abortSignal;
      const aborted = new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true
        });
      });
      this._stopWithReasonStarted?.();
      if (failOnAbort === "before-response") return aborted;
      const sse = (chunk: unknown) =>
        new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(sse({ type: "text-start", id: "t" }));
            controller.enqueue(
              sse({ type: "text-delta", id: "t", delta: "Hi" })
            );
            try {
              await aborted;
            } catch (reason) {
              if (failOnAbort === "stream") return controller.error(reason);
              // What `streamText().toUIMessageStreamResponse()` sends for
              // a failure that is not an `AbortError`.
              controller.enqueue(
                sse({ type: "error", errorText: String(reason) })
              );
              controller.close();
            }
          }
        }),
        { headers: { "Content-Type": "text/event-stream" } }
      );
    }

    if (responseDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async pull(controller) {
        if (format === "sse" && streamError) {
          // Optionally stream real content first so the in-band error
          // arrives mid-message — the #1575 partial-content scenario.
          if (errorAfterChunks > 0) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "text-start", id: "t-err" })}\n\n`
              )
            );
            for (let i = 0; i < errorAfterChunks; i++) {
              await new Promise((r) => setTimeout(r, chunkDelayMs));
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "text-delta",
                    id: "t-err",
                    delta: `partial-${i} `
                  })}\n\n`
                )
              );
            }
          }
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
              delta: `chunk-${i} `
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

  private _stopWithReasonStarted: (() => void) | undefined;
  private _onErrorCallsForTest: string[] = [];

  override onError(connection: Connection, error: unknown): void;
  override onError(error: unknown): void;
  override onError(connectionOrError: Connection | unknown, error?: unknown) {
    const thrown = error === undefined ? connectionOrError : error;
    this._onErrorCallsForTest.push(
      thrown instanceof Error ? thrown.message : String(thrown)
    );
  }

  getOnErrorCallsForTest(): string[] {
    return [...this._onErrorCallsForTest];
  }

  /**
   * A turn is stopped through its own signal while `onChatMessage` or its
   * stream waits on that signal and fails with the signal's reason.
   * Returns everything that could tell an app the turn failed.
   */
  async stopWithReasonForTest(options: {
    entry: "saveMessages" | "continueLastTurn" | "abortRequest";
    phase: "before-response" | "stream" | "error-chunk";
    reason: "none" | "string" | "error";
  }): Promise<{
    status: string;
    responses: string[];
    onErrorCalls: string[];
    errorFrames: number;
  }> {
    if (options.entry === "continueLastTurn") {
      await this.saveMessages([
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: "first turn" }]
        }
      ]);
    }
    this._chatResponseResults = [];
    this._onErrorCallsForTest = [];
    this.setTestBody({ failOnAbort: options.phase });
    const started = new Promise<void>((resolve) => {
      this._stopWithReasonStarted = resolve;
    });
    let errorFrames = 0;
    const self = this as unknown as {
      _broadcastChatMessage(...args: unknown[]): void;
      abortRequest(requestId: string, reason?: unknown): void;
      continueLastTurn(
        body?: Record<string, unknown>,
        options?: { signal?: AbortSignal }
      ): Promise<SaveMessagesResult>;
    };
    const broadcast = self._broadcastChatMessage;
    self._broadcastChatMessage = (...args) => {
      if ((args[0] as { error?: boolean }).error === true) errorFrames++;
      return broadcast.apply(this, args);
    };
    const caller = new AbortController();
    const reason =
      options.reason === "string"
        ? "caller-stop"
        : options.reason === "error"
          ? new Error("caller-stop")
          : undefined;
    try {
      const turn =
        options.entry === "continueLastTurn"
          ? self.continueLastTurn(undefined, { signal: caller.signal })
          : this.saveMessages(
              [
                ...this.messages,
                {
                  id: crypto.randomUUID(),
                  role: "user",
                  parts: [{ type: "text", text: "stop me" }]
                }
              ],
              options.entry === "saveMessages"
                ? { signal: caller.signal }
                : undefined
            );
      await started;
      if (options.entry === "abortRequest") {
        const requestId = this._startedRequestIds.at(-1);
        if (!requestId) throw new Error("no request id to abort");
        self.abortRequest(requestId, reason);
      } else {
        caller.abort(reason);
      }
      const status = await turn.then(
        (value) => value.status,
        (error) => `threw: ${error instanceof Error ? error.message : error}`
      );
      await (this as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
      return {
        status,
        responses: this._chatResponseResults.map((r) => r.status),
        onErrorCalls: [...this._onErrorCallsForTest],
        errorFrames
      };
    } finally {
      self._broadcastChatMessage = broadcast;
      this._stopWithReasonStarted = undefined;
      this.setTestBody({});
    }
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

  private _requestBodies = new Map<
    string,
    Record<string, unknown> | undefined
  >();

  /** The body `onChatMessage` got for a request. */
  getRequestBodyForTest(requestId: string): Record<string, unknown> | null {
    return this._requestBodies.get(requestId) ?? null;
  }

  abortAllRequestsForTest(): void {
    this.abortAllRequests();
  }

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
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

  resetTurnStateForTest(): void {
    this.resetTurnState();
  }

  getLastBodyForTest(): Record<string, unknown> | undefined {
    return this._lastBody;
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

  /**
   * Drive the private turn behind `saveMessages` with a
   * `shouldApplyMessages` that answers from `answers`, one per call.
   */
  async testProgrammaticTurnWithShouldApply(
    text: string,
    answers: boolean[]
  ): Promise<{ result: SaveMessagesResult; asked: number }> {
    this.setTestBody({ format: "plaintext", chunkCount: 2, chunkDelayMs: 5 });
    let asked = 0;
    const result = await (
      this as unknown as {
        _runProgrammaticMessagesTurn(
          requestId: string,
          messages: ChatMessage[],
          options: { shouldApplyMessages: () => boolean }
        ): Promise<SaveMessagesResult>;
      }
    )._runProgrammaticMessagesTurn(
      `should-apply-${crypto.randomUUID()}`,
      [
        ...this.messages,
        {
          id: `should-apply-${crypto.randomUUID()}`,
          role: "user",
          parts: [{ type: "text", text }]
        }
      ],
      { shouldApplyMessages: () => answers[asked++] ?? true }
    );
    return { result, asked };
  }

  /**
   * Queue a second `saveMessages` turn behind a running one, then call
   * `abortAllRequests()` while the second still waits in the queue.
   */
  async testQueuedSaveMessagesStoppedByAbortAllRequests(
    cancelAfterMs: number,
    body: Record<string, unknown>
  ): Promise<{ running: SaveMessagesResult; queued: SaveMessagesResult }> {
    this.setTestBody(body);
    const turn = (text: string) =>
      this.saveMessages((messages) => [
        ...messages,
        {
          id: `queued-abort-${crypto.randomUUID()}`,
          role: "user",
          parts: [{ type: "text", text }]
        }
      ]);
    setTimeout(() => {
      (this as unknown as { abortAllRequests(): void }).abortAllRequests();
    }, cancelAfterMs);
    const [running, queued] = await Promise.all([
      turn("Running"),
      turn("Queued")
    ]);
    return { running, queued };
  }

  async getPersistedUserTexts(): Promise<string[]> {
    return (await this.getPersistedMessages())
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

  /**
   * #1575: drive `ResumableStream.replayErroredChunksByRequestId` against a
   * controllable connection so the return-value contract is testable in
   * isolation: `failAfter` sends succeed, then the connection simulates a
   * post-close send (the only error `sendIfOpen` swallows). Returns the
   * method's boolean and how many frames actually went out.
   */
  replayErroredChunksByRequestIdForTest(
    requestId: string,
    failAfter: number
  ): { returned: boolean; sent: number } {
    let sent = 0;
    const fakeConnection = {
      send(_message: string) {
        if (sent >= failAfter) {
          throw new TypeError("WebSocket send() after close");
        }
        sent++;
      }
    };
    const rs = this["_resumableStream"];
    const returned = rs.replayErroredChunksByRequestId(
      fakeConnection as unknown as Parameters<
        typeof rs.replayErroredChunksByRequestId
      >[0],
      requestId
    );
    return { returned, sent };
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

  getMessageCount(): Promise<number> {
    return persistedMessageCount(this);
  }
}

/**
 * Test agent that records onChatResponse calls for verification.
 * Uses slow streaming so tests can cancel/abort mid-stream.
 */
export class ResponseAgent extends AIChatAgent<Env> {
  private _responseResults: ChatResponseResult[] = [];

  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    const body = options?.body as
      | {
          format?: string;
          chunkCount?: number;
          chunkDelayMs?: number;
          throwError?: boolean;
          streamError?: string;
          streamErrorAfterText?: boolean;
          useAbortSignal?: boolean;
          noResponse?: boolean;
        }
      | undefined;

    if (body?.noResponse) return undefined;

    const format = body?.format ?? "plaintext";
    const chunkCount = body?.chunkCount ?? 3;
    const chunkDelayMs = body?.chunkDelayMs ?? 10;
    const throwError = body?.throwError ?? false;
    const streamError = body?.streamError;
    const streamErrorAfterText = body?.streamErrorAfterText ?? false;
    const useAbortSignal = body?.useAbortSignal ?? false;
    const abortSignal = useAbortSignal ? options?.abortSignal : undefined;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async pull(controller) {
        if (format === "sse" && streamError && !streamErrorAfterText) {
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
              delta: `chunk-${i} `
            });
            controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
          } else {
            controller.enqueue(encoder.encode(`chunk-${i} `));
          }
        }
        if (format === "sse" && streamError) {
          const chunk = JSON.stringify({
            type: "error",
            errorText: streamError
          });
          controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
        } else if (format === "sse") {
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

  private _failNextAssistantPersist = false;

  /** Make the next persist that ends in an assistant message throw. */
  failNextAssistantPersist(): void {
    this._failNextAssistantPersist = true;
  }

  private _blockNextAssistantPersist = false;
  private _releaseBlockedPersist: (() => void) | null = null;

  /** Hold the next persist that ends in an assistant message until released. */
  blockNextAssistantPersist(): void {
    this._blockNextAssistantPersist = true;
  }

  isAssistantPersistBlocked(): boolean {
    return this._releaseBlockedPersist !== null;
  }

  releaseAssistantPersist(): void {
    this._releaseBlockedPersist?.();
    this._releaseBlockedPersist = null;
  }

  override async persistMessages(
    messages: ChatMessage[],
    excludeBroadcastIds: string[] = [],
    options?: { _deleteStaleRows?: boolean }
  ) {
    if (
      this._failNextAssistantPersist &&
      messages.at(-1)?.role === "assistant"
    ) {
      this._failNextAssistantPersist = false;
      throw new Error("Simulated persistence failure");
    }
    if (
      this._blockNextAssistantPersist &&
      messages.at(-1)?.role === "assistant"
    ) {
      this._blockNextAssistantPersist = false;
      await new Promise<void>((resolve) => {
        this._releaseBlockedPersist = resolve;
      });
    }
    return super.persistMessages(messages, excludeBroadcastIds, options);
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

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
  }
}

/**
 * Test agent that records onChatResponse and supports tool continuation.
 * Used to verify onChatResponse fires with continuation=true after auto-continue.
 */
export class ResponseContinuationAgent extends AIChatAgent<Env> {
  private _responseResults: ChatResponseResult[] = [];
  private _failContinuation: false | "throw" | "locked-body" = false;

  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    if (options?.continuation && this._failContinuation === "throw") {
      throw new Error("continuation failed before streaming");
    }
    if (options?.continuation && this._failContinuation === "locked-body") {
      const response = new Response("unreadable", {
        headers: { "Content-Type": "text/plain" }
      });
      response.body?.getReader();
      return response;
    }
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

  setFailContinuation(value: false | "throw" | "locked-body"): void {
    this._failContinuation = value;
  }

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
  }
}

/**
 * Test agent whose onChatResponse throws — verifies the framework handles it
 * gracefully without breaking the stream or masking the original error.
 */
export class ResponseThrowingAgent extends AIChatAgent<Env> {
  private _streamCompleted = false;

  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
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

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
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
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
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

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
  }
}

export class LatestMessageConcurrencyAgent extends SlowStreamAgent {
  messageConcurrency = "latest" as const;
}

export class MergeMessageConcurrencyAgent extends SlowStreamAgent {
  messageConcurrency = "merge" as const;
}

/**
 * {@link MergeMessageConcurrencyAgent} with a `persistMessages` override
 * that passes only the messages and the exclusions on, as an app may.
 */
export class OverridingPersistMergeAgent extends SlowStreamAgent {
  messageConcurrency = "merge" as const;

  override async persistMessages(
    messages: ChatMessage[],
    excludeBroadcastIds: string[] = []
  ) {
    await super.persistMessages(messages, excludeBroadcastIds);
  }
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

// Test agent whose onRequest throws and whose onError only logs, as the docs
// show. Its onFetchError answers with the error it received.
export class LogOnlyOnErrorAgent extends AIChatAgent<Env> {
  async onRequest(): Promise<Response> {
    throw new Error("chat request failed");
  }

  override onError(connection: Connection, error: unknown): void;
  override onError(error: unknown): void;
  override onError(_connectionOrError: Connection | unknown, _error?: unknown) {
    // Log only: return instead of rethrowing.
  }

  override onFetchError(_request: Request, error: unknown): Response {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 503 }
    );
  }

  async onChatMessage() {
    return new Response("chat response");
  }
}

// ── ChatRecoveryTestAgent (chat recovery) ─────────────────────────────

export class ChatRecoveryTestAgent extends AIChatAgent<Env> {
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
      requestId?: string;
      body?: Record<string, unknown>;
      clientTools?: ClientToolSchema[];
    }
  ) {
    this.onChatMessageCallCount++;
    this.onChatMessageBodies.push(ctx?.body);
    this.onChatMessageClientTools.push(ctx?.clientTools);
    this._recoveryRootsSeen.push(
      (
        this as unknown as {
          _chatRecoveryEngine(): { activeRootRequestId?: string };
        }
      )._chatRecoveryEngine().activeRootRequestId ?? null
    );
    if (this._throwFromNextTurn) {
      const message = this._throwFromNextTurn;
      this._throwFromNextTurn = null;
      throw new Error(message);
    }

    const hold = this._turnHold;
    if (hold && !hold.waiting) {
      hold.waiting = true;
      this._heldTurnRequestId = ctx?.requestId ?? null;
      await hold.released;
    }

    // The turn ends before the model returned a reply.
    const endBeforeReply = this._endBeforeReply;
    if (endBeforeReply) {
      this._endBeforeReply = null;
      if (endBeforeReply === "nothing") return undefined;
      throw new Error("onChatMessage failed before a reply");
    }

    if (this._hangTurnsRemaining > 0) {
      this._hangTurnsRemaining--;
      return makeHangingSSEResponse();
    }

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

    if (this._failingTurn) {
      this._failingReaderCalls++;
      const { message, remaining, prelude, responseHeaders } =
        this._failingTurn;
      this._failingTurn =
        remaining > 1
          ? { message, remaining: remaining - 1, prelude, responseHeaders }
          : null;
      return makeFailingSSEResponse(message, prelude, responseHeaders);
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

  private _throwFromNextTurn: string | null = null;
  private _recoveryRootsSeen: Array<string | null> = [];
  private _saveFromNextResponse = false;

  /** Make the next `onChatMessage` call throw `message`. */
  throwFromNextTurnForTest(message: string | null): void {
    this._throwFromNextTurn = message;
  }

  /**
   * The recovery root request id each `onChatMessage` call ran under, or
   * `null` for a turn that was not a recovery attempt's.
   */
  getRecoveryRootsSeenForTest(): Array<string | null> {
    return this._recoveryRootsSeen;
  }

  /** Make the next `onChatResponse` start a turn of its own. */
  saveFromNextResponseForTest(): void {
    this._saveFromNextResponse = true;
  }

  protected override async onChatResponse(_result: ChatResponseResult) {
    if (this._clearDuringResponseHook) {
      this._clearDuringResponseHook = false;
      this.resetTurnState();
      return;
    }
    if (!this._saveFromNextResponse) return;
    this._saveFromNextResponse = false;
    const followUp = await this.saveMessages((messages) => [
      ...messages,
      {
        id: `follow-up-${crypto.randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text: "follow-up from onChatResponse" }]
      }
    ]);
    this._followUpRequestId = followUp.requestId;
  }

  /**
   * Store text (which stays buffered) then a tool call, and report how many
   * chunks are in SQLite before and after the call.
   */
  async probeToolCallDurabilityForTest(): Promise<{
    beforeCall: number;
    afterCall: number;
  }> {
    const streamId = this._resumableStream.start("req-tool-call-durability");
    const store = (chunk: Record<string, unknown>) =>
      this._storeStreamChunk(streamId, JSON.stringify(chunk));
    const rawCount = (): number =>
      this.sql<{ count: number }>`
        SELECT COALESCE(MAX(seq_to), 0) as count FROM cf_agents_stream_blocks
        WHERE stream_id = ${streamId}
      `[0]?.count ?? 0;
    await store({ type: "reasoning-delta", id: "r", delta: "Let me look." });
    const beforeCall = rawCount();
    await store({
      type: "tool-input-available",
      toolCallId: "tc1",
      toolName: "getWeather",
      input: { city: "Paris" }
    });
    return { beforeCall, afterCall: rawCount() };
  }

  /** Holds the next onChatMessage call until released: the model is slow. */
  private _turnHold: {
    waiting: boolean;
    released: Promise<void>;
    release: () => void;
  } | null = null;

  holdNextTurnForTest(): void {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this._turnHold = { waiting: false, released, release };
  }

  private _heldTurnRequestId: string | null = null;

  /** The request id of the turn held in onChatMessage. */
  heldTurnRequestIdForTest(): string | null {
    return this._heldTurnRequestId;
  }

  isTurnHeldForTest(): boolean {
    return this._turnHold?.waiting ?? false;
  }

  releaseHeldTurnForTest(): void {
    this._turnHold?.release();
    this._turnHold = null;
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

  /**
   * Simulate the recovery continuation alarm firing inside a deploy-reset
   * window where SQL ops fail with the `SqlError`-wrapped transient
   * (`SQL query failed: <message>`, original error only in `cause`) rather
   * than the verbatim reset message (#1730). Unlike the supersede simulation
   * this shape keeps its in-process retries — the row must still be deferred
   * (not consumed) once they exhaust.
   */
  _simulateTransientErrorMessage: string | null = null;

  protected override async _chatRecoveryContinueDetached(
    ...args: Parameters<AIChatAgent<Env>["_chatRecoveryContinue"]>
  ): Promise<void> {
    if (this._simulateSupersededIsolate) {
      this._supersededThrows += 1;
      throw new Error("Durable Object reset because its code was updated.");
    }
    if (this._simulateTransientErrorMessage) {
      this._supersededThrows += 1;
      throw new Error(
        `SQL query failed: ${this._simulateTransientErrorMessage}`,
        { cause: new Error(this._simulateTransientErrorMessage) }
      );
    }
    return super._chatRecoveryContinueDetached(...args);
  }

  setSimulateSupersededIsolateForTest(value: boolean): void {
    this._simulateSupersededIsolate = value;
  }

  setSimulateTransientErrorForTest(message: string | null): void {
    this._simulateTransientErrorMessage = message;
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
      this._resumableStream.progressMarker();

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
    /** Why the incident opens. Defaults to a stall, which counts nothing. */
    trigger?: "interrupted" | "stalled";
  }): Promise<{
    incidentId: string;
    attempt: number;
    exhausted: boolean;
    reason?: string;
    interruptedAttempts?: number;
  }> {
    const { trigger = "stalled", ...identity } = input;
    const engine = (
      this as unknown as { _chatRecoveryEngine(): unknown }
    )._chatRecoveryEngine() as {
      beginIncident(
        i: typeof identity & { trigger: "interrupted" | "stalled" }
      ): Promise<{
        incident: {
          incidentId: string;
          attempt: number;
          reason?: string;
          interruptedAttempts?: number;
        };
        exhausted: boolean;
      }>;
    };
    const { incident, exhausted } = await engine.beginIncident({
      ...identity,
      trigger
    });
    return {
      incidentId: incident.incidentId,
      attempt: incident.attempt,
      exhausted,
      reason: incident.reason,
      interruptedAttempts: incident.interruptedAttempts
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
      (
        this as unknown as { _chatRecoveryEngine(): unknown }
      )._chatRecoveryEngine() as {
        updateIncident(
          id: string,
          status: string,
          reason?: string
        ): Promise<void>;
      }
    ).updateIncident(incidentId, status, reason);
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
    interruptedAttempts?: number;
    scheduled?: {
      callback: "_chatRecoveryContinue" | "_chatRecoveryRetry";
      targetMessageId?: string;
    };
  }): Promise<void> {
    await this.ctx.storage.put(
      `cf:chat-recovery:incident:${encodeURIComponent(incident.incidentId)}`,
      incident
    );
  }

  /**
   * Leave the entry an attempt writes before its isolate dies: an
   * `attemptsInFlight` entry from an isolate that no longer exists (#2613). A
   * test isolate never dies, so this is how a test reproduces a real reset.
   */
  async simulateDeadAttemptForTest(incidentId: string): Promise<void> {
    const key = `cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`;
    const incident = await this.ctx.storage.get<Record<string, unknown>>(key);
    if (!incident) throw new Error(`No recovery incident ${incidentId}`);
    await this.ctx.storage.put(key, {
      ...incident,
      attemptsInFlight: [
        { isolate: `dead-${crypto.randomUUID()}`, token: crypto.randomUUID() }
      ]
    });
  }

  /** Run a recovery callback through its real entry point. */
  async runRecoveryCallbackForTest(
    callback: "_chatRecoveryContinue" | "_chatRecoveryRetry",
    data: Record<string, unknown>
  ): Promise<void> {
    if (callback === "_chatRecoveryContinue") {
      await this._chatRecoveryContinue(data);
    } else {
      await this._chatRecoveryRetry(data);
    }
  }

  async getChatRecoveryIncidentsForTest(): Promise<unknown[]> {
    const entries = await this.ctx.storage.list({
      prefix: "cf:chat-recovery:incident:"
    });
    return [...entries.values()];
  }

  /**
   * Run a recovery continue attempt that gives up on a stable-state timeout:
   * the wait times out and the incident's attempt budget is spent. This is
   * the path production takes to the give-up.
   */
  private async _giveUpOnStableTimeoutForTest(data: {
    incidentId: string;
    originalRequestId: string;
  }): Promise<void> {
    const key = `cf:chat-recovery:incident:${encodeURIComponent(data.incidentId)}`;
    const incident = await this.ctx.storage.get<{
      attempt: number;
      maxAttempts: number;
    }>(key);
    if (incident) {
      await this.ctx.storage.put(key, {
        ...incident,
        attempt: incident.maxAttempts
      });
    }
    const forced = this._forceStableTimeout;
    this._forceStableTimeout = true;
    try {
      await super._chatRecoveryContinueDetached(data);
    } finally {
      this._forceStableTimeout = forced;
    }
  }

  /**
   * #1730 layer 3: drive the stable-timeout give-up while the durable terminal write
   * (`_recordChatTerminal`, #1645) rejects with a platform transient — the
   * exact window a give-up tends to run in. The FIRST give-up must re-throw
   * (so `Agent._executeScheduleCallback` preserves the one-shot row) and must
   * NOT seal the incident `exhausted` (a half-seal would make the deferred
   * re-run a no-op and drop the durable terminal record). The SECOND give-up
   * (the deferred re-run on a healthy isolate) must terminalize fully.
   */
  async testStableTimeoutSealTransientDefer(input: {
    transientMessage: string;
    terminalMessage: string;
  }): Promise<{
    firstThrew: boolean;
    incidentStatusAfterFirst: string | undefined;
    secondThrew: boolean;
    incidentStatusAfterSecond: string | undefined;
    terminalBroadcast: string | undefined;
    exhaustedReasons: string[];
  }> {
    const captured: ChatRecoveryExhaustedContext[] = [];
    this.chatRecovery = {
      maxAttempts: 5,
      terminalMessage: input.terminalMessage,
      onExhausted: (ctx) => {
        captured.push(ctx);
      }
    };

    const requestId = `seal-transient-${crypto.randomUUID()}`;
    const begun = await this.beginIncidentForTest({
      requestId,
      recoveryRootRequestId: requestId,
      latestUserMessageId: null,
      recoveryKind: "continue"
    });

    let terminalBroadcast: string | undefined;
    const self = this as unknown as {
      _broadcastChatMessage(
        msg: { body?: string; error?: boolean; done?: boolean },
        exclude?: string[]
      ): void;
      _recordChatTerminal(requestId: string, body: string): Promise<void>;
    };
    const realBroadcast = self._broadcastChatMessage.bind(this);
    self._broadcastChatMessage = (m, exclude) => {
      if (m.error && m.done) terminalBroadcast = m.body;
      realBroadcast(m, exclude);
    };
    const realRecordTerminal = self._recordChatTerminal.bind(this);
    let failTerminalWriteOnce = true;
    self._recordChatTerminal = async (reqId, body) => {
      if (failTerminalWriteOnce) {
        failTerminalWriteOnce = false;
        throw new Error(`SQL query failed: ${input.transientMessage}`, {
          cause: new Error(input.transientMessage)
        });
      }
      await realRecordTerminal(reqId, body);
    };

    const data = {
      incidentId: begun.incidentId,
      originalRequestId: requestId
    };
    const readIncidentStatus = async (): Promise<string | undefined> => {
      const incidents = await this.ctx.storage.list<{ status: string }>({
        prefix: "cf:chat-recovery:incident:"
      });
      return [...incidents.values()][0]?.status;
    };

    let firstThrew = false;
    try {
      await this._giveUpOnStableTimeoutForTest(data);
    } catch {
      firstThrew = true;
    }
    const incidentStatusAfterFirst = await readIncidentStatus();

    let secondThrew = false;
    try {
      await this._giveUpOnStableTimeoutForTest(data);
    } catch {
      secondThrew = true;
    } finally {
      self._broadcastChatMessage = realBroadcast;
      self._recordChatTerminal = realRecordTerminal;
    }
    const incidentStatusAfterSecond = await readIncidentStatus();

    return {
      firstThrew,
      incidentStatusAfterFirst,
      secondThrew,
      incidentStatusAfterSecond,
      terminalBroadcast,
      exhaustedReasons: captured.map((c) => c.reason)
    };
  }

  /**
   * The incident read is only for the re-entry guard. If it fails during the
   * give-up window, ai-chat should synthesize an incident and still deliver the
   * terminal UX instead of aborting terminalization.
   */
  async testStableTimeoutIncidentReadBestEffort(input: {
    transientMessage: string;
    terminalMessage: string;
  }): Promise<{
    threw: boolean;
    terminalBroadcast: string | undefined;
    exhaustedReasons: string[];
    incidentStatus: string | undefined;
  }> {
    const captured: ChatRecoveryExhaustedContext[] = [];
    this.chatRecovery = {
      maxAttempts: 5,
      terminalMessage: input.terminalMessage,
      onExhausted: (ctx) => {
        captured.push(ctx);
      }
    };

    const requestId = `read-transient-${crypto.randomUUID()}`;
    const begun = await this.beginIncidentForTest({
      requestId,
      recoveryRootRequestId: requestId,
      latestUserMessageId: null,
      recoveryKind: "continue"
    });
    const incidentKey = `cf:chat-recovery:incident:${encodeURIComponent(begun.incidentId)}`;

    let terminalBroadcast: string | undefined;
    const self = this as unknown as {
      _broadcastChatMessage(
        msg: { body?: string; error?: boolean; done?: boolean },
        exclude?: string[]
      ): void;
    };
    const realBroadcast = self._broadcastChatMessage.bind(this);
    self._broadcastChatMessage = (m, exclude) => {
      if (m.error && m.done) terminalBroadcast = m.body;
      realBroadcast(m, exclude);
    };

    const storage = this.ctx.storage as unknown as {
      get<T>(key: string): Promise<T | undefined>;
    };
    const realGet = storage.get.bind(this.ctx.storage);
    let failReadOnce = true;
    storage.get = async <T>(key: string): Promise<T | undefined> => {
      if (failReadOnce && key === incidentKey) {
        failReadOnce = false;
        throw new Error(`SQL query failed: ${input.transientMessage}`, {
          cause: new Error(input.transientMessage)
        });
      }
      return realGet<T>(key);
    };

    let threw = false;
    try {
      // The give-up alone, through its production entry: on the full
      // attempt path the failing read would be the cancelled check's.
      await (
        this as unknown as {
          _chatRecoveryEngine(): {
            exhaustRecoveryGiveUp(input: {
              callback: string;
              data: unknown;
              reason: string;
            }): Promise<void>;
          };
        }
      )
        ._chatRecoveryEngine()
        .exhaustRecoveryGiveUp({
          callback: "_chatRecoveryContinue",
          data: {
            incidentId: begun.incidentId,
            originalRequestId: requestId
          },
          reason: "stable_timeout"
        });
    } catch {
      threw = true;
    } finally {
      self._broadcastChatMessage = realBroadcast;
      storage.get = realGet;
    }

    const incidents = await this.ctx.storage.list<{ status: string }>({
      prefix: "cf:chat-recovery:incident:"
    });
    return {
      threw,
      terminalBroadcast,
      exhaustedReasons: captured.map((c) => c.reason),
      incidentStatus: [...incidents.values()][0]?.status
    };
  }

  /**
   * Once terminalization succeeds, sealing the incident is best-effort. A seal
   * write failure should not propagate back to the scheduler and cause an
   * unnecessary re-delivery of the whole give-up.
   */
  async testStableTimeoutSealWriteBestEffort(input: {
    transientMessage: string;
    terminalMessage: string;
  }): Promise<{
    threw: boolean;
    terminalBroadcast: string | undefined;
    exhaustedReasons: string[];
    incidentStatus: string | undefined;
  }> {
    const captured: ChatRecoveryExhaustedContext[] = [];
    this.chatRecovery = {
      maxAttempts: 5,
      terminalMessage: input.terminalMessage,
      onExhausted: (ctx) => {
        captured.push(ctx);
      }
    };

    const requestId = `seal-write-transient-${crypto.randomUUID()}`;
    const begun = await this.beginIncidentForTest({
      requestId,
      recoveryRootRequestId: requestId,
      latestUserMessageId: null,
      recoveryKind: "continue"
    });
    const incidentKey = `cf:chat-recovery:incident:${encodeURIComponent(begun.incidentId)}`;

    let terminalBroadcast: string | undefined;
    const self = this as unknown as {
      _broadcastChatMessage(
        msg: { body?: string; error?: boolean; done?: boolean },
        exclude?: string[]
      ): void;
    };
    const realBroadcast = self._broadcastChatMessage.bind(this);
    self._broadcastChatMessage = (m, exclude) => {
      if (m.error && m.done) terminalBroadcast = m.body;
      realBroadcast(m, exclude);
    };

    const storage = this.ctx.storage as unknown as {
      put(key: string, value: unknown): Promise<void>;
    };
    const realPut = storage.put.bind(this.ctx.storage);
    let failSealWriteOnce = true;
    storage.put = async (key, value): Promise<void> => {
      if (
        failSealWriteOnce &&
        key === incidentKey &&
        typeof value === "object" &&
        value !== null &&
        (value as { status?: string }).status === "exhausted"
      ) {
        failSealWriteOnce = false;
        throw new Error(`SQL query failed: ${input.transientMessage}`, {
          cause: new Error(input.transientMessage)
        });
      }
      await realPut(key, value);
    };

    let threw = false;
    try {
      await this._giveUpOnStableTimeoutForTest({
        incidentId: begun.incidentId,
        originalRequestId: requestId
      });
    } catch {
      threw = true;
    } finally {
      self._broadcastChatMessage = realBroadcast;
      storage.put = realPut;
    }

    const incidents = await this.ctx.storage.list<{ status: string }>({
      prefix: "cf:chat-recovery:incident:"
    });
    return {
      threw,
      terminalBroadcast,
      exhaustedReasons: captured.map((c) => c.reason),
      incidentStatus: [...incidents.values()][0]?.status
    };
  }

  private _forceStableTimeout = false;

  /** A subclass's own answer to "is a client still to answer?". */
  private _clientInteractionOverride: boolean | null = null;

  setPendingClientInteractionForTest(value: boolean | null): void {
    this._clientInteractionOverride = value;
  }

  protected override hasPendingClientInteraction(): boolean {
    return (
      this._clientInteractionOverride ?? super.hasPendingClientInteraction()
    );
  }

  setForceStableTimeoutForTest(value: boolean): void {
    this._forceStableTimeout = value;
  }

  /** Holds the next waitUntilStable until released, then times it out. */
  private _stableHold: {
    waiting: boolean;
    released: Promise<void>;
    release: () => void;
  } | null = null;

  /** The protected "cancel whatever is running". */
  abortAllRequestsForTest(): void {
    this.abortAllRequests();
  }

  holdStableWaitForTest(): void {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this._stableHold = { waiting: false, released, release };
  }

  isStableWaitHeldForTest(): boolean {
    return this._stableHold?.waiting ?? false;
  }

  releaseStableWaitForTest(): void {
    this._stableHold?.release();
    this._stableHold = null;
  }

  /** Makes waitUntilStable throw, as a bug inside a recovery attempt would. */
  private _stableWaitError: string | null = null;

  setStableWaitErrorForTest(message: string | null): void {
    this._stableWaitError = message;
  }

  override async waitUntilStable(options?: {
    timeout?: number;
    pendingInteraction?: () => boolean;
  }): Promise<boolean> {
    if (this._forceStableTimeout) return false;
    if (this._stableWaitError) throw new Error(this._stableWaitError);
    const hold = this._stableHold;
    if (hold && !hold.waiting) {
      hold.waiting = true;
      await hold.released;
      return false;
    }
    return super.waitUntilStable(options);
  }

  async runChatRecoveryContinueDirectForTest(
    data: Record<string, unknown>
  ): Promise<void> {
    await super._chatRecoveryContinueDetached(
      data as Parameters<AIChatAgent<Env>["_chatRecoveryContinue"]>[0]
    );
  }

  /** The same, returning the message of what the attempt threw, if anything. */
  async runChatRecoveryContinueCatchingForTest(
    data: Record<string, unknown>
  ): Promise<string | null> {
    try {
      await this.runChatRecoveryContinueDirectForTest(data);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async runChatRecoveryRetryDirectForTest(
    data: Record<string, unknown>
  ): Promise<void> {
    await super._chatRecoveryRetryDetached(
      data as Parameters<AIChatAgent<Env>["_chatRecoveryRetry"]>[0]
    );
  }

  /** Exercise platform failure ownership on either side of model handoff. */
  async testRecoveryDispatchHandoffForTest(options: {
    callback: "_chatRecoveryContinue" | "_chatRecoveryRetry";
    phase: "before" | "after";
  }): Promise<{ threw: boolean; tasks: number; schedules: number }> {
    const data = { incidentId: crypto.randomUUID() };
    if (options.callback === "_chatRecoveryContinue") {
      await this.preScheduleRecoveryContinueForTest(data);
    } else {
      await this.preScheduleRecoveryRetryForTest(data);
    }

    type ContinueData = Parameters<
      AIChatAgent<Env>["_chatRecoveryContinue"]
    >[0];
    type RetryData = Parameters<AIChatAgent<Env>["_chatRecoveryRetry"]>[0];
    const host = this as unknown as {
      _chatRecoveryContinueDetached(
        data?: ContinueData,
        onTurnStarted?: () => void
      ): Promise<void>;
      _chatRecoveryRetryDetached(
        data?: RetryData,
        onTurnStarted?: () => void
      ): Promise<void>;
    };
    const originalContinue = host._chatRecoveryContinueDetached.bind(this);
    const originalRetry = host._chatRecoveryRetryDetached.bind(this);
    const fail = async (onTurnStarted?: () => void): Promise<never> => {
      if (options.phase === "after") {
        onTurnStarted?.();
        // Let the bounded wrapper observe handoff before the detached body
        // rejects, matching a failure from the model turn itself.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("Network connection lost.");
    };
    host._chatRecoveryContinueDetached = (_data, onTurnStarted) =>
      fail(onTurnStarted);
    host._chatRecoveryRetryDetached = (_data, onTurnStarted) =>
      fail(onTurnStarted);

    let threw = false;
    try {
      if (options.callback === "_chatRecoveryContinue") {
        await this._chatRecoveryContinue(data);
      } else {
        await this._chatRecoveryRetry(data);
      }
    } catch (error) {
      threw =
        error instanceof Error &&
        error.message.includes("Network connection lost");
    } finally {
      host._chatRecoveryContinueDetached = originalContinue;
      host._chatRecoveryRetryDetached = originalRetry;
    }

    // The post-handoff catch enqueues asynchronously after the wrapper returns.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      threw,
      ...this.getRecoveryTransportCountsForTest(options.callback)
    };
  }

  /** Simulate the not-yet-settled recovery Task currently dispatching. */
  /** What `_dispatchRecoveredChatTurn` does on a wake: schedule a continue of `target`. */
  async rvScheduleLikeWakeForTest(
    incidentId: string,
    target: string
  ): Promise<void> {
    const incident = await this.ctx.storage.get<Record<string, unknown>>(
      `cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`
    );
    const engine = (
      this as unknown as {
        _chatRecoveryEngine(): {
          scheduleRecoveredTurn(input: Record<string, unknown>): Promise<void>;
        };
      }
    )._chatRecoveryEngine();
    await engine.scheduleRecoveredTurn({
      incident,
      recoveryKind: "continue",
      recoveryRootRequestId: incident?.recoveryRootRequestId,
      targetAssistantId: target,
      // The run has not fired yet when the next detection lands.
      delaySeconds: 60
    });
  }

  /** The chat-turn Task runs not yet settled: a turn a replay could recover. */
  openChatTurnRunsForTest(): number {
    return (
      this.sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM cf_agents_task_runs
        WHERE definition = '__cf_internal_chat_turn'
          AND state IN ('pending', 'running', 'waiting')
      `[0]?.count ?? 0
    );
  }

  /** Run every open chat-turn Task run now, as a later wake would. */
  async runOpenChatTurnRunsForTest(): Promise<void> {
    const past = Date.now() - 1_000;
    this.sql`
      UPDATE cf_agents_task_runs SET next_at = ${past}
      WHERE definition = '__cf_internal_chat_turn'
        AND state IN ('pending', 'running', 'waiting')
    `;
    this.sql`
      UPDATE cf_agents_task_steps SET next_at = ${past}
      WHERE run_id IN (
        SELECT run_id FROM cf_agents_task_runs
        WHERE definition = '__cf_internal_chat_turn'
      )
    `;
    this.sql`
      UPDATE cf_agents_jobs SET time = ${past} WHERE id LIKE 'task:%'
    `;
    await this.alarm();
    await (this as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
  }

  async rvContinueWithStreamErrorForTest(message: string): Promise<string> {
    this._emitStreamError = message;
    try {
      return (await this.continueLastTurn()).status;
    } finally {
      this._emitStreamError = null;
    }
  }

  async rvIncidentRawForTest(incidentId: string): Promise<unknown> {
    return this.ctx.storage.get(
      `cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`
    );
  }

  async preScheduleRecoveryContinueForTest(
    data: Record<string, unknown>
  ): Promise<void> {
    const input = {
      callback: "_chatRecoveryContinue" as const,
      data,
      delaySeconds: 60
    };
    await this.tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
      CHAT_RECOVERY_TASK_NAME,
      input,
      chatRecoveryTaskRunOptions(input, "redefer")
    );
  }

  /** Retry-path twin of {@link preScheduleRecoveryContinueForTest}. */
  async preScheduleRecoveryRetryForTest(
    data: Record<string, unknown>
  ): Promise<void> {
    const input = {
      callback: "_chatRecoveryRetry" as const,
      data,
      delaySeconds: 60
    };
    await this.tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
      CHAT_RECOVERY_TASK_NAME,
      input,
      chatRecoveryTaskRunOptions(input, "redefer")
    );
  }

  async getChatRecoveringForTest(): Promise<{ requestId?: string } | null> {
    return (
      (await this.ctx.storage.get<{ requestId?: string }>(
        "cf:chat:recovering"
      )) ?? null
    );
  }

  /** Build the on-connect "recovering…" replay frame (#1620), exactly as
   *  `onConnect` does when no stream is active. `null` when nothing (or only a
   *  stale record) is pending. Used to assert the on-connect convergence. */
  getRecoveringConnectFrameForTest(): Promise<Record<string, unknown> | null> {
    const self = this as unknown as {
      _buildRecoveringConnectFrame(): Promise<Record<string, unknown> | null>;
    };
    return self._buildRecoveringConnectFrame();
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

  /** Number of upcoming turns whose model stream hangs (see
   *  {@link makeHangingSSEResponse}) before reverting to the normal response. */
  private _hangTurnsRemaining = 0;

  /** Configure the live-stream inactivity watchdog (slice 3b, #1626). */
  setChatStreamStallTimeoutForTest(ms: number): void {
    this.chatStreamStallTimeoutMs = ms;
  }

  /** Make the next `hangTurns` model streams hang, for a WebSocket-driven turn. */
  armStallingTurnsForTest(timeoutMs: number, hangTurns: number): void {
    this.chatStreamStallTimeoutMs = timeoutMs;
    this._hangTurnsRemaining = hangTurns;
  }

  private _blockNextAssistantPersist = false;
  private _releaseBlockedPersist: (() => void) | null = null;

  /** Hold the next persist that ends in an assistant message until released. */
  blockNextAssistantPersistForTest(): void {
    this._blockNextAssistantPersist = true;
  }

  isAssistantPersistBlockedForTest(): boolean {
    return this._releaseBlockedPersist !== null;
  }

  releaseAssistantPersistForTest(): void {
    this._releaseBlockedPersist?.();
    this._releaseBlockedPersist = null;
  }

  override async persistMessages(
    messages: ChatMessage[],
    excludeBroadcastIds: string[] = [],
    options?: { _deleteStaleRows?: boolean }
  ) {
    if (
      this._blockNextAssistantPersist &&
      messages.at(-1)?.role === "assistant"
    ) {
      this._blockNextAssistantPersist = false;
      await new Promise<void>((resolve) => {
        this._releaseBlockedPersist = resolve;
      });
    }
    await super.persistMessages(messages, excludeBroadcastIds, options);
    // A stop that lands right after a turn's messages are stored.
    if (this._abortAfterUserPersist && messages.at(-1)?.role === "user") {
      const controller = this._abortAfterUserPersist;
      this._abortAfterUserPersist = null;
      controller.abort(new Error("stopped after the messages were stored"));
    }
  }

  private _abortAfterUserPersist: AbortController | null = null;

  /**
   * Drive a turn whose model stream hangs after a partial, with a short stall
   * timeout configured, so the inactivity watchdog fires and routes the turn
   * into bounded recovery. `hangTurns` controls how many turns hang (1 = only
   * the first attempt hangs, so a scheduled continuation would complete).
   * Returns the server-side turn status (`"aborted"` once the stall is routed).
   */
  async driveStallingTurnForTest(options?: {
    timeoutMs?: number;
    hangTurns?: number;
  }): Promise<SaveMessagesResult["status"]> {
    this.chatStreamStallTimeoutMs = options?.timeoutMs ?? 50;
    this._hangTurnsRemaining = options?.hangTurns ?? 1;
    const result = await this.saveMessages([
      {
        id: `u-${crypto.randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text: "tell me a long story" }]
      }
    ]);
    return result.status;
  }

  /**
   * A stalling turn whose request is stopped while the stall is routed,
   * before its incident is written. Returns the route's outcome and whether
   * a resumable stream is still open (active, or waiting for a cutover).
   */
  async stopWhileStallRoutedForTest(): Promise<{
    outcomes: string[];
    streamOpen: boolean;
    status: SaveMessagesResult["status"];
  }> {
    const self = this as unknown as {
      _routeStreamInterruption(input: { requestId: string }): Promise<string>;
    };
    const route = self._routeStreamInterruption.bind(this);
    const outcomes: string[] = [];
    self._routeStreamInterruption = async (input) => {
      this.abortRequest(input.requestId, "user stop");
      await new Promise((resolve) => setTimeout(resolve, 0));
      const outcome = await route(input);
      outcomes.push(outcome);
      return outcome;
    };
    try {
      const status = await this.driveStallingTurnForTest({ timeoutMs: 100 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // oxlint-disable-next-line typescript/no-explicit-any -- private field
      const stream = (this as any)._resumableStream;
      return {
        outcomes,
        streamOpen:
          stream.hasActiveStream() || stream.pendingCutoverId !== null,
        status
      };
    } finally {
      self._routeStreamInterruption = route;
    }
  }

  private _failingTurn: {
    message: string;
    remaining: number;
    prelude: FailingReaderPrelude;
    responseHeaders?: Record<string, string>;
  } | null = null;
  private _failingReaderCalls = 0;

  getFailingReaderCallsForTest(): number {
    return this._failingReaderCalls;
  }

  /** Make the next turn's reader throw `message` after `prelude`. */
  armFailingReaderTurnForTest(
    message: string,
    prelude: FailingReaderPrelude
  ): void {
    this._failingTurn = { message, remaining: 1, prelude };
  }

  /**
   * Drive a turn whose response reader throws `message` after `prelude`.
   * `turns` controls how many attempts fail before the normal response;
   * `priorAssistant` seeds an earlier answered exchange first.
   */
  async driveFailingReaderTurnForTest(
    message: string,
    turns = 1,
    options: {
      prelude?: FailingReaderPrelude;
      priorAssistant?: boolean;
      responseHeaders?: Record<string, string>;
    } = {}
  ): Promise<SaveMessagesResult["status"]> {
    if (options.priorAssistant) {
      await this.persistMessages([
        {
          id: "prior-user",
          role: "user",
          parts: [{ type: "text", text: "hello" }]
        },
        {
          id: "prior-assistant",
          role: "assistant",
          parts: [{ type: "text", text: "Earlier answer." }]
        }
      ]);
    }
    this._failingTurn = {
      message,
      remaining: turns,
      prelude: options.prelude ?? "partial",
      responseHeaders: options.responseHeaders
    };
    const result = await this.saveMessages((current) => [
      ...current,
      {
        id: `u-${crypto.randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text: "tell me a long story" }]
      }
    ]);
    return result.status;
  }

  /**
   * An agent-tool run on an agent that already holds a request body from
   * its own client. With `recovered`, the run's reply is cut off once and
   * chat recovery finishes it. Returns the stored body once the run is
   * over.
   */
  async storedBodyAfterAgentToolRunForTest(recovered: boolean): Promise<{
    status: string | undefined;
    body: Record<string, unknown> | undefined;
  }> {
    const self = this as unknown as {
      _requestContext: {
        set(context: { body: Record<string, unknown> | undefined }): void;
      };
      _lastBody: Record<string, unknown> | undefined;
    };
    self._requestContext.set({ body: { theme: "dark" } });
    const runId = crypto.randomUUID();
    if (recovered) {
      this._failingTurn = {
        message: "Network connection lost.",
        remaining: 1,
        prelude: "partial"
      };
    }
    await this.startAgentToolRun("the run's own input", { runId });
    const deadline = Date.now() + 8000;
    let inspection = await this.inspectAgentToolRun(runId);
    while (inspection?.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      inspection = await this.inspectAgentToolRun(runId);
    }
    await (this as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
    return { status: inspection?.status, body: self._lastBody };
  }

  /** The request id of the turn `onChatResponse` last started. */
  private _followUpRequestId: string | undefined;

  /**
   * An agent-tool run on an agent whose `onChatResponse` starts a turn of
   * its own once the run's reply completes. With `recovered`, the run's
   * reply is cut off once and chat recovery finishes it. Returns which
   * request the run's row names, and whose chunks the run reports.
   */
  async agentToolRunWithFollowUpTurnForTest(recovered: boolean): Promise<{
    status: string | undefined;
    rowIsFollowUp: boolean;
    followUpRan: boolean;
    followUpChunksInRun: number;
  }> {
    const runId = crypto.randomUUID();
    if (recovered) {
      this._failingTurn = {
        message: "Network connection lost.",
        remaining: 1,
        prelude: "partial"
      };
    }
    this._saveFromNextResponse = true;
    this._followUpRequestId = undefined;
    await this.startAgentToolRun("answer, then a follow-up follows", { runId });
    const deadline = Date.now() + 8000;
    let inspection = await this.inspectAgentToolRun(runId);
    while (
      (inspection?.status === "running" || !this._followUpRequestId) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      inspection = await this.inspectAgentToolRun(runId);
    }
    await (this as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
    const followUp = this._followUpRequestId;
    const row = this["_agentToolRuns"].store.read(runId);
    const followUpStream = followUp
      ? this._resumableStream.latestStreamInfoForRequest(followUp)?.id
      : undefined;
    return {
      status: inspection?.status,
      rowIsFollowUp: followUp !== undefined && row?.requestId === followUp,
      followUpRan: followUp !== undefined,
      followUpChunksInRun:
        followUpStream !== undefined &&
        (await this.inspectAgentToolRun(runId))?.streamId === followUpStream
          ? (await this.getAgentToolChunks(runId)).length
          : 0
    };
  }

  /**
   * An agent-tool run's reply is cut off, so the run is left open for chat
   * recovery, with a parent tailing it. Then the run's request is stopped
   * on the child, one of the ways an app or a client can stop it.
   */
  async stopLeftOpenAgentToolRunForTest(
    how: "abortRequest" | "abortAllRequests" | "client-cancel"
  ): Promise<{
    beforeStop: string | undefined;
    status: string | undefined;
    error: string | undefined;
    tailClosed: boolean;
    readerCalls: number;
  }> {
    const runId = crypto.randomUUID();
    this._failingTurn = {
      message: "Network connection lost.",
      remaining: 1,
      prelude: "partial"
    };
    await this.startAgentToolRun("get cut off, then stopped", { runId });
    const runs = this["_agentToolRuns"];
    // A parent's tail of the run. `tailClosed` flips when it ends.
    let tailClosed = false;
    const reader = (
      (await this.tailAgentToolRun(runId, {
        afterSequence: -1
      })) as unknown as ReadableStream<Uint8Array>
    ).getReader();
    void (async () => {
      try {
        while (!(await reader.read()).done) {
          // Drain.
        }
      } catch {
        // A broken tail has ended too.
      }
      tailClosed = true;
    })();

    const deadline = Date.now() + 8000;
    while (runs.isLive(runId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const beforeStop = runs.store.read(runId)?.status;
    const requestId = runs.store.read(runId)?.requestId;
    if (!requestId) throw new Error("the run never bound a request");
    const readerCalls = this._failingReaderCalls;

    if (how === "abortRequest") {
      this.abortRequest(requestId, "stopped");
    } else if (how === "abortAllRequests") {
      this.abortAllRequests("stopped");
    } else {
      // What the `cancel` WebSocket message does.
      await this["_turns"].cancel(requestId);
    }
    // Long enough for a recovery that was not cancelled to run.
    const tailDeadline = Date.now() + 3000;
    while (!tailClosed && Date.now() < tailDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const closedBeforeInspect = tailClosed;
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Read the row, not an inspection: an inspection would settle it.
    const row = runs.store.read(runId);
    return {
      beforeStop,
      status: row?.status,
      error: row?.error ?? undefined,
      tailClosed: closedBeforeInspect,
      readerCalls: this._failingReaderCalls - readerCalls
    };
  }

  /**
   * An agent-tool run whose reply is cut off once (the reader throws after a
   * partial reply) and is then finished by chat recovery, in one isolate.
   */
  async agentToolRunWithFailingReaderForTest(): Promise<{
    afterCutOff: string | undefined;
    final: string | undefined;
    summary: string | undefined;
    readerCalls: number;
  }> {
    const runId = crypto.randomUUID();
    this._failingTurn = {
      message: "Network connection lost.",
      remaining: 1,
      prelude: "partial"
    };
    await this.startAgentToolRun("tell me a long story", { runId });
    const runs = this["_agentToolRuns"];
    const deadline = Date.now() + 8000;
    // The run's own lifecycle ends when its turn hands back.
    while (runs.isLive(runId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const afterCutOff = runs.store.read(runId)?.status;
    let inspection = await this.inspectAgentToolRun(runId);
    while (inspection?.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      inspection = await this.inspectAgentToolRun(runId);
    }
    return {
      afterCutOff,
      final: inspection?.status,
      summary: inspection?.summary,
      readerCalls: this._failingReaderCalls
    };
  }

  /**
   * Drive an aborted turn purely server-side (no client request), through
   * the caller's signal. `"after-store"` stops it once its messages are
   * stored and before the model is called: the conversation moved, so the
   * turn supersedes a stale terminal record (#1645). `"before"` passes a
   * signal that is already aborted: the turn does nothing.
   */
  async driveAbortedTurnForTest(
    when: "before" | "after-store" = "after-store"
  ): Promise<{
    status: SaveMessagesResult["status"];
    userTexts: string[];
    chatCalls: number;
  }> {
    const controller = new AbortController();
    if (when === "before") {
      controller.abort(new Error("pre-aborted"));
    } else {
      this._abortAfterUserPersist = controller;
    }
    const callsBefore = this.onChatMessageCallCount;
    const result = await this.saveMessages(
      (messages) => [
        ...messages,
        {
          id: `u-${crypto.randomUUID()}`,
          role: "user",
          parts: [{ type: "text", text: "hello" }]
        }
      ],
      { signal: controller.signal }
    );
    this._abortAfterUserPersist = null;
    return {
      status: result.status,
      userTexts: this.messages
        .filter((message) => message.role === "user")
        .map((message) =>
          message.parts
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("")
        ),
      chatCalls: this.onChatMessageCallCount - callsBefore
    };
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
    startedDelivery?: number;
  } | null> {
    const incident = await this.ctx.storage.get<{
      attempt: number;
      status: string;
      reason?: string;
      startedDelivery?: number;
    }>(`cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`);
    return incident
      ? {
          attempt: incident.attempt,
          status: incident.status,
          reason: incident.reason,
          ...(incident.startedDelivery !== undefined && {
            startedDelivery: incident.startedDelivery
          })
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
    toolName: string,
    options: { cutOff?: boolean } = {}
  ): Promise<void> {
    const reply: ChatMessage = {
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
    };
    // A reply whose stream was cut off is settled before it is stored, the
    // way `_reply` and the orphan path store one.
    await this.persistMessages([
      options.cutOff
        ? (
            this as unknown as {
              _settleInterruptedReply(message: ChatMessage): ChatMessage;
            }
          )._settleInterruptedReply(reply)
        : reply
    ]);
  }

  /** Simulate recovery forward progress: advance the durable progress counter
   *  exactly as `_persistOrphanedStream` does when it materializes a non-empty
   *  partial. The recovery budget keys off this counter (not the live message
   *  count), so this is how a test marks "the turn advanced". */
  async bumpRecoveryProgressForTest(): Promise<void> {
    // One explicit credit — the same unit a flushed segment or a forwarded
    // child chunk adds to the derived marker.
    this._resumableStream.creditProgress();
  }

  /** The recovery progress marker as the engine would read it now. */
  async readProgressMarkerForTest(): Promise<number> {
    return this._resumableStream.progressMarker();
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
      this._resumableStream.progressMarker();
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

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
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

  async runRecoveryContinueForTest(options?: {
    targetAssistantId?: string;
    originMessageIds?: string[];
    incidentId?: string;
    originalRequestId?: string;
  }): Promise<void> {
    await this._chatRecoveryContinueDetached(options);
  }

  async runRecoveryRetryForTest(options?: {
    targetUserId?: string;
    lastBody?: Record<string, unknown>;
    lastClientTools?: ClientToolSchema[];
  }): Promise<void> {
    await this._chatRecoveryRetryDetached(options);
  }

  private async _runQueuedRecoveryTaskForTest(
    callback: "_chatRecoveryContinue" | "_chatRecoveryRetry"
  ): Promise<boolean> {
    const rows = this.sql<{ run_id: string }>`
      SELECT run_id FROM cf_agents_task_runs
      WHERE definition = ${CHAT_RECOVERY_TASK_NAME}
        AND state IN ('pending', 'running', 'waiting')
        AND json_extract(metadata, '$.callback') = ${callback}
      ORDER BY created_at ASC
      LIMIT 1
    `;
    const runId = rows[0]?.run_id;
    if (!runId) return false;
    const past = Date.now() - 1_000;
    this.sql`
      UPDATE cf_agents_task_runs
      SET next_at = ${past},
          input = json_set(input, '$.delaySeconds', 0)
      WHERE run_id = ${runId}
    `;
    this.sql`
      UPDATE cf_agents_task_steps SET next_at = ${past}
      WHERE run_id = ${runId} AND kind = 'sleep'
    `;
    this.sql`
      UPDATE cf_agents_jobs SET time = ${past}
      WHERE id = ${`task:${runId}`}
    `;
    await this.alarm();
    await (this as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
    return true;
  }

  /**
   * Look up origin ids for the recovery successor from inside an open recovery
   * scope, and for an unrelated request concurrently from outside it (#2280).
   */
  async probeRecoveryOriginScopeForTest(ids: string[]): Promise<{
    successor: string[] | undefined;
    unrelated: string[] | undefined;
  }> {
    const self = this as unknown as {
      _chatRecoveryOriginIdsScope: {
        run<R>(store: string[], fn: () => R): R;
      };
      _frames: { originIds(requestId: string): string[] | undefined };
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scoped = self._chatRecoveryOriginIdsScope.run(ids, async () => {
      await gate;
      return self._frames.originIds("successor");
    });
    const unrelated = self._frames.originIds("unrelated");
    release();
    return { successor: await scoped, unrelated };
  }

  async runScheduledRecoveryRetryForTest(): Promise<void> {
    if (await this._runQueuedRecoveryTaskForTest("_chatRecoveryRetry")) return;
    const rows = this.sql<{ payload: string }>`
      SELECT json_extract(payload, '$.payload') AS payload FROM cf_agents_jobs
      WHERE capability = 'scheduler' AND fn = '_chatRecoveryRetry'
      ORDER BY time ASC
      LIMIT 1
    `;
    if (!rows[0]) {
      await (this as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
      return;
    }
    await this._chatRecoveryRetryDetached(
      JSON.parse(rows[0].payload) as {
        targetUserId?: string;
        lastBody?: Record<string, unknown>;
        lastClientTools?: ClientToolSchema[];
      }
    );
  }

  async runScheduledRecoveryContinueForTest(): Promise<void> {
    if (await this._runQueuedRecoveryTaskForTest("_chatRecoveryContinue")) {
      return;
    }
    const rows = this.sql<{ payload: string }>`
      SELECT json_extract(payload, '$.payload') AS payload FROM cf_agents_jobs
      WHERE capability = 'scheduler' AND fn = '_chatRecoveryContinue'
      ORDER BY time ASC
      LIMIT 1
    `;
    if (!rows[0]) {
      await (this as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
      return;
    }
    await this._chatRecoveryContinueDetached(
      JSON.parse(rows[0].payload) as {
        targetAssistantId?: string;
        lastBody?: Record<string, unknown> | null;
        lastClientTools?: ClientToolSchema[] | null;
      }
    );
  }

  /** The request context stored for later turns. */
  getRequestContextForTest(): {
    body: Record<string, unknown> | undefined;
    clientTools: ClientToolSchema[] | undefined;
  } {
    return { body: this._lastBody, clientTools: this._lastClientTools };
  }

  setRequestContextForTest(
    body?: Record<string, unknown>,
    clientTools?: ClientToolSchema[]
  ): void {
    this._lastBody = body;
    this._lastClientTools = clientTools;
  }

  /** The next turn's response reader throws `message` after a partial. */
  armFailingReaderForTest(message: string): void {
    this._failingTurn = { message, remaining: 1, prelude: "partial" };
  }

  private _endBeforeReply: "nothing" | "throw" | null = null;

  /** The next `onChatMessage` returns no response, or throws. */
  endNextTurnBeforeReplyForTest(how: "nothing" | "throw"): void {
    this._endBeforeReply = how;
  }

  /** Call `continueLastTurn` the way an app does. */
  async continueLastTurnForTest(): Promise<string> {
    try {
      return (await this.continueLastTurn()).status;
    } catch (error) {
      return `threw: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** The stored request context: what the chat's next turn would run with. */
  getStoredRequestContextForTest(): {
    body: Record<string, unknown> | null;
    clientTools: string[] | null;
  } {
    return {
      body: this._lastBody ?? null,
      clientTools: this._lastClientTools?.map((tool) => tool.name) ?? null
    };
  }

  private _pinnedTurnForTest: Promise<SaveMessagesResult> | null = null;

  /** Start a turn whose caller pins its own body, as an agent-tool run does. */
  startPinnedTurnForTest(body: Record<string, unknown>): void {
    this._pinnedTurnForTest = (
      this as unknown as {
        _runProgrammaticMessagesTurn(
          requestId: string,
          messages: (current: ChatMessage[]) => ChatMessage[],
          options: { body: Record<string, unknown>; clientTools: null }
        ): Promise<SaveMessagesResult>;
      }
    )._runProgrammaticMessagesTurn(
      crypto.randomUUID(),
      (current) => [
        ...current,
        {
          id: `pinned-${crypto.randomUUID()}`,
          role: "user",
          parts: [{ type: "text", text: "pinned turn" }]
        }
      ],
      { body, clientTools: null }
    );
  }

  async awaitPinnedTurnForTest(): Promise<string> {
    return (await this._pinnedTurnForTest)?.status ?? "none";
  }

  private _clearDuringResponseHook = false;

  /** A clear lands while the next `onChatResponse` runs. */
  clearDuringNextResponseHookForTest(): void {
    this._clearDuringResponseHook = true;
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

  getRecoveryTransportCountsForTest(callback: string): {
    tasks: number;
    schedules: number;
  } {
    const schedules = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM cf_agents_jobs
      WHERE capability = 'scheduler' AND fn = ${callback}
    `;
    const tasks = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM cf_agents_task_runs
      WHERE definition = ${CHAT_RECOVERY_TASK_NAME}
        AND state IN ('pending', 'running', 'waiting')
        AND json_extract(metadata, '$.callback') = ${callback}
    `;
    return {
      tasks: tasks[0]?.count ?? 0,
      schedules: schedules[0]?.count ?? 0
    };
  }

  private _recoveryTaskKeyed: boolean[] = [];

  /** Record whether each recovery enqueued from now on has an idempotency key. */
  trackRecoveryTaskKeysForTest(): void {
    const self = this as unknown as {
      _enqueueChatRecovery(
        callback: Parameters<typeof chatRecoveryTaskRunOptions>[0]["callback"],
        data: Record<string, unknown>,
        reason: Parameters<typeof chatRecoveryTaskRunOptions>[1],
        delaySeconds: number,
        dedupeKey?: string
      ): Promise<void>;
    };
    const original = self._enqueueChatRecovery.bind(this);
    self._enqueueChatRecovery = (callback, data, reason, delaySeconds, key) => {
      this._recoveryTaskKeyed.push(
        chatRecoveryTaskRunOptions(
          { callback, data, delaySeconds },
          reason,
          key
        ).idempotencyKey !== undefined
      );
      return original(callback, data, reason, delaySeconds, key);
    };
  }

  getRecoveryTaskKeyedForTest(): boolean[] {
    return this._recoveryTaskKeyed;
  }

  /** Make the next routing into recovery throw (an incident write failure). */
  failNextIncidentBeginForTest(): void {
    const engine = (
      this as unknown as { _chatRecoveryEngine(): unknown }
    )._chatRecoveryEngine() as {
      beginIncident(...args: unknown[]): Promise<unknown>;
    };
    engine.beginIncident = async () => {
      Reflect.deleteProperty(engine, "beginIncident");
      throw new Error("incident write failed");
    };
  }

  /** The backoff, in seconds, of the recovery Task scheduled last. */
  getScheduledRecoveryDelayForTest(): number | null {
    return (
      this.sql<{ delay: number | null }>`
        SELECT json_extract(input, '$.delaySeconds') AS delay
        FROM cf_agents_task_runs
        WHERE definition = ${CHAT_RECOVERY_TASK_NAME}
        ORDER BY created_at DESC
        LIMIT 1
      `[0]?.delay ?? null
    );
  }

  getScheduleCountForCallback(callback: string): number {
    const scheduled = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_jobs
      WHERE capability = 'scheduler' AND fn = ${callback}
    `;
    const tasks = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM cf_agents_task_runs
      WHERE definition = ${CHAT_RECOVERY_TASK_NAME}
        AND state IN ('pending', 'running', 'waiting')
        AND json_extract(metadata, '$.callback') = ${callback}
    `;
    return (scheduled[0]?.count ?? 0) + (tasks[0]?.count ?? 0);
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
      select created_at from cf_agents_streams where stream_id = ${streamId}
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
      await this._persistOrphanedStream(streamId);
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

  /**
   * Leave an interrupted turn: a chat turn (`CHAT_FIBER_NAME:<requestId>`)
   * as a chat-turn Task run, anything else as a fiber row.
   */
  async insertInterruptedFiber(
    name: string,
    snapshot?: unknown
  ): Promise<void> {
    await insertInterruptedTurnForTest(this, this.ctx.storage, name, snapshot);
  }

  /** Replay every interrupted turn, as a wake does. */
  async triggerFiberRecovery(): Promise<void> {
    await recoverInterruptedTurnsForTest(this);
  }

  /** Leave a chat turn's fiber row, as a version before Tasks did. */
  insertLegacyChatFiberForTest(requestId: string, snapshot?: unknown): void {
    this.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${`fiber-${crypto.randomUUID()}`},
              ${`${AIChatAgent.CHAT_FIBER_NAME}:${requestId}`},
              ${snapshot ? JSON.stringify(snapshot) : null}, ${Date.now()})
    `;
  }

  insertInterruptedStream(
    streamId: string,
    requestId: string,
    chunks: Array<{ body: string; index: number }>,
    ageMs = 0,
    metadata?: { messageId?: string }
  ): void {
    const createdAt = Date.now() - ageMs;
    // Omitting `metadata.messageId` leaves the field out of the stream
    // metadata, simulating a stream row written before message-id tracking.
    const streamMetadata: Record<string, unknown> = { cfChat: 1 };
    if (metadata?.messageId) streamMetadata.messageId = metadata.messageId;
    this.sql`
      insert into cf_agents_streams
        (stream_id, state, tag, metadata, chunk_count, created_at, updated_at)
      values (${streamId}, 'streaming', ${requestId}, ${JSON.stringify(streamMetadata)},
              ${chunks.length}, ${createdAt}, ${createdAt})
    `;
    if (chunks.length > 0) {
      const body = chunks.map((c) => JSON.stringify(c.body)).join(",");
      this.sql`
        insert into cf_agents_stream_blocks
          (stream_id, block, seq_from, seq_to, body, created_at, updated_at)
        values (${streamId}, 0, ${chunks[0].index}, ${chunks[chunks.length - 1].index + 1},
                ${body}, ${createdAt}, ${createdAt})
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

  /**
   * Seed an in-flight (running) `cf_ai_chat_agent_tool_runs` row, as if this
   * facet were running as an agent-tool child whose turn was interrupted before
   * completing. Used to assert the recovery continuation re-binds the row's
   * `request_id` so the parent's re-attach tail keeps attributing frames.
   */
  async seedAgentToolChildRunForTest(
    runId: string,
    requestId: string,
    startedAt: number = Date.now()
  ): Promise<void> {
    this.sql`
      insert into cf_ai_chat_agent_tool_runs
        (run_id, request_id, status, input_json, started_at)
      values (${runId}, ${requestId}, 'running', '{}', ${startedAt})
    `;
  }

  /**
   * Seed a SETTLED (terminal) child-run row — `completed` with `completed_at`
   * set — to assert the rebind is a no-op for already-finished runs.
   */
  async seedSettledAgentToolChildRunForTest(
    runId: string,
    requestId: string
  ): Promise<void> {
    const now = Date.now();
    this.sql`
      insert into cf_ai_chat_agent_tool_runs
        (run_id, request_id, status, input_json, started_at, completed_at)
      values (${runId}, ${requestId}, 'completed', '{}', ${now}, ${now})
    `;
  }

  /** Directly invoke the rebind helper (bypassing the full recovery flow). */
  async rebindAgentToolChildRunRequestIdForTest(
    requestId: string,
    rootRequestId: string
  ): Promise<void> {
    this["_agentToolRuns"].rebind(requestId, rootRequestId);
  }

  /** The `request_id` currently bound to an agent-tool child run row. */
  async getAgentToolChildRunRequestIdForTest(
    runId: string
  ): Promise<string | null> {
    const rows = this.sql<{ request_id: string | null }>`
      select request_id from cf_ai_chat_agent_tool_runs where run_id = ${runId}
    `;
    return rows[0]?.request_id ?? null;
  }

  /** Resolve which agent-tool run a request id is attributed to (frame routing). */
  async resolveAgentToolRunForRequestForTest(
    requestId: string
  ): Promise<string | null> {
    return this["_agentToolRuns"].runForRequest(requestId);
  }
}

// ── NonChatRecoveryTestAgent (legacy runtime false compatibility) ──

export class NonChatRecoveryTestAgent extends AIChatAgent<Env> {
  // @ts-expect-error `false` is no longer accepted, but stale JavaScript must
  // still take the always-on durable recovery path.
  override chatRecovery: ChatRecoveryConfig = false;
  recoveryContexts: ChatRecoveryContext[] = [];
  onChatMessageCallCount = 0;
  private _stashSucceeded = false;

  async onChatMessage() {
    this.onChatMessageCallCount++;
    this.stash({ source: "legacy-false-config" });
    this._stashSucceeded = true;
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

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
  }

  getOnChatMessageCallCount(): number {
    return this.onChatMessageCallCount;
  }

  getStashSucceeded(): boolean {
    return this._stashSucceeded;
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
  override chatRecovery: ChatRecoveryConfig = true;
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

  private _onErrorSeen: string[] = [];

  override onError(connectionOrError: unknown, error?: unknown): void {
    const cause = error ?? connectionOrError;
    const message = cause instanceof Error ? cause.message : String(cause);
    this._onErrorSeen.push(message);
    throw new Error(`onError(${message})`);
  }

  async callContinueLastTurn(): Promise<{ requestId: string; status: string }> {
    return this.continueLastTurn();
  }

  /**
   * Drive `continueLastTurn` while `onChatMessage` throws, and report what
   * the caller sees and what the turn left behind.
   */
  async testContinueLastTurnWhileThrowing(): Promise<{
    thrown: string | null;
    onErrorSeen: string[];
    liveRecoveryTurns: number;
    liveClosures: number;
    fibers: number;
    abortControllers: number;
    queueIdle: boolean;
  }> {
    await this.persistMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "Hello" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Hi" }] }
    ]);
    this._shouldThrow = true;
    this._onErrorSeen = [];
    let thrown: string | null = null;
    try {
      await this.continueLastTurn();
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    } finally {
      this._shouldThrow = false;
    }
    const internals = this as unknown as {
      _liveChatRecoveryTurns: Map<string, unknown>;
      _liveChatTurnClosures: Map<string, unknown>;
      _abortRegistry: { size: number };
      _turnQueue: { isActive: boolean };
    };
    return {
      thrown,
      onErrorSeen: [...this._onErrorSeen],
      liveRecoveryTurns: internals._liveChatRecoveryTurns.size,
      liveClosures: internals._liveChatTurnClosures.size,
      fibers: this.getActiveFibers().length,
      abortControllers: internals._abortRegistry.size,
      queueIdle: !internals._turnQueue.isActive
    };
  }

  getOnChatMessageCallCount(): number {
    return this.onChatMessageCallCount;
  }

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
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

/**
 * An app whose `onStart` takes a while and whose turns need it done: a
 * request replayed after a reset must not run before the app has started.
 */
export class AsyncStartAdmissionAgent extends SlowStreamAgent {
  private _ready = false;

  override async onStart(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    this._ready = true;
  }

  override async onChatMessage(
    onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    if (!this._ready) {
      return new Response("not started", {
        headers: { "Content-Type": "text/plain" }
      });
    }
    return super.onChatMessage(onFinish, options);
  }

  /**
   * Store a user message and the record of the request that stored it, as
   * a reset leaves them when it lands before the request's turn started.
   */
  async seedQueuedRequestForTest(requestId: string): Promise<void> {
    const id = `u-${requestId}`;
    const { admissions } = (this as unknown as { _turns: ChatTurns })._turns;
    admissions?.admit({
      requestId,
      messages: [
        { id, role: "user", parts: [{ type: "text", text: requestId }] }
      ] as ChatMessage[],
      afterUserId: null,
      decision: { strategy: null, overlapping: false, debounceUntilMs: null },
      payload: {
        trigger: "submit-message",
        body: { format: "sse", chunkCount: 3, chunkDelayMs: 10 },
        clientTools: undefined
      }
    });
    admissions?.live.delete(requestId);
  }
}

// ── RecoverySlowStreamAgent (SlowStreamAgent with chatRecovery=true) ──

export class RecoverySlowStreamAgent extends SlowStreamAgent {
  override chatRecovery: ChatRecoveryConfig = true;

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

    // Root turns now start on the tasks capability; stub its internal start
    // path the same way so the simulated failure covers the migrated engine.
    type RunAttached = (...args: unknown[]) => Promise<unknown>;
    const tasksInternal = this.tasks as unknown as {
      __DO_NOT_USE_WILL_BREAK__runAttached: RunAttached;
    };
    const originalRunAttached =
      tasksInternal.__DO_NOT_USE_WILL_BREAK__runAttached.bind(
        this.tasks
      ) as RunAttached;
    tasksInternal.__DO_NOT_USE_WILL_BREAK__runAttached = (() => {
      throw new Error("simulated runFiber failure");
    }) as RunAttached;

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
      tasksInternal.__DO_NOT_USE_WILL_BREAK__runAttached = originalRunAttached;
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
  /** Echoed by `getAgentToolOutput` as whether it is still a `Date`. */
  probeDate?: Date;
  /** `getAgentToolOutput` returns a value JSON cannot hold. */
  circularOutput?: boolean;
  streamError?: string;
  /** Text streamed (and persisted) before `streamError`'s error chunk. */
  streamErrorText?: string;
};

const FACET_OOM_TEST_TASK_NAME = "__cf_test_facetRecoveryOom";
const FACET_SLOW_OOM_TEST_TASK_NAME = "__cf_test_facetRecoverySlowOom";

export class AIChatAgentToolChild extends AIChatAgent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    // Test-only routed Task definition that deterministically reaches the
    // root alarm's memory-limit breaker, mirroring the exact reset error
    // text `isDurableObjectMemoryLimitReset` matches on. Sleeps first: a
    // freshly accepted run is due immediately, and its first (uncontrolled-
    // timing) natural dispatch must not race the test's own explicit
    // strike-seeding — the sleep parks it safely regardless of when that
    // dispatch happens. Only a caller that forces the run due a second time
    // (past the journaled sleep) reaches the throw.
    this.tasks.register(FACET_OOM_TEST_TASK_NAME, async (_input, step) => {
      await step.sleep("armed", "1 hour");
      throw new Error(
        "Durable Object's isolate exceeded its memory limit and was reset."
      );
    });
    // Twin of the above, but genuinely slow (not suspended) past the
    // dispatch budget once armed, so the routed dispatch budget race on
    // the root actually detaches before this throws — exercising root's
    // own tracking of the still-pending call, not just the local path.
    this.tasks.register(FACET_SLOW_OOM_TEST_TASK_NAME, async (_input, step) => {
      await step.sleep("armed", "1 hour");
      await new Promise((resolve) => setTimeout(resolve, 6_500));
      throw new Error(
        "Durable Object's isolate exceeded its memory limit and was reset."
      );
    });
  }

  /** Reset this agent's isolate, as an eviction does. */
  async resetIsolateForTest(): Promise<void> {
    this.ctx.abort("test: forced reset");
  }

  /**
   * Seed one active incident and its routed recovery Task run, mirrored as
   * one wake job on the root's queue, and wait for its natural first
   * dispatch to safely park it (`waiting`, per the definitions above).
   * Returns the run ID so the caller can locate that mirror on the root's
   * own queue and force it due again to arm the OOM throw.
   */
  async seedFacetRecoveryOomForTest(
    incidentId: string,
    definition: string = FACET_OOM_TEST_TASK_NAME
  ): Promise<string> {
    const now = Date.now();
    await this.ctx.storage.put(
      `cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`,
      {
        incidentId,
        requestId: incidentId,
        recoveryRootRequestId: incidentId,
        recoveryKind: "continue",
        attempt: 1,
        maxAttempts: 10,
        status: "scheduled",
        firstSeenAt: now,
        lastAttemptAt: now
      }
    );
    const receipt = await this.tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
      definition,
      { incidentId },
      { retain: false }
    );
    for (let i = 0; i < 50; i++) {
      const run = await this.tasks.get(receipt.runId);
      if (run?.state === "waiting") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return receipt.runId;
  }

  /** Force this facet's own run row due now, past its journaled sleep. */
  async armFacetRecoveryOomForTest(runId: string): Promise<void> {
    const now = Date.now();
    // The run row's own deadline AND its journaled sleep step's deadline
    // both gate replay: forcing only the run row due replays straight into
    // the still-not-due sleep step, which just re-suspends for another
    // hour unchanged.
    this.sql`
      UPDATE cf_agents_task_runs SET next_at = ${now} WHERE run_id = ${runId}
    `;
    this.sql`
      UPDATE cf_agents_task_steps SET next_at = ${now}
      WHERE run_id = ${runId} AND step_name = 'armed'
    `;
  }

  /** This facet's own run row state, to check a routed strike reached it. */
  getFacetRecoveryOomRunStateForTest(runId: string): {
    state: string;
    generation: string | null;
    next_at: number | null;
  } | null {
    const rows = this.sql<{
      state: string;
      generation: string | null;
      next_at: number | null;
    }>`
      SELECT state, generation, next_at FROM cf_agents_task_runs
      WHERE run_id = ${runId}
    `;
    return rows[0] ?? null;
  }

  /** Read the persisted status of a test recovery incident. */
  async facetRecoveryIncidentStatusForTest(
    incidentId: string
  ): Promise<string | null> {
    const incident = await this.ctx.storage.get<{ status: string }>(
      `cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`
    );
    return incident?.status ?? null;
  }

  /** Leave an interrupted turn on this facet (see `insertInterruptedTurnForTest`). */
  async insertInterruptedFiber(
    name: string,
    snapshot?: unknown
  ): Promise<void> {
    await insertInterruptedTurnForTest(this, this.ctx.storage, name, snapshot);
  }

  /** Replay this facet's interrupted turns, as a wake does. */
  async triggerFiberRecovery(): Promise<void> {
    await recoverInterruptedTurnsForTest(this);
  }

  /** Count this facet's own non-terminal recovery Task runs for `callback`. */
  getChatRecoveryTaskRunCountForTest(callback: string): number {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM cf_agents_task_runs
      WHERE definition = ${CHAT_RECOVERY_TASK_NAME}
        AND state IN ('pending', 'running', 'waiting')
        AND json_extract(metadata, '$.callback') = ${callback}
    `;
    return rows[0]?.count ?? 0;
  }

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
    if (request.input.circularOutput) {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      return circular;
    }
    if (request.input.probeDate !== undefined) {
      return { inputIsDate: request.input.probeDate instanceof Date };
    }
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
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
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

    this._chatCallsForTest.push(prompt);
    this._turnStoresForTest.push(this._turnStoreCountsForTest());
    const bodyText = `AIChat child handled: ${prompt}`;
    await delayWithAbort(Number(input?.delayMs ?? 0), options?.abortSignal);
    if (input?.streamError) {
      return makeDelayedSSEChunkResponse(
        [
          ...(input.streamErrorText
            ? [
                { type: "text-start" },
                { type: "text-delta", delta: input.streamErrorText },
                { type: "text-end" }
              ]
            : []),
          { type: "error", errorText: input.streamError }
        ],
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

  /** The prompt of every `onChatMessage` call, in order. */
  private _chatCallsForTest: string[] = [];

  /** Where each running turn was stored, read inside `onChatMessage`. */
  private _turnStoresForTest: Array<{ taskRuns: number; fibers: number }> = [];

  private _turnStoreCountsForTest(): { taskRuns: number; fibers: number } {
    const taskRuns = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM cf_agents_task_runs
      WHERE definition = ${AIChatAgent.CHAT_FIBER_NAME}
        AND state IN ('pending', 'running', 'waiting')
    `;
    const fibers = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM cf_agents_runs
    `;
    return {
      taskRuns: taskRuns[0]?.count ?? 0,
      fibers: fibers[0]?.count ?? 0
    };
  }

  /** Chat-turn recoveries this facet ran, by request id. */
  private _turnRecoveriesForTest: string[] = [];

  /** Leave a chat-turn Task run whose isolate died (no live closure). */
  async seedOrphanChatTurnRunForTest(requestId: string): Promise<string> {
    const self = this as unknown as {
      _recoverChatTurn(turn: { requestId: string }): Promise<void>;
    };
    const original = self._recoverChatTurn.bind(this);
    self._recoverChatTurn = async (turn) => {
      this._turnRecoveriesForTest.push(turn.requestId);
      return original(turn);
    };
    const receipt = await this.tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
      AIChatAgent.CHAT_FIBER_NAME,
      { requestId, continuation: false, nonce: `gone-${requestId}` },
      { metadata: { requestId } }
    );
    return receipt.runId;
  }

  getTurnRecoveriesForTest(): string[] {
    return this._turnRecoveriesForTest;
  }

  getTaskRunStateForTest(runId: string): string | null {
    return (
      this.sql<{ state: string }>`
        SELECT state FROM cf_agents_task_runs WHERE run_id = ${runId}
      `[0]?.state ?? null
    );
  }

  getTurnStoresForTest(): Array<{ taskRuns: number; fibers: number }> {
    return this._turnStoresForTest;
  }

  private async _waitForRunTerminalForTest(
    runId: string
  ): Promise<AgentToolRunInspection | null> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const inspection = await this.inspectAgentToolRun(runId);
      if (
        (inspection && inspection.status !== "running") ||
        Date.now() > deadline
      ) {
        return inspection;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Resolve once no run's lifecycle is left in this isolate. */
  private async _waitForRunsSettledForTest(): Promise<void> {
    const deadline = Date.now() + 5000;
    while (
      this["_agentToolRuns"].controllers.size > 0 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await this["_turnQueue"].waitForIdle();
  }

  private _userTextsForTest(): string[] {
    return this.messages
      .filter((message) => message.role === "user")
      .map((message) =>
        message.parts
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("")
      );
  }

  /** The output hook of a run started here gets the input as it was passed. */
  async runWithDateInputForTest(): Promise<unknown> {
    const runId = crypto.randomUUID();
    await this.startAgentToolRun(
      { prompt: "typed input", probeDate: new Date(0) },
      { runId }
    );
    return (await this._waitForRunTerminalForTest(runId))?.output;
  }

  /** A run whose output hook returns a value JSON cannot hold. */
  async runWithCircularOutputForTest(): Promise<{
    status: string | undefined;
    output: unknown;
  }> {
    const runId = crypto.randomUUID();
    await this.startAgentToolRun(
      { prompt: "circular output", circularOutput: true },
      { runId }
    );
    const inspection = await this._waitForRunTerminalForTest(runId);
    return { status: inspection?.status, output: inspection?.output };
  }

  /** A chat reset lands while the run's reply streams. */
  async resetWhileRunStreamsForTest(): Promise<AgentToolRunInspection | null> {
    const runId = crypto.randomUUID();
    await this.startAgentToolRun(
      { prompt: "reset probe", chunkDelayMs: 60 },
      { runId }
    );
    if (!(await this._waitForLiveTurnForTest(runId))) {
      throw new Error("the run's turn never started streaming");
    }
    this.resetTurnState();
    return this._waitForRunTerminalForTest(runId);
  }

  /**
   * A run is cancelled while its turn waits in the queue behind another
   * run's turn, optionally followed by a chat reset.
   */
  async cancelQueuedRunForTest(thenReset: boolean): Promise<{
    queued: AgentToolRunInspection | null;
    userTexts: string[];
    chatCalls: string[];
  }> {
    const first = crypto.randomUUID();
    const queued = crypto.randomUUID();
    await this.startAgentToolRun(
      { prompt: "first run", delayMs: 150 },
      { runId: first }
    );
    const deadline = Date.now() + 2000;
    while (!this._chatCallsForTest.includes("first run")) {
      if (Date.now() > deadline) throw new Error("first run never started");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await this.startAgentToolRun({ prompt: "queued run" }, { runId: queued });
    await this.cancelAgentToolRun(queued, "stop");
    if (thenReset) this.resetTurnState();
    await this._waitForRunsSettledForTest();
    return {
      queued: await this.inspectAgentToolRun(queued),
      userTexts: this._userTextsForTest(),
      chatCalls: [...this._chatCallsForTest]
    };
  }

  /**
   * A run started with the parent's signal is stopped through that signal
   * while its turn waits in the queue behind another run's turn.
   */
  async signalCancelsQueuedRunForTest(): Promise<{
    atAbort: AgentToolRunInspection | null;
    userTexts: string[];
    chatCalls: string[];
  }> {
    const first = crypto.randomUUID();
    const queued = crypto.randomUUID();
    await this.startAgentToolRun(
      { prompt: "first run", delayMs: 150 },
      { runId: first }
    );
    const deadline = Date.now() + 2000;
    while (!this._chatCallsForTest.includes("first run")) {
      if (Date.now() > deadline) throw new Error("first run never started");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const parent = new AbortController();
    await this.startAgentToolRun(
      { prompt: "queued run" },
      { runId: queued, signal: parent.signal }
    );
    parent.abort(new Error("parent stopped"));
    // Read while the first run still holds the queue.
    const atAbort = await this.inspectAgentToolRun(queued);
    await this._waitForRunsSettledForTest();
    return {
      atAbort,
      userTexts: this._userTextsForTest(),
      chatCalls: [...this._chatCallsForTest]
    };
  }

  /**
   * Three runs started together on one agent. Each turn must run with its
   * own run's input as body, and a run still waiting in the queue must not
   * change the stored request context of the turn that is running.
   */
  async queuedRunsKeepTheirOwnBodyForTest(): Promise<{
    storedWhileQueued: unknown;
    second: { status: string | undefined; error: string | undefined };
  }> {
    await this.startAgentToolRun(
      { prompt: "a", delayMs: 150 },
      { runId: "body-a" }
    );
    const deadline = Date.now() + 2000;
    while (!this._chatCallsForTest.includes("a")) {
      if (Date.now() > deadline) throw new Error("first run never started");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await this.startAgentToolRun(
      { prompt: "b", streamError: "boom" },
      { runId: "body-b" }
    );
    await this.startAgentToolRun({ prompt: "c" }, { runId: "body-c" });
    // Both runs are queued by now; the first is still running.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const storedWhileQueued = (
      this._lastBody as { agentToolInput?: { prompt?: string } } | undefined
    )?.agentToolInput?.prompt;
    await this._waitForRunsSettledForTest();
    const second = await this.inspectAgentToolRun("body-b");
    return {
      storedWhileQueued,
      second: { status: second?.status, error: second?.error }
    };
  }

  /** A cancel for a run that already finished must not touch other turns. */
  async cancelFinishedRunForTest(): Promise<{
    status: string | undefined;
    otherTurnAborted: boolean;
    ownRequestAborted: boolean;
    after: { status: string; cancelledAt: number | null } | null;
  }> {
    const runId = crypto.randomUUID();
    await this.startAgentToolRun({ prompt: "quick run" }, { runId });
    const finished = await this._waitForRunTerminalForTest(runId);
    await this._waitForRunsSettledForTest();
    const store = this["_agentToolRuns"].store;
    const signal = this["_abortRegistry"].getSignal("another-turn");
    // A later turn could run under the finished run's old request id.
    const ownRequestId = store.read(runId)?.requestId ?? "";
    const own = this["_abortRegistry"].getSignal(ownRequestId);
    await this.cancelAgentToolRun(runId, "late cancel");
    const otherTurnAborted = signal?.aborted ?? false;
    const ownRequestAborted = own?.aborted ?? false;
    this["_abortRegistry"].remove("another-turn");
    this["_abortRegistry"].remove(ownRequestId);
    const row = store.read(runId);
    return {
      status: finished?.status,
      otherTurnAborted,
      ownRequestAborted,
      after: row ? { status: row.status, cancelledAt: row.cancelledAt } : null
    };
  }

  /**
   * A cancel of a run being recovered stops what runs under the request ids
   * on its row (the recovered turn, a recovery attempt registered under the
   * first id) and nothing else on the agent.
   */
  async cancelRecoveredRunForTest(): Promise<{
    recoveredTurnAborted: boolean;
    attemptAborted: boolean;
    otherTurnAborted: boolean;
    otherAttemptAborted: boolean;
  }> {
    const runId = crypto.randomUUID();
    this.sql`
      INSERT INTO cf_ai_chat_agent_tool_runs
        (run_id, request_id, root_request_id, status, started_at)
      VALUES (${runId}, 'recovered-request', 'first-request', 'running',
        ${Date.now()})
    `;
    const registry = this["_abortRegistry"];
    const recoveredTurn = registry.getSignal("recovered-request");
    const otherTurn = registry.getSignal("a-users-turn");
    const attempt = this["_turns"].beginRecoveryAttempt("first-request");
    const otherAttempt = this["_turns"].beginRecoveryAttempt("a-users-root");
    try {
      await this.cancelAgentToolRun(runId, "parent gave up");
      return {
        recoveredTurnAborted: recoveredTurn?.aborted ?? false,
        attemptAborted: attempt.signal.aborted,
        otherTurnAborted: otherTurn?.aborted ?? false,
        otherAttemptAborted: otherAttempt.signal.aborted
      };
    } finally {
      attempt.end();
      otherAttempt.end();
      registry.remove("recovered-request");
      registry.remove("a-users-turn");
    }
  }

  /**
   * The run was cancelled, then the isolate died before the run's turn
   * unwound, so chat recovery wakes for that turn. It must not run, and the
   * incident must say the run was cancelled.
   */
  async recoverCancelledRunForTest(
    path: "continue" | "retry",
    cancelled = true
  ): Promise<{
    incident: { status: string; reason?: string } | null;
    chatCalls: number;
  }> {
    await this.persistMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "question" }] },
      ...(path === "continue"
        ? [
            {
              id: "a1",
              role: "assistant" as const,
              parts: [{ type: "text" as const, text: "partial answer" }]
            }
          ]
        : [])
    ]);
    const runId = crypto.randomUUID();
    // The run's turn was recovered once already, so the row names the
    // recovered turn. Recovery still names the turn by its first request id.
    this.sql`
      INSERT INTO cf_ai_chat_agent_tool_runs
        (run_id, request_id, root_request_id, status, started_at, completed_at,
         cancelled_at)
      VALUES (${runId}, 'recovered-request', 'interrupted-request', 'aborted',
        ${Date.now()}, ${Date.now()}, ${cancelled ? Date.now() : null})
    `;
    const incidentId = crypto.randomUUID();
    const key = `cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`;
    const now = Date.now();
    await this.ctx.storage.put(key, {
      incidentId,
      requestId: "recovered-request",
      recoveryRootRequestId: "interrupted-request",
      recoveryKind: path,
      attempt: 1,
      maxAttempts: 10,
      status: "scheduled",
      firstSeenAt: now,
      lastAttemptAt: now
    });
    const recovery = this as unknown as {
      _chatRecoveryContinueDetached(d: object): Promise<void>;
      _chatRecoveryRetryDetached(d: object): Promise<void>;
    };
    if (path === "continue") {
      await recovery._chatRecoveryContinueDetached({
        incidentId,
        originalRequestId: "interrupted-request",
        targetAssistantId: "a1"
      });
    } else {
      await recovery._chatRecoveryRetryDetached({
        incidentId,
        originalRequestId: "interrupted-request",
        targetUserId: "u1"
      });
    }
    const incident =
      (await this.ctx.storage.get<{ status: string; reason?: string }>(key)) ??
      null;
    return {
      incident: incident
        ? { status: incident.status, reason: incident.reason }
        : null,
      chatCalls: this._chatCallsForTest.length
    };
  }

  /** `starting` is an open status too: a cancel settles such a row. */
  async cancelStartingRunForTest(): Promise<string | null> {
    const runId = crypto.randomUUID();
    this.sql`
      INSERT INTO cf_ai_chat_agent_tool_runs (run_id, status, started_at)
      VALUES (${runId}, 'starting', ${Date.now()})
    `;
    await this.cancelAgentToolRun(runId, "stop");
    return this._readChildRunStatusForTest(runId);
  }

  private _attachRaceInjection: { runId: string; body: string } | null = null;

  /**
   * #1589: arm a one-shot chunk injection that fires from inside
   * `getAgentToolChunks` — i.e. AFTER the stored snapshot is read but (in the
   * buggy ordering) BEFORE `tailAgentToolRun` attaches its live forwarder. This
   * deterministically reproduces the drain↔register window a network-paced
   * proxied remote stream hits constantly.
   */
  armAttachRaceInjectionForTest(runId: string, body: string): void {
    this._attachRaceInjection = { runId, body };
  }

  private _progressInjection: {
    runId: string;
    progressBody: string;
    milestoneBody: string;
  } | null = null;

  /**
   * Arm a one-shot injection of NON-stored progress + milestone frames (the
   * `reportProgress` wire shape) that fire from inside `getAgentToolChunks`,
   * i.e. while the parent is still in the stored-replay → live-forwarding
   * handoff. Unlike a streamed chunk these are broadcast-only — they carry no
   * stored `chunk_index`, so they rely on the in-memory live sequence counter
   * to be forwarded. Guards that they survive the handoff and reach the parent.
   */
  armProgressInjectionForTest(
    runId: string,
    progressBody: string,
    milestoneBody: string
  ): void {
    this._progressInjection = { runId, progressBody, milestoneBody };
  }

  /**
   * Bounded-poll until the live child turn has registered its request id and
   * resumable stream id, so a test injection attributes (and, for a stored
   * chunk, persists) exactly like a real streamed chunk. Returns null if the
   * turn never came up within the window.
   */
  private async _waitForLiveTurnForTest(
    runId: string
  ): Promise<{ requestId: string; streamId: string } | null> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const requestId =
        this["_agentToolRuns"].store.read(runId)?.requestId ?? undefined;
      if (requestId) {
        const streamId =
          this._resumableStream.latestStreamInfoForRequest(requestId)?.id;
        if (streamId) return { requestId, streamId };
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return null;
  }

  override async getAgentToolChunks(
    runId: string,
    options?: { afterSequence?: number }
  ): Promise<AgentToolStoredChunk[]> {
    const chunks = await super.getAgentToolChunks(runId, options);

    const race = this._attachRaceInjection;
    if (race && race.runId === runId) {
      this._attachRaceInjection = null;
      // Land a STORED + broadcast chunk in the drain↔register window. This runs
      // INSIDE getAgentToolChunks, i.e. before tailAgentToolRun's post-drain
      // forwarder registration in the buggy ordering, so it faithfully lands in
      // the attach window. With the #1589 fix the forwarder is already attached,
      // so the chunk is buffered and replayed in order instead of being dropped.
      const live = await this._waitForLiveTurnForTest(runId);
      if (live) {
        await this["_storeStreamChunk"](live.streamId, race.body);
        this["_broadcastChatMessage"]({
          body: race.body,
          done: false,
          id: live.requestId,
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
        });
      }
    }

    const progress = this._progressInjection;
    if (progress && progress.runId === runId) {
      this._progressInjection = null;
      // Land NON-stored progress + milestone frames in the same window. These
      // are broadcast-only (exactly like `reportProgress`): they carry no
      // stored chunk_index, so they depend on the in-memory live sequence to be
      // forwarded. Sourcing the forward sequence from the stored chunk count
      // would collide them with the last stored chunk and the tail's high-water
      // dedupe would silently drop them — the regression this guards against.
      const live = await this._waitForLiveTurnForTest(runId);
      if (live) {
        this["_broadcastChatMessage"]({
          body: progress.progressBody,
          done: false,
          id: live.requestId,
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
        });
        this["_broadcastChatMessage"]({
          body: progress.milestoneBody,
          done: false,
          id: live.requestId,
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
        });
      }
    }

    return chunks;
  }

  /**
   * Reproduce the post-restart cold-counter realign (Devin review on #1827,
   * the hibernation / chat-recovery re-attach path). Seeds a RUNNING run with a
   * stored backlog 0..N, wipes the in-memory live sequence (as a child DO
   * restart / hibernation wake would), then tails it directly. After the drain
   * the live counter must realign to N+1 so a NEW broadcast — the recovered
   * turn's next chunk — forwards at N+1 instead of restarting at 0 and being
   * silently dropped by `emit`'s high-water dedupe.
   *
   * Returns the drained backlog sequences, the live counter after the drain,
   * and the forwarded post-restart chunk (null if it was dropped — the pre-fix
   * behaviour).
   */
  async coldCounterReattachForwardsForTest(afterSequence = -1): Promise<{
    drained: number[];
    liveSequenceAfterDrain: number | undefined;
    postRestart: { sequence: number; body: string } | null;
  }> {
    const runId = "cold-realign-run";
    const requestId = "cold-realign-req";
    const streamId = this["_resumableStream"].start(requestId);
    const backlog = [
      JSON.stringify({ type: "text-start" }),
      JSON.stringify({ type: "text-delta", delta: "a" }),
      JSON.stringify({ type: "text-delta", delta: "b" })
    ];
    for (const body of backlog) {
      await this["_storeStreamChunk"](streamId, body);
    }
    this["_resumableStream"].flushBuffer();
    this.sql`
      insert into cf_ai_chat_agent_tool_runs (run_id, request_id, status, input_json, started_at)
      values (${runId}, ${requestId}, 'running', '{}', ${Date.now()})
    `;
    // Simulate a restart / hibernation wake: the in-memory live sequence map is
    // cold; only the durable stored backlog survives.
    this["_agentToolRuns"].liveSequences.delete(runId);

    const stream = (await this.tailAgentToolRun(runId, {
      afterSequence
    })) as unknown as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readLine = async (timeoutMs: number): Promise<string | null> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line) return line;
          continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        const next = await Promise.race([
          reader.read(),
          new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), remaining)
          )
        ]);
        if (next === "timeout" || next.done) return null;
        buffer += decoder.decode(next.value, { stream: true });
      }
    };

    const drained: number[] = [];
    for (let i = afterSequence + 1; i < backlog.length; i++) {
      const line = await readLine(2000);
      if (line === null) break;
      drained.push((JSON.parse(line) as { sequence: number }).sequence);
    }

    // Wait (bounded) for the post-drain realign to run.
    const deadline = Date.now() + 2000;
    while (
      this["_agentToolRuns"].liveSequences.get(runId) !== backlog.length &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const liveSequenceAfterDrain =
      this["_agentToolRuns"].liveSequences.get(runId);

    // The recovered turn now broadcasts a NEW chunk (not in the backlog).
    const postBody = JSON.stringify({
      type: "tool-output-available",
      toolCallId: "post-restart",
      output: "ok"
    });
    this["_broadcastChatMessage"]({
      body: postBody,
      done: false,
      id: requestId,
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
    });

    const postLine = await readLine(2000);
    const postRestart =
      postLine === null
        ? null
        : (JSON.parse(postLine) as { sequence: number; body: string });
    await reader.cancel();
    return { drained, liveSequenceAfterDrain, postRestart };
  }

  /**
   * A warm run that already broadcast a progress frame, then a tail attaching
   * while a progress frame and a chunk (stored before the attach) are
   * broadcast during its drain. Returns every body the tail forwarded.
   */
  async progressDuringDrainForTest(): Promise<string[]> {
    const runId = "progress-drain-run";
    const requestId = "progress-drain-req";
    const streamId = this["_resumableStream"].start(requestId);
    this.sql`
      insert into cf_ai_chat_agent_tool_runs (run_id, request_id, status, input_json, started_at)
      values (${runId}, ${requestId}, 'running', '{}', ${Date.now()})
    `;
    this["_agentToolRuns"].runsByRequestId.set(requestId, runId);
    this["_agentToolRuns"].liveSequences.set(runId, 0);
    const broadcast = (body: string) =>
      this["_broadcastChatMessage"]({
        body,
        done: false,
        id: requestId,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
      });
    const progress = (message: string) =>
      JSON.stringify({
        type: "data-agent-progress",
        transient: true,
        data: { message }
      });

    const stored = [
      JSON.stringify({ type: "text-start", id: "t" }),
      JSON.stringify({ type: "text-delta", id: "t", delta: "a" }),
      JSON.stringify({ type: "text-delta", id: "t", delta: "b" })
    ];
    for (const body of stored.slice(0, 2)) {
      await this["_storeStreamChunk"](streamId, body);
      broadcast(body);
    }
    broadcast(progress("before-attach"));
    await this["_storeStreamChunk"](streamId, stored[2]);
    this["_resumableStream"].flushBuffer();

    const tail = this.tailAgentToolRun(runId, { afterSequence: -1 });
    broadcast(progress("during-drain"));
    broadcast(stored[2]);
    const reader = (
      (await tail) as unknown as ReadableStream<Uint8Array>
    ).getReader();

    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 500;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const next = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), remaining)
        )
      ]);
      if (next === "timeout" || next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
    }
    await reader.cancel();
    this["_agentToolRuns"].runsByRequestId.delete(requestId);
    this["_agentToolRuns"].liveSequences.delete(runId);
    return buffer
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { body: string }).body);
  }

  /**
   * A warm run that streamed a chunk too large to store, then a tail
   * re-attaching while a stored chunk is broadcast during its drain, followed
   * by another oversized chunk and a stored one. Returns what the tail
   * forwarded (oversized deltas summarized).
   */
  async skippedChunkReattachForTest(): Promise<
    Array<{ sequence: number; delta?: string; unstored: boolean }>
  > {
    const runId = "skipped-chunk-run";
    const requestId = "skipped-chunk-req";
    const streamId = this["_resumableStream"].start(requestId);
    this.sql`
      insert into cf_ai_chat_agent_tool_runs (run_id, request_id, status, input_json, started_at)
      values (${runId}, ${requestId}, 'running', '{}', ${Date.now()})
    `;
    this["_agentToolRuns"].runsByRequestId.set(requestId, runId);
    this["_agentToolRuns"].liveSequences.set(runId, 0);
    const broadcast = (body: string) =>
      this["_broadcastChatMessage"]({
        body,
        done: false,
        id: requestId,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
      });
    const send = async (body: string) => {
      await this["_storeStreamChunk"](streamId, body);
      broadcast(body);
    };
    const delta = (value: string) =>
      JSON.stringify({ type: "text-delta", id: "t", delta: value });
    const oversized = delta("x".repeat(1_900_000));

    await send(JSON.stringify({ type: "text-start", id: "t" }));
    await send(delta("a"));
    await send(oversized);
    await this["_storeStreamChunk"](streamId, delta("c"));
    this["_resumableStream"].flushBuffer();

    const tail = this.tailAgentToolRun(runId, { afterSequence: -1 });
    broadcast(delta("c"));
    const reader = (
      (await tail) as unknown as ReadableStream<Uint8Array>
    ).getReader();
    await send(oversized);
    await send(delta("d"));

    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 500;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const next = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), remaining)
        )
      ]);
      if (next === "timeout" || next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
    }
    await reader.cancel();
    this["_agentToolRuns"].runsByRequestId.delete(requestId);
    this["_agentToolRuns"].liveSequences.delete(runId);
    return buffer
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const chunk = JSON.parse(line) as AgentToolStoredChunk;
        const body = JSON.parse(chunk.body) as { delta?: string };
        return {
          sequence: chunk.sequence,
          ...(body.delta !== undefined
            ? { delta: body.delta.length > 10 ? "<oversized>" : body.delta }
            : {}),
          unstored: chunk.unstoredId !== undefined
        };
      });
  }

  /**
   * A running run with a cold live counter (as after a restart) and a stored
   * backlog 0..2, tailed while the recovered turn broadcasts a new chunk during
   * the tail's post-drain inspection. Returns the forwarded sequences and the
   * new chunk (null if dropped).
   */
  async broadcastDuringInspectionForTest(): Promise<{
    drained: number[];
    postRestart: { sequence: number; body: string } | null;
  }> {
    const runId = "inspect-pending-run";
    const requestId = "inspect-pending-req";
    const streamId = this["_resumableStream"].start(requestId);
    const backlog = ["a", "b", "c"].map((delta) =>
      JSON.stringify({ type: "text-delta", id: "t", delta })
    );
    for (const body of backlog) {
      await this["_storeStreamChunk"](streamId, body);
    }
    this["_resumableStream"].flushBuffer();
    this.sql`
      insert into cf_ai_chat_agent_tool_runs (run_id, request_id, status, input_json, started_at)
      values (${runId}, ${requestId}, 'running', '{}', ${Date.now()})
    `;
    this["_agentToolRuns"].liveSequences.delete(runId);

    const self = this as unknown as {
      inspectAgentToolRun: (runId: string) => Promise<unknown>;
    };
    const original = self.inspectAgentToolRun;
    let reached!: () => void;
    const atInspection = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    self.inspectAgentToolRun = async (id: string) => {
      reached();
      await gate;
      return original.call(this, id);
    };

    try {
      const reader = (
        (await this.tailAgentToolRun(runId, {
          afterSequence: -1
        })) as unknown as ReadableStream<Uint8Array>
      ).getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const readLine = async (timeoutMs: number): Promise<string | null> => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const nl = buffer.indexOf("\n");
          if (nl >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line) return line;
            continue;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) return null;
          const next = await Promise.race([
            reader.read(),
            new Promise<"timeout">((resolve) =>
              setTimeout(() => resolve("timeout"), remaining)
            )
          ]);
          if (next === "timeout" || next.done) return null;
          buffer += decoder.decode(next.value, { stream: true });
        }
      };

      const drained: number[] = [];
      for (let i = 0; i < backlog.length; i++) {
        const line = await readLine(2000);
        if (line === null) break;
        drained.push((JSON.parse(line) as { sequence: number }).sequence);
      }
      await atInspection;
      const postBody = JSON.stringify({
        type: "text-delta",
        id: "t",
        delta: "post-restart"
      });
      await this["_storeStreamChunk"](streamId, postBody);
      this["_broadcastChatMessage"]({
        body: postBody,
        done: false,
        id: requestId,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
      });
      release();
      const postLine = await readLine(500);
      await reader.cancel();
      return {
        drained,
        postRestart:
          postLine === null
            ? null
            : (JSON.parse(postLine) as { sequence: number; body: string })
      };
    } finally {
      release();
      self.inspectAgentToolRun = original;
      this["_agentToolRuns"].liveSequences.delete(runId);
    }
  }

  /**
   * Inspect a stale `running` run row (no live run, no recovery) with
   * `reconcile: false`. Returns the reported and the stored status afterwards.
   */
  async inspectStaleRunReadOnlyForTest(): Promise<{
    reported: string | undefined;
    stored: string | undefined;
  }> {
    const runId = crypto.randomUUID();
    this.sql`
      insert into cf_ai_chat_agent_tool_runs (run_id, status, input_json, started_at)
      values (${runId}, 'running', '{}', ${Date.now()})
    `;
    const inspection = await this.inspectAgentToolRun(runId, {
      reconcile: false
    });
    return {
      reported: inspection?.status,
      stored: this["_agentToolRuns"].store.read(runId)?.status
    };
  }

  /**
   * A child turn that streams error text, then an error chunk, and persists its
   * assistant reply — but is "evicted" before `startAgentToolRun`'s finalizer
   * seals the row `error`. Holds the finalizer at the point the turn returns,
   * drops the run's in-memory state as an eviction would, then inspects
   * (reconciling the stale `running` row).
   */
  async reconcileEvictedErroredRunForTest(): Promise<{
    before: string | null;
    assistantText: string;
    inspection: AgentToolRunInspection | null;
  }> {
    const runId = crypto.randomUUID();
    let reached!: () => void;
    let release!: () => void;
    const reachedGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Hold the run's lifecycle at the point its turn hands back.
    const self = this as unknown as {
      _runProgrammaticMessagesTurn: (
        ...args: unknown[]
      ) => Promise<SaveMessagesResult>;
    };
    const runTurn = self._runProgrammaticMessagesTurn.bind(this);
    self._runProgrammaticMessagesTurn = async (...args) => {
      const result = await runTurn(...args);
      self._runProgrammaticMessagesTurn = runTurn;
      reached();
      await released;
      return result;
    };
    await this.startAgentToolRun(
      {
        prompt: "fail midway",
        streamError: "model exploded",
        streamErrorText: "Sorry, something went wrong."
      },
      { runId }
    );
    await reachedGate;
    try {
      this["_agentToolRuns"].controllers.delete(runId);
      this["_agentToolRuns"].lastErrors.delete(runId);
      this["_agentToolRuns"].liveSequences.delete(runId);
      this["_agentToolRuns"].preTurnAssistantIds.delete(runId);
      this["_agentToolRuns"].runsByRequestId.clear();
      const before = this._readChildRunStatusForTest(runId);
      const assistantText = this.messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.parts)
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      const inspection = await this.inspectAgentToolRun(runId);
      return { before, assistantText, inspection };
    } finally {
      release();
    }
  }

  /**
   * Rebind an in-flight `eventDelivery: "terminal"` run the way a recovered
   * turn does, then close its tailers the way a settled recovered turn does.
   * Returns whether the run is still in the terminal-only set.
   */
  terminalOnlyRunAfterRecoveredTurnForTest(): {
    afterRebind: boolean;
    afterClose: boolean;
  } {
    const runId = "terminal-only-recovered-run";
    this.sql`
      insert into cf_ai_chat_agent_tool_runs
        (run_id, request_id, status, input_json, started_at, event_delivery)
      values (${runId}, 'old-req', 'running', '{}', ${Date.now()}, 'terminal')
    `;
    this["_agentToolRuns"].rebind("recovery-req", "old-req");
    const afterRebind = this["_agentToolRuns"].terminalOnlyRuns.has(runId);
    this["_agentToolRuns"].closeTailers(runId);
    return {
      afterRebind,
      afterClose: this["_agentToolRuns"].terminalOnlyRuns.has(runId)
    };
  }

  /**
   * Reproduce the cancelled-tailer-starves-siblings bug (Devin review on #1827).
   * Two parents tail the SAME run; tailer A's consumer cancels its reader. With
   * an empty `cancel` handler and an unguarded `controller.close()`, A's stale
   * forwarder stays registered, and the next broadcast throws while emitting to
   * A (enqueue on a cancelled stream → `close()` → `controller.close()` throws),
   * which propagates out of `interceptAgentToolBroadcast`'s forward loop and
   * starves sibling tailer B of that chunk. With the fix A is detached on cancel
   * and `controller.close()` is guarded, so B still receives the chunk.
   */
  async cancelledTailerStarvationForTest(): Promise<{
    siblingBodyAfterCancel: string | null;
  }> {
    const runId = "starve-run";
    const requestId = "starve-req";
    const streamId = this["_resumableStream"].start(requestId);
    await this["_storeStreamChunk"](
      streamId,
      JSON.stringify({ type: "text-start" })
    );
    this["_resumableStream"].flushBuffer();
    this.sql`
      insert into cf_ai_chat_agent_tool_runs (run_id, request_id, status, input_json, started_at)
      values (${runId}, ${requestId}, 'running', '{}', ${Date.now()})
    `;
    // One stored chunk (index 0) ⇒ live counter sits at 1, in lockstep.
    this["_agentToolRuns"].liveSequences.set(runId, 1);

    // afterSequence: 0 ⇒ the drain skips the stored backlog, so both tailers go
    // live immediately. A is registered first (iterated first in the broadcast).
    const a = (await this.tailAgentToolRun(runId, {
      afterSequence: 0
    })) as unknown as ReadableStream<Uint8Array>;
    const b = (await this.tailAgentToolRun(runId, {
      afterSequence: 0
    })) as unknown as ReadableStream<Uint8Array>;
    const readerA = a.getReader();
    const readerB = b.getReader();

    // Wait until both forwarders are registered and live (drain complete).
    const regDeadline = Date.now() + 2000;
    while (
      (this["_agentToolRuns"].forwarders.get(runId)?.size ?? 0) < 2 &&
      Date.now() < regDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    // A's consumer detaches.
    await readerA.cancel();

    // A new chunk is broadcast for the run.
    const body = JSON.stringify({
      type: "tool-output-available",
      toolCallId: "sibling",
      output: "ok"
    });
    this["_broadcastChatMessage"]({
      body,
      done: false,
      id: requestId,
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
    });

    // B must still receive it.
    const decoder = new TextDecoder();
    let buf = "";
    let siblingBodyAfterCancel: string | null = null;
    const deadline = Date.now() + 2000;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) {
          siblingBodyAfterCancel = (JSON.parse(line) as { body: string }).body;
          break;
        }
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const next = await Promise.race([
        readerB.read(),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), remaining)
        )
      ]);
      if (next === "timeout" || next.done) break;
      buf += decoder.decode(next.value, { stream: true });
    }
    await readerB.cancel();
    return { siblingBodyAfterCancel };
  }

  /**
   * #1575: broadcast a chat error frame whose request id belongs to no
   * agent-tool run, simulating an unrelated turn failing on this agent
   * while a run is being tailed.
   */
  broadcastUnrelatedErrorForTest(requestId: string): void {
    this.broadcast(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        id: requestId,
        error: true,
        done: false,
        body: "unrelated turn failure"
      })
    );
  }

  /**
   * #1575: number of live request-id → run-id cache entries. Used to assert
   * the negative cache (null entries for unrelated turns) does not leak past
   * a run's lifetime.
   */
  agentToolRunsByRequestIdSizeForTest(): number {
    // Bracket access: the field is private on the base AIChatAgent, and this
    // test-only subclass deliberately peeks at it without widening the
    // published API.
    return this["_agentToolRuns"].runsByRequestId.size;
  }

  /**
   * #1575: simulate a DO restart mid-run — the in-memory request-id map is
   * empty (wiped by the restart), but the run row persisted its `request_id`
   * at turn start. `AgentToolRuns.runForRequest` must still attribute a frame to
   * the run via the SQL fallback, and an unknown request resolves to null.
   */
  resolveAgentToolRunAfterRestartForTest(
    runId: string,
    requestId: string
  ): { running: string | null; unknown: string | null } {
    this.sql`
      insert into cf_ai_chat_agent_tool_runs
        (run_id, request_id, status, input_json, started_at)
      values (${runId}, ${requestId}, 'running', '{}', ${Date.now()})
    `;
    // Cold in-memory map, as after a restart.
    this["_agentToolRuns"].runsByRequestId.clear();
    return {
      running: this["_agentToolRuns"].runForRequest(requestId),
      unknown: this["_agentToolRuns"].runForRequest("no-such-request")
    };
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
      _chatRecoveryContinueDetached(d?: {
        targetAssistantId?: string;
      }): Promise<void>;
      _chatRecoveryRetryDetached(d?: Record<string, never>): Promise<void>;
    };
    if (path === "continue") {
      // A non-leaf `targetAssistantId` → benign "conversation_changed" skip
      // that still reaches the `finally`.
      await recovery._chatRecoveryContinueDetached({
        targetAssistantId: "no-such-leaf"
      });
    } else {
      // A non-user leaf (or empty transcript) → benign "no_unanswered_user_
      // message" skip that still reaches the `finally`.
      await recovery._chatRecoveryRetryDetached({});
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
      INSERT INTO cf_ai_chat_agent_tool_runs (run_id, request_id, status, started_at)
      VALUES (${runId}, 'recovered-request', 'running', ${Date.now()})
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
  override async __unsafe_ensureInitialized(): Promise<void> {
    await new Promise<void>(() => {
      // Intentionally never resolves: simulates a child wedged in startup.
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

/** The child name the test parent gives each run, so a test can reach it first. */
function agentToolChildNameForTest(runId: string): string {
  return `child-${runId}`;
}

/**
 * The child of a run the test parent started. The stub is typed as the
 * class: every method a test calls on it is async.
 */
async function agentToolChildForTest<T extends Agent>(
  namespace: DurableObjectNamespace<T>,
  runId: string
): Promise<T> {
  return (await getAgentByName(
    namespace,
    agentToolChildNameForTest(runId)
  )) as unknown as T;
}

export class AIChatAgentToolParent extends Agent<Env> {
  private events: AgentToolEventMessage[] = [];
  private finishes: AgentToolFinishForTest[] = [];
  private finishRunIdsToThrow = new Set<string>();
  private lifecycleOrder: string[] = [];

  /**
   * Drive the root alarm straight to sealing for one routed child recovery
   * row. The root is deliberately a plain Agent: only the child owns the
   * active chat-recovery incident and terminal policy.
   */
  async driveFacetRecoveryOomSealForTest(
    executing: { childName: string; incidentId: string },
    pending: { childName: string; incidentId: string }
  ): Promise<string[]> {
    const pendingChild = await this.subAgent(
      AIChatAgentToolChild,
      pending.childName
    );
    const pendingRunId = await pendingChild.seedFacetRecoveryOomForTest(
      pending.incidentId
    );
    const executingChild = await this.subAgent(
      AIChatAgentToolChild,
      executing.childName
    );
    const executingRunId = await executingChild.seedFacetRecoveryOomForTest(
      executing.incidentId
    );
    // Both runs safely parked themselves (waiting, ~1h out) on their own
    // uncontrolled first dispatch; force only the executing one due again,
    // past its journaled sleep, so this alarm cycle drives it and leaves
    // the pending one untouched.
    await executingChild.armFacetRecoveryOomForTest(executingRunId);
    this.sql`
      UPDATE cf_agents_jobs
      SET time = ${Date.now() - 1_000}
      WHERE capability = 'tasks'
        AND json_extract(payload, '$.runId') = ${executingRunId}
    `;
    await this.ctx.storage.put("cf_agents:oom_alarm_strikes", 2);
    await this.alarm();
    return [executingRunId, pendingRunId];
  }

  /**
   * Drive the root alarm to a single (non-sealing) memory-limit strike on
   * one routed child recovery run. Returns the run ID; the breaker's
   * deferred isolate reset means the caller should read the resulting
   * claim state through a fresh stub, not this same invocation.
   */
  async driveFacetRecoveryOomBackoffForTest(executing: {
    childName: string;
    incidentId: string;
  }): Promise<string> {
    const child = await this.subAgent(
      AIChatAgentToolChild,
      executing.childName
    );
    const runId = await child.seedFacetRecoveryOomForTest(executing.incidentId);
    await child.armFacetRecoveryOomForTest(runId);
    this.sql`
      UPDATE cf_agents_jobs
      SET time = ${Date.now() - 1_000}
      WHERE capability = 'tasks' AND json_extract(payload, '$.runId') = ${runId}
    `;
    // One strike under the 3-strike seal threshold (#1825): the breaker
    // backs off without sealing.
    await this.ctx.storage.put("cf_agents:oom_alarm_strikes", 0);
    await this.alarm();
    return runId;
  }

  /**
   * Drive the root alarm to dispatch a routed run whose failure takes
   * longer than the five-second dispatch budget, sealing on it. Root's
   * own budget wins the race well before the facet throws, so this
   * returns once root has detached — the caller must wait out the
   * remaining delay (through a fresh stub) before checking the seal
   * actually landed.
   */
  async driveFacetRecoverySlowOomSealForTest(executing: {
    childName: string;
    incidentId: string;
  }): Promise<string> {
    const child = await this.subAgent(
      AIChatAgentToolChild,
      executing.childName
    );
    const runId = await child.seedFacetRecoveryOomForTest(
      executing.incidentId,
      "__cf_test_facetRecoverySlowOom"
    );
    await child.armFacetRecoveryOomForTest(runId);
    this.sql`
      UPDATE cf_agents_jobs
      SET time = ${Date.now() - 1_000}
      WHERE capability = 'tasks' AND json_extract(payload, '$.runId') = ${runId}
    `;
    // Two strikes already banked: the slow run's eventual (delayed)
    // failure is the third, sealing strike (#1825).
    await this.ctx.storage.put("cf_agents:oom_alarm_strikes", 2);
    await this.alarm();
    return runId;
  }

  /** This facet's own run row state, read through the parent by name. */
  async facetRecoveryOomRunStateForTest(
    childName: string,
    runId: string
  ): Promise<{
    state: string;
    generation: string | null;
    next_at: number | null;
  } | null> {
    const child = await this.subAgent(AIChatAgentToolChild, childName);
    return child.getFacetRecoveryOomRunStateForTest(runId);
  }

  /** Whether a routed Task run still has a wake job mirrored on this root. */
  rootHasRoutedTaskWakeForTest(runId: string): boolean {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM cf_agents_jobs
      WHERE capability = 'tasks' AND json_extract(payload, '$.runId') = ${runId}
    `;
    return (rows[0]?.count ?? 0) > 0;
  }

  /** Read a child facet's durable recovery incident after root sealing. */
  async facetRecoveryIncidentStatusForTest(
    childName: string,
    incidentId: string
  ): Promise<string | null> {
    const child = await this.subAgent(AIChatAgentToolChild, childName);
    return child.facetRecoveryIncidentStatusForTest(incidentId);
  }

  /** Whether a root-owned schedule row still exists. */
  rootHasScheduleForTest(scheduleId: string): boolean {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM cf_agents_jobs WHERE id = ${scheduleId}
    `;
    return (rows[0]?.count ?? 0) > 0;
  }

  /**
   * Drive real fiber-interruption recovery detection on a routed child and
   * report where the continuation landed: the Task run stays on the child
   * (its storage owns the run and step journal), mirrored as one routed wake
   * job on this root's queue (`owner_path` set) — the alarm this root
   * actually owns. `schedules` pins that the retired Scheduler bridge stays
   * dead. Pins `_enqueueChatRecovery` against the real detection path, not a
   * manually seeded row.
   */
  async driveFacetChatRecoveryDetectionForTest(childName: string): Promise<{
    taskRunOnChild: number;
    routedWakeOnRoot: number;
    schedules: number;
  }> {
    const child = await this.subAgent(AIChatAgentToolChild, childName);
    await child.insertInterruptedFiber("__cf_internal_chat_turn:req-facet");
    await child.triggerFiberRecovery();
    const taskRunOnChild = await child.getChatRecoveryTaskRunCountForTest(
      "_chatRecoveryContinue"
    );
    const schedules = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM cf_agents_jobs
      WHERE capability = 'scheduler' AND fn = '_chatRecoveryContinue'
    `;
    const routedWakeOnRoot = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM cf_agents_jobs
      WHERE capability = 'tasks'
        AND json_extract(payload, '$.owner_path') IS NOT NULL
    `;
    return {
      taskRunOnChild,
      routedWakeOnRoot: routedWakeOnRoot[0]?.count ?? 0,
      schedules: schedules[0]?.count ?? 0
    };
  }

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

  /** Replay an interrupted facet chat turn from the root's alarm. */
  async facetOrphanTurnReplayForTest(childName: string): Promise<{
    mirrored: number;
    recoveries: string[];
    state: string | null;
  }> {
    const child = await this.subAgent(AIChatAgentToolChild, childName);
    const runId = await child.seedOrphanChatTurnRunForTest("req-orphan");
    const mirrored =
      this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM cf_agents_jobs
      WHERE capability = 'tasks'
        AND json_extract(payload, '$.runId') = ${runId}
        AND json_extract(payload, '$.owner_path') IS NOT NULL
    `[0]?.count ?? 0;
    this.sql`
      UPDATE cf_agents_jobs SET time = ${Date.now() - 1_000}
      WHERE capability = 'tasks' AND json_extract(payload, '$.runId') = ${runId}
    `;
    await this.alarm();
    for (let i = 0; i < 100; i++) {
      const state = await child.getTaskRunStateForTest(runId);
      if (state === "completed" || state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      mirrored,
      recoveries: await child.getTurnRecoveriesForTest(),
      state: await child.getTaskRunStateForTest(runId)
    };
  }

  /** Run a child, and say where the child stored its running turn. */
  async runChildTurnStoresForTest(): Promise<{
    status: string;
    stores: Array<{ taskRuns: number; fibers: number }>;
  }> {
    const runId = crypto.randomUUID();
    const result = await this.runChild({ prompt: "where" }, runId);
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      runId
    );
    return {
      status: result.status,
      stores: await child.getTurnStoresForTest()
    };
  }

  async runChild(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<RunAgentToolResult> {
    this.events = [];
    this.finishes = [];
    return this.runAgentTool(AIChatAgentToolChild, {
      runId,
      childName: agentToolChildNameForTest(runId),
      parentToolCallId: "test-tool-call",
      input,
      inputPreview: input.prompt
    });
  }

  /**
   * The parent forwards five chunks of the run's first turn, then its tail
   * breaks. The recovered turn has a stream of its own, which holds two
   * chunks when the parent re-attaches and gets two more. Returns the
   * sequence the parent broadcast each chunk under.
   */
  async runChildRecoveredOnAShorterStreamForTest(): Promise<{
    status: string;
    sequences: number[];
  }> {
    const runId = crypto.randomUUID();
    const running: AgentToolRunInspection = {
      runId,
      status: "running",
      startedAt: Date.now()
    };
    const line = (sequence: number, body: string) =>
      new TextEncoder().encode(`${JSON.stringify({ sequence, body })}\n`);
    const chunk = (text: string) =>
      JSON.stringify({ type: "text-delta", id: "t", delta: text });
    const self = this as unknown as {
      _asAgentToolChildAdapter(child: unknown): unknown;
    };
    const asAdapter = self._asAgentToolChildAdapter;
    let tails = 0;
    let done = false;
    self._asAgentToolChildAdapter = () => ({
      startAgentToolRun: async () => running,
      cancelAgentToolRun: async () => {},
      inspectAgentToolRun: async () =>
        done ? { ...running, status: "completed", summary: "ok" } : running,
      // The run's current stream: the recovered turn's, two chunks so far.
      getAgentToolChunks: async () => [
        { sequence: 0, body: chunk("r0") },
        { sequence: 1, body: chunk("r1") }
      ],
      tailAgentToolRun: async () => {
        const first = ++tails === 1;
        let sent = 0;
        return new ReadableStream<Uint8Array>({
          // One chunk per read: an errored stream drops what is queued.
          pull(controller) {
            if (first) {
              if (sent < 5) {
                controller.enqueue(line(sent, chunk(`a${sent}`)));
                sent++;
                return;
              }
              controller.error(
                new Error(
                  "ReadableStream received over RPC disconnected prematurely."
                )
              );
              return;
            }
            if (sent < 2) {
              controller.enqueue(line(2 + sent, chunk(`r${2 + sent}`)));
              sent++;
              return;
            }
            done = true;
            controller.close();
          }
        });
      }
    });
    this.events = [];
    try {
      const result = await this.runAgentTool(AIChatAgentToolChild, {
        runId,
        childName: agentToolChildNameForTest(runId),
        parentToolCallId: "test-tool-call",
        input: { prompt: "recovers on a shorter stream" },
        inputPreview: "recovers on a shorter stream"
      });
      return {
        status: result.status,
        sequences: this.events
          .filter((message) => message.event.kind === "chunk")
          .map((message) => message.sequence)
      };
    } finally {
      self._asAgentToolChildAdapter = asAdapter;
    }
  }

  /**
   * The child never closes the parent's tail and never sends anything
   * through it. Its run is over by the second time the parent asks.
   */
  async runChildWhoseTailNeverClosesForTest(): Promise<{
    status: string;
    inspections: number;
    parentRow: string | null;
  }> {
    const runId = crypto.randomUUID();
    const running: AgentToolRunInspection = {
      runId,
      status: "running",
      startedAt: Date.now()
    };
    const self = this as unknown as {
      _asAgentToolChildAdapter(child: unknown): unknown;
      _resolvedOptions: { agentToolReattachNoProgressTimeoutMs: number };
    };
    const asAdapter = self._asAgentToolChildAdapter;
    const budget = self._resolvedOptions.agentToolReattachNoProgressTimeoutMs;
    let inspections = 0;
    self._asAgentToolChildAdapter = () => ({
      startAgentToolRun: async () => running,
      cancelAgentToolRun: async () => {},
      inspectAgentToolRun: async () =>
        ++inspections < 2
          ? running
          : { ...running, status: "aborted", error: "stopped on the child" },
      getAgentToolChunks: async () => [],
      tailAgentToolRun: async () => new ReadableStream({})
    });
    self._resolvedOptions.agentToolReattachNoProgressTimeoutMs = 50;
    try {
      const result = await Promise.race([
        this.runAgentTool(AIChatAgentToolChild, {
          runId,
          childName: agentToolChildNameForTest(runId),
          parentToolCallId: "test-tool-call",
          input: { prompt: "never closes" },
          inputPreview: "never closes"
        }),
        new Promise<{ status: string }>((resolve) =>
          setTimeout(() => resolve({ status: "still waiting" }), 3000)
        )
      ]);
      return {
        status: result.status,
        inspections,
        parentRow: this.getParentAgentToolStatusForTest(runId)
      };
    } finally {
      self._asAgentToolChildAdapter = asAdapter;
      self._resolvedOptions.agentToolReattachNoProgressTimeoutMs = budget;
    }
  }

  /**
   * The parent's tail breaks and the child keeps reporting the run as
   * running without ever producing anything: the parent's no-progress
   * budget runs out.
   */
  async runChildThatNeverRecoversForTest(): Promise<{
    status: string;
    reason?: string;
    childStillRunning?: boolean;
    parentRow: string | null;
  }> {
    const runId = crypto.randomUUID();
    const running: AgentToolRunInspection = {
      runId,
      status: "running",
      startedAt: Date.now()
    };
    const self = this as unknown as {
      _asAgentToolChildAdapter(child: unknown): unknown;
      _resolvedOptions: { agentToolReattachNoProgressTimeoutMs: number };
    };
    const asAdapter = self._asAgentToolChildAdapter;
    const budget = self._resolvedOptions.agentToolReattachNoProgressTimeoutMs;
    self._asAgentToolChildAdapter = () => ({
      startAgentToolRun: async () => running,
      cancelAgentToolRun: async () => {},
      inspectAgentToolRun: async () => running,
      getAgentToolChunks: async () => [],
      tailAgentToolRun: async () => {
        throw new Error(
          "ReadableStream received over RPC disconnected prematurely."
        );
      }
    });
    self._resolvedOptions.agentToolReattachNoProgressTimeoutMs = 50;
    try {
      const result = await this.runAgentTool(AIChatAgentToolChild, {
        runId,
        childName: agentToolChildNameForTest(runId),
        parentToolCallId: "test-tool-call",
        input: { prompt: "never recovers" },
        inputPreview: "never recovers"
      });
      return {
        status: result.status,
        reason: result.reason,
        childStillRunning: result.childStillRunning,
        parentRow: this.getParentAgentToolStatusForTest(runId)
      };
    } finally {
      self._asAgentToolChildAdapter = asAdapter;
      self._resolvedOptions.agentToolReattachNoProgressTimeoutMs = budget;
    }
  }

  /**
   * The child's isolate goes away under the `startAgentToolRun` call, so
   * the call fails. With `childHasRun`, the child had inserted the run
   * before it went and finishes it afterwards. Without, it never heard of
   * the run.
   */
  async runChildWhoseStartCallFailsForTest(childHasRun: boolean): Promise<{
    result: { status: string; error?: string } | { threw: string };
    parentRow: string | null;
  }> {
    const runId = crypto.randomUUID();
    const self = this as unknown as {
      _asAgentToolChildAdapter(child: unknown): unknown;
    };
    const asAdapter = self._asAgentToolChildAdapter;
    let inspections = 0;
    self._asAgentToolChildAdapter = () => ({
      startAgentToolRun: async () => {
        throw new Error("test: forced reset");
      },
      cancelAgentToolRun: async () => {},
      inspectAgentToolRun: async () => {
        if (!childHasRun) return null;
        return {
          runId,
          status: ++inspections < 2 ? "running" : "completed",
          summary: "done after all",
          startedAt: 1
        };
      },
      getAgentToolChunks: async () => [],
      tailAgentToolRun: async () =>
        new ReadableStream<Uint8Array>({
          start: (controller) => controller.close()
        })
    });
    try {
      const result = await this.runAgentTool(AIChatAgentToolChild, {
        runId,
        childName: agentToolChildNameForTest(runId),
        parentToolCallId: "test-tool-call",
        input: { prompt: "start call fails" },
        inputPreview: "start call fails"
      }).then(
        (value) => ({ status: value.status, error: value.error }),
        (error) => ({
          threw: error instanceof Error ? error.message : String(error)
        })
      );
      return { result, parentRow: this.getParentAgentToolStatusForTest(runId) };
    } finally {
      self._asAgentToolChildAdapter = asAdapter;
    }
  }

  /**
   * The child's isolate resets while the parent waits on its run. Returns
   * what the parent's `runAgentTool` handed back and what the child's row
   * says once its chat recovery has finished the turn.
   */
  async runChildThroughResetForTest(): Promise<{
    result: { status: string; error?: string };
    parentRow: string | null;
    child: { status: string; error?: string } | null;
  }> {
    const runId = crypto.randomUUID();
    const running = this.runAgentTool(AIChatAgentToolChild, {
      runId,
      childName: agentToolChildNameForTest(runId),
      parentToolCallId: "test-tool-call",
      input: { prompt: "work through a reset", chunkDelayMs: 100 },
      inputPreview: "work through a reset"
    });
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      runId
    );
    // Reset once the run's reply is streaming: a turn that had not
    // started cannot be recovered.
    const streaming = Date.now() + 5000;
    while (
      (await child.getAgentToolChunks(runId)).length === 0 &&
      Date.now() < streaming
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await child.resetIsolateForTest().catch(() => {});
    const result = await running;
    const deadline = Date.now() + 10_000;
    let inspection: { status: string; error?: string } | null = null;
    while (Date.now() < deadline) {
      const fresh = await agentToolChildForTest<AIChatAgentToolChild>(
        this.env.AIChatAgentToolChild,
        runId
      );
      inspection = await fresh.inspectAgentToolRun(runId);
      if (
        inspection &&
        inspection.status !== "running" &&
        inspection.status !== "starting"
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const row = this.sql<{ status: string }>`
      SELECT status FROM cf_agent_tool_runs WHERE run_id = ${runId}
    `[0];
    return {
      result: { status: result.status, error: result.error },
      parentRow: row?.status ?? null,
      child: inspection
        ? { status: inspection.status, error: inspection.error }
        : null
    };
  }

  /**
   * #1589: run a child that injects a chunk into the tail attach window and
   * return the forwarded agent-tool events so the test can assert the chunk
   * survives the stored-replay → live-forwarding handoff.
   */
  async runChildWithAttachRaceForTest(
    input: AgentToolInput,
    raceBody: string,
    runId = crypto.randomUUID()
  ): Promise<{ result: RunAgentToolResult; events: AgentToolEventMessage[] }> {
    this.events = [];
    this.finishes = [];
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      runId
    );
    await child.armAttachRaceInjectionForTest(runId, raceBody);
    const result = await this.runAgentTool(AIChatAgentToolChild, {
      runId,
      childName: agentToolChildNameForTest(runId),
      parentToolCallId: "test-tool-call",
      input,
      inputPreview: input.prompt
    });
    return { result, events: this.events };
  }

  /**
   * Run a child that injects NON-stored progress + milestone frames into the
   * tail attach window and return the forwarded events, so the test can assert
   * broadcast-only `reportProgress` frames survive the stored-replay →
   * live-forwarding handoff (they have no stored chunk_index, so the in-memory
   * live sequence counter is load-bearing for forwarding them).
   */
  async runChildWithProgressInjectionForTest(
    input: AgentToolInput,
    progressBody: string,
    milestoneBody: string,
    runId = crypto.randomUUID()
  ): Promise<{ result: RunAgentToolResult; events: AgentToolEventMessage[] }> {
    this.events = [];
    this.finishes = [];
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      runId
    );
    await child.armProgressInjectionForTest(runId, progressBody, milestoneBody);
    const result = await this.runAgentTool(AIChatAgentToolChild, {
      runId,
      childName: agentToolChildNameForTest(runId),
      parentToolCallId: "test-tool-call",
      input,
      inputPreview: input.prompt
    });
    return { result, events: this.events };
  }

  /**
   * Drive the child's post-restart cold-counter realign probe (Devin review on
   * #1827). Routed through `subAgent` so the child runs in its SQL-enabled DO.
   */
  async coldCounterChildReattachForTest(afterSequence?: number): Promise<{
    drained: number[];
    liveSequenceAfterDrain: number | undefined;
    postRestart: { sequence: number; body: string } | null;
  }> {
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.coldCounterReattachForwardsForTest(afterSequence);
  }

  async progressDuringChildDrainForTest(): Promise<string[]> {
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.progressDuringDrainForTest();
  }

  async skippedChunkChildReattachForTest(): Promise<
    Array<{ sequence: number; delta?: string; unstored: boolean }>
  > {
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.skippedChunkReattachForTest();
  }

  async broadcastDuringChildInspectionForTest(): Promise<{
    drained: number[];
    postRestart: { sequence: number; body: string } | null;
  }> {
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.broadcastDuringInspectionForTest();
  }

  async inspectStaleChildRunReadOnlyForTest(): Promise<{
    reported: string | undefined;
    stored: string | undefined;
  }> {
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.inspectStaleRunReadOnlyForTest();
  }

  async reconcileEvictedErroredChildForTest(): Promise<{
    before: string | null;
    assistantText: string;
    inspection: AgentToolRunInspection | null;
  }> {
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.reconcileEvictedErroredRunForTest();
  }

  async terminalOnlyChildAfterRecoveredTurnForTest(): Promise<{
    afterRebind: boolean;
    afterClose: boolean;
  }> {
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.terminalOnlyRunAfterRecoveredTurnForTest();
  }

  /**
   * Drive the cancelled-tailer-starves-siblings probe (Devin review on #1827).
   * Routed through `subAgent` so the child runs in its SQL-enabled DO.
   */
  async cancelledTailerStarvationChildForTest(): Promise<{
    siblingBodyAfterCancel: string | null;
  }> {
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.cancelledTailerStarvationForTest();
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
        childName: agentToolChildNameForTest(runId),
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

  /**
   * #1575: run a child while injecting a chat error frame from an UNRELATED
   * turn (a request id that belongs to no agent-tool run) into the child's
   * broadcast stream mid-run. The run's terminal status must not be
   * contaminated by it.
   */
  async runChildWithInjectedUnrelatedError(
    input: AgentToolInput,
    injectAfterMs: number,
    runId = crypto.randomUUID()
  ): Promise<RunAgentToolResult> {
    this.events = [];
    this.finishes = [];
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      runId
    );
    const timer = setTimeout(() => {
      void child.broadcastUnrelatedErrorForTest(`unrelated-turn-${runId}`);
    }, injectAfterMs);
    try {
      return await this.runAgentTool(AIChatAgentToolChild, {
        runId,
        childName: agentToolChildNameForTest(runId),
        parentToolCallId: "test-tool-call",
        input,
        inputPreview: input.prompt
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * #1575: read the child's live request-id cache size after a run, to assert
   * negatively-cached entries for unrelated turns were swept on completion.
   */
  async childAgentToolRunsMapSizeForTest(runId: string): Promise<number> {
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      runId
    );
    return child.agentToolRunsByRequestIdSizeForTest();
  }

  /**
   * #1575: resolve a run via the child's request-id SQL fallback after the
   * in-memory map is cleared (post-restart attribution).
   */
  async childResolveAfterRestartForTest(
    runId: string,
    requestId: string
  ): Promise<{ running: string | null; unknown: string | null }> {
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      runId
    );
    return child.resolveAgentToolRunAfterRestartForTest(runId, requestId);
  }

  /**
   * #1575: start a child run directly — no tailer/forwarder is ever
   * attached — and wait for its terminal inspection. Terminal status must
   * come from the child turn's own result, not from tailing side effects.
   */
  /**
   * Three runs on one child, started together: a slow one, one whose input
   * asks for a stream error, and a third. Returns the second run's outcome.
   */
  async startThreeChildRunsForTest(): Promise<AgentToolRunInspection> {
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      crypto.randomUUID()
    );
    const errorRunId = crypto.randomUUID();
    await child.startAgentToolRun(
      { prompt: "first", delayMs: 200 },
      { runId: crypto.randomUUID() }
    );
    await child.startAgentToolRun(
      { prompt: "second", streamError: "boom" },
      { runId: errorRunId }
    );
    await child.startAgentToolRun(
      { prompt: "third" },
      { runId: crypto.randomUUID() }
    );
    return this.waitForTerminalInspectionForTest(child, errorRunId);
  }

  async startChildWithoutTailForTest(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<AgentToolRunInspection> {
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      runId
    );
    await child.startAgentToolRun(input, { runId });
    return this.waitForTerminalInspectionForTest(child, runId);
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
        child_name, run_id, parent_tool_call_id, agent_type, input_preview,
        input_redacted, status, display_metadata, display_order, started_at
      ) VALUES (
        ${agentToolChildNameForTest(runId)}, ${runId}, 'test-tool-call', ${agentType},
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
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      runId
    );
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
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      runId
    );
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
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      runId
    );
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
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      runId
    );
    return child.inspectAgentToolRun(runId);
  }

  async getChildChunks(
    runId: string,
    afterSequence?: number
  ): Promise<AgentToolStoredChunk[]> {
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      runId
    );
    return child.getAgentToolChunks(runId, { afterSequence });
  }

  async getChildMessages(runId: string): Promise<ChatMessage[]> {
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      runId
    );
    return child.listMessagesForTest();
  }

  async startAndCancelChild(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<AgentToolRunInspection | null> {
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      runId
    );
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
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.reconcileStaleChildRunViaRecoveryForTest(
      path,
      withAssistantTurn
    );
  }

  private async _freshChildForTest() {
    return agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
      crypto.randomUUID()
    );
  }

  async childRunWithDateInputForTest() {
    return (await this._freshChildForTest()).runWithDateInputForTest();
  }

  async childRunWithCircularOutputForTest() {
    return (await this._freshChildForTest()).runWithCircularOutputForTest();
  }

  async childResetWhileRunStreamsForTest() {
    return (await this._freshChildForTest()).resetWhileRunStreamsForTest();
  }

  async childCancelQueuedRunForTest(thenReset: boolean) {
    return (await this._freshChildForTest()).cancelQueuedRunForTest(thenReset);
  }

  async childCancelFinishedRunForTest() {
    return (await this._freshChildForTest()).cancelFinishedRunForTest();
  }

  async childCancelRecoveredRunForTest() {
    return (await this._freshChildForTest()).cancelRecoveredRunForTest();
  }

  async childRecoverCancelledRunForTest(
    path: "continue" | "retry",
    cancelled = true
  ) {
    return (await this._freshChildForTest()).recoverCancelledRunForTest(
      path,
      cancelled
    );
  }

  async childSignalCancelsQueuedRunForTest() {
    return (await this._freshChildForTest()).signalCancelsQueuedRunForTest();
  }

  async childQueuedRunsKeepTheirOwnBodyForTest() {
    return (
      await this._freshChildForTest()
    ).queuedRunsKeepTheirOwnBodyForTest();
  }

  async childCancelStartingRunForTest() {
    return (await this._freshChildForTest()).cancelStartingRunForTest();
  }

  async childCancelAgentToolRunAbortsRecoveryForTest(): Promise<{
    abortedBefore: boolean;
    abortedAfter: boolean;
    childStatus: string | null;
  }> {
    const child = await agentToolChildForTest<AIChatAgentToolChild>(
      this.env.AIChatAgentToolChild,
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
      childName: agentToolChildNameForTest(runId),
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
