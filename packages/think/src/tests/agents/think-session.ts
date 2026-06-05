import type { LanguageModel, UIMessage } from "ai";
import { hasToolCall, Output, tool } from "ai";
import { defineScheduledTasks, Think } from "../../think";
import { Agent } from "agents";
import type {
  AgentToolEventMessage,
  AgentToolLifecycleResult,
  AgentToolRunInfo,
  AgentToolRunInspection,
  AgentToolStoredChunk,
  RunAgentToolResult
} from "agents";
import type {
  StreamCallback,
  StreamableResult,
  ChatOptions,
  ChatResponseResult,
  SaveMessagesResult,
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryExhaustedContext,
  ChatRecoveryOptions,
  ThinkSubmissionInspection,
  ThinkSubmissionStatus,
  SubmitMessagesResult,
  ThinkScheduledTask,
  ThinkScheduledTaskContext,
  ThinkScheduledTasks,
  TurnContext,
  TurnConfig,
  PrepareStepContext,
  StepConfig,
  ToolCallContext,
  ToolCallDecision,
  ToolCallResultContext,
  StepContext,
  ChunkContext
} from "../../think";
import { sanitizeMessage, enforceRowSizeLimit } from "agents/chat";
import type { ClientToolSchema } from "agents/chat";
import type { Schedule } from "agents";
import { Session } from "agents/experimental/memory/session";
import { z } from "zod";

// ── Test result type ────────────────────────────────────────────

export type TestChatResult = {
  events: string[];
  done: boolean;
  error?: string;
  interruptedCalls: number;
};

/** Shallow JSON object for DO RPC returns (`Record<string, unknown>` fails RPC typing). */
export type RpcJsonObject = Record<
  string,
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<string | number | boolean | null>
>;

// ── Mock LanguageModel (v3 format) ──────────────────────────────

let _mockCallCount = 0;

// AI SDK v3 LanguageModel spec helpers. See
// node_modules/@ai-sdk/provider/dist/index.d.ts (LanguageModelV3*).
const v3FinishReason = (unified: "stop" | "tool-calls") => ({
  unified,
  raw: undefined
});
const v3Usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens: {
    total: inputTokens,
    noCache: inputTokens,
    cacheRead: 0,
    cacheWrite: 0
  },
  outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 }
});

type CapturedModelCallSettings = {
  maxOutputTokens?: unknown;
  temperature?: unknown;
  topP?: unknown;
  topK?: unknown;
  presencePenalty?: unknown;
  frequencyPenalty?: unknown;
  stopSequences?: unknown;
  seed?: unknown;
  headers?: unknown;
  providerOptions?: unknown;
};

type MockModelOptions = {
  onCall?: (settings: CapturedModelCallSettings) => void;
};

function captureModelCallSettings(options: unknown): CapturedModelCallSettings {
  const record =
    options != null && typeof options === "object"
      ? (options as Record<string, unknown>)
      : {};
  return {
    maxOutputTokens: record.maxOutputTokens,
    temperature: record.temperature,
    topP: record.topP,
    topK: record.topK,
    presencePenalty: record.presencePenalty,
    frequencyPenalty: record.frequencyPenalty,
    stopSequences: record.stopSequences,
    seed: record.seed,
    headers: record.headers,
    providerOptions: record.providerOptions
  };
}

function createMockModel(
  response: string,
  options: MockModelOptions = {}
): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-model",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream(callOptions: unknown) {
      options.onCall?.(captureModelCallSettings(callOptions));
      _mockCallCount++;
      const callId = _mockCallCount;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: `t-${callId}` });
          controller.enqueue({
            type: "text-delta",
            id: `t-${callId}`,
            delta: response
          });
          controller.enqueue({ type: "text-end", id: `t-${callId}` });
          controller.enqueue({
            type: "finish",
            finishReason: v3FinishReason("stop"),
            usage: v3Usage(10, 5)
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

/**
 * Mimics Claude 4.6+: rejects a request whose final message is an assistant
 * message ("assistant prefill"). Reports the trailing role of each call so a
 * test can assert the continuation never sends a trailing assistant message.
 */
function createPrefillRejectingModel(
  response: string,
  options: { onCall?: (lastRole: string | undefined) => void } = {}
): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-prefill-rejecting",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream(callOptions: unknown) {
      const prompt =
        (callOptions as { prompt?: Array<{ role?: string }> }).prompt ?? [];
      const lastRole = prompt[prompt.length - 1]?.role;
      options.onCall?.(lastRole);
      if (lastRole === "assistant") {
        throw new Error(
          "This model does not support assistant message prefill. The conversation must end with a user message."
        );
      }
      _mockCallCount++;
      const callId = _mockCallCount;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: `t-${callId}` });
          controller.enqueue({
            type: "text-delta",
            id: `t-${callId}`,
            delta: response
          });
          controller.enqueue({ type: "text-end", id: `t-${callId}` });
          controller.enqueue({
            type: "finish",
            finishReason: v3FinishReason("stop"),
            usage: v3Usage(10, 5)
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

function createReasoningMockModel(
  response: string,
  reasoning: string
): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-reasoning-model",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream() {
      _mockCallCount++;
      const callId = _mockCallCount;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "reasoning-start", id: `r-${callId}` });
          controller.enqueue({
            type: "reasoning-delta",
            id: `r-${callId}`,
            delta: reasoning
          });
          controller.enqueue({ type: "reasoning-end", id: `r-${callId}` });
          controller.enqueue({ type: "text-start", id: `t-${callId}` });
          controller.enqueue({
            type: "text-delta",
            id: `t-${callId}`,
            delta: response
          });
          controller.enqueue({ type: "text-end", id: `t-${callId}` });
          controller.enqueue({
            type: "finish",
            finishReason: v3FinishReason("stop"),
            usage: v3Usage(10, 8)
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

/** Mock model that emits multiple text-delta chunks for abort testing */
function createMultiChunkMockModel(chunks: string[]): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-multi-chunk",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream() {
      _mockCallCount++;
      const callId = _mockCallCount;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: `t-${callId}` });
          for (const chunk of chunks) {
            controller.enqueue({
              type: "text-delta",
              id: `t-${callId}`,
              delta: chunk
            });
          }
          controller.enqueue({ type: "text-end", id: `t-${callId}` });
          controller.enqueue({
            type: "finish",
            finishReason: v3FinishReason("stop"),
            usage: v3Usage(10, chunks.length)
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

function createInBandErrorMockModel(
  errorText: string,
  textChunks: string[] = []
): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-in-band-error",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream() {
      _mockCallCount++;
      const callId = _mockCallCount;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (textChunks.length > 0) {
            controller.enqueue({ type: "text-start", id: `t-${callId}` });
            for (const chunk of textChunks) {
              controller.enqueue({
                type: "text-delta",
                id: `t-${callId}`,
                delta: chunk
              });
            }
          }
          controller.enqueue({ type: "error", error: new Error(errorText) });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

function createInBandErrorStreamResult(
  errorText: string,
  textChunks: string[] = [],
  afterErrorTextChunks: string[] = []
): StreamableResult {
  return {
    toUIMessageStream() {
      return {
        [Symbol.asyncIterator]() {
          let index = 0;
          const chunks: unknown[] = [];
          if (textChunks.length > 0) {
            chunks.push({ type: "text-start", id: "t-inband" });
            for (const chunk of textChunks) {
              chunks.push({
                type: "text-delta",
                id: "t-inband",
                delta: chunk
              });
            }
          }
          chunks.push({ type: "error", errorText });
          if (afterErrorTextChunks.length > 0) {
            chunks.push({ type: "text-start", id: "t-after-error" });
            for (const chunk of afterErrorTextChunks) {
              chunks.push({
                type: "text-delta",
                id: "t-after-error",
                delta: chunk
              });
            }
          }

          return {
            async next() {
              if (index < chunks.length) {
                return {
                  done: false as const,
                  value: chunks[index++]
                };
              }
              return { done: true as const, value: undefined };
            }
          };
        }
      };
    }
  };
}

function createEmptyStreamResult(): StreamableResult {
  return {
    toUIMessageStream() {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return { done: true as const, value: undefined };
            }
          };
        }
      };
    }
  };
}

/**
 * Mock model that emits multiple text-delta chunks with a configurable
 * delay between each. Lets tests reliably reach the read loop in
 * `_streamResult` and then abort mid-stream without racing the chunk
 * pipeline.
 */
function createDelayedMultiChunkMockModel(
  chunks: string[],
  delayMs: number
): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-delayed-multi-chunk",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream() {
      _mockCallCount++;
      const callId = _mockCallCount;
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: `t-${callId}` });
          for (const chunk of chunks) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            controller.enqueue({
              type: "text-delta",
              id: `t-${callId}`,
              delta: chunk
            });
          }
          controller.enqueue({ type: "text-end", id: `t-${callId}` });
          controller.enqueue({
            type: "finish",
            finishReason: v3FinishReason("stop"),
            usage: v3Usage(10, chunks.length)
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

/** Sentinel error class to distinguish simulated errors in tests */
class SimulatedChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulatedChatError";
  }
}

// ── Collecting callback for tests ────────────────────────────────

class TestCollectingCallback implements StreamCallback {
  events: string[] = [];
  doneCalled = false;
  errorMessage?: string;
  requestId?: string;
  interruptedCalls = 0;

  onStart(event: { requestId: string }): void {
    this.requestId = event.requestId;
  }

  onEvent(json: string): void {
    this.events.push(json);
  }

  onDone(): void {
    this.doneCalled = true;
  }

  onError(error: string): void {
    this.errorMessage = error;
  }

  onInterrupted(): void {
    this.interruptedCalls++;
  }
}

// ── ThinkTestAgent ─────────────────────────────────────────
// Extends Think directly — tests exercise the real production code
// path, not a copy. Overrides: getModel(), onChatError(),
// beforeTurn/onStepFinish/onChunk (instrumentation),
// _transformInferenceResult (error injection).

export class ThinkTestAgent extends Think {
  private _response = "Hello from the assistant!";
  private _chatErrorLog: string[] = [];
  private _errorConfig: {
    afterChunks: number;
    message: string;
  } | null = null;
  private _stripTextResponseForTest = false;
  private _stallAfterChunks: number | null = null;
  // #1626 stall-recovery: when set, only the first N inferences stall (then the
  // continuation streams normally). `null` = every inference stalls (the
  // original terminal-watchdog behavior).
  private _stallAttemptsRemaining: number | null = null;
  private _streamChunkDelayMs: number | null = null;
  private _agentToolOutputForTest = new Map<string, unknown>();
  private _responseLog: ChatResponseResult[] = [];

  override onChatError(error: unknown): unknown {
    const msg = error instanceof Error ? error.message : String(error);
    this._chatErrorLog.push(msg);
    return error;
  }

  private _beforeTurnLog: Array<{
    system: string;
    toolNames: string[];
    continuation: boolean;
    body?: RpcJsonObject;
  }> = [];
  private _beforeTurnMessagesJson: string[] = [];
  private _stepLog: Array<{
    finishReason: string;
    text: string;
    toolCallCount: number;
    toolResultCount: number;
    inputTokens: number;
    outputTokens: number;
  }> = [];
  private _chunkCount = 0;
  private _turnConfigOverride: TurnConfig | null = null;
  private _stepConfigOverride: StepConfig | null = null;
  private _beforeStepAsyncDelayMs = 0;
  private _telemetryEvents: string[] = [];
  private _lastModelCallSettings: CapturedModelCallSettings | null = null;
  private _reasoningResponse: { response: string; reasoning: string } | null =
    null;
  private _inBandErrorResponse: {
    errorText: string;
    textChunks: string[];
  } | null = null;
  private _beforeStepLog: Array<{
    stepNumber: number;
    previousStepCount: number;
    messageCount: number;
    modelId: string;
  }> = [];

  override onChatResponse(result: ChatResponseResult): void {
    this._responseLog.push(result);
  }

  protected override getAgentToolOutput(runId: string): unknown {
    return this._agentToolOutputForTest.get(runId);
  }

  override beforeTurn(ctx: TurnContext): TurnConfig | void {
    this._beforeTurnLog.push({
      system: ctx.system,
      toolNames: Object.keys(ctx.tools),
      continuation: ctx.continuation,
      body: ctx.body as RpcJsonObject | undefined
    });
    this._beforeTurnMessagesJson.push(JSON.stringify(ctx.messages));
    if (this._turnConfigOverride) return this._turnConfigOverride;
  }

  async setTurnConfigOverride(config: TurnConfig | null): Promise<void> {
    this._turnConfigOverride = config;
  }

  async setSendReasoningDefault(sendReasoning: boolean): Promise<void> {
    this.sendReasoning = sendReasoning;
  }

  /**
   * Set a `TurnConfig.output` override using the AI SDK's `Output.text()`
   * helper. The Output spec contains promises and other non-cloneable
   * fields, so it must be constructed inside the DO process — this RPC
   * exists so tests can opt into it without sending the spec across the
   * DO boundary.
   */
  async setTurnConfigOutputText(): Promise<void> {
    this._turnConfigOverride = { output: Output.text(), activeTools: [] };
  }

  async setTurnConfigTelemetry(): Promise<void> {
    this._telemetryEvents = [];
    this._turnConfigOverride = {
      experimental_telemetry: {
        isEnabled: true,
        functionId: "think-test-turn",
        metadata: { source: "think-test" },
        integrations: {
          onStart: (event) => {
            this._telemetryEvents.push(
              `start:${event.functionId}:${event.metadata?.source ?? ""}`
            );
          },
          onFinish: (event) => {
            this._telemetryEvents.push(
              `finish:${event.functionId}:${event.metadata?.source ?? ""}`
            );
          }
        }
      }
    };
  }

  override async beforeStep(
    ctx: PrepareStepContext
  ): Promise<StepConfig | void> {
    this._beforeStepLog.push({
      stepNumber: ctx.stepNumber,
      previousStepCount: ctx.steps.length,
      messageCount: ctx.messages.length,
      modelId:
        ((ctx.model as Record<string, unknown>).modelId as string) ?? "unknown"
    });
    if (this._beforeStepAsyncDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this._beforeStepAsyncDelayMs));
    }
    if (this._stepConfigOverride) return this._stepConfigOverride;
  }

  async setStepConfigOverride(config: StepConfig | null): Promise<void> {
    this._stepConfigOverride = config;
  }

  async setStepModelOverride(response: string): Promise<void> {
    this._stepConfigOverride = { model: createMockModel(response) };
  }

  async setBeforeStepAsyncDelay(ms: number): Promise<void> {
    this._beforeStepAsyncDelayMs = ms;
  }

  async resetTurnStateForTest(): Promise<void> {
    this.resetTurnState();
  }

  override onStepFinish(ctx: StepContext): void {
    // Capture a few fields from the full StepResult to confirm the
    // AI SDK shape is reaching the hook (text, finishReason, real usage,
    // and the typed tool call/result arrays).
    this._stepLog.push({
      finishReason: ctx.finishReason,
      text: ctx.text,
      toolCallCount: ctx.toolCalls.length,
      toolResultCount: ctx.toolResults.length,
      inputTokens: ctx.usage?.inputTokens ?? 0,
      outputTokens: ctx.usage?.outputTokens ?? 0
    });
  }

  override onChunk(_ctx: ChunkContext): void {
    this._chunkCount++;
  }

  async getBeforeTurnLog(): Promise<
    Array<{
      system: string;
      toolNames: string[];
      continuation: boolean;
      body?: RpcJsonObject;
    }>
  > {
    return this._beforeTurnLog;
  }

  async getLastBeforeTurnMessagesJson(): Promise<string | null> {
    const log = this._beforeTurnMessagesJson;
    return log.length > 0 ? log[log.length - 1] : null;
  }

  async getStepLog(): Promise<
    Array<{
      finishReason: string;
      text: string;
      toolCallCount: number;
      toolResultCount: number;
      inputTokens: number;
      outputTokens: number;
    }>
  > {
    return this._stepLog;
  }

  async getTelemetryEvents(): Promise<string[]> {
    return this._telemetryEvents;
  }

  async getLastModelCallSettings(): Promise<CapturedModelCallSettings | null> {
    return this._lastModelCallSettings;
  }

  async getBeforeStepLog(): Promise<
    Array<{
      stepNumber: number;
      previousStepCount: number;
      messageCount: number;
      modelId: string;
    }>
  > {
    return this._beforeStepLog;
  }

  async getChunkCount(): Promise<number> {
    return this._chunkCount;
  }

  protected override _transformInferenceResult(
    result: StreamableResult
  ): StreamableResult {
    if (
      !this._errorConfig &&
      !this._stripTextResponseForTest &&
      this._stallAfterChunks == null &&
      this._streamChunkDelayMs == null
    )
      return result;

    const config = this._errorConfig;
    const stripText = this._stripTextResponseForTest;
    // Per-inference stall gating: if attempt-limited (#1626), only stall while
    // attempts remain (decrement here so the continuation inference streams).
    let willStall = this._stallAfterChunks != null;
    if (willStall && this._stallAttemptsRemaining != null) {
      if (this._stallAttemptsRemaining > 0) {
        this._stallAttemptsRemaining--;
      } else {
        willStall = false;
      }
    }
    const stallAfter = willStall ? this._stallAfterChunks : null;
    const chunkDelayMs = this._streamChunkDelayMs;

    return {
      toUIMessageStream(options?: { sendReasoning?: boolean }) {
        const originalStream = result.toUIMessageStream(options);
        const reader = (
          originalStream as unknown as ReadableStream<unknown>
        ).getReader();
        let chunkCount = 0;
        let shouldThrow = false;

        const wrapped: AsyncIterable<unknown> = {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                // Simulate a parked/hung provider: emit `stallAfter` chunks,
                // then never resolve. The stall watchdog must abort the turn.
                if (stallAfter != null && chunkCount >= stallAfter) {
                  return new Promise<IteratorResult<unknown>>(() => {});
                }
                // Simulate a slow-but-steady stream: each chunk arrives after a
                // delay. With a watchdog timeout larger than the delay, the
                // watchdog must reset on every chunk and never fire.
                if (chunkDelayMs != null) {
                  await new Promise((r) => setTimeout(r, chunkDelayMs));
                }
                while (true) {
                  if (shouldThrow && config) {
                    await reader.cancel();
                    throw new SimulatedChatError(config.message);
                  }
                  const { done, value } = await reader.read();
                  if (done) return { done: true as const, value: undefined };
                  chunkCount++;
                  if (config && chunkCount >= config.afterChunks) {
                    shouldThrow = true;
                  }
                  if (
                    stripText &&
                    value != null &&
                    typeof value === "object" &&
                    "type" in value &&
                    (value.type === "text-start" ||
                      value.type === "text-delta" ||
                      value.type === "text-end")
                  ) {
                    continue;
                  }
                  return { done: false as const, value };
                }
              },
              async return() {
                await reader.cancel();
                return { done: true as const, value: undefined };
              }
            };
          }
        };

        return wrapped;
      }
    };
  }

  // ── Test-specific public methods ───────────────────────────────
  // These are callable via DurableObject RPC stubs (no @callable needed).

  /**
   * Simulate an in-flight resumable stream without actually running a
   * turn. Used by the `onConnect` broadcast regression tests — the
   * suspended state lets a fresh WebSocket observe what the server
   * sends on connect mid-stream.
   */
  async testStartResumableStream(requestId: string): Promise<string> {
    return this._resumableStream.start(requestId);
  }

  async testStoreResumableChunk(streamId: string, body: string): Promise<void> {
    this._resumableStream.storeChunk(streamId, body);
    this._resumableStream.flushBuffer();
  }

  /** Pair with `testStartResumableStream` — clean up the simulated stream. */
  async testCompleteResumableStream(streamId: string): Promise<void> {
    this._resumableStream.complete(streamId);
  }

  async getLatestStreamStatusForTest(): Promise<string | null> {
    const streams = this.sql<{ status: string }>`
      SELECT status
      FROM cf_ai_chat_stream_metadata
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return streams[0]?.status ?? null;
  }

  async testChat(message: string): Promise<TestChatResult> {
    const cb = new TestCollectingCallback();
    await this.chat(message, cb);
    return {
      events: cb.events,
      done: cb.doneCalled,
      error: cb.errorMessage,
      interruptedCalls: cb.interruptedCalls
    };
  }

  private _readChildRunStatusForTest(runId: string): string | null {
    const rows = this.sql<{ status: string }>`
      SELECT status FROM cf_agent_tool_child_runs WHERE run_id = ${runId}
    `;
    return rows[0]?.status ?? null;
  }

  /**
   * P1 (#1630): a child facet that was evicted mid agent-tool run strands its
   * `cf_agent_tool_child_runs` row `running`. Its own durable chat-recovery
   * settles the turn OUTSIDE `startAgentToolRun`'s finalizer, so the `finally`
   * of BOTH recovery entrypoints must reconcile that stranded row — otherwise a
   * re-attached parent waits out a full no-progress window for an already-
   * settled child. This drives each entrypoint into a benign no-op path (no real
   * inference) that still runs its `finally`, and asserts the row finalized:
   * `completed` when a recovered assistant turn exists, else `error`.
   */
  async reconcileStaleChildRunViaRecoveryForTest(
    path: "continue" | "retry",
    withAssistantTurn: boolean
  ): Promise<{ before: string | null; after: string | null }> {
    if (withAssistantTurn) {
      // A completed assistant turn the reconcile recognises as recovered.
      await this.testChat("seed a completed assistant turn");
    }
    const runId = crypto.randomUUID();
    // `inspectAgentToolRun` ensures the child-run table exists; the run does not
    // exist yet, so it returns null.
    await this.inspectAgentToolRun(runId);
    // Strand a `running` row with no live abort controller — exactly the post-
    // eviction shape the reconcile repairs.
    this.sql`
      INSERT INTO cf_agent_tool_child_runs (run_id, status, started_at)
      VALUES (${runId}, 'running', ${Date.now()})
    `;
    const before = this._readChildRunStatusForTest(runId);
    if (path === "continue") {
      // A non-leaf `targetAssistantId` → benign "conversation_changed" skip
      // that still reaches the `finally`.
      await this._chatRecoveryContinue({ targetAssistantId: "no-such-leaf" });
    } else {
      // No `recoveredRequestId` (avoids the pre-`try` early return) + a non-user
      // leaf (or empty transcript) → benign skip that still reaches `finally`.
      await this._chatRecoveryRetry({});
    }
    return { before, after: this._readChildRunStatusForTest(runId) };
  }

  /**
   * P2 (#1630/#1672): `ThinkTestAgent` sets NO re-attach overrides, so its
   * resolved budgets are the SDK defaults. The hard ceiling now defaults to
   * uncapped (`Infinity`) to mirror chat-recovery's `maxRecoveryWork` — a
   * regression that reintroduces a finite default would re-break healthy
   * long-running children, so lock the default here.
   */
  getDefaultReattachBudgetsForTest(): {
    noProgressTimeoutMs: number;
    maxWindowIsFinite: boolean;
  } {
    const resolved = (
      this as unknown as {
        _resolvedOptions: {
          agentToolReattachNoProgressTimeoutMs: number;
          agentToolReattachMaxWindowMs: number;
        };
      }
    )._resolvedOptions;
    return {
      noProgressTimeoutMs: resolved.agentToolReattachNoProgressTimeoutMs,
      maxWindowIsFinite: Number.isFinite(resolved.agentToolReattachMaxWindowMs)
    };
  }

  /**
   * P4 (#1630): `cancelAgentToolRun` must abort not just the original in-isolate
   * run but any in-flight chat-recovery turn driving this child facet (which
   * runs outside `startAgentToolRun` and registers a submission abort
   * controller), so a torn-down child stops grinding instead of finishing an
   * orphaned recovered turn. Registers a controller exactly as the recovery
   * entrypoints do, then asserts cancel sweeps it and seals the row `aborted`.
   */
  async cancelAgentToolRunAbortsRecoveryForTest(): Promise<{
    abortedBefore: boolean;
    abortedAfter: boolean;
    childStatus: string | null;
  }> {
    const runId = crypto.randomUUID();
    await this.inspectAgentToolRun(runId);
    this.sql`
      INSERT INTO cf_agent_tool_child_runs (run_id, status, started_at)
      VALUES (${runId}, 'running', ${Date.now()})
    `;
    const controller = new AbortController();
    (
      this as unknown as {
        _submissionAbortControllers: Map<string, AbortController>;
      }
    )._submissionAbortControllers.set("recovered-submission", controller);
    const abortedBefore = controller.signal.aborted;
    await this.cancelAgentToolRun(runId, "parent gave up re-attaching");
    return {
      abortedBefore,
      abortedAfter: controller.signal.aborted,
      childStatus: this._readChildRunStatusForTest(runId)
    };
  }

  async testChatWithRethrowingErrorCallback(message: string): Promise<string> {
    const cb: StreamCallback = {
      onStart() {},
      onEvent() {},
      onDone() {},
      onError(error: string) {
        throw new Error(error);
      }
    };
    try {
      await this.chat(message, cb);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async testChatWithThrowingErrorCallback(message: string): Promise<string> {
    const cb: StreamCallback = {
      onStart() {},
      onEvent() {},
      onDone() {},
      onError() {
        throw new Error("callback failed");
      }
    };
    try {
      await this.chat(message, cb);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async testChatWithUIMessage(msg: UIMessage): Promise<TestChatResult> {
    const cb = new TestCollectingCallback();
    await this.chat(msg, cb);
    return {
      events: cb.events,
      done: cb.doneCalled,
      error: cb.errorMessage,
      interruptedCalls: cb.interruptedCalls
    };
  }

  async testChatWithIgnoredRuntimeTools(
    message: string
  ): Promise<TestChatResult> {
    const cb = new TestCollectingCallback();
    await this.chat(message, cb, {
      tools: {
        ignoredRuntimeTool: tool({
          description: "Should not be merged into chat() turns.",
          inputSchema: z.object({}),
          execute: () => "ignored"
        })
      }
    } as unknown as ChatOptions);
    return {
      events: cb.events,
      done: cb.doneCalled,
      error: cb.errorMessage,
      interruptedCalls: cb.interruptedCalls
    };
  }

  async persistTestMessage(msg: UIMessage): Promise<void> {
    await this.session.appendMessage(msg);
  }

  async seedWorkspaceBytes(
    path: string,
    bytes: number[],
    mimeType?: string
  ): Promise<void> {
    const parent = path.replace(/\/[^/]+$/, "");
    const workspace = this.workspace;
    const writeFileBytes = Reflect.get(workspace, "writeFileBytes");
    if (typeof writeFileBytes !== "function") {
      throw new Error("Test workspace does not support writeFileBytes");
    }
    if (parent && parent !== "/") {
      await workspace.mkdir(parent, { recursive: true });
    }
    await writeFileBytes.call(workspace, path, new Uint8Array(bytes), mimeType);
  }

  async testChatWithError(errorMessage?: string): Promise<TestChatResult> {
    this._errorConfig = {
      afterChunks: 2,
      message: errorMessage ?? "Mock error"
    };
    try {
      return await this.testChat("trigger error");
    } finally {
      this._errorConfig = null;
    }
  }

  /**
   * Emit `afterChunks` chunks then hang the stream forever. With
   * `chatStreamStallTimeoutMs` set, the inactivity watchdog should abort the
   * turn and surface a terminal stream error instead of parking indefinitely.
   */
  async testChatWithStall(
    afterChunks: number,
    timeoutMs: number
  ): Promise<TestChatResult> {
    this._stallAfterChunks = afterChunks;
    this.chatStreamStallTimeoutMs = timeoutMs;
    // Assert the watchdog → TERMINAL behavior with recovery OFF. (With recovery
    // on — the Think default — a stall now routes into bounded recovery; see
    // `testChatWithStallThenRecover`.)
    const prevRecovery = this.chatRecovery;
    this.chatRecovery = false;
    try {
      return await this.testChat("trigger stall");
    } finally {
      this._stallAfterChunks = null;
      this.chatStreamStallTimeoutMs = 0;
      this.chatRecovery = prevRecovery;
    }
  }

  /**
   * #1626: the FIRST inference hangs after `afterChunks` chunks (watchdog
   * aborts it), which must now route into bounded recovery instead of failing
   * terminally; the scheduled continuation then streams normally to completion.
   * Returns whether the first turn surfaced a terminal error (it must NOT), the
   * scheduled-continue count, and the recovered transcript so a test can assert
   * the turn recovered. chatRecovery stays at its default (`true`).
   */
  async testChatWithStallThenRecover(
    afterChunks: number,
    timeoutMs: number
  ): Promise<{
    firstError: string | undefined;
    firstInterruptedCalls: number;
    scheduledContinues: number;
    assistantMessages: number;
    finalAssistantText: string;
  }> {
    this._stallAfterChunks = afterChunks;
    this._stallAttemptsRemaining = 1;
    this.chatStreamStallTimeoutMs = timeoutMs;
    try {
      const first = await this.testChat("trigger stall then recover");
      const scheduled = this.sql<{ payload: string }>`
        SELECT payload FROM cf_agents_schedules
        WHERE callback = '_chatRecoveryContinue'
        ORDER BY time ASC LIMIT 1
      `;
      const scheduledContinues =
        this.sql<{ count: number }>`
          SELECT COUNT(*) as count FROM cf_agents_schedules
          WHERE callback = '_chatRecoveryContinue'
        `[0]?.count ?? 0;
      // Drive the scheduled continuation — this inference streams normally (the
      // stall budget is exhausted), so the turn completes.
      if (scheduled[0]) {
        await (
          this as unknown as {
            _chatRecoveryContinue(d: unknown): Promise<void>;
          }
        )._chatRecoveryContinue(JSON.parse(scheduled[0].payload));
      }

      const messages = await this.getMessages();
      const assistant = messages.filter((m) => m.role === "assistant");
      const finalAssistant = assistant[assistant.length - 1];
      const finalAssistantText = finalAssistant
        ? finalAssistant.parts
            .filter(
              (p): p is { type: "text"; text: string } => p.type === "text"
            )
            .map((p) => p.text)
            .join("")
        : "";
      return {
        firstError: first.error,
        firstInterruptedCalls: first.interruptedCalls,
        scheduledContinues,
        assistantMessages: assistant.length,
        finalAssistantText
      };
    } finally {
      this._stallAfterChunks = null;
      this._stallAttemptsRemaining = null;
      this.chatStreamStallTimeoutMs = 0;
    }
  }

  /**
   * #1626 review #3: `TurnConfig.chatStreamStallTimeoutMs` (returned from
   * `beforeTurn`) overrides the instance-level timeout for a SINGLE turn. Here
   * the instance watchdog is OFF (`0`) but the per-turn override arms it — so a
   * stall still fires and routes into bounded recovery. (If the override were
   * NOT applied, the instance-off watchdog would never fire and `testChat` would
   * hang; a returning, recovered result proves the override took effect.)
   */
  async testChatWithPerTurnStallOverride(perTurnTimeoutMs: number): Promise<{
    firstError: string | undefined;
    scheduledContinues: number;
    finalAssistantText: string;
  }> {
    this.chatStreamStallTimeoutMs = 0; // instance watchdog OFF
    this._turnConfigOverride = { chatStreamStallTimeoutMs: perTurnTimeoutMs };
    this._stallAfterChunks = 3;
    this._stallAttemptsRemaining = 1;
    try {
      const first = await this.testChat("per-turn stall override");
      const scheduled = this.sql<{ payload: string }>`
        SELECT payload FROM cf_agents_schedules
        WHERE callback = '_chatRecoveryContinue'
        ORDER BY time ASC LIMIT 1
      `;
      const scheduledContinues =
        this.sql<{ count: number }>`
          SELECT COUNT(*) as count FROM cf_agents_schedules
          WHERE callback = '_chatRecoveryContinue'
        `[0]?.count ?? 0;
      if (scheduled[0]) {
        await (
          this as unknown as {
            _chatRecoveryContinue(d: unknown): Promise<void>;
          }
        )._chatRecoveryContinue(JSON.parse(scheduled[0].payload));
      }
      const messages = await this.getMessages();
      const assistant = messages.filter((m) => m.role === "assistant");
      const finalAssistant = assistant[assistant.length - 1];
      const finalAssistantText = finalAssistant
        ? finalAssistant.parts
            .filter(
              (p): p is { type: "text"; text: string } => p.type === "text"
            )
            .map((p) => p.text)
            .join("")
        : "";
      return {
        firstError: first.error,
        scheduledContinues,
        finalAssistantText
      };
    } finally {
      this._stallAfterChunks = null;
      this._stallAttemptsRemaining = null;
      this._turnConfigOverride = null;
      this.chatStreamStallTimeoutMs = 0;
    }
  }

  /**
   * Regression for the RPC stall-recovery re-arm asymmetry: with a pending
   * auto-continuation already armed (as if a prior parallel tool-batch sibling
   * had opted in with `autoContinue: true` but the batch isn't whole yet), a
   * stream stall that routes into bounded recovery must NOT re-arm the 50ms
   * coalesce timer in the RPC `_streamResultToRpcCallback` `finally`. The
   * scheduled recovery continuation re-runs the turn and its own stream finalize
   * re-triggers the held barrier; re-arming here too would fire a SECOND
   * continuation alongside the recovery one (a spurious double model
   * invocation). This mirrors the deliberate plain-clear in the WebSocket
   * `_streamResult` recovery paths.
   *
   * Returns whether the coalesce timer was left armed after the stalled turn
   * resolved (must be `false` with the fix) and whether `_streamingAssistant`
   * was cleared (must be `true`). Read synchronously on resolve — before the
   * (erroneously) armed macrotask timer could fire.
   */
  async testStallRecoveryDoesNotRearmPendingContinuation(
    afterChunks: number,
    timeoutMs: number
  ): Promise<{
    firstError: string | undefined;
    scheduledContinues: number;
    coalesceTimerArmedAfterStall: boolean;
    streamingAssistantCleared: boolean;
  }> {
    const internal = this as unknown as {
      _continuation: {
        pending: Record<string, unknown> | null;
        awaitingConnections: Map<string, unknown>;
      };
      _continuationTimer: ReturnType<typeof setTimeout> | null;
      _streamingAssistant: unknown;
    };
    // Seed a pending auto-continuation with `pastCoalesce: false` so the buggy
    // re-arm path (`_rearmPendingAutoContinuationForBatch`) would reset the
    // coalesce timer in the recovery `finally`.
    internal._continuation.pending = {
      connection: undefined,
      connectionId: "test-conn",
      requestId: crypto.randomUUID(),
      clientTools: undefined,
      body: undefined,
      errorPrefix: "[Think] Auto-continuation failed:",
      prerequisite: null,
      pastCoalesce: false
    };
    this._stallAfterChunks = afterChunks;
    this._stallAttemptsRemaining = 1;
    this.chatStreamStallTimeoutMs = timeoutMs;
    try {
      const first = await this.testChat("seeded pending, then stall");
      // Read synchronously: no `await` has yielded since the recovery `finally`
      // ran, so an erroneously armed 50ms timer cannot have fired yet.
      const coalesceTimerArmedAfterStall = internal._continuationTimer !== null;
      const streamingAssistantCleared = internal._streamingAssistant === null;
      const scheduledContinues =
        this.sql<{ count: number }>`
          SELECT COUNT(*) as count FROM cf_agents_schedules
          WHERE callback = '_chatRecoveryContinue'
        `[0]?.count ?? 0;
      return {
        firstError: first.error,
        scheduledContinues,
        coalesceTimerArmedAfterStall,
        streamingAssistantCleared
      };
    } finally {
      // Tear down the seeded pending + any armed timer so nothing leaks into a
      // later turn (and the seeded undefined connection never gets used).
      if (internal._continuationTimer) {
        clearTimeout(internal._continuationTimer);
        internal._continuationTimer = null;
      }
      internal._continuation.pending = null;
      internal._continuation.awaitingConnections.clear();
      this._stallAfterChunks = null;
      this._stallAttemptsRemaining = null;
      this.chatStreamStallTimeoutMs = 0;
    }
  }

  /**
   * Stream each chunk after `delayMs` with the watchdog armed at `timeoutMs`
   * (> delay). Proves the watchdog resets per chunk and does NOT false-fire on
   * a slow-but-steady stream.
   */
  async testChatWithSlowStream(
    delayMs: number,
    timeoutMs: number
  ): Promise<TestChatResult> {
    this._streamChunkDelayMs = delayMs;
    this.chatStreamStallTimeoutMs = timeoutMs;
    try {
      return await this.testChat("slow but steady");
    } finally {
      this._streamChunkDelayMs = null;
      this.chatStreamStallTimeoutMs = 0;
    }
  }

  /**
   * Throw a stream error after `afterChunks` chunks with the watchdog armed.
   * Guards that an in-band error under the watchdog wrapper terminates cleanly
   * (the wrapper cancels the source on break without an unhandled rejection).
   */
  async testChatWithErrorUnderStallGuard(
    timeoutMs: number,
    errorMessage = "Mock error under guard"
  ): Promise<TestChatResult> {
    this._errorConfig = { afterChunks: 1, message: errorMessage };
    this.chatStreamStallTimeoutMs = timeoutMs;
    try {
      return await this.testChat("error under guard");
    } finally {
      this._errorConfig = null;
      this.chatStreamStallTimeoutMs = 0;
    }
  }

  async setInBandErrorResponse(
    errorText: string,
    textChunks: string[] = []
  ): Promise<void> {
    this._inBandErrorResponse = { errorText, textChunks };
  }

  async clearInBandErrorResponse(): Promise<void> {
    this._inBandErrorResponse = null;
  }

  async runInBandStreamErrorForTest(errorText: string): Promise<void> {
    await (
      this as unknown as {
        _streamResult: (
          requestId: string,
          result: StreamableResult
        ) => Promise<void>;
      }
    )._streamResult(
      crypto.randomUUID(),
      createInBandErrorStreamResult(errorText)
    );
  }

  async runPartialInBandStreamErrorForTest(errorText: string): Promise<void> {
    await (
      this as unknown as {
        _streamResult: (
          requestId: string,
          result: StreamableResult
        ) => Promise<void>;
      }
    )._streamResult(
      crypto.randomUUID(),
      createInBandErrorStreamResult(errorText, ["partial response"])
    );
  }

  async runInBandStreamErrorThenTextForTest(errorText: string): Promise<void> {
    await (
      this as unknown as {
        _streamResult: (
          requestId: string,
          result: StreamableResult
        ) => Promise<void>;
      }
    )._streamResult(
      crypto.randomUUID(),
      createInBandErrorStreamResult(errorText, [], ["ignored response"])
    );
  }

  async runEmptyStreamForTest(): Promise<void> {
    await (
      this as unknown as {
        _streamResult: (
          requestId: string,
          result: StreamableResult
        ) => Promise<void>;
      }
    )._streamResult(crypto.randomUUID(), createEmptyStreamResult());
  }

  async runEmptyRpcStreamForTest(): Promise<{ doneCalled: boolean }> {
    let doneCalled = false;
    await (
      this as unknown as {
        _streamResultToRpcCallback: (
          requestId: string,
          result: StreamableResult,
          callback: StreamCallback
        ) => Promise<void>;
      }
    )._streamResultToRpcCallback(
      crypto.randomUUID(),
      createEmptyStreamResult(),
      {
        onStart() {},
        onEvent() {},
        onDone() {
          doneCalled = true;
        },
        onError(error: string) {
          throw new Error(error);
        }
      }
    );
    return { doneCalled };
  }

  async testChatWithAbort(
    message: string,
    abortAfterEvents: number
  ): Promise<TestChatResult & { doneCalled: boolean }> {
    const events: string[] = [];
    let doneCalled = false;
    const controller = new AbortController();

    const cb: StreamCallback = {
      onStart() {},
      onEvent(json: string) {
        events.push(json);
        if (events.length >= abortAfterEvents) {
          controller.abort();
        }
      },
      onDone() {
        doneCalled = true;
      },
      onError(error: string) {
        events.push(`ERROR:${error}`);
      }
    };

    await this.chat(message, cb, { signal: controller.signal });

    return { events, done: doneCalled, doneCalled, interruptedCalls: 0 };
  }

  async testChatWithCancelChat(
    message: string,
    cancelAfterEvents: number
  ): Promise<TestChatResult & { doneCalled: boolean; requestId?: string }> {
    const events: string[] = [];
    let doneCalled = false;
    let requestId: string | undefined;

    const cb: StreamCallback = {
      onStart(event) {
        requestId = event.requestId;
      },
      onEvent: async (json: string) => {
        events.push(json);
        if (requestId && events.length >= cancelAfterEvents) {
          await this.cancelChat(requestId, "test cancel");
        }
      },
      onDone() {
        doneCalled = true;
      },
      onError(error: string) {
        events.push(`ERROR:${error}`);
      }
    };

    await this.chat(message, cb);

    return {
      events,
      done: doneCalled,
      doneCalled,
      requestId,
      interruptedCalls: 0
    };
  }

  async setResponse(response: string): Promise<void> {
    this._response = response;
  }

  async setStripTextResponseForTest(strip: boolean): Promise<void> {
    this._stripTextResponseForTest = strip;
  }

  async setAgentToolOutputForTest(
    runId: string,
    output: unknown
  ): Promise<void> {
    this._agentToolOutputForTest.set(runId, output);
  }

  async clearAgentToolOutputForTest(runId: string): Promise<void> {
    this._agentToolOutputForTest.delete(runId);
  }

  private _multiChunks: string[] | null = null;

  async setMultiChunkResponse(chunks: string[]): Promise<void> {
    this._multiChunks = chunks;
  }

  async clearMultiChunkResponse(): Promise<void> {
    this._multiChunks = null;
  }

  async setReasoningResponse(
    response: string,
    reasoning: string
  ): Promise<void> {
    this._reasoningResponse = { response, reasoning };
  }

  override getModel(): LanguageModel {
    if (this._inBandErrorResponse) {
      return createInBandErrorMockModel(
        this._inBandErrorResponse.errorText,
        this._inBandErrorResponse.textChunks
      );
    }
    if (this._reasoningResponse) {
      return createReasoningMockModel(
        this._reasoningResponse.response,
        this._reasoningResponse.reasoning
      );
    }
    if (this._multiChunks) {
      return createMultiChunkMockModel(this._multiChunks);
    }
    return createMockModel(this._response, {
      onCall: (settings) => {
        this._lastModelCallSettings = settings;
      }
    });
  }

  async getChatErrorLog(): Promise<string[]> {
    return this._chatErrorLog;
  }

  async getStoredMessages(): Promise<UIMessage[]> {
    return this.getMessages();
  }

  async getCachedMessagesForTest(): Promise<UIMessage[]> {
    return this.messages;
  }

  async getSessionHistoryForTest(): Promise<UIMessage[]> {
    return (await this.session.getHistory()) as UIMessage[];
  }

  async enableCompactionForTest(): Promise<void> {
    this.session
      .onCompaction(async (messages) => {
        if (messages.length < 2) return null;
        return {
          summary: "compacted-summary",
          fromMessageId: messages[0].id,
          toMessageId: messages[messages.length - 1].id
        };
      })
      .compactAfter(1);
  }

  async mutatingGetMessagesResultChangesCacheForTest(): Promise<boolean> {
    const before = (await this.getMessages()).length;
    const messages = await this.getMessages();
    messages.push({
      id: "mutated-outside-cache",
      role: "user",
      parts: [{ type: "text", text: "mutated" }]
    });
    return (await this.getMessages()).length !== before;
  }

  async appendHistoryMessageForTest(msg: UIMessage): Promise<void> {
    await this.appendMessageToHistory(msg);
  }

  async appendSessionMessageForTest(msg: UIMessage): Promise<void> {
    await this.session.appendMessage(msg);
  }

  async updateSessionMessageForTest(msg: UIMessage): Promise<void> {
    await this.session.updateMessage(msg);
  }

  async getResponseLog(): Promise<ChatResponseResult[]> {
    return this._responseLog;
  }

  async seedAgentToolLastErrorForTest(
    runId: string,
    error: string
  ): Promise<void> {
    (
      this as unknown as { _agentToolLastErrors: Map<string, string> }
    )._agentToolLastErrors.set(runId, error);
  }

  async getAgentToolCleanupMapSizesForTest(): Promise<{
    lastErrors: number;
    preTurnAssistantIds: number;
  }> {
    const self = this as unknown as {
      _agentToolLastErrors: Map<string, string>;
      _agentToolPreTurnAssistantIds: Map<string, Set<string>>;
    };
    return {
      lastErrors: self._agentToolLastErrors.size,
      preTurnAssistantIds: self._agentToolPreTurnAssistantIds.size
    };
  }

  // ── Static method proxies for unit testing ─────────────────────

  async sanitizeMessage(msg: UIMessage): Promise<UIMessage> {
    return sanitizeMessage(msg);
  }

  async enforceRowSizeLimit(msg: UIMessage): Promise<UIMessage> {
    return enforceRowSizeLimit(msg);
  }

  async hostWriteFile(path: string, content: string): Promise<void> {
    await this._hostWriteFile(path, content);
  }

  async hostReadFile(path: string): Promise<string | null> {
    return this._hostReadFile(path);
  }

  async hostGetContext(label: string): Promise<string | null> {
    return this._hostGetContext(label);
  }

  async hostGetMessages(
    limit?: number
  ): Promise<Array<{ id: string; role: string; content: string }>> {
    return this._hostGetMessages(limit);
  }

  async hostGetSessionInfo(): Promise<{ messageCount: number }> {
    return this._hostGetSessionInfo();
  }

  async isInsideInferenceLoop(): Promise<boolean> {
    return (this as unknown as { _insideInferenceLoop: boolean })
      ._insideInferenceLoop;
  }

  async hostDeleteFile(path: string): Promise<boolean> {
    return this._hostDeleteFile(path);
  }

  async hostListFiles(
    dir: string
  ): Promise<
    Array<{ name: string; type: string; size: number; path: string }>
  > {
    return this._hostListFiles(dir);
  }

  async hostSendMessage(content: string): Promise<void> {
    return this._hostSendMessage(content);
  }

  async getLastBeforeTurnSystem(): Promise<string | null> {
    const log = this._beforeTurnLog;
    return log.length > 0 ? log[log.length - 1].system : null;
  }
}

type AgentToolFinishForTest = {
  run: AgentToolRunInfo;
  result: AgentToolLifecycleResult;
};

export class StuckThinkAgentToolChild extends Agent {
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
    throw new Error("stuck Think child should never start");
  }

  async cancelAgentToolRun(): Promise<void> {}

  async inspectAgentToolRun(): Promise<AgentToolRunInspection | null> {
    throw new Error("stuck Think child should never be inspected");
  }

  async getAgentToolChunks(): Promise<AgentToolStoredChunk[]> {
    return [];
  }
}

export class ThinkAgentToolParent extends Agent {
  // Distinctive non-default re-attach budgets so a behavioral test can prove
  // the public `AgentStaticOptions` knobs are honored (resolved + used by
  // recovery), not just type-checked. These only affect a re-attach with NO
  // explicit override; every reconcile helper here that needs a fast budget
  // passes one, and the one no-override path (an already-completed child) never
  // consumes the budget.
  static options = {
    agentToolReattachNoProgressTimeoutMs: 4242,
    agentToolReattachMaxWindowMs: 54_321
  };

  private events: AgentToolEventMessage[] = [];
  private finishes: AgentToolFinishForTest[] = [];
  private startupObservedStatuses: string[][] = [];
  private insertRunDuringOnStartId: string | null = null;

  /**
   * Surface the resolved re-attach budgets so a test can assert the static
   * options above flowed through `_resolvedOptions` (#1630 follow-up).
   */
  getResolvedReattachBudgetsForTest(): {
    noProgressTimeoutMs: number;
    maxWindowMs: number;
  } {
    const resolved = (
      this as unknown as {
        _resolvedOptions: {
          agentToolReattachNoProgressTimeoutMs: number;
          agentToolReattachMaxWindowMs: number;
        };
      }
    )._resolvedOptions;
    return {
      noProgressTimeoutMs: resolved.agentToolReattachNoProgressTimeoutMs,
      maxWindowMs: resolved.agentToolReattachMaxWindowMs
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
  }

  override onStart(): void {
    const rows = this.sql<{ status: string }>`
      SELECT status FROM cf_agent_tool_runs ORDER BY started_at ASC
    `;
    this.startupObservedStatuses.push(rows.map((row) => row.status));
    if (this.insertRunDuringOnStartId) {
      this.insertRecoverableParentRunForTest(
        this.insertRunDuringOnStartId,
        "StuckThinkAgentToolChild",
        "created during onStart",
        Date.now()
      );
    }
  }

  async runThinkChild(
    input: string,
    runId = crypto.randomUUID()
  ): Promise<RunAgentToolResult> {
    this.events = [];
    this.finishes = [];
    return this.runAgentTool(ThinkTestAgent, {
      runId,
      parentToolCallId: "think-tool-call",
      input,
      inputPreview: input
    });
  }

  /**
   * A run that was previously sealed `interrupted` (recovery gave up) but whose
   * child has since reached terminal. Re-issuing with the same runId must
   * RE-ATTACH and repair the parent row to the child's real result, not return
   * the stale `interrupted` (#1630 — `interrupted` is a soft, repairable
   * terminal). Without the fix, the model would see a retryable failure and
   * re-run the child's already-completed work.
   */
  async reissueInterruptedThinkChildForTest(
    input: string,
    runId = crypto.randomUUID()
  ): Promise<{ status: string | null; reissueStatus: string }> {
    const child = await this.subAgent(ThinkTestAgent, runId);
    const started = await child.startAgentToolRun(input, { runId });
    await this.waitForTerminalInspectionForTest(child, runId);

    // Seal the parent row `interrupted`, as a prior recovery that exhausted its
    // re-attach budget would have.
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, input_preview,
        input_redacted, status, display_metadata, display_order,
        started_at, completed_at
      ) VALUES (
        ${runId}, 'think-tool-call', 'ThinkTestAgent',
        ${JSON.stringify(input)}, 1, 'interrupted',
        ${JSON.stringify({ name: "think child" })}, 0,
        ${started.startedAt}, ${Date.now()}
      )
    `;

    this.events = [];
    this.finishes = [];
    const result = await this.runAgentTool(ThinkTestAgent, {
      runId,
      parentToolCallId: "think-tool-call",
      input,
      inputPreview: input
    });
    return {
      status: this.getParentAgentToolStatusForTest(runId),
      reissueStatus: result.status
    };
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
        ${runId}, 'think-tool-call', ${agentType},
        ${JSON.stringify(inputPreview)}, 1, ${status},
        ${JSON.stringify({ name: "think child" })}, 0, ${startedAt}
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
    throw new Error("Timed out waiting for Think child completion");
  }

  private async reconcileAgentToolRunsForTest(options?: {
    deferFinishHooks?: boolean;
    childInspectionTimeoutMs?: number;
    reattachTimeoutMs?: number;
    reattachMaxWindowMs?: number;
    totalRecoveryTimeoutMs?: number;
  }): Promise<Array<() => Promise<void>>> {
    return (
      this as unknown as {
        _reconcileAgentToolRuns(options?: {
          deferFinishHooks?: boolean;
          childInspectionTimeoutMs?: number;
          reattachTimeoutMs?: number;
          reattachMaxWindowMs?: number;
          totalRecoveryTimeoutMs?: number;
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

  async reconcileCompletedThinkChildForTest(
    input: string,
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    inspection: AgentToolRunInspection;
    status: string | null;
  }> {
    const child = await this.subAgent(ThinkTestAgent, runId);
    const started = await child.startAgentToolRun(input, { runId });
    this.insertRecoverableParentRunForTest(
      runId,
      "ThinkTestAgent",
      input,
      started.startedAt
    );
    const inspection = await this.waitForTerminalInspectionForTest(
      child,
      runId
    );

    this.events = [];
    this.finishes = [];
    await this.reconcileAgentToolRunsForTest();
    return {
      events: this.events,
      finishes: this.finishes,
      inspection,
      status: this.getParentAgentToolStatusForTest(runId)
    };
  }

  /**
   * A still-running child that reaches terminal *during* the parent's bounded
   * re-attach window: reconciliation should tail it to terminal and finalize
   * the parent row `completed` instead of abandoning it `interrupted` (#1630).
   * The child completes shortly after start (small before-step delay) and the
   * re-attach budget is generous, so the parent collects the real result.
   */
  async reconcileRunningThinkChildForTest(
    input: string,
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    status: string | null;
  }> {
    const child = await this.subAgent(ThinkTestAgent, runId);
    // Short delay: the child is genuinely still running when reconciliation
    // starts, then reaches terminal a moment later — within the re-attach
    // budget — so the parent tails it to `completed`.
    await child.setBeforeStepAsyncDelay(200);
    const started = await child.startAgentToolRun(input, { runId });
    this.insertRecoverableParentRunForTest(
      runId,
      "ThinkTestAgent",
      input,
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
   * forever (#1630). A small budget threaded through the test seam keeps it
   * fast.
   */
  async reattachStuckTailableThinkChildForTest(
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    elapsedMs: number;
    status: string | null;
  }> {
    const child = await this.subAgent(ThinkTestAgent, runId);
    // Long delay → the child stays `running` for the whole (small) re-attach
    // budget, so the parent times out and interrupts.
    await child.setBeforeStepAsyncDelay(60_000);
    const started = await child.startAgentToolRun("stuck tailable child", {
      runId
    });
    this.insertRecoverableParentRunForTest(
      runId,
      "ThinkTestAgent",
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

  /**
   * A tail-able child that never reaches terminal, reconciled with a
   * no-progress budget LARGER than the hard ceiling so the ceiling wins the
   * race (#1630 follow-up). `window-exceeded` is the one give-up reason
   * that TEARS THE CHILD DOWN — the child has had its full window and is truly
   * exhausted — so this also asserts the child run row ends up `aborted`
   * (`childStillRunning: false`), unlike the soft `no-progress` seal.
   */
  async reattachMaxWindowExhaustedThinkChildForTest(
    runId = crypto.randomUUID()
  ): Promise<{
    finishes: AgentToolFinishForTest[];
    elapsedMs: number;
    status: string | null;
    childStatus: string | null;
  }> {
    const child = await this.subAgent(ThinkTestAgent, runId);
    // Long delay → the child stays `running` (no chunks, never terminal) for the
    // whole window, so only the ceiling can end the wait.
    await child.setBeforeStepAsyncDelay(60_000);
    const started = await child.startAgentToolRun("max-window child", {
      runId
    });
    this.insertRecoverableParentRunForTest(
      runId,
      "ThinkTestAgent",
      "max-window child",
      started.startedAt
    );

    this.events = [];
    this.finishes = [];
    const startedAt = Date.now();
    // No-progress (5s) >> ceiling (200ms): the ceiling fires first while the
    // child is still non-terminal ⇒ `reason: "max-window"` ⇒ teardown.
    await this.reconcileAgentToolRunsForTest({
      reattachTimeoutMs: 5_000,
      reattachMaxWindowMs: 200
    });
    // The parent's give-up teardown should have cancelled the child run.
    const childInspection = await child.inspectAgentToolRun(runId);
    return {
      finishes: this.finishes,
      elapsedMs: Date.now() - startedAt,
      status: this.getParentAgentToolStatusForTest(runId),
      childStatus: childInspection?.status ?? null
    };
  }

  /**
   * Two still-running children where the FIRST (by `started_at`) is hung and
   * the second completes quickly. Re-attaches must run in parallel, each with
   * its own budget, so the slow child can't starve the fast one against the
   * shared inspect deadline (#1630). With the buggy serial design the slow
   * child's re-attach burns the total-recovery deadline and the fast child is
   * abandoned `interrupted` before it's ever re-attached.
   */
  async reconcileParallelThinkChildrenForTest(): Promise<{
    stuckStatus: string | null;
    fastStatus: string | null;
  }> {
    const stuckRunId = crypto.randomUUID();
    const fastRunId = crypto.randomUUID();

    const stuckChild = await this.subAgent(ThinkTestAgent, stuckRunId);
    await stuckChild.setBeforeStepAsyncDelay(60_000);
    const stuckStart = await stuckChild.startAgentToolRun("stuck child", {
      runId: stuckRunId
    });
    // Ensure the stuck child sorts FIRST by started_at (it would be re-attached
    // first and, serially, would consume the whole budget before the fast one).
    this.insertRecoverableParentRunForTest(
      stuckRunId,
      "ThinkTestAgent",
      "stuck child",
      stuckStart.startedAt
    );

    const fastChild = await this.subAgent(ThinkTestAgent, fastRunId);
    await fastChild.setBeforeStepAsyncDelay(200);
    const fastStart = await fastChild.startAgentToolRun("fast child", {
      runId: fastRunId
    });
    this.insertRecoverableParentRunForTest(
      fastRunId,
      "ThinkTestAgent",
      "fast child",
      Math.max(fastStart.startedAt, stuckStart.startedAt + 1)
    );

    this.events = [];
    this.finishes = [];
    try {
      // Tiny inspect deadline + a re-attach budget larger than it: the serial
      // design would let the stuck child's re-attach blow the deadline and
      // starve the fast child; the parallel design collects the fast child.
      await this.reconcileAgentToolRunsForTest({
        totalRecoveryTimeoutMs: 300,
        reattachTimeoutMs: 1500
      });
    } finally {
      await stuckChild.cancelAgentToolRun(stuckRunId, "test cleanup");
    }
    return {
      stuckStatus: this.getParentAgentToolStatusForTest(stuckRunId),
      fastStatus: this.getParentAgentToolStatusForTest(fastRunId)
    };
  }

  async reconcileStuckThinkChildWithTimeoutForTest(
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    elapsedMs: number;
    status: string | null;
  }> {
    this.insertRecoverableParentRunForTest(
      runId,
      "StuckThinkAgentToolChild",
      "stuck Think child",
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

  /**
   * Drive `_reattachAgentToolRunToTerminal` directly with an in-process adapter
   * that does NOT implement `tailAgentToolRun`, to cover the `not-tailable`
   * early return (#1630). This branch is unreachable through a real (RPC) child
   * — a Durable Object stub reports every method as a `function`, so the
   * `typeof` guard always passes and a genuinely non-tailable child instead
   * surfaces as a tail-call failure — so we exercise it via a plain adapter,
   * which is exactly the shape the guard defends against.
   */
  async reattachNotTailableAdapterForTest(): Promise<{
    reason?: string;
    result: boolean;
  }> {
    const adapter = {
      startAgentToolRun: async (): Promise<AgentToolRunInspection> => {
        throw new Error("not-tailable adapter should never start");
      },
      cancelAgentToolRun: async (): Promise<void> => {},
      inspectAgentToolRun:
        async (): Promise<AgentToolRunInspection | null> => ({
          runId: "not-tailable",
          status: "running",
          startedAt: Date.now()
        }),
      getAgentToolChunks: async (): Promise<AgentToolStoredChunk[]> => []
      // Intentionally NO `tailAgentToolRun`.
    };
    const reattach = await (
      this as unknown as {
        _reattachAgentToolRunToTerminal(
          adapter: unknown,
          row: {
            run_id: string;
            agent_type: string;
            parent_tool_call_id: string | null;
          },
          sequence: number
        ): Promise<{ reason?: string; result?: unknown }>;
      }
    )._reattachAgentToolRunToTerminal(
      adapter,
      {
        run_id: crypto.randomUUID(),
        agent_type: "NotTailableAdapter",
        parent_tool_call_id: null
      },
      1
    );
    return { reason: reattach.reason, result: reattach.result !== undefined };
  }

  /**
   * Drive `_reattachAgentToolRunToTerminal` with a fully-scripted in-process
   * adapter to pin the re-arm decision matrix at unit speed (#1630). A real
   * re-eviction (stream closes mid-flight while the child keeps advancing) is
   * only otherwise exercised by the slow e2e, so this isolates the two paths
   * the re-arm logic turns on:
   *
   *  - `"rearm-then-complete"`: attempt 1 streams chunks then closes cleanly
   *    (`done` + progress) while the child is still `running` ⇒ the loop
   *    RE-ARMS; attempt 2 closes and the child now inspects `completed` ⇒ the
   *    parent collects the real terminal result instead of sealing interrupted.
   *  - `"idle-after-progress"`: attempt 1 streams chunks then goes silent for a
   *    full no-progress window (stream never closes) ⇒ the loop must NOT re-arm
   *    despite the earlier progress (it seals `no-progress` after a single tail,
   *    proving both the honest-stall semantics and that no fresh reader is
   *    abandoned per cycle).
   *  - `"infinite-no-progress-ceiling"`: an `Infinity` no-progress budget on a
   *    totally silent, never-closing stream ⇒ the idle timer is disabled, so
   *    silence alone NEVER seals `no-progress`; only the finite hard ceiling
   *    ends the wait (`window-exceeded`). Pre-fix, `Infinity` short-circuited to
   *    an immediate `no-progress` seal with zero tail attempts.
   */
  async reattachScriptedAdapterForTest(
    scenario:
      | "rearm-then-complete"
      | "idle-after-progress"
      | "infinite-no-progress-ceiling"
  ): Promise<{ status?: string; reason?: string; tailAttempts: number }> {
    let tailAttempts = 0;
    let inspectCalls = 0;

    const makeStream = (bodies: string[], close: boolean) =>
      new ReadableStream<AgentToolStoredChunk>({
        start(controller) {
          let seq = 1;
          for (const body of bodies) {
            controller.enqueue({
              runId: "scripted",
              sequence: seq++,
              body
            } as AgentToolStoredChunk);
          }
          // When `close` is false the stream stays open with no further data, so
          // the forward loop waits and the no-progress (idle) budget fires.
          if (close) controller.close();
        }
      });

    const adapter = {
      startAgentToolRun: async (): Promise<AgentToolRunInspection> => {
        throw new Error("scripted adapter should never start");
      },
      cancelAgentToolRun: async (): Promise<void> => {},
      getAgentToolChunks: async (): Promise<AgentToolStoredChunk[]> => [],
      inspectAgentToolRun: async (): Promise<AgentToolRunInspection | null> => {
        inspectCalls++;
        // rearm-then-complete: `running` after the first tail (so the loop
        // re-arms), then `completed` so the second collect returns terminal.
        if (scenario === "rearm-then-complete" && inspectCalls >= 2) {
          return {
            runId: "scripted",
            status: "completed",
            startedAt: 0,
            completedAt: Date.now(),
            output: "ok",
            summary: "scripted completion"
          };
        }
        return { runId: "scripted", status: "running", startedAt: 0 };
      },
      tailAgentToolRun: async (): Promise<
        ReadableStream<AgentToolStoredChunk>
      > => {
        tailAttempts++;
        if (scenario === "rearm-then-complete") {
          return tailAttempts === 1
            ? makeStream(["a", "b"], true)
            : makeStream([], true);
        }
        // `infinite-no-progress-ceiling`: a totally silent, never-closing
        // stream. With an `Infinity` no-progress budget the idle timer is
        // disabled, so the ONLY thing that can end the wait is the finite hard
        // ceiling — proving silence alone no longer seals `no-progress`.
        if (scenario === "infinite-no-progress-ceiling") {
          return makeStream([], false);
        }
        return makeStream(["a", "b"], false);
      }
    };

    const reattach = await (
      this as unknown as {
        _reattachAgentToolRunToTerminal(
          adapter: unknown,
          row: {
            run_id: string;
            agent_type: string;
            parent_tool_call_id: string | null;
          },
          sequence: number,
          noProgressTimeoutMs?: number,
          maxWindowMs?: number
        ): Promise<{ result?: { status?: string }; reason?: string }>;
      }
    )._reattachAgentToolRunToTerminal(
      adapter,
      {
        run_id: crypto.randomUUID(),
        agent_type: "ScriptedAdapter",
        parent_tool_call_id: null
      },
      1,
      // no-progress budget: tight for the stall scenario, Infinity for the
      // "never seal on silence" scenario, generous otherwise.
      scenario === "idle-after-progress"
        ? 50
        : scenario === "infinite-no-progress-ceiling"
          ? Number.POSITIVE_INFINITY
          : 5_000,
      // hard ceiling: a short finite cap for the infinite-budget scenario so the
      // otherwise-unbounded silent wait still terminates the test.
      scenario === "infinite-no-progress-ceiling" ? 150 : 10_000
    );

    return {
      status: reattach.result?.status,
      reason: reattach.reason,
      tailAttempts
    };
  }

  async scheduleStuckThinkChildRecoveryForTest(
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    status: string | null;
  }> {
    this.insertRecoverableParentRunForTest(
      runId,
      "StuckThinkAgentToolChild",
      "scheduled stuck Think child",
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

  async scheduleStuckThinkChildRecoveryTwiceForTest(
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    status: string | null;
  }> {
    this.insertRecoverableParentRunForTest(
      runId,
      "StuckThinkAgentToolChild",
      "single flight stuck Think child",
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

  async startupDefersStaleThinkRecoveryForTest(
    runId = crypto.randomUUID()
  ): Promise<{
    statusesDuringStartup: string[];
    statusAfterStartup: string | null;
    finalStatus: string | null;
    startupElapsedMs: number;
    finishes: AgentToolFinishForTest[];
    events: AgentToolEventMessage[];
  }> {
    this.insertRecoverableParentRunForTest(
      runId,
      "StuckThinkAgentToolChild",
      "startup stuck Think child",
      Date.now()
    );

    this.events = [];
    this.finishes = [];
    this.startupObservedStatuses = [];
    const startedAt = Date.now();
    await this.onStart();
    const startupElapsedMs = Date.now() - startedAt;
    const statusAfterStartup = this.getParentAgentToolStatusForTest(runId);

    for (let attempt = 0; attempt < 40; attempt++) {
      if (this.getParentAgentToolStatusForTest(runId) === "interrupted") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return {
      statusesDuringStartup: this.startupObservedStatuses[0] ?? [],
      statusAfterStartup,
      finalStatus: this.getParentAgentToolStatusForTest(runId),
      startupElapsedMs,
      finishes: this.finishes,
      events: this.events
    };
  }

  async startupRecoveryIgnoresRunsCreatedDuringOnStartForTest(): Promise<{
    staleStatus: string | null;
    onStartRunStatus: string | null;
    finishes: AgentToolFinishForTest[];
    events: AgentToolEventMessage[];
  }> {
    const staleRunId = crypto.randomUUID();
    const onStartRunId = crypto.randomUUID();
    this.insertRecoverableParentRunForTest(
      staleRunId,
      "StuckThinkAgentToolChild",
      "startup snapshot stale child",
      Date.now()
    );

    this.events = [];
    this.finishes = [];
    this.startupObservedStatuses = [];
    this.insertRunDuringOnStartId = onStartRunId;
    try {
      await this.onStart();
    } finally {
      this.insertRunDuringOnStartId = null;
    }

    for (let attempt = 0; attempt < 40; attempt++) {
      if (this.getParentAgentToolStatusForTest(staleRunId) === "interrupted") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return {
      staleStatus: this.getParentAgentToolStatusForTest(staleRunId),
      onStartRunStatus: this.getParentAgentToolStatusForTest(onStartRunId),
      finishes: this.finishes,
      events: this.events
    };
  }

  getParentAgentToolStatusForTest(runId: string): string | null {
    const rows = this.sql<{ status: string }>`
      SELECT status FROM cf_agent_tool_runs WHERE run_id = ${runId} LIMIT 1
    `;
    return rows[0]?.status ?? null;
  }
}

// ── ThinkSessionTestAgent ───────────────────────────────────
// Extends Think with Session configuration for context block testing.

export class ThinkSessionTestAgent extends Think {
  private _response = "Hello from session agent!";

  override configureSession(session: Session) {
    return session
      .withContext("memory", {
        description: "Important facts learned during conversation.",
        maxTokens: 2000
      })
      .withCachedPrompt();
  }

  override getModel(): LanguageModel {
    return createMockModel(this._response);
  }

  async setResponse(response: string): Promise<void> {
    this._response = response;
  }

  async testChat(message: string): Promise<TestChatResult> {
    const cb = new TestCollectingCallback();
    await this.chat(message, cb);
    return {
      events: cb.events,
      done: cb.doneCalled,
      error: cb.errorMessage,
      interruptedCalls: cb.interruptedCalls
    };
  }

  async getStoredMessages(): Promise<UIMessage[]> {
    return this.getMessages();
  }

  async getContextBlockContent(label: string): Promise<string | null> {
    const block = this.session.getContextBlock(label);
    return block?.content ?? null;
  }

  async getSystemPromptSnapshot(): Promise<string> {
    return this.session.freezeSystemPrompt();
  }

  async setContextBlock(label: string, content: string): Promise<void> {
    await this.session.replaceContextBlock(label, content);
  }

  async getAssembledSystemPrompt(): Promise<string> {
    const frozenPrompt = await this.session.freezeSystemPrompt();
    return frozenPrompt || this.getSystemPrompt();
  }

  async addDynamicContext(label: string, description?: string): Promise<void> {
    await this.session.addContext(label, { description });
  }

  async removeDynamicContext(label: string): Promise<boolean> {
    return this.session.removeContext(label);
  }

  async refreshPrompt(): Promise<string> {
    return this.session.refreshSystemPrompt();
  }

  async getContextLabels(): Promise<string[]> {
    return this.session.getContextBlocks().map((b) => b.label);
  }

  async getSessionToolNames(): Promise<string[]> {
    const tools = await this.session.tools();
    return Object.keys(tools);
  }

  async getContextBlockDetails(
    label: string
  ): Promise<{ writable: boolean; isSkill: boolean } | null> {
    const block = this.session.getContextBlock(label);
    if (!block) return null;
    return { writable: block.writable, isSkill: block.isSkill };
  }

  async hostSetContext(label: string, content: string): Promise<void> {
    await this._hostSetContext(label, content);
  }

  async hostGetContext(label: string): Promise<string | null> {
    return this._hostGetContext(label);
  }
}

// ── ThinkAsyncConfigSessionAgent ─────────────────────────────
// Tests async configureSession — simulates reading config before setup.

export class ThinkAsyncConfigSessionAgent extends Think {
  override async configureSession(session: Session): Promise<Session> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return session
      .withContext("memory", {
        description: "Async-configured memory block.",
        maxTokens: 1000
      })
      .withCachedPrompt();
  }

  override getModel(): LanguageModel {
    return createMockModel("Async session agent response");
  }

  async testChat(message: string): Promise<TestChatResult> {
    const cb = new TestCollectingCallback();
    await this.chat(message, cb);
    return {
      events: cb.events,
      done: cb.doneCalled,
      error: cb.errorMessage,
      interruptedCalls: cb.interruptedCalls
    };
  }

  async getStoredMessages(): Promise<UIMessage[]> {
    return this.getMessages();
  }

  async getContextBlockContent(label: string): Promise<string | null> {
    const block = this.session.getContextBlock(label);
    return block?.content ?? null;
  }

  async setContextBlock(label: string, content: string): Promise<void> {
    await this.session.replaceContextBlock(label, content);
  }

  async getAssembledSystemPrompt(): Promise<string> {
    const frozenPrompt = await this.session.freezeSystemPrompt();
    return frozenPrompt || this.getSystemPrompt();
  }
}

// ── ThinkConfigTestAgent ────────────────────────────────────
// Tests dynamic configuration persistence.

type TestConfig = {
  theme: string;
  maxTokens: number;
};

export class ThinkConfigTestAgent extends Think<Cloudflare.Env> {
  override getModel(): LanguageModel {
    return createMockModel("Config agent response");
  }

  async setTestConfig(config: TestConfig): Promise<void> {
    this.configure<TestConfig>(config);
  }

  async getTestConfig(): Promise<TestConfig | null> {
    return this.getConfig<TestConfig>();
  }
}

export class ThinkLegacyConfigMigrationAgent extends Think<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS assistant_config (
        session_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (session_id, key)
      )
    `);
    ctx.storage.sql.exec(`
      INSERT OR REPLACE INTO assistant_config (session_id, key, value)
      VALUES ('', '_think_config', '{"theme":"dark","maxTokens":4000}')
    `);
  }

  override getModel(): LanguageModel {
    return createMockModel("Legacy config migration response");
  }

  async setTestConfig(config: TestConfig): Promise<void> {
    this.configure<TestConfig>(config);
  }

  rerunLegacyMigrationForTest(): void {
    this._migrateLegacyConfigToThinkTable();
  }

  async getRawThinkConfigForTest(): Promise<TestConfig | null> {
    const rows = this.sql<{ value: string }>`
      SELECT value FROM think_config
      WHERE key = ${"_think_config"}
    `;
    const raw = rows[0]?.value;
    return raw ? (JSON.parse(raw) as TestConfig) : null;
  }

  async getTestConfig(): Promise<TestConfig | null> {
    return this.getConfig<TestConfig>();
  }
}

// ── ThinkConfigInSessionAgent ────────────────────────────────
// Reproduces GH-1309: getConfig() inside configureSession() should
// not throw when Think's private config table has not been initialized yet.

type ConfigInSessionConfig = {
  persona: string;
};

export class ThinkConfigInSessionAgent extends Think<Cloudflare.Env> {
  override configureSession(session: Session) {
    const persona =
      this.getConfig<ConfigInSessionConfig>()?.persona || "default persona";
    return session
      .withContext("memory", {
        description: `Agent persona: ${persona}`
      })
      .withCachedPrompt();
  }

  override getModel(): LanguageModel {
    return createMockModel("Config-in-session response");
  }

  async setTestConfig(config: ConfigInSessionConfig): Promise<void> {
    this.configure<ConfigInSessionConfig>(config);
  }

  async getTestConfig(): Promise<ConfigInSessionConfig | null> {
    return this.getConfig<ConfigInSessionConfig>();
  }

  async testChat(message: string): Promise<TestChatResult> {
    const cb = new TestCollectingCallback();
    await this.chat(message, cb);
    return {
      events: cb.events,
      done: cb.doneCalled,
      error: cb.errorMessage,
      interruptedCalls: cb.interruptedCalls
    };
  }

  async getStoredMessages(): Promise<UIMessage[]> {
    return this.getMessages();
  }
}

// ── ThinkToolsTestAgent ───────────────────────────────────
// Extends Think with tools configured for tool integration testing.
// Uses a mock model that calls the "echo" tool on first invocation.

function createToolCallingMockModel(): LanguageModel {
  let callCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-tool-calling",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented");
    },
    doStream(options: Record<string, unknown>) {
      callCount++;
      const messages = (options as { prompt?: unknown[] }).prompt ?? [];
      const hasToolResult = messages.some(
        (m: unknown) =>
          typeof m === "object" &&
          m !== null &&
          (m as Record<string, unknown>).role === "tool"
      );
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (!hasToolResult && callCount === 1) {
            controller.enqueue({
              type: "tool-input-start",
              id: "tc1",
              toolName: "echo"
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: "tc1",
              delta: JSON.stringify({ message: "hello" })
            });
            controller.enqueue({ type: "tool-input-end", id: "tc1" });
            // v3 spec also requires an explicit `tool-call` chunk so the
            // streamText pipeline records a TypedToolCall on the StepResult.
            controller.enqueue({
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "echo",
              input: JSON.stringify({ message: "hello" })
            });
            controller.enqueue({
              type: "finish",
              finishReason: v3FinishReason("tool-calls"),
              usage: v3Usage(10, 5)
            });
          } else {
            controller.enqueue({ type: "text-start", id: "t-final" });
            controller.enqueue({
              type: "text-delta",
              id: "t-final",
              delta: "Done with tools"
            });
            controller.enqueue({ type: "text-end", id: "t-final" });
            controller.enqueue({
              type: "finish",
              finishReason: v3FinishReason("stop"),
              usage: v3Usage(20, 10)
            });
          }
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

export class ThinkToolsTestAgent extends Think {
  override maxSteps = 3;

  // Stored as JSON strings so the log can flow back over the DO RPC
  // boundary without tripping the type system on `unknown` payloads.
  private _beforeToolCallLog: Array<{
    toolName: string;
    inputJson: string;
  }> = [];
  private _afterToolCallLog: Array<{
    toolName: string;
    inputJson: string;
    outputJson: string;
  }> = [];
  private _toolCallDecision: ToolCallDecision | null = null;
  private _beforeStepLog: Array<{
    stepNumber: number;
    previousStepCount: number;
    previousToolResultCount: number;
  }> = [];

  override beforeStep(ctx: PrepareStepContext): StepConfig | void {
    this._beforeStepLog.push({
      stepNumber: ctx.stepNumber,
      previousStepCount: ctx.steps.length,
      previousToolResultCount: ctx.steps.reduce(
        (n, s) => n + s.toolResults.length,
        0
      )
    });
  }

  async getBeforeStepLog(): Promise<
    Array<{
      stepNumber: number;
      previousStepCount: number;
      previousToolResultCount: number;
    }>
  > {
    return this._beforeStepLog;
  }

  override getModel(): LanguageModel {
    return createToolCallingMockModel();
  }

  override getTools() {
    const mode = this._echoExecuteMode;
    if (mode === "async-iterable") {
      // Regression for the wrapper bug where the original `execute`
      // returned `Promise<AsyncIterable>` (the iterable was constructed
      // inside an async function). The wrapper must `await` the call
      // before checking `Symbol.asyncIterator`, otherwise the AI SDK
      // sees the iterator instance as the final output value.
      return {
        echo: tool({
          description: "Echo a message back (streaming)",
          inputSchema: z.object({ message: z.string() }),
          execute: async ({ message }: { message: string }) => {
            async function* gen() {
              yield `echo-prelim-1: ${message}`;
              yield `echo-prelim-2: ${message}`;
              yield `echo: ${message}`;
            }
            return gen();
          }
        })
      };
    }
    if (mode === "sync-iterable") {
      return {
        echo: tool({
          description: "Echo a message back (sync streaming)",
          inputSchema: z.object({ message: z.string() }),
          execute: ({ message }: { message: string }) => {
            async function* gen() {
              yield `echo-prelim: ${message}`;
              yield `echo: ${message}`;
            }
            return gen();
          }
        })
      };
    }
    return {
      echo: tool({
        description: "Echo a message back",
        inputSchema: z.object({ message: z.string() }),
        execute: async ({ message }: { message: string }) => `echo: ${message}`
      })
    };
  }

  private _echoExecuteMode: "default" | "async-iterable" | "sync-iterable" =
    "default";

  async setEchoExecuteMode(
    mode: "default" | "async-iterable" | "sync-iterable"
  ): Promise<void> {
    this._echoExecuteMode = mode;
  }

  async stopAfterEchoToolCall(): Promise<void> {
    this._turnStopCondition = hasToolCall("echo");
  }

  private _turnStopCondition: TurnConfig["stopWhen"];

  override beforeTurn(): TurnConfig | void {
    if (this._turnStopCondition) {
      return { stopWhen: this._turnStopCondition };
    }
  }

  private _beforeToolCallThrowMessage: string | null = null;
  private _beforeToolCallAsync = false;

  override async beforeToolCall(
    ctx: ToolCallContext
  ): Promise<ToolCallDecision | void> {
    this._beforeToolCallLog.push({
      toolName: ctx.toolName,
      inputJson: JSON.stringify(ctx.input)
    });
    if (this._beforeToolCallThrowMessage !== null) {
      throw new Error(this._beforeToolCallThrowMessage);
    }
    if (this._beforeToolCallAsync) {
      // Force the decision to resolve via a microtask hop so the wrapper
      // exercises its `await this.beforeToolCall(ctx)` path with a real
      // pending promise.
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
    if (this._toolCallDecision) return this._toolCallDecision;
  }

  override afterToolCall(ctx: ToolCallResultContext): void {
    this._afterToolCallLog.push({
      toolName: ctx.toolName,
      inputJson: JSON.stringify(ctx.input),
      outputJson: ctx.success
        ? JSON.stringify(ctx.output)
        : JSON.stringify({ error: String(ctx.error) })
    });
  }

  async testChat(message: string): Promise<TestChatResult> {
    const cb = new TestCollectingCallback();
    await this.chat(message, cb);
    return {
      events: cb.events,
      done: cb.doneCalled,
      error: cb.errorMessage,
      interruptedCalls: cb.interruptedCalls
    };
  }

  async getBeforeToolCallLog(): Promise<
    Array<{ toolName: string; inputJson: string }>
  > {
    return this._beforeToolCallLog;
  }

  async getAfterToolCallLog(): Promise<
    Array<{
      toolName: string;
      inputJson: string;
      outputJson: string;
    }>
  > {
    return this._afterToolCallLog;
  }

  async setToolCallDecision(decision: ToolCallDecision | null): Promise<void> {
    this._toolCallDecision = decision;
  }

  async setBeforeToolCallThrows(message: string | null): Promise<void> {
    this._beforeToolCallThrowMessage = message;
  }

  async setBeforeToolCallAsync(async: boolean): Promise<void> {
    this._beforeToolCallAsync = async;
  }

  async getStoredMessages(): Promise<UIMessage[]> {
    return this.getMessages();
  }
}

// ── ThinkProgrammaticTestAgent ──────────────────────────────
// Tests saveMessages, continueLastTurn, and body persistence.

export class ThinkProgrammaticTestAgent extends Think {
  protected static override submissionRecoveryStaleMs = 15 * 60 * 1000;

  private _responseLog: ChatResponseResult[] = [];
  private _submissionLog: ThinkSubmissionInspection[] = [];
  private _workflowEventLog: Array<{
    workflowName: string;
    workflowId: string;
    event: { type: string; payload?: unknown };
  }> = [];
  private _workflowEventFailuresRemaining = 0;
  private _capturedTurnContexts: Array<{
    continuation?: boolean;
    body?: RpcJsonObject;
  }> = [];
  private _delayedChunks: { chunks: string[]; delayMs: number } | null = null;
  private _throwBeforeTurnError: string | null = null;
  private _submissionStatusDelayMs = 0;
  private _programmaticResponse = "Programmatic response";
  private _inBandErrorResponse: {
    errorText: string;
    textChunks: string[];
  } | null = null;

  override getModel(): LanguageModel {
    if (this._inBandErrorResponse) {
      return createInBandErrorMockModel(
        this._inBandErrorResponse.errorText,
        this._inBandErrorResponse.textChunks
      );
    }
    if (this._delayedChunks) {
      return createDelayedMultiChunkMockModel(
        this._delayedChunks.chunks,
        this._delayedChunks.delayMs
      );
    }
    return createMockModel(this._programmaticResponse);
  }

  override onChatResponse(result: ChatResponseResult): void {
    this._responseLog.push(result);
  }

  override async sendWorkflowEvent(
    workflowName: string & {},
    workflowId: string,
    event: { type: string; payload?: unknown }
  ): Promise<void> {
    if (this._workflowEventFailuresRemaining > 0) {
      this._workflowEventFailuresRemaining--;
      throw new Error("simulated workflow event failure");
    }
    this._workflowEventLog.push({ workflowName, workflowId, event });
  }

  override async onSubmissionStatus(
    result: ThinkSubmissionInspection
  ): Promise<void> {
    if (this._submissionStatusDelayMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, this._submissionStatusDelayMs)
      );
    }
    this._submissionLog.push(result);
  }

  override beforeTurn(ctx: TurnContext): void {
    if (this._throwBeforeTurnError) {
      throw new Error(this._throwBeforeTurnError);
    }
    this._capturedTurnContexts.push({
      continuation: ctx.continuation,
      body: ctx.body as RpcJsonObject | undefined
    });
  }

  async setDelayedChunkResponse(
    chunks: string[],
    delayMs: number
  ): Promise<void> {
    this._delayedChunks = { chunks, delayMs };
  }

  async clearDelayedChunkResponse(): Promise<void> {
    this._delayedChunks = null;
  }

  async setInBandStreamErrorResponse(
    errorText: string,
    textChunks: string[] = []
  ): Promise<void> {
    this._inBandErrorResponse = { errorText, textChunks };
  }

  async clearInBandStreamErrorResponse(): Promise<void> {
    this._inBandErrorResponse = null;
  }

  async setThrowingStreamError(message: string | null): Promise<void> {
    this._throwBeforeTurnError = message;
  }

  async getProgrammaticStreamErrorCountForTest(): Promise<number> {
    return (
      this as unknown as { _programmaticStreamErrors: Map<string, string> }
    )._programmaticStreamErrors.size;
  }

  async getSubmissionFinalStatusForTest(
    resultStatus: SaveMessagesResult["status"],
    streamError?: string
  ): Promise<ThinkSubmissionStatus> {
    return (
      this as unknown as {
        _getSubmissionFinalStatus: (
          resultStatus: SaveMessagesResult["status"],
          streamError: string | undefined
        ) => ThinkSubmissionStatus;
      }
    )._getSubmissionFinalStatus(resultStatus, streamError);
  }

  async runNonSubmissionStreamFailureForTest(requestId: string): Promise<void> {
    const result: StreamableResult = {
      toUIMessageStream() {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                throw new SimulatedChatError("non-submission stream failed");
              }
            };
          }
        };
      }
    };
    await (
      this as unknown as {
        _streamResult: (
          requestId: string,
          result: StreamableResult
        ) => Promise<void>;
      }
    )._streamResult(requestId, result);
  }

  async setSubmissionStatusDelayForTest(delayMs: number): Promise<void> {
    this._submissionStatusDelayMs = delayMs;
  }

  async setProgrammaticResponseForTest(response: string): Promise<void> {
    this._programmaticResponse = response;
  }

  async setLastBodyForTest(body: Record<string, unknown>): Promise<void> {
    (
      this as unknown as { _lastBody: Record<string, unknown> | undefined }
    )._lastBody = body;
  }

  async setWorkflowEventFailuresForTest(count: number): Promise<void> {
    this._workflowEventFailuresRemaining = count;
  }

  async getWorkflowEventsForTest(): Promise<
    Array<{
      workflowName: string;
      workflowId: string;
      event: { type: string; payload?: unknown };
    }>
  > {
    return this._workflowEventLog;
  }

  async setSubmissionRecoveryStaleMsForTest(ms: number): Promise<void> {
    (
      this.constructor as typeof ThinkProgrammaticTestAgent
    ).submissionRecoveryStaleMs = ms;
  }

  async testSaveMessages(msgs: UIMessage[]): Promise<SaveMessagesResult> {
    return this.saveMessages(msgs);
  }

  async testSubmitMessages(
    text: string,
    options?: {
      submissionId?: string;
      idempotencyKey?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<SubmitMessagesResult> {
    return this.submitMessages(
      [
        {
          id: crypto.randomUUID(),
          role: "user" as const,
          parts: [{ type: "text" as const, text }]
        }
      ],
      options
    );
  }

  async testSubmitMessagesError(
    text: string,
    options?: {
      submissionId?: string;
      idempotencyKey?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<string> {
    try {
      await this.submitMessages(
        [
          {
            id: crypto.randomUUID(),
            role: "user" as const,
            parts: [{ type: "text" as const, text }]
          }
        ],
        options
      );
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async testSubmitMessagesEmptyError(): Promise<string> {
    try {
      await this.submitMessages([]);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async inspectSubmissionForTest(
    submissionId: string
  ): Promise<ThinkSubmissionInspection | null> {
    return this.inspectSubmission(submissionId);
  }

  async listSubmissionsForTest(options?: {
    status?: ThinkSubmissionStatus | ThinkSubmissionStatus[];
    limit?: number;
  }): Promise<ThinkSubmissionInspection[]> {
    return this.listSubmissions(options);
  }

  async cancelSubmissionForTest(
    submissionId: string,
    reason?: string
  ): Promise<void> {
    await this.cancelSubmission(submissionId, reason);
  }

  async deleteSubmissionForTest(submissionId: string): Promise<boolean> {
    return this.deleteSubmission(submissionId);
  }

  async deleteSubmissionsForTest(options?: {
    status?: ThinkSubmissionStatus | ThinkSubmissionStatus[];
    completedBefore?: Date;
    limit?: number;
  }): Promise<number> {
    return this.deleteSubmissions(options);
  }

  async drainSubmissionsForTest(): Promise<void> {
    await this._drainThinkSubmissions();
  }

  async recoverSubmissionsForTest(): Promise<void> {
    await (
      this as unknown as { _recoverSubmissionsOnStart: () => Promise<void> }
    )._recoverSubmissionsOnStart();
  }

  async resetTurnStateForTest(): Promise<void> {
    this.resetTurnState();
  }

  async recoverChatFiberForTest(requestId: string): Promise<void> {
    await this._handleInternalFiberRecovery({
      id: `fiber-${requestId}`,
      name: `${(this.constructor as typeof Think).CHAT_FIBER_NAME}:${requestId}`,
      snapshot: null,
      createdAt: Date.now(),
      recoveryReason: "interrupted"
    });
  }

  async continueRecoveredChatForTest(requestId: string): Promise<void> {
    await this._chatRecoveryContinue({ recoveredRequestId: requestId });
  }

  async cancelDuringRecoveredContinuationForTest(
    requestId: string,
    delayMs: number
  ): Promise<void> {
    const continuation = this._chatRecoveryContinue({
      recoveredRequestId: requestId
    });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await this.cancelSubmission(requestId, "stop during recovery");
    await continuation.catch(() => {});
  }

  async scheduleRecoveredContinuationForTest(requestId: string): Promise<void> {
    await this.schedule(
      60,
      "_chatRecoveryContinue",
      { recoveredRequestId: requestId },
      { idempotent: true }
    );
  }

  async insertSubmissionForTest(options: {
    submissionId: string;
    status?: ThinkSubmissionStatus;
    requestId?: string;
    metadata?: Record<string, unknown>;
    errorMessage?: string | null;
    messagesAppliedAt?: number | null;
    completedAt?: number | null;
    createdAt?: number;
    messageIds?: string[];
  }): Promise<void> {
    (
      this as unknown as { _ensureSubmissionTable: () => void }
    )._ensureSubmissionTable();
    const now = options.createdAt ?? Date.now();
    const requestId = options.requestId ?? options.submissionId;
    const status = options.status ?? "pending";
    const messagesAppliedAt =
      options.messagesAppliedAt === undefined
        ? null
        : options.messagesAppliedAt;
    const startedAt = status === "running" ? now : null;
    const completedAt =
      options.completedAt === undefined ? null : options.completedAt;
    const metadataJson =
      options.metadata === undefined ? null : JSON.stringify(options.metadata);
    const errorMessage =
      options.errorMessage === undefined ? null : options.errorMessage;
    const messageIds = options.messageIds ?? [crypto.randomUUID()];
    const messagesJson = JSON.stringify(
      messageIds.map((id) => ({
        id,
        role: "user",
        parts: [{ type: "text", text: `Inserted ${options.submissionId}` }]
      }))
    );
    this.sql`
      INSERT INTO cf_think_submissions (
        submission_id, idempotency_key, request_id, stream_id, status,
        messages_json, metadata_json, error_message, created_at,
        messages_applied_at, started_at, completed_at
      )
      VALUES (
        ${options.submissionId}, NULL, ${requestId}, NULL, ${status},
        ${messagesJson}, ${metadataJson}, ${errorMessage}, ${now}, ${messagesAppliedAt},
        ${startedAt}, ${completedAt}
      )
    `;
  }

  async recoverWorkflowNotificationsForTest(): Promise<void> {
    (
      this as unknown as { _recoverWorkflowNotifications: () => void }
    )._recoverWorkflowNotifications();
  }

  async drainWorkflowNotificationsForTest(): Promise<void> {
    await (
      this as unknown as { _drainWorkflowNotifications: () => Promise<void> }
    )._drainWorkflowNotifications();
  }

  async insertWorkflowNotificationForTest(options: {
    notificationId: string;
    submissionId: string;
    workflowName?: string;
    workflowId?: string;
    eventType?: string;
    payload?: unknown;
  }): Promise<void> {
    (
      this as unknown as { _ensureWorkflowNotificationTable: () => void }
    )._ensureWorkflowNotificationTable();
    const now = Date.now();
    this.sql`
      INSERT INTO cf_think_workflow_notifications (
        notification_id, submission_id, workflow_name, workflow_id, event_type,
        payload_json, attempts, last_error, created_at, updated_at, delivered_at
      )
      VALUES (
        ${options.notificationId},
        ${options.submissionId},
        ${options.workflowName ?? "TEST_WORKFLOW"},
        ${options.workflowId ?? "workflow-1"},
        ${options.eventType ?? "think-prompt-test"},
        ${JSON.stringify(options.payload ?? { submissionId: options.submissionId, status: "error" })},
        0,
        NULL,
        ${now},
        ${now},
        NULL
      )
    `;
  }

  async listWorkflowNotificationsForTest(): Promise<
    Array<{
      notificationId: string;
      submissionId: string;
      workflowName: string;
      workflowId: string;
      eventType: string;
      payloadJson: string;
      attempts: number;
      lastError: string | null;
      deliveredAt: number | null;
    }>
  > {
    (
      this as unknown as { _ensureWorkflowNotificationTable: () => void }
    )._ensureWorkflowNotificationTable();
    return this.sql<{
      notification_id: string;
      submission_id: string;
      workflow_name: string;
      workflow_id: string;
      event_type: string;
      payload_json: string;
      attempts: number;
      last_error: string | null;
      delivered_at: number | null;
    }>`
      SELECT notification_id, submission_id, workflow_name, workflow_id,
             event_type, payload_json, attempts, last_error, delivered_at
      FROM cf_think_workflow_notifications
      ORDER BY created_at ASC, notification_id ASC
    `.map((row) => ({
      notificationId: row.notification_id,
      submissionId: row.submission_id,
      workflowName: row.workflow_name,
      workflowId: row.workflow_id,
      eventType: row.event_type,
      payloadJson: row.payload_json,
      attempts: row.attempts,
      lastError: row.last_error,
      deliveredAt: row.delivered_at
    }));
  }

  async insertMalformedSubmissionForTest(options: {
    submissionId: string;
    requestId?: string;
  }): Promise<void> {
    (
      this as unknown as { _ensureSubmissionTable: () => void }
    )._ensureSubmissionTable();
    const now = Date.now();
    const requestId = options.requestId ?? options.submissionId;
    this.sql`
      INSERT INTO cf_think_submissions (
        submission_id, idempotency_key, request_id, stream_id, status,
        messages_json, metadata_json, error_message, created_at,
        messages_applied_at, started_at, completed_at
      )
      VALUES (
        ${options.submissionId}, NULL, ${requestId}, NULL, 'running',
        '{', NULL, NULL, ${now}, NULL, ${now}, NULL
      )
    `;
  }

  async insertRecoverableFiberForTest(
    requestId: string,
    createdAt: number
  ): Promise<void> {
    this.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (
        ${`fiber-${requestId}`},
        ${(this.constructor as typeof Think).CHAT_FIBER_NAME + ":" + requestId},
        NULL,
        ${createdAt}
      )
    `;
  }

  async testSaveMessagesWithFn(text: string): Promise<SaveMessagesResult> {
    return this.saveMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user" as const,
        parts: [{ type: "text" as const, text }]
      }
    ]);
  }

  async testContinueLastTurn(): Promise<SaveMessagesResult> {
    return this.continueLastTurn();
  }

  async testContinueLastTurnWithBody(
    body: Record<string, unknown>
  ): Promise<SaveMessagesResult> {
    return this.continueLastTurn(body);
  }

  // ── External-signal abort seams ─────────────────────────────────
  //
  // The AbortSignal itself can't cross the DurableObject RPC boundary
  // (workerd's RPC serializer rejects it), so each test scenario lives
  // inside the DO process and just exposes the resulting
  // `SaveMessagesResult` to the test runner.

  /** Drive a saveMessages turn with an externally-aborted signal. */
  async testSaveMessagesWithSignal(
    text: string,
    options: {
      /** Abort the controller before the call. */
      preAbort?: boolean;
      /** Abort the controller after this many ms. 0 = synchronous. */
      abortAfterMs?: number;
      /** If true, abort AFTER saveMessages resolves (verify no leak). */
      abortAfterCompletion?: boolean;
    }
  ): Promise<SaveMessagesResult> {
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
        {
          id: crypto.randomUUID(),
          role: "user" as const,
          parts: [{ type: "text" as const, text }]
        }
      ],
      { signal: controller.signal }
    );

    if (options.abortAfterCompletion) {
      // Aborting AFTER the call resolves must NOT throw, must NOT
      // affect the registry (which by now is empty for this id), and
      // must NOT trip any leaked listener — covered by the listener
      // cleanup contract on `linkExternal`.
      controller.abort(new Error("post-completion abort"));
    }

    return result;
  }

  /**
   * Drive saveMessages and abort partway through the stream. Returns
   * the result + a snapshot of the assistant message that was
   * persisted (if any) so tests can verify partial-persist semantics.
   */
  async testSaveMessagesAbortMidStream(
    text: string,
    abortAfterMs: number
  ): Promise<{
    result: SaveMessagesResult;
    persistedMessageCount: number;
    lastResponseStatus: ChatResponseResult["status"] | null;
  }> {
    const result = await this.testSaveMessagesWithSignal(text, {
      abortAfterMs
    });
    const lastResponse =
      this._responseLog.length > 0
        ? this._responseLog[this._responseLog.length - 1]
        : null;
    return {
      result,
      persistedMessageCount: (await this.getMessages()).length,
      lastResponseStatus: lastResponse?.status ?? null
    };
  }

  /**
   * Programmatically cancel a saveMessages turn via the public
   * `abortAllRequests` surface. Verifies the public abort method
   * behaves the same as MSG_CHAT_CANCEL for programmatic turns.
   */
  async testSaveMessagesCancelledByAbortAllRequests(
    text: string,
    cancelAfterMs: number
  ): Promise<SaveMessagesResult> {
    setTimeout(() => this.abortAllRequests(), cancelAfterMs);
    return this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text }]
      }
    ]);
  }

  /** Drive continueLastTurn with an external signal. */
  async testContinueLastTurnWithSignal(options: {
    preAbort?: boolean;
    abortAfterMs?: number;
  }): Promise<SaveMessagesResult> {
    const controller = new AbortController();
    if (options.preAbort) {
      controller.abort(new Error("pre-aborted"));
    } else if (typeof options.abortAfterMs === "number") {
      const ms = options.abortAfterMs;
      setTimeout(() => controller.abort(new Error("mid-stream abort")), ms);
    }
    return this.continueLastTurn(undefined, { signal: controller.signal });
  }

  /**
   * Returns the number of active controllers in the abort registry —
   * non-zero between tests means a controller leaked.
   */
  async getAbortControllerCount(): Promise<number> {
    return (this as unknown as { _aborts: { size: number } })._aborts.size;
  }

  async getStoredMessages(): Promise<UIMessage[]> {
    return this.getMessages();
  }

  async getResponseLog(): Promise<ChatResponseResult[]> {
    return this._responseLog;
  }

  async getSubmissionLog(): Promise<ThinkSubmissionInspection[]> {
    return this._submissionLog;
  }

  async clearResponseLog(): Promise<void> {
    this._responseLog.length = 0;
  }

  async getCapturedOptions(): Promise<
    Array<{ continuation?: boolean; body?: RpcJsonObject }>
  > {
    return this._capturedTurnContexts;
  }

  async testChat(message: string): Promise<TestChatResult> {
    const cb = new TestCollectingCallback();
    await this.chat(message, cb);
    return {
      events: cb.events,
      done: cb.doneCalled,
      error: cb.errorMessage,
      interruptedCalls: cb.interruptedCalls
    };
  }
}

type ScheduledTaskConfigForTest = {
  schedule: string;
  timezone?: string;
  prompt?: string;
  handler?: "record" | "throw" | "throw-once";
  retry?: ThinkScheduledTask["retry"];
  metadata?: Record<string, unknown>;
};

type DeclaredScheduledTaskRowForTest = {
  owner_key: string;
  task_id: string;
  schedule_hash: string;
  task_hash: string;
  schedule_id: string | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
};

type DeclaredScheduledTaskPayloadForTest = {
  taskId: string;
  scheduleHash: string;
  scheduledFor: number;
};

type ScheduledTaskHandlerEventForTest = {
  taskId: string;
  scheduledFor: number;
  scheduledForIso: string;
  occurrenceKey: string;
  idempotencyKey: string;
  schedule: string;
  scheduleKind: string;
  timezone: string | null;
  metadataJson: string | null;
};

export class ThinkScheduledTasksTestAgent extends ThinkProgrammaticTestAgent {
  override async getDefaultTimezone(): Promise<string | undefined> {
    return this.ctx.storage.get<string>("scheduledTasksDefaultTimezone");
  }

  override async getScheduledTasks(): Promise<ThinkScheduledTasks> {
    const config =
      (await this.ctx.storage.get<Record<string, ScheduledTaskConfigForTest>>(
        "scheduledTasksConfig"
      )) ?? {};
    const tasks: ThinkScheduledTasks = {};
    for (const [taskId, task] of Object.entries(config)) {
      const base = {
        schedule: task.schedule as ThinkScheduledTask["schedule"],
        ...(task.timezone !== undefined && { timezone: task.timezone }),
        ...(task.retry !== undefined && { retry: task.retry }),
        ...(task.metadata !== undefined && { metadata: task.metadata })
      };
      if (task.handler) {
        tasks[taskId] = {
          ...base,
          handler: async (ctx: ThinkScheduledTaskContext) => {
            const events =
              (await this.ctx.storage.get<ScheduledTaskHandlerEventForTest[]>(
                "scheduledTaskHandlerEvents"
              )) ?? [];
            events.push({
              taskId: ctx.taskId,
              scheduledFor: ctx.scheduledFor,
              scheduledForIso: ctx.scheduledForDate.toISOString(),
              occurrenceKey: ctx.occurrenceKey,
              idempotencyKey: ctx.idempotencyKey,
              schedule: ctx.schedule,
              scheduleKind: ctx.scheduleKind,
              timezone: ctx.timezone ?? null,
              metadataJson:
                ctx.metadata === undefined ? null : JSON.stringify(ctx.metadata)
            });
            await this.ctx.storage.put("scheduledTaskHandlerEvents", events);
            if (
              task.handler === "throw" ||
              (task.handler === "throw-once" &&
                events.filter((event) => event.taskId === ctx.taskId).length ===
                  1)
            ) {
              throw new Error("scheduled handler failed");
            }
          }
        } as ThinkScheduledTask;
        continue;
      }
      const prompt: ThinkScheduledTask["prompt"] =
        task.prompt === "__throw__"
          ? () => {
              throw new Error("scheduled prompt failed");
            }
          : (task.prompt ?? "");
      tasks[taskId] = {
        ...base,
        prompt
      } as ThinkScheduledTask;
    }
    return defineScheduledTasks(tasks);
  }

  async setScheduledTasksForTest(
    config: Record<string, ScheduledTaskConfigForTest>
  ): Promise<void> {
    await this.ctx.storage.put("scheduledTasksConfig", config);
  }

  async setDefaultTimezoneForTest(timezone?: string): Promise<void> {
    if (timezone === undefined) {
      await this.ctx.storage.delete("scheduledTasksDefaultTimezone");
      return;
    }
    await this.ctx.storage.put("scheduledTasksDefaultTimezone", timezone);
  }

  async reconcileScheduledTasksForTest(): Promise<void> {
    await this.internal_reconcileScheduledTasks();
  }

  async reconcileScheduledTasksErrorForTest(): Promise<string> {
    try {
      await this.reconcileScheduledTasksForTest();
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async validateScheduleForTest(
    schedule: string,
    options: { timezone?: string; defaultTimezone?: string } = {}
  ): Promise<string | null> {
    return (
      this as unknown as {
        _declaredScheduleValidationError: (
          schedule: string,
          timezone?: string,
          defaultTimezone?: string
        ) => string | null;
      }
    )._declaredScheduleValidationError(
      schedule,
      options.timezone,
      options.defaultTimezone
    );
  }

  async nextScheduleTimeForTest(
    schedule: string,
    nowIso: string,
    options: {
      timezone?: string;
      defaultTimezone?: string;
      previousScheduledFor?: number;
    } = {}
  ): Promise<number> {
    return (
      this as unknown as {
        _nextDeclaredScheduleTimeForConfig: (
          schedule: string,
          now: Date,
          options?: {
            taskTimezone?: string;
            defaultTimezone?: string;
            previousScheduledFor?: number;
          }
        ) => Date;
      }
    )
      ._nextDeclaredScheduleTimeForConfig(schedule, new Date(nowIso), {
        taskTimezone: options.timezone,
        defaultTimezone: options.defaultTimezone,
        previousScheduledFor: options.previousScheduledFor
      })
      .getTime();
  }

  async listDeclaredScheduledTaskRowsForTest(): Promise<
    DeclaredScheduledTaskRowForTest[]
  > {
    const ownerKey = (
      this as unknown as { _declaredScheduleOwnerKey(): string }
    )._declaredScheduleOwnerKey();
    return this.sql<DeclaredScheduledTaskRowForTest>`
      SELECT owner_key, task_id, schedule_hash, task_hash, schedule_id,
             next_run_at, created_at, updated_at
      FROM cf_think_scheduled_tasks
      WHERE owner_key = ${ownerKey}
      ORDER BY task_id ASC
    `;
  }

  async listSchedulesForTest(): Promise<Schedule<unknown>[]> {
    return this.listSchedules();
  }

  async listScheduledTaskHandlerEventsForTest(): Promise<
    ScheduledTaskHandlerEventForTest[]
  > {
    return (
      (await this.ctx.storage.get<ScheduledTaskHandlerEventForTest[]>(
        "scheduledTaskHandlerEvents"
      )) ?? []
    );
  }

  async clearDeclaredScheduleIdForTest(taskId: string): Promise<void> {
    const row = (
      this as unknown as {
        _readDeclaredScheduledTaskRow(
          taskId: string
        ): DeclaredScheduledTaskRowForTest | null;
      }
    )._readDeclaredScheduledTaskRow(taskId);
    if (!row) throw new Error("No declared schedule row");
    if (row.schedule_id) await this.cancelSchedule(row.schedule_id);
    this.sql`
      UPDATE cf_think_scheduled_tasks
      SET schedule_id = NULL
      WHERE owner_key = ${row.owner_key}
        AND task_id = ${taskId}
    `;
  }

  async createUnrelatedScheduleForTest(): Promise<string> {
    const schedule = await this.schedule(
      new Date(Date.now() + 60 * 60_000),
      "noopScheduledTaskForTest",
      { source: "unrelated" },
      { idempotent: true }
    );
    return schedule.id;
  }

  async noopScheduledTaskForTest(): Promise<void> {}

  async getFirstDeclaredPayloadForTest(): Promise<DeclaredScheduledTaskPayloadForTest> {
    const [row] = await this.listDeclaredScheduledTaskRowsForTest();
    if (!row?.schedule_id) throw new Error("No declared schedule row");
    const schedule = await this.getScheduleById(row.schedule_id);
    if (!schedule) throw new Error("Declared schedule row has no schedule");
    return schedule.payload as DeclaredScheduledTaskPayloadForTest;
  }

  async runDeclaredPayloadForTest(
    payload: DeclaredScheduledTaskPayloadForTest
  ): Promise<void> {
    await this._runDeclaredScheduledTask(payload);
  }

  async runDeclaredPayloadErrorForTest(
    payload: DeclaredScheduledTaskPayloadForTest
  ): Promise<string> {
    try {
      await this.runDeclaredPayloadForTest(payload);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async setChildScheduledTasksForTest(
    name: string,
    config: Record<string, ScheduledTaskConfigForTest>
  ): Promise<void> {
    const child = await this.subAgent(ThinkScheduledTasksTestAgent, name);
    await child.setScheduledTasksForTest(config);
  }

  async setChildDefaultTimezoneForTest(
    name: string,
    timezone?: string
  ): Promise<void> {
    const child = await this.subAgent(ThinkScheduledTasksTestAgent, name);
    await child.setDefaultTimezoneForTest(timezone);
  }

  async reconcileChildScheduledTasksForTest(name: string): Promise<void> {
    const child = await this.subAgent(ThinkScheduledTasksTestAgent, name);
    await child.reconcileScheduledTasksForTest();
  }

  async listChildDeclaredScheduledTaskRowsForTest(
    name: string
  ): Promise<DeclaredScheduledTaskRowForTest[]> {
    const child = await this.subAgent(ThinkScheduledTasksTestAgent, name);
    return child.listDeclaredScheduledTaskRowsForTest();
  }

  async listChildSchedulesForTest(name: string): Promise<Schedule<unknown>[]> {
    const child = await this.subAgent(ThinkScheduledTasksTestAgent, name);
    return child.listSchedulesForTest();
  }
}

// ── ThinkAsyncHookTestAgent ──────────────────────────────────
// Tests that async onChatResponse doesn't drop results during rapid turns.

export class ThinkAsyncHookTestAgent extends Think {
  private _responseLog: ChatResponseResult[] = [];
  private _hookDelayMs = 50;

  override getModel(): LanguageModel {
    return createMockModel("Async hook response");
  }

  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this._hookDelayMs));
    this._responseLog.push(result);
  }

  async testChat(message: string): Promise<TestChatResult> {
    const cb = new TestCollectingCallback();
    await this.chat(message, cb);
    return {
      events: cb.events,
      done: cb.doneCalled,
      error: cb.errorMessage,
      interruptedCalls: cb.interruptedCalls
    };
  }

  async getResponseLog(): Promise<ChatResponseResult[]> {
    return this._responseLog;
  }

  async getStoredMessages(): Promise<UIMessage[]> {
    return this.getMessages();
  }

  async setHookDelay(ms: number): Promise<void> {
    this._hookDelayMs = ms;
  }
}

// ── ThinkRecoveryTestAgent ──────────────────────────────────
// Tests chatRecovery, fiber wrapping, onChatRecovery hook.

export class ThinkRecoveryTestAgent extends Think {
  override chatRecovery: ChatRecoveryConfig = true;

  private _recoveryContexts: Array<{
    incidentId: string;
    recoveryRootRequestId: string;
    attempt: number;
    maxAttempts: number;
    recoveryKind: "retry" | "continue";
    recoveryData: unknown;
    partialText: string;
    streamId: string;
    createdAt: number;
    lastBody?: Record<string, unknown>;
    lastClientTools?: ClientToolSchema[];
  }> = [];
  private _recoveryOverride: ChatRecoveryOptions = {};
  private _recoveryShouldThrow = false;
  private _exhaustedContexts: ChatRecoveryExhaustedContext[] = [];
  private _onExhaustedCalls = 0;
  private _turnCallCount = 0;
  private _turnBodies: Array<Record<string, unknown> | undefined> = [];
  private _turnClientToolNames: Array<string[]> = [];
  private _stashData: unknown = null;
  private _stashResult: { success: boolean; error?: string } | null = null;
  private _rejectPrefill = false;
  private _lastPromptRole: string | undefined;
  private _throwBeforeTurnMessage: string | null = null;

  override getModel(): LanguageModel {
    if (this._rejectPrefill) {
      return createPrefillRejectingModel("Continued response.", {
        onCall: (role) => {
          this._lastPromptRole = role;
        }
      });
    }
    return createMockModel("Continued response.");
  }

  override beforeTurn(ctx: TurnContext): void {
    // Simulate a pre-stream failure (e.g. message reconciliation) that throws
    // before any stream is produced, so it surfaces in `_handleChatRequest`'s
    // outer catch rather than the stream-level `_fireResponseHook` path.
    if (this._throwBeforeTurnMessage) {
      throw new Error(this._throwBeforeTurnMessage);
    }
    this._turnCallCount++;
    this._turnBodies.push(ctx.body);
    this._turnClientToolNames.push(Object.keys(ctx.tools));

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
  }

  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    this._recoveryContexts.push({
      incidentId: ctx.incidentId,
      recoveryRootRequestId: ctx.recoveryRootRequestId,
      attempt: ctx.attempt,
      maxAttempts: ctx.maxAttempts,
      recoveryKind: ctx.recoveryKind,
      recoveryData: ctx.recoveryData,
      partialText: ctx.partialText,
      streamId: ctx.streamId,
      createdAt: ctx.createdAt,
      lastBody: ctx.lastBody,
      lastClientTools: ctx.lastClientTools
    });
    if (this._recoveryShouldThrow) {
      throw new Error("onChatRecovery boom");
    }
    return this._recoveryOverride;
  }

  async testChat(message: string): Promise<TestChatResult> {
    const cb = new TestCollectingCallback();
    await this.chat(message, cb);
    return {
      events: cb.events,
      done: cb.doneCalled,
      error: cb.errorMessage,
      interruptedCalls: cb.interruptedCalls
    };
  }

  async getStoredMessages(): Promise<UIMessage[]> {
    return this.getMessages();
  }

  async getActiveFibers(): Promise<Array<{ id: string; name: string }>> {
    return this.sql<{ id: string; name: string }>`
      SELECT id, name FROM cf_agents_runs
    `;
  }

  async getTurnCallCount(): Promise<number> {
    return this._turnCallCount;
  }

  async getRecoveryContexts(): Promise<
    Array<{
      incidentId: string;
      recoveryRootRequestId: string;
      attempt: number;
      maxAttempts: number;
      recoveryKind: "retry" | "continue";
      recoveryData: unknown;
      partialText: string;
      streamId: string;
      createdAt: number;
      lastBody?: Record<string, unknown>;
      lastClientTools?: ClientToolSchema[];
    }>
  > {
    return this._recoveryContexts;
  }

  /** Capture the `onExhausted` context for assertions (instead of throwing). */
  async enableExhaustedCaptureForTest(
    maxAttempts: number,
    terminalMessage?: string
  ): Promise<void> {
    this._exhaustedContexts = [];
    this.chatRecovery = {
      maxAttempts,
      ...(terminalMessage ? { terminalMessage } : {}),
      onExhausted: (exhaustedCtx) => {
        this._exhaustedContexts.push(exhaustedCtx);
      }
    };
  }

  // Explicit serializable return shape (rather than `ChatRecoveryExhaustedContext[]`):
  // the context's `partialParts: MessagePart[]` is a deeply-generic AI SDK union
  // that the RPC stub-type machinery cannot instantiate (TS2589), which also
  // poisons sibling stub methods. `unknown[]` keeps the RPC type shallow; the
  // test only reads the scalar fields below.
  async getExhaustedContextsForTest(): Promise<
    Array<{
      incidentId: string;
      requestId: string;
      recoveryRootRequestId: string;
      attempt: number;
      maxAttempts: number;
      recoveryKind: "retry" | "continue";
      streamId: string;
      createdAt: number;
      partialText: string;
      partialParts: unknown[];
      reason: string;
      terminalMessage: string;
    }>
  > {
    return this._exhaustedContexts;
  }

  async getTurnBodies(): Promise<Array<Record<string, unknown> | undefined>> {
    return this._turnBodies;
  }

  async getTurnClientToolNames(): Promise<string[][]> {
    return this._turnClientToolNames;
  }

  async setRecoveryOverride(options: ChatRecoveryOptions): Promise<void> {
    this._recoveryOverride = options;
  }

  async setChatRecoveryConfigForTest(
    config: ChatRecoveryConfig
  ): Promise<void> {
    this.chatRecovery = config;
  }

  /** Configure recovery with a built-in `shouldKeepRecovering` predicate.
   *  Functions can't cross the RPC boundary, so this sets the predicate in-DO
   *  rather than accepting one through `setChatRecoveryConfigForTest`. */
  async setShouldKeepRecoveringForTest(keepRecovering: boolean): Promise<void> {
    this.chatRecovery = { shouldKeepRecovering: () => keepRecovering };
  }

  async getChatRecoveryIncidentsForTest(): Promise<unknown[]> {
    const entries = await this.ctx.storage.list({
      prefix: "cf:chat-recovery:incident:"
    });
    return [...entries.values()];
  }

  /**
   * Simulate forward recovery progress by adding one assistant message to the
   * cached message list (what `_persistOrphanedStream` -> `_persistAssistantMessage`
   * does after a partial). Used to exercise the progress-aware attempt-budget
   * reset in `_beginChatRecoveryIncident`.
   */
  async addAssistantMessageForTest(id: string): Promise<void> {
    const self = this as unknown as { _cachedMessages: UIMessage[] };
    self._cachedMessages = [
      ...self._cachedMessages,
      {
        id,
        role: "assistant",
        parts: [{ type: "text", text: "progress" }]
      }
    ];
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

  /** Simulate compaction collapsing the transcript by dropping all assistant
   *  messages from the live cache. Used to prove the recovery progress signal
   *  is compaction-immune (#1628). */
  async dropAssistantMessagesForTest(): Promise<void> {
    const self = this as unknown as { _cachedMessages: UIMessage[] };
    self._cachedMessages = self._cachedMessages.filter(
      (m) => m.role !== "assistant"
    );
  }

  /**
   * Stream a couple of text chunks (throttled → buffered) then a settled tool
   * result, and report how many chunks are durably persisted (raw SQLite, no
   * flush) before vs. after the tool result. Proves a settled tool result is
   * flushed immediately rather than left in the in-memory buffer.
   */
  async probeToolResultDurabilityForTest(): Promise<{
    bufferedTextCount: number;
    afterToolOutputCount: number;
  }> {
    const self = this as unknown as {
      _resumableStream: { start(id: string): string };
      _storeChunkDurably(
        streamId: string,
        chunk: unknown,
        chunkBody: string,
        state: { chunksSinceFlush: number; hasFlushedContent: boolean }
      ): Promise<void>;
    };
    const streamId = self._resumableStream.start("req-tool-durability");
    const state = { chunksSinceFlush: 0, hasFlushedContent: false };
    const store = (chunk: Record<string, unknown>): Promise<void> =>
      self._storeChunkDurably(streamId, chunk, JSON.stringify(chunk), state);
    const rawCount = (): number => {
      const rows = this.sql<{ count: number }>`
        SELECT COUNT(*) as count FROM cf_ai_chat_stream_chunks
        WHERE stream_id = ${streamId}
      `;
      return rows[0]?.count ?? 0;
    };

    await store({ type: "text-delta", id: "t", delta: "hello " });
    await store({ type: "text-delta", id: "t", delta: "there" });
    const bufferedTextCount = rawCount();
    await store({
      type: "tool-output-available",
      toolCallId: "tc1",
      output: { ok: true }
    });
    const afterToolOutputCount = rawCount();
    return { bufferedTextCount, afterToolOutputCount };
  }

  /** Stream content (which durably flushes) then re-persist the same orphan,
   *  reading the recovery-progress counter at each step. Proves the production-
   *  time signal advances on new content but NOT on a reconnect/recovery
   *  re-persist (#1637 reconnect-immunity). */
  async probeProgressReconnectImmunityForTest(): Promise<{
    start: number;
    afterFlush: number;
    afterPersist: number;
  }> {
    const self = this as unknown as {
      _resumableStream: { start(id: string): string };
      _storeChunkDurably(
        streamId: string,
        chunk: unknown,
        chunkBody: string,
        state: { chunksSinceFlush: number; hasFlushedContent: boolean }
      ): Promise<void>;
      _persistOrphanedStream(streamId: string): Promise<void>;
    };
    const read = async (): Promise<number> =>
      (await this.ctx.storage.get<number>("cf:chat-recovery:progress")) ?? 0;

    const start = await read();
    const streamId = self._resumableStream.start("req-progress-immunity");
    const state = { chunksSinceFlush: 0, hasFlushedContent: false };
    const store = (chunk: Record<string, unknown>): Promise<void> =>
      self._storeChunkDurably(streamId, chunk, JSON.stringify(chunk), state);

    await store({ type: "text-delta", id: "t", delta: "hello" });
    await store({
      type: "tool-input-available",
      toolCallId: "tc1",
      toolName: "x",
      input: {}
    });
    await store({
      type: "tool-output-available",
      toolCallId: "tc1",
      output: { ok: true }
    });
    const afterFlush = await read();

    // A recovery/reconnect persist of the same already-streamed content must
    // NOT be miscounted as new forward progress.
    await self._persistOrphanedStream(streamId);
    const afterPersist = await read();

    return { start, afterFlush, afterPersist };
  }

  /** Simulate a parent re-attach that forwards `chunks` of a child's stream by
   *  driving the real `_forwardAgentToolStream` over a synthetic child stream
   *  (each chunk closed normally). The in-memory throttle is reset first so this
   *  models a fresh post-restart isolate (where the first forwarded chunk always
   *  credits). Returns the durable recovery-progress counter before/after so a
   *  test can assert that forwarding child output credits the PARENT's progress
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

  /** Seed a session that ends in a PARTIAL assistant message (the state a
   * deploy-interrupted turn leaves behind, which `continueLastTurn` replays). */
  async seedPartialAssistantTurnForTest(): Promise<void> {
    const self = this as unknown as {
      _upsertMessageInHistory(msg: UIMessage, parentId?: string): Promise<void>;
    };
    await self._upsertMessageInHistory({
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Say hello." }]
    });
    await self._upsertMessageInHistory(
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "Sure, here is" }]
      },
      "u1"
    );
  }

  /** Run `continueLastTurn` against a model that rejects assistant prefill. */
  async runContinueWithPrefillRejectingModelForTest(): Promise<{
    status: string;
    error?: string;
  }> {
    this._rejectPrefill = true;
    this.chatRecovery = false;
    const result = await this.continueLastTurn();
    return {
      status: result.status,
      ...(result.error !== undefined ? { error: result.error } : {})
    };
  }

  getLastPromptRoleForTest(): string | undefined {
    return this._lastPromptRole;
  }

  /** Drive the internal terminal-status hook (what `_streamResult` calls). */
  async fireResponseHookForTest(result: {
    requestId: string;
    status: "completed" | "error" | "aborted";
    error?: string;
  }): Promise<void> {
    const self = this as unknown as {
      _fireResponseHook(r: unknown): Promise<void>;
    };
    await self._fireResponseHook({
      message: {
        id: `m-${result.requestId}`,
        role: "assistant",
        parts: [{ type: "text", text: "" }]
      },
      requestId: result.requestId,
      continuation: false,
      status: result.status,
      ...(result.error !== undefined ? { error: result.error } : {})
    });
  }

  /**
   * Drive a real chat request through `_handleChatRequest` that fails before
   * the stream starts (a `beforeTurn` throw stands in for a message
   * reconciliation/persist failure). Recovery is disabled so the error reaches
   * the outer catch instead of being intercepted by the recovery fiber.
   */
  async simulatePreStreamChatFailureForTest(input: {
    requestId: string;
    userText: string;
    error: string;
  }): Promise<void> {
    this.chatRecovery = false;
    this._throwBeforeTurnMessage = input.error;
    const connection = { id: "c-prestream", send() {} };
    const event = {
      type: "chat-request" as const,
      id: input.requestId,
      init: {
        method: "POST",
        body: JSON.stringify({
          messages: [
            {
              id: `u-${input.requestId}`,
              role: "user",
              parts: [{ type: "text", text: input.userText }]
            }
          ]
        })
      }
    };
    const self = this as unknown as {
      _handleChatRequest(c: unknown, e: unknown): Promise<void>;
    };
    await self._handleChatRequest(connection, event);
  }

  /** What `onConnect` replays to a reconnecting client (no active stream). */
  async getIdleConnectMessagesForTest(): Promise<
    Array<Record<string, unknown>>
  > {
    const self = this as unknown as {
      _buildIdleConnectMessages(): Promise<Array<Record<string, unknown>>>;
    };
    return self._buildIdleConnectMessages();
  }

  async setRecoveryShouldThrowForTest(shouldThrow: boolean): Promise<void> {
    this._recoveryShouldThrow = shouldThrow;
  }

  async enableThrowingOnExhaustedForTest(
    maxAttempts: number,
    terminalMessage: string
  ): Promise<void> {
    this._onExhaustedCalls = 0;
    this.chatRecovery = {
      maxAttempts,
      terminalMessage,
      onExhausted: () => {
        this._onExhaustedCalls++;
        throw new Error("onExhausted boom");
      }
    };
  }

  async getOnExhaustedCallsForTest(): Promise<number> {
    return this._onExhaustedCalls;
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
   *  isn't collapsed by alarm-debounce (#1637) — lets flow tests simulate
   *  genuinely-separate interruptions without real delays. */
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

  /**
   * #1626: directly exercise the exhausted branch of `_routeStallToBoundedRecovery`.
   * Seeds an incident at the budget edge (attempt = maxAttempts, aged past the
   * 30s debounce), then routes one more stall. The route must advance the
   * incident past the budget and deliver the SAME terminal UX as deploy-recovery
   * exhaustion (fires `onExhausted`, marks the incident `exhausted`, broadcasts
   * the configured `terminalMessage`) — NOT leak the raw stall error.
   *
   * Driven at the seam (not via the full watchdog/continuation machinery, which
   * the recover unit test + e2e already cover) so the exhaustion assertion is
   * deterministic and free of turn-queue/generation timing.
   */
  async testStallRouteExhaustion(
    maxAttempts: number,
    terminalMessage: string
  ): Promise<{
    outcome: string;
    exhaustedContexts: number;
    exhaustedReason: string | undefined;
    incidentStatus: string | undefined;
    terminalBroadcast: string | undefined;
  }> {
    const captured: ChatRecoveryExhaustedContext[] = [];
    this.chatRecovery = {
      maxAttempts,
      terminalMessage,
      onExhausted: (ctx) => {
        captured.push(ctx);
      }
    };
    // A user message must be the latest leaf so `latestUserMessageId` resolves
    // to the same identity the route computes.
    const userId = `user-${crypto.randomUUID()}`;
    const self = this as unknown as { _cachedMessages: UIMessage[] };
    self._cachedMessages = [
      ...self._cachedMessages,
      { id: userId, role: "user", parts: [{ type: "text", text: "hi" }] }
    ];
    const requestId = `stall-exhaust-${crypto.randomUUID()}`;
    // Open the incident at attempt = maxAttempts, then age it past the debounce
    // so the route's begin advances to maxAttempts + 1 → exhausted.
    const begun = await this.beginIncidentForTest({
      requestId,
      recoveryRootRequestId: requestId,
      latestUserMessageId: userId,
      recoveryKind: "continue"
    });
    for (let i = begun.attempt; i < maxAttempts; i++) {
      await this.ageIncidentForTest(begun.incidentId, 60_000);
      await this.beginIncidentForTest({
        requestId,
        recoveryRootRequestId: requestId,
        latestUserMessageId: userId,
        recoveryKind: "continue"
      });
    }
    await this.ageIncidentForTest(begun.incidentId, 60_000);

    let terminalBroadcast: string | undefined;
    const realBroadcast = (
      this as unknown as {
        _broadcastChat(m: {
          body?: string;
          error?: boolean;
          done?: boolean;
        }): void;
      }
    )._broadcastChat.bind(this);
    (
      this as unknown as {
        _broadcastChat: (m: {
          body?: string;
          error?: boolean;
          done?: boolean;
        }) => void;
      }
    )._broadcastChat = (m) => {
      if (m.error && m.done) terminalBroadcast = m.body;
      realBroadcast(m);
    };

    let outcome: string;
    try {
      outcome = await (
        this as unknown as {
          _routeStallToBoundedRecovery(i: {
            requestId: string;
            streamId: string;
            partialParts: unknown[];
            targetAssistantId?: string;
          }): Promise<string>;
        }
      )._routeStallToBoundedRecovery({
        requestId,
        streamId: "stall-stream",
        partialParts: []
      });
    } finally {
      (
        this as unknown as { _broadcastChat: (m: unknown) => void }
      )._broadcastChat = realBroadcast as (m: unknown) => void;
    }

    const incidents = await this.ctx.storage.list<{ status: string }>({
      prefix: "cf:chat-recovery:incident:"
    });
    return {
      outcome,
      exhaustedContexts: captured.length,
      exhaustedReason: captured[0]?.reason,
      incidentStatus: [...incidents.values()][0]?.status,
      terminalBroadcast
    };
  }

  /**
   * Drive `_handleRecoveryCallbackError` (the catch path of
   * `_chatRecoveryContinue` / `_chatRecoveryRetry`) and report the outcome.
   *
   * - A non-reset throw must terminalize (fire `onExhausted` + broadcast the
   *   terminal banner, seal the incident `exhausted`) and NOT re-throw — so
   *   `Agent._executeScheduleCallback` doesn't swallow it and delete the
   *   one-shot row with no terminal UX.
   * - A deploy code-update reset must re-throw (so the platform re-runs
   *   recovery on the fresh isolate) and NOT terminalize.
   */
  async testRecoveryCallbackError(input: {
    errorMessage: string;
    maxAttempts?: number;
    terminalMessage?: string;
  }): Promise<{
    threw: boolean;
    exhaustedContexts: number;
    exhaustedReason: string | undefined;
    terminalBroadcast: string | undefined;
    incidentStatus: string | undefined;
  }> {
    const maxAttempts = input.maxAttempts ?? 5;
    const terminalMessage =
      input.terminalMessage ?? "Conversation interrupted.";
    const captured: ChatRecoveryExhaustedContext[] = [];
    this.chatRecovery = {
      maxAttempts,
      terminalMessage,
      onExhausted: (ctx) => {
        captured.push(ctx);
      }
    };

    const requestId = `recovery-error-${crypto.randomUUID()}`;
    const begun = await this.beginIncidentForTest({
      requestId,
      recoveryRootRequestId: requestId,
      latestUserMessageId: null,
      recoveryKind: "continue"
    });

    let terminalBroadcast: string | undefined;
    const realBroadcast = (
      this as unknown as {
        _broadcastChat(m: {
          body?: string;
          error?: boolean;
          done?: boolean;
        }): void;
      }
    )._broadcastChat.bind(this);
    (
      this as unknown as {
        _broadcastChat: (m: {
          body?: string;
          error?: boolean;
          done?: boolean;
        }) => void;
      }
    )._broadcastChat = (m) => {
      if (m.error && m.done) terminalBroadcast = m.body;
      realBroadcast(m);
    };

    const error = new Error(input.errorMessage);

    let threw = false;
    try {
      await (
        this as unknown as {
          _handleRecoveryCallbackError(
            callback: string,
            data: unknown,
            error: unknown
          ): Promise<void>;
        }
      )._handleRecoveryCallbackError(
        "_chatRecoveryContinue",
        { incidentId: begun.incidentId, originalRequestId: requestId },
        error
      );
    } catch {
      threw = true;
    } finally {
      (
        this as unknown as { _broadcastChat: (m: unknown) => void }
      )._broadcastChat = realBroadcast as (m: unknown) => void;
    }

    const incidents = await this.ctx.storage.list<{ status: string }>({
      prefix: "cf:chat-recovery:incident:"
    });
    return {
      threw,
      exhaustedContexts: captured.length,
      exhaustedReason: captured[0]?.reason,
      terminalBroadcast,
      incidentStatus: [...incidents.values()][0]?.status
    };
  }

  async setStashData(data: unknown): Promise<void> {
    this._stashData = data;
  }

  async getStashResult(): Promise<{
    success: boolean;
    error?: string;
  } | null> {
    return this._stashResult;
  }

  async getLatestStreamSnapshot(): Promise<{
    requestId: string;
    status: "streaming" | "completed" | "error";
    chunkCount: number;
    text: string;
  } | null> {
    const streams = this.sql<{
      id: string;
      request_id: string;
      status: "streaming" | "completed" | "error";
    }>`
      SELECT id, request_id, status
      FROM cf_ai_chat_stream_metadata
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const stream = streams[0];
    if (!stream) return null;

    const chunks = this.sql<{ body: string }>`
      SELECT body
      FROM cf_ai_chat_stream_chunks
      WHERE stream_id = ${stream.id}
      ORDER BY chunk_index ASC
    `;

    const text = chunks
      .map((chunk) => {
        try {
          const parsed = JSON.parse(chunk.body) as {
            type?: string;
            delta?: string;
          };
          return parsed.type === "text-delta" ? (parsed.delta ?? "") : "";
        } catch {
          return "";
        }
      })
      .join("");

    return {
      requestId: stream.request_id,
      status: stream.status,
      chunkCount: chunks.length,
      text
    };
  }

  async testSaveMessages(text: string): Promise<SaveMessagesResult> {
    return this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text }]
      }
    ]);
  }

  async testContinueLastTurn(): Promise<SaveMessagesResult> {
    return this.continueLastTurn();
  }

  async runRecoveryRetryForTest(options?: {
    targetUserId?: string;
    lastBody?: Record<string, unknown>;
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

  async setRequestContextForTest(
    body?: Record<string, unknown>,
    clientTools?: ClientToolSchema[]
  ): Promise<void> {
    const internals = this as unknown as {
      _lastBody?: Record<string, unknown>;
      _lastClientTools?: ClientToolSchema[];
    };
    internals._lastBody = body;
    internals._lastClientTools = clientTools;
  }

  /**
   * Simulate the durable state a HITL turn leaves before a Durable Object
   * restart: the client tools are persisted to the `think_config` store (where
   * onStart's `_restoreClientTools()` reads them), while the IN-MEMORY cache is
   * cleared to mimic a fresh wake whose onStart has not run yet. Used to
   * exercise the hibernation ordering guard in `_beginChatRecoveryIncident`.
   */
  async seedDurableClientToolsForTest(
    clientTools: ClientToolSchema[]
  ): Promise<void> {
    const internals = this as unknown as {
      _lastClientTools?: ClientToolSchema[];
      _persistClientTools(): void;
    };
    internals._lastClientTools = clientTools;
    internals._persistClientTools();
    internals._lastClientTools = undefined;
  }

  /** Clear the in-memory client-tool cache (without touching the durable
   *  `think_config` store) to simulate a fresh post-hibernation wake whose
   *  onStart `_restoreClientTools()` has not run yet. */
  async clearInMemoryClientToolsForTest(): Promise<void> {
    (
      this as unknown as { _lastClientTools?: ClientToolSchema[] }
    )._lastClientTools = undefined;
  }

  async insertInterruptedStream(
    streamId: string,
    requestId: string,
    chunks: Array<{ body: string; index: number }>,
    status: "streaming" | "completed" | "error" = "streaming"
  ): Promise<void> {
    const now = Date.now();
    this.sql`
      INSERT INTO cf_ai_chat_stream_metadata (id, request_id, status, created_at)
      VALUES (${streamId}, ${requestId}, ${status}, ${now})
    `;
    for (const chunk of chunks) {
      const chunkId = `${streamId}-${chunk.index}`;
      this.sql`
        INSERT INTO cf_ai_chat_stream_chunks (id, stream_id, chunk_index, body, created_at)
        VALUES (${chunkId}, ${streamId}, ${chunk.index}, ${chunk.body}, ${now})
      `;
    }
  }

  async getScheduledChatRecoveryCountForTest(
    callback = "_chatRecoveryContinue"
  ): Promise<number> {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count
      FROM cf_agents_schedules
      WHERE callback = ${callback}
    `;
    return rows[0]?.count ?? 0;
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

  async persistTestMessage(msg: UIMessage): Promise<void> {
    await this.session.appendMessage(msg);
  }

  async hasPendingInteractionForTest(): Promise<boolean> {
    return this.hasPendingInteraction();
  }

  async waitUntilStableForTest(timeout?: number): Promise<boolean> {
    return this.waitUntilStable({ timeout: timeout ?? 5000 });
  }

  private _forceStableTimeout = false;

  async setForceStableTimeoutForTest(value: boolean): Promise<void> {
    this._forceStableTimeout = value;
  }

  protected override async waitUntilStable(options?: {
    timeout?: number;
  }): Promise<boolean> {
    if (this._forceStableTimeout) return false;
    return super.waitUntilStable(options);
  }

  /** Seed a `running` durable submission keyed by `requestId` (== submission id). */
  async seedRunningSubmissionForTest(requestId: string): Promise<void> {
    (
      this as unknown as { _ensureSubmissionTable(): void }
    )._ensureSubmissionTable();
    const now = Date.now();
    this.sql`
      INSERT INTO cf_think_submissions (
        submission_id, idempotency_key, request_id, stream_id, status,
        messages_json, metadata_json, error_message, created_at,
        messages_applied_at, started_at, completed_at
      ) VALUES (
        ${requestId}, NULL, ${requestId}, NULL, 'running',
        '[]', NULL, NULL, ${now}, ${now}, ${now}, NULL
      )
    `;
  }

  async getSubmissionStatusForTest(
    submissionId: string
  ): Promise<string | null> {
    const rows = this.sql<{ status: string }>`
      SELECT status FROM cf_think_submissions WHERE submission_id = ${submissionId}
    `;
    return rows[0]?.status ?? null;
  }

  /** Drive the boot-time submission sweep to assert a parked (completed)
   *  submission isn't resurrected as an error on the next restart. */
  async recoverSubmissionsOnStartForTest(): Promise<void> {
    await (
      this as unknown as { _recoverSubmissionsOnStart(): Promise<void> }
    )._recoverSubmissionsOnStart();
  }

  async runChatRecoveryContinueForTestWith(
    data: Record<string, unknown>
  ): Promise<void> {
    await (
      this as unknown as {
        _chatRecoveryContinue(d: unknown): Promise<void>;
      }
    )._chatRecoveryContinue(data);
  }

  async runChatRecoveryRetryForTestWith(
    data: Record<string, unknown>
  ): Promise<void> {
    await (
      this as unknown as {
        _chatRecoveryRetry(d: unknown): Promise<void>;
      }
    )._chatRecoveryRetry(data);
  }

  /** Retry-path twin of `preScheduleRecoveryContinueForTest`. */
  async preScheduleRecoveryRetryForTest(
    data: Record<string, unknown>
  ): Promise<void> {
    await this.schedule(60, "_chatRecoveryRetry", data, {
      idempotent: false
    });
  }

  async getIncidentAttemptForTest(incidentId: string): Promise<{
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
   * Pre-insert a matching `_chatRecoveryContinue` schedule row to simulate the
   * not-yet-deleted one-shot row that `alarm()` is executing — so a reschedule
   * with `idempotent: true` would (incorrectly) dedup onto it.
   */
  async preScheduleRecoveryContinueForTest(
    data: Record<string, unknown>
  ): Promise<void> {
    await this.schedule(60, "_chatRecoveryContinue", data, {
      idempotent: false
    });
  }

  async getScheduledChatRecoveryPayloadForTest(
    callback = "_chatRecoveryContinue"
    // Concrete, serializable return shape: a `Record<string, unknown>` collapses
    // to `never` across the Durable Object RPC stub boundary (Workers RPC drops
    // `unknown`-valued records as non-serializable), which made callers see
    // `payload` as `never`. The scheduled payload only needs its recovery-link
    // fields exposed for assertions.
  ): Promise<{ recoveredRequestId?: string; requestId?: string } | null> {
    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM cf_agents_schedules
      WHERE callback = ${callback}
      ORDER BY time ASC
      LIMIT 1
    `;
    return rows[0]
      ? (JSON.parse(rows[0].payload) as {
          recoveredRequestId?: string;
          requestId?: string;
        })
      : null;
  }
}

// ── ThinkNonRecoveryTestAgent ───────────────────────────────
// Same as ThinkRecoveryTestAgent but with chatRecovery = false.

export class ThinkNonRecoveryTestAgent extends Think {
  override chatRecovery = false;
  private _turnCallCount = 0;

  override getModel(): LanguageModel {
    return createMockModel("Continued response.");
  }

  override beforeTurn(_ctx: TurnContext): void {
    this._turnCallCount++;
  }

  async testChat(message: string): Promise<TestChatResult> {
    const cb = new TestCollectingCallback();
    await this.chat(message, cb);
    return {
      events: cb.events,
      done: cb.doneCalled,
      error: cb.errorMessage,
      interruptedCalls: cb.interruptedCalls
    };
  }

  async getStoredMessages(): Promise<UIMessage[]> {
    return this.getMessages();
  }

  async getActiveFibers(): Promise<Array<{ id: string; name: string }>> {
    return this.sql<{ id: string; name: string }>`
      SELECT id, name FROM cf_agents_runs
    `;
  }

  async getTurnCallCount(): Promise<number> {
    return this._turnCallCount;
  }
}
