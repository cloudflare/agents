import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { hasToolCall, Output, tool } from "ai";
import { action, Think } from "../../think";
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
  SaveMessagesOptions,
  SaveMessagesResult,
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryExhaustedContext,
  ChatRecoveryOptions,
  ThinkSubmissionInspection,
  ThinkSubmissionStatus,
  SubmitMessagesResult,
  TurnResult,
  RunTurnWait,
  RunTurnOptions,
  MediaEvictionConfig,
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
  Action,
  ActionAuthorizationContext,
  ActionAuthorizationDecision,
  StepContext,
  ChunkContext
} from "../../think";
import {
  sanitizeMessage,
  enforceRowSizeLimit,
  StreamAccumulator
} from "agents/chat";
import type { ClientToolSchema } from "agents/chat";
import type { Schedule } from "agents";
import { Session } from "agents/experimental/memory/session";
import { z } from "zod";

// ── Test result type ────────────────────────────────────────────

export type TestChatResult = {
  events: string[];
  done: boolean;
  error?: string;
  requestId?: string;
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

  /**
   * #1575: broadcast a chat error frame whose request id belongs to no
   * agent-tool run, simulating an unrelated turn failing on this agent
   * while a run is being tailed.
   */
  broadcastUnrelatedErrorForTest(requestId: string): void {
    this.broadcast(
      JSON.stringify({
        type: "cf_agent_use_chat_response",
        id: requestId,
        error: true,
        done: false,
        body: "unrelated turn failure"
      })
    );
  }

  /**
   * #1575: simulate a DO restart mid-run — the in-memory request-id map is
   * empty (wiped by the restart), but the child-run row persisted its
   * `request_id` at turn start. `_agentToolRunForRequest` must still attribute
   * a frame to the run via the SQL fallback, and an unknown request resolves
   * to null.
   */
  resolveAgentToolRunAfterRestartForTest(
    runId: string,
    requestId: string
  ): { running: string | null; unknown: string | null } {
    this["_ensureAgentToolChildRunTable"]();
    this.sql`
      INSERT INTO cf_agent_tool_child_runs (run_id, request_id, status, started_at)
      VALUES (${runId}, ${requestId}, 'running', ${Date.now()})
    `;
    // Cold in-memory map, as after a restart.
    this["_agentToolRunsByRequestId"].clear();
    return {
      running: this["_agentToolRunForRequest"](requestId),
      unknown: this["_agentToolRunForRequest"]("no-such-request")
    };
  }

  private _beforeTurnLog: Array<{
    system: string;
    toolNames: string[];
    continuation: boolean;
    body?: RpcJsonObject;
  }> = [];
  private _beforeTurnMessagesJson: string[] = [];
  private _capturedTurnChannels: string[] = [];

  override configureChannels() {
    return {
      voice: {
        kind: "voice" as const,
        ingress: { transport: "voice" as const },
        instructions: "VOICE MODE",
        tools: () => ({}),
        maxTurns: 3
      }
    };
  }
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
    this._capturedTurnChannels.push(this.activeChannel?.channelId ?? "");
    if (this._turnConfigOverride) return this._turnConfigOverride;
  }

  async getCapturedTurnChannelsForTest(): Promise<string[]> {
    return this._capturedTurnChannels;
  }

  async runChannelTurnForTest(options: {
    input?: string;
    channel?: string;
    continuation?: boolean;
  }): Promise<void> {
    if (options.continuation) {
      await this.runTurn({ continuation: true, channel: options.channel });
      return;
    }
    await this.runTurn({
      input: options.input ?? "hi",
      channel: options.channel
    });
  }

  async renderAttachmentsForTest(
    attachments: import("../../think").ReplyAttachment[]
  ): Promise<UIMessage[]> {
    await (
      this as unknown as {
        _renderChannelAttachments(
          a: import("../../think").ReplyAttachment[]
        ): Promise<void>;
      }
    )._renderChannelAttachments(attachments);
    return this.getMessages();
  }

  async resetCapturedTurnChannelsForTest(): Promise<void> {
    this._capturedTurnChannels = [];
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

  /**
   * Sets a per-turn `experimental_transform` that upper-cases every `text-delta`
   * part flowing through the stream. The transform is constructed inside the DO
   * (it's a function and can't cross the RPC boundary). A test asserts the
   * persisted assistant text is upper-cased, proving the transform was forwarded
   * to `streamText` and applied. Regression for #1714.
   */
  async setTurnConfigTransform(): Promise<void> {
    this._turnConfigOverride = {
      experimental_transform: () =>
        new TransformStream({
          transform(chunk, controller) {
            if (chunk.type === "text-delta") {
              controller.enqueue({ ...chunk, text: chunk.text.toUpperCase() });
            } else {
              controller.enqueue(chunk);
            }
          }
        })
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

  /**
   * Persist a durable terminal record exactly as recovery exhaustion does
   * (#1645), so a test can drive the reconnect path without a full
   * deploy-churn exhaustion.
   */
  async recordTerminalForTest(requestId: string, body: string): Promise<void> {
    await (
      this as unknown as {
        _recordTerminalChatStatus: (
          status: "interrupted",
          requestId: string,
          body: string
        ) => Promise<void>;
      }
    )._recordTerminalChatStatus("interrupted", requestId, body);
  }

  /** Read the durable terminal record (#1645) so a test can assert it is
   *  cleared when the conversation is cleared. */
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
      _autoContinuation: {
        _timer: ReturnType<typeof setTimeout> | null;
        cancelTimer(): void;
      };
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
      const coalesceTimerArmedAfterStall =
        internal._autoContinuation._timer !== null;
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
      internal._autoContinuation.cancelTimer();
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

  /**
   * #1575: drive `_replayTerminalOnAck` end to end — produce a real errored
   * stream that buffered partial content, then replay the pending terminal
   * onto a capturing connection. Returns the frames a reconnecting client
   * would observe, in order, so the test can assert the partial content is
   * replayed before the terminal error frame.
   */
  async replayTerminalOnAckCaptureForTest(errorText: string): Promise<{
    returned: boolean;
    frames: Array<Record<string, unknown>>;
  }> {
    const requestId = crypto.randomUUID();
    await (
      this as unknown as {
        _streamResult: (
          requestId: string,
          result: StreamableResult
        ) => Promise<void>;
      }
    )._streamResult(
      requestId,
      createInBandErrorStreamResult(errorText, ["partial response"])
    );
    const frames: Array<Record<string, unknown>> = [];
    const fakeConnection = {
      send(message: string) {
        frames.push(JSON.parse(message) as Record<string, unknown>);
      }
    };
    // The terminal-replay logic now lives on the shared `ResumeHandshake`
    // driver (Tier-2). Reach it through the host's lazy getter and exercise the
    // same `_replayTerminalOnAck` so this package keeps its own #1575 guard.
    const handshake = (
      this as unknown as {
        _resumeHandshake: () => {
          _replayTerminalOnAck: (
            connection: { send(message: string): void },
            requestId: string
          ) => Promise<boolean>;
        };
      }
    )._resumeHandshake();
    const returned = await handshake._replayTerminalOnAck(
      fakeConnection,
      requestId
    );
    return { returned, frames };
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

  async deliverNoticeErrorForTest(
    text: string,
    channel?: string
  ): Promise<string | null> {
    try {
      await this.deliverNotice(text, channel ? { channel } : undefined);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
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

  /**
   * Calls `addMessages` and returns the error message instead of letting the
   * throw cross the RPC boundary (which workerd logs as an unhandled rejection).
   */
  async addMessagesExpectingError(
    messages: UIMessage[],
    options?: Parameters<ThinkTestAgent["addMessages"]>[1]
  ): Promise<string | null> {
    try {
      await this.addMessages(messages, options);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Calls `addMessages` while the agent believes a turn is in flight, to
   * exercise the mid-turn gating (durable write only; live cache untouched).
   */
  async addMessagesMidTurnForTest(messages: UIMessage[]): Promise<{
    cacheLengthDuring: number;
    storedAfter: number;
  }> {
    const self = this as unknown as { _insideInferenceLoop: boolean };
    const prev = self._insideInferenceLoop;
    self._insideInferenceLoop = true;
    let cacheLengthDuring: number;
    try {
      await this.addMessages(messages);
      cacheLengthDuring = this.messages.length;
    } finally {
      self._insideInferenceLoop = prev;
    }
    const stored = (await this.session.getHistory()) as UIMessage[];
    return {
      cacheLengthDuring,
      storedAfter: stored.length
    };
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

/**
 * Middle layer for nested agent-tools (grandparent → middle → grandchild). As a
 * valid agent-tool CHILD it inherits the full child adapter from
 * {@link ThinkTestAgent}; as a PARENT it dispatches its own grandchild run via
 * `runAgentTool` at the start of its run. The grandchild's frames are observed
 * only by the middle (its immediate parent) — observation does not bridge up to
 * the grandparent.
 */
export class ThinkNestedMiddleAgent extends ThinkTestAgent {
  override async startAgentToolRun(
    input: unknown,
    options: { runId: string }
  ): Promise<AgentToolRunInspection> {
    await this.runAgentTool(ThinkTestAgent, {
      runId: `${options.runId}-grandchild`,
      parentToolCallId: "nested-grandchild-call",
      input: "grandchild work",
      inputPreview: "grandchild work"
    });
    return super.startAgentToolRun(input, options);
  }

  /** This facet's OWN parent registry rows (the grandchild runs it dispatched). */
  getAgentToolRunStatusesForTest(): Array<{ runId: string; status: string }> {
    const rows = this.sql<{ run_id: string; status: string }>`
      SELECT run_id, status FROM cf_agent_tool_runs ORDER BY started_at ASC
    `;
    return rows.map((r) => ({ runId: r.run_id, status: r.status }));
  }

  /** Set THIS middle node's own concurrency cap (independent of its parent). */
  async setMaxConcurrentAgentToolsForTest(limit: number): Promise<void> {
    this.maxConcurrentAgentTools = limit;
  }

  /**
   * Launch `count` grandchildren concurrently against the MIDDLE node's own cap,
   * to prove each nesting level enforces its own `maxConcurrentAgentTools`
   * independently of its parent's.
   */
  async runConcurrentGrandchildrenForTest(
    count: number
  ): Promise<Array<{ runId: string; status: string; error?: string }>> {
    const runIds = Array.from(
      { length: count },
      (_, i) => `gc-${i}-${crypto.randomUUID()}`
    );
    return Promise.all(
      runIds.map((runId) =>
        this.runAgentTool(ThinkTestAgent, {
          runId,
          parentToolCallId: `gc-${runId}`,
          input: "grandchild work",
          inputPreview: "grandchild work"
        }).then(
          (r) => ({ runId, status: r.status, error: r.error }),
          (e: unknown) => ({
            runId,
            status: "throw",
            error: e instanceof Error ? e.message : String(e)
          })
        )
      )
    );
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

  /** Set the parent's concurrency cap at runtime (default `Infinity`). */
  async setMaxConcurrentAgentToolsForTest(limit: number): Promise<void> {
    this.maxConcurrentAgentTools = limit;
  }

  /**
   * Run a nested agent-tool chain (this parent → middle → grandchild) and report
   * the middle's terminal status, the run ids this parent observed via
   * agent-tool events, and the middle's own grandchild run rows. Asserts the
   * nesting works and that grandchild observation does not bridge up to here.
   */
  async runNestedMiddleForTest(runId: string): Promise<{
    middleStatus: string;
    middleError?: string;
    parentEventRunIds: string[];
    grandchildRuns: Array<{ runId: string; status: string }>;
  }> {
    this.events = [];
    this.finishes = [];
    const result = await this.runAgentTool(ThinkNestedMiddleAgent, {
      runId,
      parentToolCallId: "nested-middle-call",
      input: "middle work",
      inputPreview: "middle work"
    });
    const parentEventRunIds = Array.from(
      new Set(this.events.map((e) => e.event.runId))
    );
    const middle = await this.subAgent(ThinkNestedMiddleAgent, runId);
    const grandchildRuns = await middle.getAgentToolRunStatusesForTest();
    return {
      middleStatus: result.status,
      ...(result.error !== undefined && { middleError: result.error }),
      parentEventRunIds,
      grandchildRuns
    };
  }

  /**
   * Launch `count` Think children concurrently against the current
   * `maxConcurrentAgentTools` cap and return each run's terminal status. The cap
   * is enforced synchronously at admission (before any await), so over-limit
   * launches reject deterministically (`status: "error"`, no queue) without
   * needing slow children.
   */
  async runConcurrentThinkChildrenForTest(
    count: number
  ): Promise<Array<{ runId: string; status: string; error?: string }>> {
    this.events = [];
    this.finishes = [];
    const runIds = Array.from(
      { length: count },
      (_, i) => `concurrency-${i}-${crypto.randomUUID()}`
    );
    return Promise.all(
      runIds.map((runId) =>
        this.runAgentTool(ThinkTestAgent, {
          runId,
          parentToolCallId: `concurrency-${runId}`,
          input: "concurrent child",
          inputPreview: "concurrent child"
        }).then(
          (r) => ({ runId, status: r.status, error: r.error }),
          (e: unknown) => ({
            runId,
            status: "throw",
            error: e instanceof Error ? e.message : String(e)
          })
        )
      )
    );
  }

  /**
   * Seed a PARENT-side `cf_agent_tool_runs` row with an explicit status, to
   * assert how the concurrency cap counts (or ignores) a given lifecycle state.
   * Soft-terminal `interrupted` rows must NOT occupy a slot (only
   * `starting`/`running` do), so a re-issue after recovery is never cap-blocked.
   */
  async seedParentAgentToolRunForTest(
    runId: string,
    status: string
  ): Promise<void> {
    const now = Date.now();
    const completedAt =
      status === "starting" || status === "running" ? null : now;
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, input_preview,
        input_redacted, status, display_metadata, display_order,
        started_at, completed_at
      ) VALUES (
        ${runId}, 'seed-tool-call', 'ThinkTestAgent', ${JSON.stringify("seed")},
        1, ${status}, ${JSON.stringify({ name: "seed" })}, 0, ${now}, ${completedAt}
      )
    `;
  }

  /** Launch a single real Think child against the current cap. */
  async runSingleThinkChildForTest(): Promise<{
    status: string;
    error?: string;
  }> {
    this.events = [];
    this.finishes = [];
    const r = await this.runAgentTool(ThinkTestAgent, {
      runId: `single-${crypto.randomUUID()}`,
      parentToolCallId: "single-call",
      input: "single child",
      inputPreview: "single child"
    });
    return { status: r.status, error: r.error };
  }

  /**
   * #1575: run a Think child while injecting a chat error frame from an
   * UNRELATED turn (a request id that belongs to no agent-tool run) into the
   * child's broadcast stream mid-run. The run's terminal status must not be
   * contaminated by it.
   */
  async runThinkChildWithInjectedUnrelatedError(
    input: string,
    injectAfterMs: number,
    runId = crypto.randomUUID()
  ): Promise<RunAgentToolResult> {
    this.events = [];
    this.finishes = [];
    const child = await this.subAgent(ThinkTestAgent, runId);
    const timer = setTimeout(() => {
      void child.broadcastUnrelatedErrorForTest(`unrelated-turn-${runId}`);
    }, injectAfterMs);
    try {
      return await this.runAgentTool(ThinkTestAgent, {
        runId,
        parentToolCallId: "think-tool-call",
        input,
        inputPreview: input
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * #1575: run a Think child whose turn dies with an in-band stream error.
   * Used to assert error classification independent of tailer timing and that
   * concurrent runs stay isolated.
   */
  async runThinkChildWithInBandError(
    input: string,
    errorText: string,
    runId = crypto.randomUUID()
  ): Promise<RunAgentToolResult> {
    this.events = [];
    this.finishes = [];
    const child = await this.subAgent(ThinkTestAgent, runId);
    await child.setInBandErrorResponse(errorText);
    return this.runAgentTool(ThinkTestAgent, {
      runId,
      parentToolCallId: "think-tool-call",
      input,
      inputPreview: input
    });
  }

  /**
   * #1575: start a Think child run directly — no tailer is ever attached —
   * with a turn that dies in-band, and wait for its terminal inspection.
   * Terminal status must come from the child's own result, not from tailing.
   */
  async startThinkChildWithoutTailForTest(
    input: string,
    errorText: string,
    runId = crypto.randomUUID()
  ): Promise<AgentToolRunInspection> {
    const child = await this.subAgent(ThinkTestAgent, runId);
    await child.setInBandErrorResponse(errorText);
    await child.startAgentToolRun(input, { runId });
    return this.waitForTerminalInspectionForTest(child, runId);
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

function createAttachReplyMockModel(): LanguageModel {
  let callCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-attach-reply",
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
              id: "ar1",
              toolName: "attachAction"
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: "ar1",
              delta: JSON.stringify({})
            });
            controller.enqueue({ type: "tool-input-end", id: "ar1" });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "ar1",
              toolName: "attachAction",
              input: JSON.stringify({})
            });
            controller.enqueue({
              type: "finish",
              finishReason: v3FinishReason("tool-calls"),
              usage: v3Usage(10, 5)
            });
          } else {
            controller.enqueue({ type: "text-start", id: "ar-final" });
            controller.enqueue({
              type: "text-delta",
              id: "ar-final",
              delta: "attached-done"
            });
            controller.enqueue({ type: "text-end", id: "ar-final" });
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

// Calls the `pauseAction` durable-pause action on the first model step, then
// emits text on every later step (within the parking turn and on the
// connection-independent continuation after approval).
function createDurablePauseMockModel(): LanguageModel {
  let callCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-durable-pause",
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
      // Only park when a user explicitly asked for it on this turn — so a
      // post-resolution continuation (driven by a system note, no fresh user
      // ask) responds with text instead of re-parking.
      const userAskedToPause = messages.some((m: unknown) => {
        if (typeof m !== "object" || m === null) return false;
        const mm = m as Record<string, unknown>;
        if (mm.role !== "user") return false;
        return JSON.stringify(mm.content ?? "").includes("pauseAction");
      });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (!hasToolResult && callCount === 1 && userAskedToPause) {
            controller.enqueue({
              type: "tool-input-start",
              id: "dp1",
              toolName: "pauseAction"
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: "dp1",
              delta: JSON.stringify({ message: "hello" })
            });
            controller.enqueue({ type: "tool-input-end", id: "dp1" });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "dp1",
              toolName: "pauseAction",
              input: JSON.stringify({ message: "hello" })
            });
            controller.enqueue({
              type: "finish",
              finishReason: v3FinishReason("tool-calls"),
              usage: v3Usage(10, 5)
            });
          } else {
            const id = `dp-text-${callCount}`;
            controller.enqueue({ type: "text-start", id });
            controller.enqueue({
              type: "text-delta",
              id,
              delta: "acknowledged"
            });
            controller.enqueue({ type: "text-end", id });
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

// Emits a single tool call for whichever tool the turn forces via `toolChoice`
// (or the first `think_final_answer*` tool advertised), with the configured
// arguments. Mirrors how a real model terminates a structured workflow turn by
// calling the synthetic final-answer tool — exercises the #1685 capture path
// without a network round-trip.
function createFinalAnswerMockModel(args: unknown): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-final-answer",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream(options: Record<string, unknown>) {
      const opts = options as {
        toolChoice?: { type?: string; toolName?: string };
        tools?: Array<{ name?: string }>;
      };
      const toolName =
        opts.toolChoice?.type === "tool" && opts.toolChoice.toolName
          ? opts.toolChoice.toolName
          : ((opts.tools ?? [])
              .map((t) => t.name)
              .find((n) => n?.startsWith("think_final_answer")) ??
            "think_final_answer");
      const input = JSON.stringify(args);
      const id = "final-answer-call";
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "tool-input-start", id, toolName });
          controller.enqueue({ type: "tool-input-delta", id, delta: input });
          controller.enqueue({ type: "tool-input-end", id });
          controller.enqueue({
            type: "tool-call",
            toolCallId: id,
            toolName,
            input
          });
          controller.enqueue({
            type: "finish",
            finishReason: v3FinishReason("tool-calls"),
            usage: v3Usage(10, 5)
          });
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
  private _responseLog: ChatResponseResult[] = [];

  override onChatResponse(result: ChatResponseResult): void {
    this._responseLog.push(result);
  }

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
    if (this._useAttachReplyAction) return createAttachReplyMockModel();
    if (this._useDurablePauseAction) return createDurablePauseMockModel();
    return createToolCallingMockModel();
  }

  override getTools(): ToolSet {
    if (this._useEchoAction) return {};
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
            this._echoExecuteCount++;
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
            this._echoExecuteCount++;
            async function* gen() {
              yield `echo-prelim: ${message}`;
              yield `echo: ${message}`;
            }
            return gen();
          }
        })
      };
    }
    if (mode === "async-generator") {
      // Canonical AI SDK streaming tool: an `async function*` `execute`.
      // Think preserves preliminary streaming for this form — each yielded
      // value reaches the model as a `preliminary` tool-result, the last as
      // the final value.
      const self = this;
      return {
        echo: tool({
          description: "Echo a message back (async generator streaming)",
          inputSchema: z.object({ message: z.string() }),
          execute: async function* ({ message }: { message: string }) {
            self._echoExecuteCount++;
            yield `echo-prelim-1: ${message}`;
            yield `echo-prelim-2: ${message}`;
            yield `echo: ${message}`;
          }
        })
      };
    }
    if (mode === "needs-approval") {
      // A raw AI SDK `needsApproval` tool (not a Think Action). Used to
      // verify the dual-gate ordering: the AI SDK approval gate runs first,
      // then — after approval — `beforeToolCall` is still the outer gate
      // around the original `execute`.
      return {
        echo: tool({
          description: "Echo a message back (requires approval)",
          inputSchema: z.object({ message: z.string() }),
          needsApproval: true,
          execute: async ({ message }: { message: string }) => {
            this._echoExecuteCount++;
            return `echo: ${message}`;
          }
        })
      };
    }
    if (mode === "add-messages") {
      // Calls `addMessages` from inside a real tool `execute` to verify the
      // mid-turn contract: the inference-loop flag is set (so the broadcast is
      // suppressed) and the durable write lands immediately.
      return {
        echo: tool({
          description: "Echo a message back (and inject context mid-turn)",
          inputSchema: z.object({ message: z.string() }),
          execute: async ({ message }: { message: string }) => {
            this._midTurnInsideLoop = (
              this as unknown as { _insideInferenceLoop: boolean }
            )._insideInferenceLoop;
            await this.addMessages([
              {
                id: "mid-turn-injected",
                role: "user",
                parts: [{ type: "text", text: "injected during execute" }]
              }
            ]);
            this._midTurnPersisted = Boolean(
              await this.session.getMessage("mid-turn-injected")
            );
            return `echo: ${message}`;
          }
        })
      };
    }
    return {
      echo: tool({
        description: "Echo a message back",
        inputSchema: z.object({ message: z.string() }),
        execute: async ({ message }: { message: string }) => {
          this._echoExecuteCount++;
          return `echo: ${message}`;
        }
      })
    };
  }

  override getActions(): Record<string, Action> {
    const actions: Record<string, Action> = {};
    if (this._useDurablePauseAction) {
      const approval =
        this._durablePauseApproval === "predicate-hello"
          ? ({ input }: { input: { message: string } }) =>
              input.message === "hello"
          : this._durablePauseApproval;
      actions.pauseAction = action({
        name: "pauseAction",
        description: "A durable-pause action awaiting human approval",
        inputSchema: z.object({ message: z.string() }),
        kind: "durable-pause",
        approvalSummary: "Approve pause action",
        approvalRisk: "high",
        permissions: ["pause:run"],
        idempotencyKey: this._durablePauseIdempotencyKey ?? undefined,
        ...(approval !== undefined && { approval }),
        execute: async ({ message }, ctx): Promise<unknown> => {
          this._durablePauseExecCount++;
          if (this._durablePauseAttachReply) {
            ctx.attachReply({ type: "voice_note" });
          }
          if (this._durablePauseExecThrows) {
            throw new Error("durable pause execute failed");
          }
          return `paused-exec: ${message}`;
        }
      });
    }
    if (this._useAttachReplyAction) {
      const scenario = this._attachReplyScenario;
      actions.attachAction = action({
        name: "attachAction",
        description: "Attach delivery metadata to the final reply",
        inputSchema: z.object({}),
        ...(scenario === "approval-gated" && {
          approval: true,
          approvalSummary: "Approve attach action",
          approvalRisk: "low" as const
        }),
        ...(scenario === "predicate-noop" && {
          approval: ({ ctx }) => {
            ctx.attachReply({ type: "from_predicate" });
            return false;
          }
        }),
        ...(scenario === "permission-noop" && {
          permissions: ({ ctx }) => {
            ctx.attachReply({ type: "from_permission" });
            return ["attach:run"];
          }
        }),
        execute: async (_input, ctx): Promise<unknown> => {
          if (scenario === "two") {
            ctx.attachReply({ type: "voice_note" });
            ctx.attachReply({ type: "card", payload: { id: 1 } });
          } else if (scenario === "invalid") {
            ctx.attachReply(null as never);
            ctx.attachReply({} as never);
            ctx.attachReply({ type: 123 } as never);
          } else if (scenario === "non-json") {
            const payload: { big: bigint; self?: unknown } = { big: 1n };
            payload.self = payload;
            ctx.attachReply({ type: "card", payload });
          } else if (scenario === "overcap") {
            for (let i = 0; i < 40; i++) {
              ctx.attachReply({ type: "x", i });
            }
          } else if (scenario === "approval-gated") {
            ctx.attachReply({ type: "voice_note" });
          } else if (scenario === "attach-then-throw") {
            ctx.attachReply({ type: "voice_note" });
            throw new Error("attach action failed");
          }
          return "attached";
        }
      });
    }
    if (!this._useEchoAction) return actions;
    const mode = this._actionExecuteMode;
    return {
      ...actions,
      echo: action({
        description: "Echo a message back as an action",
        inputSchema: z.object({ message: z.string() }),
        idempotencyKey:
          mode === "attach-idempotency-key"
            ? ({ ctx }) => {
                ctx.attachReply({ type: "from_idempotency_key" });
                return this._actionIdempotencyKey ?? "attach-idempotency-key";
              }
            : mode === "ledger-key" ||
                mode === "ledger-throw" ||
                mode === "ledger-large-output" ||
                mode === "ledger-slow" ||
                mode === "ledger-symbol-output" ||
                mode === "ledger-approval" ||
                mode === "attach-ledger"
              ? (this._actionIdempotencyKey ?? "echo-ledger-key")
              : undefined,
        permissions:
          mode === "permission" || mode === "approval-permission"
            ? ["echo:run"]
            : mode === "function-policy"
              ? ({ input }) => [`echo:${input.message}`]
              : undefined,
        timeoutMs: mode === "timeout" ? 5 : undefined,
        approval:
          mode === "approval" ||
          mode === "approval-permission" ||
          mode === "ledger-approval"
            ? true
            : mode === "function-policy"
              ? ({ input }) => input.message === "hello"
              : undefined,
        approvalSummary:
          mode === "approval" ||
          mode === "approval-permission" ||
          mode === "function-policy" ||
          mode === "ledger-approval"
            ? "Approve echo action"
            : undefined,
        approvalRisk:
          mode === "approval" ||
          mode === "approval-permission" ||
          mode === "ledger-approval"
            ? "low"
            : undefined,
        execute: async ({ message }, ctx): Promise<unknown> => {
          this._actionExecutionCount++;
          this._lastActionContext = {
            requestId: ctx.requestId,
            toolCallId: ctx.toolCallId,
            messageCount: ctx.messages.length
          };
          if (mode === "throw") {
            throw new Error("action failed");
          }
          if (mode === "ledger-throw") {
            throw new Error("ledger action failed");
          }
          if (mode === "timeout") {
            await new Promise(() => {});
          }
          if (mode === "ledger-slow") {
            await new Promise((resolve) =>
              setTimeout(resolve, this._actionDelayMs)
            );
          }
          if (mode === "large-output") {
            return `echo: ${message} ${"x".repeat(25_000)}`;
          }
          if (mode === "ledger-large-output") {
            return `echo: ${message} ${"x".repeat(25_000)}`;
          }
          if (mode === "non-json-output") {
            const output: { count: bigint; self?: unknown } = { count: 12n };
            output.self = output;
            return output;
          }
          if (mode === "ledger-symbol-output") {
            return Symbol("not-json");
          }
          if (mode === "attach-ledger") {
            ctx.attachReply({ type: "voice_note" });
          }
          if (mode === "attach-idempotency-key") {
            ctx.attachReply({ type: "voice_note" });
          }
          return `action echo: ${message}`;
        }
      })
    };
  }

  private _echoExecuteMode:
    | "default"
    | "async-iterable"
    | "sync-iterable"
    | "async-generator"
    | "needs-approval"
    | "add-messages" = "default";

  /** Counts how many times the `echo` tool's `execute` actually runs. */
  private _echoExecuteCount = 0;

  private _midTurnInsideLoop: boolean | null = null;
  private _midTurnPersisted: boolean | null = null;
  private _useEchoAction = false;
  private _actionExecuteMode:
    | "default"
    | "throw"
    | "timeout"
    | "large-output"
    | "non-json-output"
    | "approval"
    | "permission"
    | "approval-permission"
    | "function-policy"
    | "ledger-key"
    | "ledger-throw"
    | "ledger-large-output"
    | "ledger-slow"
    | "ledger-symbol-output"
    | "ledger-approval"
    | "attach-ledger"
    | "attach-idempotency-key" = "default";
  private _actionExecutionCount = 0;
  private _actionIdempotencyKey: string | null = null;
  private _useAttachReplyAction = false;
  private _attachReplyScenario:
    | "two"
    | "none"
    | "invalid"
    | "non-json"
    | "overcap"
    | "approval-gated"
    | "predicate-noop"
    | "permission-noop"
    | "attach-then-throw" = "two";
  private _useDurablePauseAction = false;
  private _durablePauseApproval: boolean | "predicate-hello" | undefined =
    undefined;
  private _durablePauseIdempotencyKey: string | null = null;
  private _durablePauseExecCount = 0;
  private _durablePauseExecThrows = false;
  private _durablePauseAttachReply = false;
  private _actionDelayMs = 25;
  private _actionGrantedPermissions: string[] | null | undefined = undefined;
  private _denyActionReason: string | null = null;
  private _lastActionContext: {
    requestId: string;
    toolCallId: string;
    messageCount: number;
  } | null = null;

  async setEchoExecuteMode(
    mode:
      | "default"
      | "async-iterable"
      | "sync-iterable"
      | "async-generator"
      | "needs-approval"
      | "add-messages"
  ): Promise<void> {
    this._echoExecuteMode = mode;
  }

  /** How many times the `echo` tool's `execute` body actually ran. */
  async getEchoExecuteCount(): Promise<number> {
    return this._echoExecuteCount;
  }

  async useEchoActionForTest(
    mode:
      | "default"
      | "throw"
      | "timeout"
      | "large-output"
      | "non-json-output"
      | "approval"
      | "permission"
      | "approval-permission"
      | "function-policy"
      | "ledger-key"
      | "ledger-throw"
      | "ledger-large-output"
      | "ledger-slow"
      | "ledger-symbol-output"
      | "ledger-approval"
      | "attach-ledger"
      | "attach-idempotency-key" = "default"
  ): Promise<void> {
    this._useEchoAction = true;
    this._actionExecuteMode = mode;
  }

  async useAttachReplyActionForTest(
    scenario:
      | "two"
      | "none"
      | "invalid"
      | "non-json"
      | "overcap"
      | "approval-gated"
      | "predicate-noop"
      | "permission-noop"
      | "attach-then-throw" = "two"
  ): Promise<void> {
    this._useAttachReplyAction = true;
    this._attachReplyScenario = scenario;
  }

  async getResponseAttachmentsJson(): Promise<string> {
    const last = this._responseLog[this._responseLog.length - 1];
    return JSON.stringify(last?.attachments ?? null);
  }

  async getLastResponseRequestIdForTest(): Promise<string | null> {
    const last = this._responseLog[this._responseLog.length - 1];
    return last?.requestId ?? null;
  }

  async clearResponseLogForTest(): Promise<void> {
    this._responseLog.length = 0;
  }

  async mutateLastResponseAttachmentForTest(): Promise<void> {
    const attachment = this._responseLog.at(-1)?.attachments?.[0];
    if (attachment !== undefined) {
      (attachment as { type: string; mutated?: boolean }).type = "mutated";
      (attachment as { type: string; mutated?: boolean }).mutated = true;
    }
  }

  async replyAttachmentsJsonForTest(requestId?: string): Promise<string> {
    return JSON.stringify(this.replyAttachments(requestId));
  }

  async setActionIdempotencyKey(key: string | null): Promise<void> {
    this._actionIdempotencyKey = key;
  }

  async setActionDelayForTest(ms: number): Promise<void> {
    this._actionDelayMs = ms;
  }

  async setActionLedgerRetentionForTest(
    retention: Partial<{
      settledMs: number | false;
      pendingMs: number | false;
      maxSweepRows: number;
    }>
  ): Promise<void> {
    this.actionLedgerRetention = {
      ...this.actionLedgerRetention,
      ...retention
    };
  }

  async setActionLedgerPendingRetryLeaseForTest(
    ms: number | false
  ): Promise<void> {
    this.actionLedgerPendingRetryLeaseMs = ms;
  }

  async executeEchoActionToolForTest(message = "hello"): Promise<unknown> {
    const tools = await (
      this as unknown as { _compileActionTools: () => Promise<ToolSet> }
    )._compileActionTools();
    const echo = tools.echo as {
      execute?: (
        input: unknown,
        options: {
          toolCallId?: string;
          messages?: [];
          abortSignal?: AbortSignal;
        }
      ) => Promise<unknown>;
    };
    const result = await echo.execute?.(
      { message },
      { toolCallId: "tc-direct", messages: [] }
    );
    return typeof result === "symbol" ? { type: "symbol" } : result;
  }

  async executeEchoActionToolParallelForTest(): Promise<unknown[]> {
    return Promise.all([
      this.executeEchoActionToolForTest(),
      this.executeEchoActionToolForTest()
    ]);
  }

  async listActionLedgerRowsForTest(): Promise<
    Array<{
      key: string;
      action_name: string;
      input_hash: string;
      status: string;
      result_json: string | null;
      updated_at: number;
    }>
  > {
    (
      this as unknown as { _ensureActionLedgerTable: () => void }
    )._ensureActionLedgerTable();
    return this.sql<{
      key: string;
      action_name: string;
      input_hash: string;
      status: string;
      result_json: string | null;
      updated_at: number;
    }>`
      SELECT key, action_name, input_hash, status, result_json, updated_at
      FROM cf_think_action_ledger
      ORDER BY key ASC
    `;
  }

  async insertActionLedgerRowForTest(options: {
    key: string;
    actionName?: string;
    input?: unknown;
    status?: "pending" | "settled";
    output?: unknown;
    updatedAt?: number;
  }): Promise<void> {
    (
      this as unknown as { _ensureActionLedgerTable: () => void }
    )._ensureActionLedgerTable();
    const inputHash = (
      this as unknown as { _actionInputHash: (input: unknown) => string }
    )._actionInputHash(options.input ?? { message: "hello" });
    const output =
      options.status === "settled"
        ? JSON.stringify({
            valuePresent: options.output !== undefined,
            value: options.output
          })
        : null;
    const now = options.updatedAt ?? Date.now();
    this.sql`
      INSERT INTO cf_think_action_ledger (
        key, action_name, request_id, tool_call_id, input_hash, status,
        result_json, created_at, updated_at
      )
      VALUES (
        ${options.key}, ${options.actionName ?? "echo"}, ${null}, ${"tc-seeded"},
        ${inputHash}, ${options.status ?? "pending"}, ${output}, ${now}, ${now}
      )
    `;
  }

  async sweepActionLedgerForTest(): Promise<{
    settled: number;
    pending: number;
  }> {
    return (
      this as unknown as {
        _sweepActionLedger: (options: {
          force?: boolean;
        }) => Promise<{ settled: number; pending: number }>;
      }
    )._sweepActionLedger({ force: true });
  }

  // ── Durable-pause action test helpers ───────────────────────────

  async useDurablePauseActionForTest(options?: {
    approval?: boolean | "predicate-hello";
    idempotencyKey?: string;
    execThrows?: boolean;
    attachReply?: boolean;
  }): Promise<void> {
    this._useDurablePauseAction = true;
    this._durablePauseApproval = options?.approval;
    this._durablePauseIdempotencyKey = options?.idempotencyKey ?? null;
    this._durablePauseExecThrows = options?.execThrows ?? false;
    this._durablePauseAttachReply = options?.attachReply ?? false;
  }

  /** Drop the durable-pause action so a later approve can't re-derive it. */
  async removeDurablePauseActionForTest(): Promise<void> {
    this._useDurablePauseAction = false;
  }

  async getDurablePauseExecCount(): Promise<number> {
    return this._durablePauseExecCount;
  }

  /** Compile tools and directly invoke the durable-pause action to park it. */
  async parkDurablePauseForTest(
    message = "hello",
    toolCallId = `tc-pause-${crypto.randomUUID()}`
  ): Promise<unknown> {
    const tools = await (
      this as unknown as { _compileActionTools: () => Promise<ToolSet> }
    )._compileActionTools();
    const pauseTool = tools.pauseAction as {
      execute?: (
        input: unknown,
        options: {
          toolCallId?: string;
          messages?: [];
          abortSignal?: AbortSignal;
        }
      ) => Promise<unknown>;
    };
    return pauseTool.execute?.({ message }, { toolCallId, messages: [] });
  }

  async listActionPendingForTest(): Promise<
    Array<{
      execution_id: string;
      action_name: string;
      tool_call_id: string;
      input_json: string;
      descriptor_json: string | null;
    }>
  > {
    return (
      this as unknown as {
        _listActionPendingRows: () => Array<{
          execution_id: string;
          action_name: string;
          tool_call_id: string;
          input_json: string;
          descriptor_json: string | null;
        }>;
      }
    )._listActionPendingRows();
  }

  async approveExecutionForTest(executionId: string): Promise<unknown> {
    return this.approveExecution(executionId);
  }

  async rejectExecutionForTest(
    executionId: string,
    reason?: string
  ): Promise<unknown> {
    return this.rejectExecution(executionId, reason);
  }

  async approveExecutionTwiceForTest(executionId: string): Promise<unknown[]> {
    return Promise.all([
      this.approveExecution(executionId),
      this.approveExecution(executionId)
    ]);
  }

  /** Returns a JSON string (RPC can't serialize the `unknown`-typed input). */
  async pendingApprovalsForTest(executionId?: string): Promise<string> {
    return JSON.stringify(await this.pendingApprovals(executionId));
  }

  async sweepActionPendingApprovalsForTest(): Promise<{ swept: number }> {
    return (
      this as unknown as {
        _sweepActionPendingApprovals: (options: {
          force?: boolean;
        }) => Promise<{ swept: number }>;
      }
    )._sweepActionPendingApprovals({ force: true });
  }

  async setActionPendingApprovalTtlForTest(ttl: number | false): Promise<void> {
    (
      this as unknown as { actionPendingApprovalTtlMs: number | false }
    ).actionPendingApprovalTtlMs = ttl;
  }

  async backdateActionPendingForTest(
    executionId: string,
    createdAt: number
  ): Promise<void> {
    this.sql`
      UPDATE cf_think_action_pending_approvals
      SET created_at = ${createdAt}
      WHERE execution_id = ${executionId}
    `;
  }

  /** Derive a descriptor for a paused output (codemode-style) for unit tests. */
  async descriptorForPausedOutputForTest(
    requestId: string,
    toolCallId: string,
    output: unknown
  ): Promise<unknown> {
    return (
      this as unknown as {
        _descriptorForPausedOutput: (
          requestId: string,
          toolCallId: string,
          output: unknown
        ) => unknown;
      }
    )._descriptorForPausedOutput(requestId, toolCallId, output);
  }

  /** Override describePausedExecution to enrich codemode descriptors. */
  async setDescribePausedExecutionForTest(
    override: {
      summary?: string;
      permissions?: string[];
      risk?: "low" | "medium" | "high";
    } | null
  ): Promise<void> {
    if (override === null) {
      (
        this as unknown as { describePausedExecution: unknown }
      ).describePausedExecution = () => undefined;
      return;
    }
    (
      this as unknown as { describePausedExecution: unknown }
    ).describePausedExecution = () => override;
  }

  async setActionGrantedPermissions(
    permissions: string[] | null | undefined
  ): Promise<void> {
    this._actionGrantedPermissions = permissions;
  }

  async setDenyActionReason(reason: string | null): Promise<void> {
    this._denyActionReason = reason;
  }

  async getActionProbe(): Promise<{
    count: number;
    context: {
      requestId: string;
      toolCallId: string;
      messageCount: number;
    } | null;
  }> {
    return {
      count: this._actionExecutionCount,
      context: this._lastActionContext
    };
  }

  async getMidTurnAddProbe(): Promise<{
    insideLoop: boolean | null;
    persisted: boolean | null;
  }> {
    return {
      insideLoop: this._midTurnInsideLoop,
      persisted: this._midTurnPersisted
    };
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

  override authorizeTurn(): ActionAuthorizationDecision {
    if (this._actionGrantedPermissions === undefined) return true;
    return {
      allowed: true,
      ...(this._actionGrantedPermissions !== null && {
        grantedPermissions: this._actionGrantedPermissions
      })
    };
  }

  override authorizeAction(
    ctx: ActionAuthorizationContext
  ): ActionAuthorizationDecision | Promise<ActionAuthorizationDecision> {
    if (this._denyActionReason !== null) {
      return { allowed: false, reason: this._denyActionReason };
    }
    return super.authorizeAction(ctx);
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

  // Records every `tool-result` stream part the AI SDK emits, including the
  // `preliminary: true` ones a streaming tool produces. Lets streaming tests
  // assert that preliminary chunks survive `beforeToolCall` wrapping.
  private _toolResultChunkLog: Array<{
    outputJson: string;
    preliminary: boolean;
  }> = [];

  override onChunk(ctx: ChunkContext): void {
    if (ctx.chunk.type === "tool-result") {
      const chunk = ctx.chunk as { output: unknown; preliminary?: boolean };
      this._toolResultChunkLog.push({
        outputJson: JSON.stringify(chunk.output),
        preliminary: chunk.preliminary === true
      });
    }
  }

  async getToolResultChunkLog(): Promise<
    Array<{ outputJson: string; preliminary: boolean }>
  > {
    return this._toolResultChunkLog;
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

  // ── Recovery-simulation helpers (for action-pause × recovery) ─────

  async persistTestMessage(msg: UIMessage): Promise<void> {
    await this.session.appendMessage(msg);
  }

  async hasPendingInteractionForTest(): Promise<boolean> {
    return this.hasPendingInteraction();
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

  async getScheduledChatRecoveryCountForTest(
    callback = "_chatRecoveryContinue"
  ): Promise<number> {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_schedules WHERE callback = ${callback}
    `;
    return rows[0]?.count ?? 0;
  }

  async runScheduledRecoveryRetryForTest(): Promise<void> {
    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM cf_agents_schedules
      WHERE callback = '_chatRecoveryRetry'
      ORDER BY time ASC
      LIMIT 1
    `;
    if (!rows[0]) return;
    await (
      this as unknown as {
        _chatRecoveryRetry(d: {
          targetUserId?: string;
          lastBody?: Record<string, unknown>;
        }): Promise<void>;
      }
    )._chatRecoveryRetry(
      JSON.parse(rows[0].payload) as {
        targetUserId?: string;
        lastBody?: Record<string, unknown>;
      }
    );
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

  async runScheduledRecoveryContinueForTest(): Promise<void> {
    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM cf_agents_schedules
      WHERE callback = '_chatRecoveryContinue'
      ORDER BY time ASC
      LIMIT 1
    `;
    if (!rows[0]) return;
    await (
      this as unknown as {
        _chatRecoveryContinue(d: {
          targetAssistantId?: string;
          lastBody?: Record<string, unknown> | null;
          lastClientTools?: ClientToolSchema[] | null;
        }): Promise<void>;
      }
    )._chatRecoveryContinue(
      JSON.parse(rows[0].payload) as {
        targetAssistantId?: string;
        lastBody?: Record<string, unknown> | null;
        lastClientTools?: ClientToolSchema[] | null;
      }
    );
  }

  async getActiveFibers(): Promise<Array<{ id: string; name: string }>> {
    return this.sql<{ id: string; name: string }>`
      SELECT id, name FROM cf_agents_runs
    `;
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
  private _finalAnswerResponse: unknown = undefined;
  private _nestedAdmissionMode:
    | "wait"
    | "continuation"
    | "stream"
    | "submit"
    | "addMessages"
    | "detachedNotify"
    | null = null;
  private _nestedAdmissionAttempted = false;
  private _nestedAdmissionSucceeded = false;
  private _nestedAdmissionError: string | null = null;
  private _inBandErrorResponse: {
    errorText: string;
    textChunks: string[];
  } | null = null;
  private _failNextContinueTransient: string | null = null;

  /**
   * Arm a ONE-SHOT platform-transient fault on the next `continueLastTurn`
   * (#1730): the next recovered continuation throws the production `SqlError`
   * shape (`SQL query failed: <message>` with the bare platform error as
   * `cause`, no `retryable` flag on the wrapper), then the fault clears so the
   * deferred re-run succeeds.
   */
  async failNextRecoveredContinueForTest(message: string): Promise<void> {
    this._failNextContinueTransient = message;
  }

  protected override async continueLastTurn(
    body?: Record<string, unknown>,
    options?: SaveMessagesOptions
  ): Promise<SaveMessagesResult> {
    if (this._failNextContinueTransient) {
      const message = this._failNextContinueTransient;
      this._failNextContinueTransient = null;
      throw new Error(`SQL query failed: ${message}`, {
        cause: new Error(message)
      });
    }
    return super.continueLastTurn(body, options);
  }

  override getModel(): LanguageModel {
    if (this._inBandErrorResponse) {
      return createInBandErrorMockModel(
        this._inBandErrorResponse.errorText,
        this._inBandErrorResponse.textChunks
      );
    }
    if (this._finalAnswerResponse !== undefined) {
      return createFinalAnswerMockModel(this._finalAnswerResponse);
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

  override async beforeTurn(ctx: TurnContext): Promise<void> {
    if (this._throwBeforeTurnError) {
      throw new Error(this._throwBeforeTurnError);
    }
    this._capturedTurnContexts.push({
      continuation: ctx.continuation,
      body: ctx.body as RpcJsonObject | undefined
    });
    if (this._nestedAdmissionMode && !this._nestedAdmissionAttempted) {
      this._nestedAdmissionAttempted = true;
      try {
        await this._runNestedAdmissionForTest(this._nestedAdmissionMode);
        this._nestedAdmissionSucceeded = true;
      } catch (error) {
        this._nestedAdmissionError =
          error instanceof Error ? error.message : String(error);
      }
    }
  }

  private async _runNestedAdmissionForTest(
    mode: Exclude<typeof this._nestedAdmissionMode, null>
  ): Promise<void> {
    const msg = {
      id: crypto.randomUUID(),
      role: "user" as const,
      parts: [{ type: "text" as const, text: `nested ${mode}` }]
    };
    switch (mode) {
      case "wait":
        await this.runTurn({ mode: "wait", input: msg });
        return;
      case "continuation":
        await this.runTurn({ mode: "wait", continuation: true });
        return;
      case "stream":
        await this.runTurn({
          mode: "stream",
          input: msg,
          callback: new TestCollectingCallback()
        });
        return;
      case "submit":
        await this.runTurn({ mode: "submit", input: msg });
        return;
      case "addMessages":
        await this.addMessages([msg]);
        return;
      case "detachedNotify":
        await this.notifyDetachedFinishForTest({
          runId: "nested-detached-notify",
          notifySource: "nested-detached-source"
        });
        return;
    }
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

  async notifyDetachedFinishForTest(options?: {
    runId?: string;
    notifySource?: string;
  }): Promise<void> {
    const runId = options?.runId ?? "detached-notify-run";
    await this._cfDetachedNotifyFinish(
      {
        runId,
        agentType: "Researcher",
        status: "completed",
        inputPreview: "detached topic",
        displayOrder: 0,
        startedAt: Date.now(),
        ...(options?.notifySource !== undefined && {
          notifySource: options.notifySource
        })
      },
      {
        status: "completed",
        summary: "detached summary"
      }
    );
  }

  /**
   * Drive `_deliverDetachedMilestone` (the `detached: { onMilestones }`
   * convenience) directly. Called twice with the same milestone to prove the
   * idempotency key collapses warm-path + reconcile delivery to a single
   * synthetic turn (rfc-detached-agent-tools §progress, 4b).
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
    const mode = options?.mode ?? "react";
    const internals = this as unknown as {
      _deliverDetachedMilestone: (
        run: AgentToolRunInfo,
        milestone: {
          name: string;
          sequence: number;
          at: number;
          data?: unknown;
        },
        mode: "react" | "narrate"
      ) => Promise<void>;
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

  /**
   * Prove that a serialized detached delivery (the fast-path / backbone case)
   * runs strictly BETWEEN turns: while a turn is occupying the queue, a
   * `_runDetachedDelivery(_, { serialize: true })` must wait for it rather than
   * interleave its state-mutating callback with the active turn (#1752 fix #2).
   */
  async serializedDetachedDeliveryOrderingForTest(): Promise<string[]> {
    const order: string[] = [];
    const internals = this as unknown as {
      _turnQueue: {
        enqueue: (id: string, fn: () => Promise<void>) => Promise<void>;
      };
      _runDetachedDelivery: (
        invoke: () => Promise<void>,
        options?: { serialize?: boolean }
      ) => Promise<void>;
    };

    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });

    // Occupy the turn queue with a still-running "turn".
    const turnPromise = internals._turnQueue.enqueue(
      "test-active-turn",
      async () => {
        await turnGate;
        order.push("turn");
      }
    );

    // A serialized delivery dispatched while the turn is active must queue
    // behind it, not run concurrently.
    const deliveryPromise = internals._runDetachedDelivery(
      async () => {
        order.push("delivery");
      },
      { serialize: true }
    );

    // Let the delivery (incorrectly) run first if it were NOT serialized.
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseTurn();
    await Promise.all([turnPromise, deliveryPromise]);
    return order;
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

  // Make the next turn(s) terminate by calling the structured-output
  // `think_final_answer` tool with `args` as its arguments (issue #1685).
  async setFinalAnswerResponseForTest(args: unknown): Promise<void> {
    this._finalAnswerResponse = args;
  }

  // Drive the assistant-message persistence chokepoint directly. Used to
  // simulate the recovery re-persist path (which runs outside an active turn)
  // and assert the internal `think_final_answer` tool is stripped statelessly.
  async persistAssistantMessageForTest(msg: UIMessage): Promise<void> {
    await (
      this as unknown as {
        _persistAssistantMessage: (m: UIMessage) => Promise<void>;
      }
    )._persistAssistantMessage(msg);
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

  async testSaveMessagesEmptyFunction(): Promise<SaveMessagesResult> {
    return this.saveMessages(() => []);
  }

  async runNestedAdmissionScenario(
    mode: Exclude<typeof this._nestedAdmissionMode, null>
  ): Promise<{
    attempted: boolean;
    succeeded: boolean;
    error: string | null;
  }> {
    this._nestedAdmissionMode = mode;
    this._nestedAdmissionAttempted = false;
    this._nestedAdmissionSucceeded = false;
    this._nestedAdmissionError = null;
    await this.testChat(`outer ${mode}`);
    this._nestedAdmissionMode = null;
    return {
      attempted: this._nestedAdmissionAttempted,
      succeeded: this._nestedAdmissionSucceeded,
      error: this._nestedAdmissionError
    };
  }

  async testRunTurnWait(options: RunTurnWait): Promise<TurnResult> {
    return this.runTurn(options);
  }

  async testRunTurnWaitString(text: string): Promise<TurnResult> {
    return this.runTurn({ mode: "wait", input: text });
  }

  async testRunTurnWaitWithFn(text: string): Promise<TurnResult> {
    return this.runTurn({
      mode: "wait",
      input: (current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "user" as const,
          parts: [{ type: "text" as const, text }]
        }
      ]
    });
  }

  async testRunTurnContinuation(
    body?: Record<string, unknown>
  ): Promise<TurnResult> {
    return this.runTurn({ mode: "wait", continuation: true, body });
  }

  async testRunTurnSubmit(
    text: string,
    options?: {
      submissionId?: string;
      idempotencyKey?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<SubmitMessagesResult> {
    return this.runTurn({ mode: "submit", input: text, ...options });
  }

  async testRunTurnStream(text: string): Promise<TestChatResult> {
    const callback = new TestCollectingCallback();
    await this.runTurn({ mode: "stream", input: text, callback });
    return {
      events: callback.events,
      done: callback.doneCalled,
      error: callback.errorMessage,
      requestId: callback.requestId,
      interruptedCalls: callback.interruptedCalls
    };
  }

  async testRunTurnStreamArray(
    messages: UIMessage[],
    channel?: string
  ): Promise<TestChatResult> {
    const callback = new TestCollectingCallback();
    await this.runTurn({ mode: "stream", input: messages, callback, channel });
    return {
      events: callback.events,
      done: callback.doneCalled,
      error: callback.errorMessage,
      requestId: callback.requestId,
      interruptedCalls: callback.interruptedCalls
    };
  }

  async testRunTurnStreamWithFn(text: string): Promise<TestChatResult> {
    const callback = new TestCollectingCallback();
    await this.runTurn({
      mode: "stream",
      input: (current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "user" as const,
          parts: [{ type: "text" as const, text }]
        }
      ],
      callback
    });
    return {
      events: callback.events,
      done: callback.doneCalled,
      error: callback.errorMessage,
      requestId: callback.requestId,
      interruptedCalls: callback.interruptedCalls
    };
  }

  async testRunTurnStreamEmpty(
    input: "" | UIMessage[] | ((current: UIMessage[]) => UIMessage[])
  ): Promise<TestChatResult> {
    const callback = new TestCollectingCallback();
    await this.runTurn({ mode: "stream", input, callback });
    return {
      events: callback.events,
      done: callback.doneCalled,
      error: callback.errorMessage,
      requestId: callback.requestId,
      interruptedCalls: callback.interruptedCalls
    };
  }

  async testRunTurnExpectError(
    options: RunTurnOptions | Record<string, unknown>
  ): Promise<{ name: string; message: string } | null> {
    try {
      const runTurnImpl = this.runTurn.bind(this) as (
        options: RunTurnOptions
      ) => Promise<TurnResult | SubmitMessagesResult | void>;
      await runTurnImpl(options as RunTurnOptions);
      return null;
    } catch (error) {
      return {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testRunTurnSubmitWithFunction(): Promise<{
    name: string;
    message: string;
  } | null> {
    return this.testRunTurnExpectError({
      mode: "submit",
      input: () => []
    });
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

  private async _waitForSubmissionForTest(
    submissionId: string,
    predicate: (submission: ThinkSubmissionInspection) => boolean
  ): Promise<ThinkSubmissionInspection> {
    for (let attempt = 0; attempt < 80; attempt++) {
      const submission = await this.inspectSubmission(submissionId);
      if (submission && predicate(submission)) return submission;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const submission = await this.inspectSubmission(submissionId);
    if (!submission) {
      throw new Error(`Submission ${submissionId} was not found`);
    }
    return submission;
  }

  async cancelQueuedRunningSubmissionBeforeSlotForTest(options?: {
    submissionId?: string;
    metadata?: Record<string, unknown>;
    messageTexts?: string[];
  }): Promise<{
    submission: ThinkSubmissionInspection | null;
    messages: UIMessage[];
    responses: ChatResponseResult[];
    submissionLog: ThinkSubmissionInspection[];
    workflowEvents: Array<{
      workflowName: string;
      workflowId: string;
      event: { type: string; payload?: unknown };
    }>;
  }> {
    const previousDelayedChunks = this._delayedChunks;
    this._delayedChunks = {
      chunks: ["active ", "turn ", "still ", "running"],
      delayMs: 50
    };

    const activeCallback = new TestCollectingCallback();
    const activeTurn = this.chat("active turn", activeCallback);
    try {
      let activeTurnStarted = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        const activeUserMessage = (await this.getMessages()).find(
          (message) =>
            message.role === "user" &&
            message.parts.some(
              (part) => part.type === "text" && part.text === "active turn"
            )
        );
        if (activeUserMessage) {
          activeTurnStarted = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!activeTurnStarted) {
        throw new Error("Active turn did not start before queued submission");
      }

      const submissionId = options?.submissionId ?? "sub-queued-running-cancel";
      const messageTexts = options?.messageTexts ?? ["queued then cancelled"];
      await this.submitMessages(
        messageTexts.map((text, index) => ({
          id: `${submissionId}-message-${index}`,
          role: "user" as const,
          parts: [{ type: "text" as const, text }]
        })),
        {
          submissionId,
          metadata: options?.metadata
        }
      );

      await this._waitForSubmissionForTest(
        submissionId,
        (submission) => submission.status === "running"
      );
      await this.cancelSubmission(submissionId, "cancelled before queue slot");

      await activeTurn;
      await (
        this as unknown as {
          _turnQueue: { waitForIdle: () => Promise<void> };
        }
      )._turnQueue.waitForIdle();
      await this.drainWorkflowNotificationsForTest();

      return {
        submission: await this.inspectSubmission(submissionId),
        messages: await this.getMessages(),
        responses: this._responseLog,
        submissionLog: this._submissionLog,
        workflowEvents: this._workflowEventLog
      };
    } finally {
      this._delayedChunks = previousDelayedChunks;
      await activeTurn.catch(() => {});
    }
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

  /**
   * Like `continueRecoveredChatForTest` but catches in-DO and returns the
   * thrown message (or `null` when nothing threw) — a rejection crossing the
   * RPC boundary is also reported by workerd as an unhandled rejection, which
   * pollutes test output even when the caller expects it.
   */
  async continueRecoveredChatCatchingForTest(
    requestId: string
  ): Promise<string | null> {
    try {
      await this._chatRecoveryContinue({ recoveredRequestId: requestId });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
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
    return tasks;
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

  // ── #1703: alarm() must not arm a keepAlive heartbeat when there are
  // no pending workflow notifications, otherwise the DO fires every 30s
  // forever and never hibernates.
  async getKeepAliveRefsForTest(): Promise<number> {
    return (this as unknown as { _keepAliveRefs: number })._keepAliveRefs;
  }

  async runAlarmForTest(): Promise<{
    keepAliveRefs: number;
    scheduledAlarm: number | null;
  }> {
    await this.alarm();
    return {
      keepAliveRefs: (this as unknown as { _keepAliveRefs: number })
        ._keepAliveRefs,
      scheduledAlarm: await this.ctx.storage.getAlarm()
    };
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
  // recovery × channels: capture the channel context + assembled system prompt
  // that each turn (including recovered ones) actually ran with, so a test can
  // assert per-channel policy is re-applied on recovery, not just that the
  // `metadata.channel` stamp survives.
  private _capturedTurnChannels: string[] = [];
  private _capturedTurnSystems: string[] = [];

  // A single per-channel policy (voice) so recovery tests can assert that a
  // recovered turn re-resolves the channel from the persisted user message and
  // re-applies BOTH its instructions and its tool policy. The channel
  // contributes a `voiceMarker` tool — present on a recovered voice turn,
  // absent on a recovered default-channel turn — so a test can prove the
  // channel `tools` callback is re-invoked across recovery (not just the
  // instruction string). (Tool *removal* is covered for non-recovery turns in
  // channel-policy.test.ts.)
  override configureChannels() {
    return {
      voice: {
        kind: "voice" as const,
        ingress: { transport: "voice" as const },
        instructions: "VOICE MODE",
        tools: () => ({
          voiceMarker: tool({
            description: "voice-only marker tool",
            inputSchema: z.object({}),
            execute: async () => "ok"
          })
        }),
        maxTurns: 3
      }
    };
  }

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
    this._capturedTurnChannels.push(this.activeChannel?.channelId ?? "");
    this._capturedTurnSystems.push(ctx.system);

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

  /** The active channel id captured at each turn's `beforeTurn` (""=none). */
  async getCapturedTurnChannelsForTest(): Promise<string[]> {
    return this._capturedTurnChannels;
  }

  /** The assembled system prompt captured at each turn's `beforeTurn`. */
  async getCapturedTurnSystemsForTest(): Promise<string[]> {
    return this._capturedTurnSystems;
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

  /** The durable terminal record (#1645) the resume handshake replays. A
   *  failed turn persists this so a client that reconnects after the turn ended
   *  is surfaced the outcome (delivery itself is over the resume handshake). */
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
   * - A non-transient (application) throw must terminalize (fire `onExhausted`
   *   + broadcast the terminal banner, seal the incident `exhausted`) and NOT
   *   re-throw — so `Agent._executeScheduleCallback` doesn't swallow it and
   *   delete the one-shot row with no terminal UX.
   * - A PLATFORM TRANSIENT (deploy code-update reset / script supersede,
   *   "Network connection lost.", a `retryable`-flagged error — bare or
   *   wrapped like `SqlError`) must re-throw (so the platform re-runs recovery
   *   once healthy) and NOT terminalize (#1730). The recovered submission must
   *   stay `running` so the deferred re-run picks it up instead of skipping
   *   with `submission_not_running`.
   *
   * `errorShape` controls how `errorMessage` is thrown:
   *   - "plain" (default): `new Error(errorMessage)`
   *   - "sql-wrapped": the `SqlError` shape — message prefixed with
   *     "SQL query failed: ", original error only in `cause`, no flag
   *   - "retryable": `retryable: true` set on the error object
   *
   * `seedRunningSubmission` inserts a `running` durable submission keyed by
   * the incident's requestId and passes it as `recoveredRequestId`, so tests
   * can assert what the handler does to it on each branch.
   */
  async testRecoveryCallbackError(input: {
    errorMessage: string;
    errorShape?: "plain" | "sql-wrapped" | "retryable";
    seedRunningSubmission?: boolean;
    maxAttempts?: number;
    terminalMessage?: string;
  }): Promise<{
    threw: boolean;
    exhaustedContexts: number;
    exhaustedReason: string | undefined;
    terminalBroadcast: string | undefined;
    incidentStatus: string | undefined;
    submissionStatus: string | null;
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

    if (input.seedRunningSubmission) {
      (
        this as unknown as { _ensureSubmissionTable: () => void }
      )._ensureSubmissionTable();
      const now = Date.now();
      this.sql`
        INSERT INTO cf_think_submissions (
          submission_id, idempotency_key, request_id, stream_id, status,
          messages_json, metadata_json, error_message, created_at,
          messages_applied_at, started_at, completed_at
        )
        VALUES (
          ${requestId}, NULL, ${requestId}, NULL, 'running',
          ${JSON.stringify([])}, NULL, NULL, ${now}, ${now}, ${now}, NULL
        )
      `;
    }

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

    const error =
      input.errorShape === "sql-wrapped"
        ? new Error(`SQL query failed: ${input.errorMessage}`, {
            cause: new Error(input.errorMessage)
          })
        : new Error(input.errorMessage);
    if (input.errorShape === "retryable") {
      (error as unknown as { retryable: boolean }).retryable = true;
    }

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
        {
          incidentId: begun.incidentId,
          originalRequestId: requestId,
          ...(input.seedRunningSubmission
            ? { recoveredRequestId: requestId }
            : {})
        },
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
    const submissionRows = input.seedRunningSubmission
      ? this.sql<{ status: string }>`
          SELECT status FROM cf_think_submissions
          WHERE request_id = ${requestId}
          LIMIT 1
        `
      : [];
    return {
      threw,
      exhaustedContexts: captured.length,
      exhaustedReason: captured[0]?.reason,
      terminalBroadcast,
      incidentStatus: [...incidents.values()][0]?.status,
      submissionStatus: submissionRows[0]?.status ?? null
    };
  }

  /**
   * #1730 layer 3: drive the give-up path while the durable terminal write
   * (`_recordTerminalChatStatus`) rejects with a platform transient — the
   * exact window a give-up tends to run in. The FIRST give-up must re-throw
   * (so the one-shot row is preserved) and must NOT seal the incident
   * `exhausted` (a half-seal would make the deferred re-run a no-op and drop
   * the durable terminal record). The SECOND give-up (the deferred re-run on
   * a healthy isolate) must terminalize fully: banner + sealed incident.
   */
  async testGiveUpSealTransientDefer(input: {
    transientMessage: string;
    terminalMessage?: string;
  }): Promise<{
    firstThrew: boolean;
    incidentStatusAfterFirst: string | undefined;
    secondThrew: boolean;
    incidentStatusAfterSecond: string | undefined;
    terminalBroadcast: string | undefined;
    exhaustedReasons: string[];
  }> {
    const terminalMessage =
      input.terminalMessage ?? "Conversation interrupted.";
    const captured: ChatRecoveryExhaustedContext[] = [];
    this.chatRecovery = {
      maxAttempts: 5,
      terminalMessage,
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
      _broadcastChat(m: {
        body?: string;
        error?: boolean;
        done?: boolean;
      }): void;
      _recordTerminalChatStatus(
        status: string,
        requestId: string,
        body: string
      ): Promise<void>;
      _handleRecoveryCallbackError(
        callback: string,
        data: unknown,
        error: unknown
      ): Promise<void>;
    };
    const realBroadcast = self._broadcastChat.bind(this);
    self._broadcastChat = (m) => {
      if (m.error && m.done) terminalBroadcast = m.body;
      realBroadcast(m);
    };
    const realRecordTerminal = self._recordTerminalChatStatus.bind(this);
    let failTerminalWriteOnce = true;
    self._recordTerminalChatStatus = async (status, reqId, body) => {
      if (failTerminalWriteOnce) {
        failTerminalWriteOnce = false;
        throw new Error(`SQL query failed: ${input.transientMessage}`, {
          cause: new Error(input.transientMessage)
        });
      }
      await realRecordTerminal(status, reqId, body);
    };

    const data = { incidentId: begun.incidentId, originalRequestId: requestId };
    const appError = new Error("model rejected the continuation");

    const readIncidentStatus = async (): Promise<string | undefined> => {
      const incidents = await this.ctx.storage.list<{ status: string }>({
        prefix: "cf:chat-recovery:incident:"
      });
      return [...incidents.values()][0]?.status;
    };

    let firstThrew = false;
    try {
      await self._handleRecoveryCallbackError(
        "_chatRecoveryContinue",
        data,
        appError
      );
    } catch {
      firstThrew = true;
    }
    const incidentStatusAfterFirst = await readIncidentStatus();

    let secondThrew = false;
    try {
      await self._handleRecoveryCallbackError(
        "_chatRecoveryContinue",
        data,
        appError
      );
    } catch {
      secondThrew = true;
    } finally {
      self._broadcastChat = realBroadcast;
      self._recordTerminalChatStatus = realRecordTerminal;
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

    // Use ResumableStream.getStreamChunks so packed segment rows are unpacked
    // into individual chunk bodies (matching production replay/reconstruction).
    const chunks = (
      this as unknown as {
        _resumableStream: {
          getStreamChunks(id: string): Array<{ body: string }>;
        };
      }
    )._resumableStream.getStreamChunks(stream.id);

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

  /** Drive a programmatic turn via the unified `runTurn` (wait mode) API. */
  async testRunTurnWait(
    text: string,
    options?: { channel?: string }
  ): Promise<{ status: string; continuation: boolean }> {
    const result = await this.runTurn({
      input: text,
      ...(options?.channel !== undefined && { channel: options.channel })
    });
    return { status: result.status, continuation: result.continuation };
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

  /** Insert a stream-metadata row aged `ageMs` in the past (for cleanup tests). */
  async insertAgedStreamForTest(
    streamId: string,
    requestId: string,
    status: "streaming" | "completed" | "error",
    ageMs: number
  ): Promise<void> {
    const createdAt = Date.now() - ageMs;
    const completedAt = status === "streaming" ? null : createdAt + 1000;
    this.sql`
      INSERT INTO cf_ai_chat_stream_metadata (id, request_id, status, created_at, completed_at)
      VALUES (${streamId}, ${requestId}, ${status}, ${createdAt}, ${completedAt})
    `;
  }

  /** Status of a single stream-metadata row, or null if absent. */
  async getStreamStatusForTest(streamId: string): Promise<string | null> {
    const rows = this.sql<{ status: string }>`
      SELECT status FROM cf_ai_chat_stream_metadata WHERE id = ${streamId}
    `;
    return rows[0]?.status ?? null;
  }

  /** Append a chunk to a stream dated `ageMs` in the past (last-activity sweep). */
  async insertStreamChunkForTest(
    streamId: string,
    ageMs: number
  ): Promise<void> {
    (
      this as unknown as {
        _resumableStream: {
          insertChunkAt(id: string, body: string, ageMs: number): void;
        };
      }
    )._resumableStream.insertChunkAt(streamId, '{"type":"text"}', ageMs);
  }

  /** Start a stream via the cleanup-arming wrapper (without ever finishing it). */
  async startStreamForTest(requestId: string): Promise<string> {
    return (
      this as unknown as {
        _startResumableStream(requestId: string): string;
      }
    )._startResumableStream(requestId);
  }

  /** Invoke the alarm-driven cleanup callback directly. */
  async runStreamCleanupForTest(): Promise<void> {
    await (
      this as unknown as { _cleanupStreamBuffers(): Promise<void> }
    )._cleanupStreamBuffers();
  }

  /** Finish a stream via the cleanup-arming wrapper (mirrors a real turn end). */
  async completeStreamForTest(streamId: string): Promise<void> {
    (
      this as unknown as { _completeResumableStream(id: string): void }
    )._completeResumableStream(streamId);
  }

  /** Arm the cleanup alarm without finishing a stream (leaves no new buffer). */
  async armStreamCleanupForTest(): Promise<void> {
    await (
      this as unknown as { _ensureStreamCleanupScheduled(): Promise<void> }
    )._ensureStreamCleanupScheduled();
  }

  /**
   * The delay (seconds) of the pending cleanup schedule, or null if none.
   * Locks the arming interval (STREAM_CLEANUP_DELAY_SECONDS) so a regression
   * that lengthens it back toward the old 24h leak window is caught.
   */
  async streamCleanupScheduleDelaySecondsForTest(): Promise<number | null> {
    const rows = this.sql<{ delayInSeconds: number | null }>`
      SELECT delayInSeconds
      FROM cf_agents_schedules
      WHERE callback = '_cleanupStreamBuffers'
      LIMIT 1
    `;
    return rows[0]?.delayInSeconds ?? null;
  }

  /**
   * Backdate any pending cleanup schedule so it is due, then run the REAL
   * `alarm()` handler. This exercises the production path where `alarm()`
   * deletes the fired one-shot row after the callback returns — so a re-arm
   * must create a fresh row to survive (the idempotent-reschedule footgun).
   */
  async fireDueCleanupAlarmForTest(): Promise<void> {
    this.sql`
      UPDATE cf_agents_schedules
      SET time = ${Math.floor(Date.now() / 1000) - 1}
      WHERE callback = '_cleanupStreamBuffers'
    `;
    await this.alarm();
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

  /**
   * Seed an in-flight (not-yet-completed) `cf_agent_tool_child_runs` row, as if
   * this facet were running as an agent-tool child whose turn was interrupted
   * before completing. Used to assert the recovery continuation re-binds the
   * row's `request_id` so the parent's re-attach tail keeps attributing frames.
   */
  async seedAgentToolChildRunForTest(
    runId: string,
    requestId: string,
    startedAt: number = Date.now()
  ): Promise<void> {
    (
      this as unknown as { _ensureAgentToolChildRunTable(): void }
    )._ensureAgentToolChildRunTable();
    this.sql`
      INSERT INTO cf_agent_tool_child_runs (run_id, request_id, status, started_at)
      VALUES (${runId}, ${requestId}, 'running', ${startedAt})
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
    (
      this as unknown as { _ensureAgentToolChildRunTable(): void }
    )._ensureAgentToolChildRunTable();
    const now = Date.now();
    this.sql`
      INSERT INTO cf_agent_tool_child_runs
        (run_id, request_id, status, started_at, completed_at)
      VALUES (${runId}, ${requestId}, 'completed', ${now}, ${now})
    `;
  }

  /** Directly invoke the rebind helper (bypassing the full recovery flow). */
  async rebindAgentToolChildRunRequestIdForTest(
    requestId: string
  ): Promise<void> {
    (
      this as unknown as {
        _rebindAgentToolChildRunRequestId(requestId: string): void;
      }
    )._rebindAgentToolChildRunRequestId(requestId);
  }

  /** Whether this facet has a `cf_agent_tool_child_runs` table at all. */
  async hasAgentToolChildRunTableForTest(): Promise<boolean> {
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type = 'table' AND name = 'cf_agent_tool_child_runs'
    `;
    return (rows[0]?.n ?? 0) > 0;
  }

  /** The `request_id` currently bound to an agent-tool child run row. */
  async getAgentToolChildRunRequestIdForTest(
    runId: string
  ): Promise<string | null> {
    const rows = this.sql<{ request_id: string | null }>`
      SELECT request_id FROM cf_agent_tool_child_runs WHERE run_id = ${runId}
    `;
    return rows[0]?.request_id ?? null;
  }

  /** Resolve which agent-tool run a request id is attributed to (frame routing). */
  async resolveAgentToolRunForRequestForTest(
    requestId: string
  ): Promise<string | null> {
    return (
      this as unknown as {
        _agentToolRunForRequest(requestId: string): string | null;
      }
    )._agentToolRunForRequest(requestId);
  }

  /**
   * Seed the in-flight `_streamingAssistant` accumulator with `parts` (or clear
   * it with `null`), simulating a mid-stream turn whose partial hasn't been
   * persisted to `this.messages` yet — e.g. a parallel tool batch where a
   * client-tool `input-available` part has streamed but the end-of-stream
   * persist hasn't run. Lets tests exercise `hasPendingInteraction`'s
   * accumulator scan in isolation.
   */
  async setStreamingAssistantForTest(
    parts: UIMessage["parts"] | null
  ): Promise<void> {
    (
      this as unknown as { _streamingAssistant: StreamAccumulator | null }
    )._streamingAssistant =
      parts === null
        ? null
        : new StreamAccumulator({
            messageId: "streaming-assistant",
            existingParts: parts
          });
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

// ── onStart degradation agents (#1710) ──────────────────────────
// Verify that data-driven failures inside Think's internal onStart steps
// degrade (recorded + skipped) instead of throwing. A throw out of onStart
// is terminal: partyserver resets init state and rethrows on every wake, so
// an alarm-driven wake would retry the failing onStart forever and the DO
// would be permanently bricked.

export type OnStartDegradationForTest = { step: string; error: string };

/** getScheduledTasks() throws → step 9 (declared-task reconcile) fails. */
export class ThinkOnStartReconcileFailureAgent extends Think {
  override getModel(): LanguageModel {
    return createMockModel("reconcile-failure agent response");
  }

  override getScheduledTasks(): ThinkScheduledTasks {
    throw new Error("simulated getScheduledTasks failure");
  }

  async getOnStartDegradationsForTest(): Promise<OnStartDegradationForTest[]> {
    return this._onStartDegradations.map((d) => ({
      step: d.step,
      error: String(d.error)
    }));
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

/**
 * The first session.getHistory() call — onStart transcript hydration —
 * throws, simulating SQLITE_NOMEM on an oversized transcript. Subsequent
 * reads succeed, matching "allocator pressure at boot, normal afterwards".
 */
export class ThinkOnStartHydrationFailureAgent extends Think {
  private _hydrationReadsFailed = 0;

  override configureSession(session: Session): Session {
    // onStart hydration reads through `getRecentHistory` (budgeted) with
    // `getHistory` as the unbudgeted fallback — fail the FIRST read on
    // either path, then behave normally.
    let failedOnce = false;
    const failFirstRead = () => {
      if (failedOnce) return;
      failedOnce = true;
      this._hydrationReadsFailed++;
      throw new Error("SQL query failed: out of memory: SQLITE_NOMEM");
    };
    const originalHistory = session.getHistory.bind(session);
    session.getHistory = async (leafId?: string | null) => {
      failFirstRead();
      return originalHistory(leafId);
    };
    const originalRecent = session.getRecentHistory.bind(session);
    session.getRecentHistory = async (
      maxContentBytes: number,
      minRecentMessages?: number
    ) => {
      failFirstRead();
      return originalRecent(maxContentBytes, minRecentMessages);
    };
    return session;
  }

  override getModel(): LanguageModel {
    return createMockModel("hydration-failure agent response");
  }

  async getOnStartDegradationsForTest(): Promise<OnStartDegradationForTest[]> {
    return this._onStartDegradations.map((d) => ({
      step: d.step,
      error: String(d.error)
    }));
  }

  async getHydrationReadsFailedForTest(): Promise<number> {
    return this._hydrationReadsFailed;
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

  /** Re-read the live cache from durable storage at a safe boundary. */
  async resyncForTest(): Promise<UIMessage[]> {
    return this.syncMessagesFromStorage();
  }
}

// ── Windowed hydration agent (#1710, step 2) ────────────────────
// `hydrationByteBudget` bounds how much of the stored transcript is
// hydrated into `this.messages` on each cache refresh. Seeding happens in
// configureSession, which runs BEFORE onStart's hydration — so the first
// boot already sees an oversized stored transcript, like a real wake of a
// long-lived session.

export class ThinkWindowedHydrationAgent extends Think {
  // ~30KB per message, 10 messages ≈ 300KB stored; budget 64KB → only the
  // most recent couple of messages fit the hydration window.
  override hydrationByteBudget = 64 * 1024;
  override mediaEviction: boolean = false;

  override async configureSession(session: Session): Promise<Session> {
    if (this.name.includes("seeded")) {
      const existing = await session.getHistory();
      if (existing.length === 0) {
        for (let i = 0; i < 10; i++) {
          await session.appendMessage({
            id: `seed-${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            parts: [{ type: "text", text: `seed ${i} ${"x".repeat(30_000)}` }]
          });
        }
      }
    }
    return session;
  }

  override getModel(): LanguageModel {
    return createMockModel("windowed hydration agent response");
  }

  async getHydrationInfoForTest(): Promise<{
    truncated: boolean;
    totalContentBytes: number;
    hydratedMessages: number;
  } | null> {
    return this._lastHydration;
  }

  async getCachedMessageIdsForTest(): Promise<string[]> {
    return this.messages.map((m) => m.id);
  }

  async getFullHistoryIdsForTest(): Promise<string[]> {
    return (await this.session.getHistory()).map((m) => m.id);
  }

  async getOnStartDegradationsForTest(): Promise<OnStartDegradationForTest[]> {
    return this._onStartDegradations.map((d) => ({
      step: d.step,
      error: String(d.error)
    }));
  }

  /** Public accessor surface — mirrors getOnStartDegradations() for RPC. */
  async getPublicDegradationsForTest(): Promise<OnStartDegradationForTest[]> {
    return this.getOnStartDegradations().map((d) => ({
      step: d.step,
      error: String(d.error)
    }));
  }

  /** Re-run the safe-boundary cache refresh (exercises emit-on-change gating). */
  async resyncForTest(): Promise<number> {
    return (await this.syncMessagesFromStorage()).length;
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

// ── Media eviction agents (#1710, step 3) ───────────────────────

const BIG_MEDIA_CHARS = 12_000;

/**
 * Eviction disabled by default so tests can seed deterministically, then
 * enable a specific config and run passes explicitly.
 */
export class ThinkMediaEvictionAgent extends Think {
  override mediaEviction: MediaEvictionConfig | boolean = false;

  override getModel(): LanguageModel {
    return createMockModel("media eviction agent response");
  }

  async setMediaEvictionForTest(
    config: MediaEvictionConfig | boolean
  ): Promise<void> {
    this.mediaEviction = config;
  }

  /**
   * Frames broadcast by Session status updates (`cf_agent_session`) — the
   * side effect of a PUBLIC `updateMessage`. Eviction rewrites rows via the
   * silent maintenance path (`internal_rewriteMessage`), which must NOT add
   * to this count (each status emit also runs a full-history token
   * estimate, reintroducing the memory pressure eviction removes).
   */
  private _sessionStatusBroadcasts = 0;

  override broadcast(
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void {
    if (typeof message === "string") {
      try {
        const parsed = JSON.parse(message) as { type?: string };
        if (parsed.type === "cf_agent_session") {
          this._sessionStatusBroadcasts++;
        }
      } catch {
        // non-JSON frame — not a session status broadcast
      }
    }
    super.broadcast(message, without);
  }

  async getSessionStatusBroadcastsForTest(): Promise<number> {
    return this._sessionStatusBroadcasts;
  }

  /**
   * Seed: 2 aged messages with oversized media (a data-URL file part and a
   * tool output with a nested big string) + 4 small filler messages. The
   * eviction cutoff clamps `keepRecentMessages` to the model's read-time
   * window (4), so with 6 seeded messages the 2 media messages are aged
   * and the 4 fillers are protected.
   */
  async seedMediaHistoryForTest(prefix = "m"): Promise<void> {
    await this.appendMessageToHistory({
      id: `${prefix}0`,
      role: "user",
      parts: [
        { type: "text", text: "look at this screenshot" },
        {
          type: "file",
          mediaType: "image/png",
          url: `data:image/png;base64,${"A".repeat(BIG_MEDIA_CHARS)}`
        }
      ]
    } as UIMessage);
    await this.appendMessageToHistory({
      id: `${prefix}1`,
      role: "assistant",
      parts: [
        {
          type: "tool-screenshot",
          toolCallId: `${prefix}-call-1`,
          state: "output-available",
          input: {},
          output: {
            mediaType: "image/png",
            data: "B".repeat(BIG_MEDIA_CHARS),
            note: "small structured field"
          }
        }
      ]
    } as unknown as UIMessage);
    for (let i = 2; i < 6; i++) {
      await this.appendMessageToHistory({
        id: `${prefix}${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [
          {
            type: "text",
            text: i % 2 === 0 ? "recent question" : "recent answer"
          }
        ]
      } as UIMessage);
    }
  }

  async runEvictionForTest(): Promise<{
    messages: number;
    parts: number;
    bytes: number;
    externalizedBytes: number;
  } | null> {
    return this._evictAgedMediaBestEffort();
  }

  async getStoredMessageForTest(id: string): Promise<UIMessage | null> {
    return (await this.session.getMessage(id)) as UIMessage | null;
  }

  async readWorkspaceFileForTest(path: string): Promise<string | null> {
    return this.workspace.readFile(path);
  }
}

/** Eviction enabled with tiny thresholds — exercises the background pass. */
export class ThinkMediaEvictionAutoAgent extends ThinkMediaEvictionAgent {
  override mediaEviction: MediaEvictionConfig = {
    keepRecentMessages: 2,
    minPartBytes: 10_000
  };
}
