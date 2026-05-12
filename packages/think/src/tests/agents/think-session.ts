import type { LanguageModel, UIMessage } from "ai";
import { Output, tool } from "ai";
import { Think } from "../../think";
import type {
  StreamCallback,
  StreamableResult,
  ChatResponseResult,
  SaveMessagesResult,
  ChatRecoveryContext,
  ChatRecoveryOptions,
  ThinkSubmissionInspection,
  ThinkSubmissionStatus,
  SubmitMessagesResult,
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
import { Session } from "agents/experimental/memory/session";
import { z } from "zod";

// ── Test result type ────────────────────────────────────────────

export type TestChatResult = {
  events: string[];
  done: boolean;
  error?: string;
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

  onEvent(json: string): void {
    this.events.push(json);
  }

  onDone(): void {
    this.doneCalled = true;
  }

  onError(error: string): void {
    this.errorMessage = error;
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
    if (!this._errorConfig && !this._stripTextResponseForTest) return result;

    const config = this._errorConfig;
    const stripText = this._stripTextResponseForTest;

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

  async testChat(message: string): Promise<TestChatResult> {
    const cb = new TestCollectingCallback();
    await this.chat(message, cb);
    return {
      events: cb.events,
      done: cb.doneCalled,
      error: cb.errorMessage
    };
  }

  async testChatWithUIMessage(msg: UIMessage): Promise<TestChatResult> {
    const cb = new TestCollectingCallback();
    await this.chat(msg, cb);
    return {
      events: cb.events,
      done: cb.doneCalled,
      error: cb.errorMessage
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

  async testChatWithAbort(
    message: string,
    abortAfterEvents: number
  ): Promise<TestChatResult & { doneCalled: boolean }> {
    const events: string[] = [];
    let doneCalled = false;
    const controller = new AbortController();

    const cb: StreamCallback = {
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

    return { events, done: doneCalled, doneCalled };
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
      error: cb.errorMessage
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
      error: cb.errorMessage
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
      error: cb.errorMessage
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
      error: cb.errorMessage
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
  private _capturedTurnContexts: Array<{
    continuation?: boolean;
    body?: RpcJsonObject;
  }> = [];
  private _delayedChunks: { chunks: string[]; delayMs: number } | null = null;
  private _throwBeforeTurnError: string | null = null;
  private _submissionStatusDelayMs = 0;

  override getModel(): LanguageModel {
    if (this._delayedChunks) {
      return createDelayedMultiChunkMockModel(
        this._delayedChunks.chunks,
        this._delayedChunks.delayMs
      );
    }
    return createMockModel("Programmatic response");
  }

  override onChatResponse(result: ChatResponseResult): void {
    this._responseLog.push(result);
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
      createdAt: Date.now()
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
        ${messagesJson}, NULL, NULL, ${now}, ${messagesAppliedAt},
        ${startedAt}, ${completedAt}
      )
    `;
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
      persistedMessageCount: this.getMessages().length,
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
      error: cb.errorMessage
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
      error: cb.errorMessage
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
  override chatRecovery = true;

  private _recoveryContexts: Array<{
    recoveryData: unknown;
    partialText: string;
    streamId: string;
    createdAt: number;
  }> = [];
  private _recoveryOverride: ChatRecoveryOptions = {};
  private _turnCallCount = 0;
  private _stashData: unknown = null;
  private _stashResult: { success: boolean; error?: string } | null = null;

  override getModel(): LanguageModel {
    return createMockModel("Continued response.");
  }

  override beforeTurn(_ctx: TurnContext): void {
    this._turnCallCount++;

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
      recoveryData: ctx.recoveryData,
      partialText: ctx.partialText,
      streamId: ctx.streamId,
      createdAt: ctx.createdAt
    });
    return this._recoveryOverride;
  }

  async testChat(message: string): Promise<TestChatResult> {
    const cb = new TestCollectingCallback();
    await this.chat(message, cb);
    return {
      events: cb.events,
      done: cb.doneCalled,
      error: cb.errorMessage
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
      recoveryData: unknown;
      partialText: string;
      streamId: string;
      createdAt: number;
    }>
  > {
    return this._recoveryContexts;
  }

  async setRecoveryOverride(options: ChatRecoveryOptions): Promise<void> {
    this._recoveryOverride = options;
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

  async insertInterruptedStream(
    streamId: string,
    requestId: string,
    chunks: Array<{ body: string; index: number }>
  ): Promise<void> {
    const now = Date.now();
    this.sql`
      INSERT INTO cf_ai_chat_stream_metadata (id, request_id, status, created_at)
      VALUES (${streamId}, ${requestId}, 'active', ${now})
    `;
    for (const chunk of chunks) {
      const chunkId = `${streamId}-${chunk.index}`;
      this.sql`
        INSERT INTO cf_ai_chat_stream_chunks (id, stream_id, chunk_index, body, created_at)
        VALUES (${chunkId}, ${streamId}, ${chunk.index}, ${chunk.body}, ${now})
      `;
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

  async persistTestMessage(msg: UIMessage): Promise<void> {
    await this.session.appendMessage(msg);
  }

  async hasPendingInteractionForTest(): Promise<boolean> {
    return this.hasPendingInteraction();
  }

  async waitUntilStableForTest(timeout?: number): Promise<boolean> {
    return this.waitUntilStable({ timeout: timeout ?? 5000 });
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
      error: cb.errorMessage
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
