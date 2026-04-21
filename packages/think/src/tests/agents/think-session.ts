import type { LanguageModel, UIMessage } from "ai";
import { tool } from "ai";
import { Think } from "../../think";
import type {
  StreamCallback,
  StreamableResult,
  ChatResponseResult,
  SaveMessagesResult,
  ChatRecoveryContext,
  ChatRecoveryOptions,
  TurnContext,
  TurnConfig,
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

function createMockModel(response: string): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-model",
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

  override onChatResponse(result: ChatResponseResult): void {
    this._responseLog.push(result);
  }

  override beforeTurn(ctx: TurnContext): TurnConfig | void {
    this._beforeTurnLog.push({
      system: ctx.system,
      toolNames: Object.keys(ctx.tools),
      continuation: ctx.continuation,
      body: ctx.body as RpcJsonObject | undefined
    });
    if (this._turnConfigOverride) return this._turnConfigOverride;
  }

  async setTurnConfigOverride(config: TurnConfig | null): Promise<void> {
    this._turnConfigOverride = config;
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

  async getChunkCount(): Promise<number> {
    return this._chunkCount;
  }

  protected override _transformInferenceResult(
    result: StreamableResult
  ): StreamableResult {
    if (!this._errorConfig) return result;

    const config = this._errorConfig;
    const originalStream = result.toUIMessageStream();
    const reader = (originalStream as unknown as ReadableStream).getReader();
    let chunkCount = 0;
    let shouldThrow = false;

    const wrapped: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (shouldThrow) {
              await reader.cancel();
              throw new SimulatedChatError(config.message);
            }
            const { done, value } = await reader.read();
            if (done) return { done: true as const, value: undefined };
            chunkCount++;
            if (chunkCount >= config.afterChunks) {
              shouldThrow = true;
            }
            return { done: false as const, value };
          },
          async return() {
            await reader.cancel();
            return { done: true as const, value: undefined };
          }
        };
      }
    };

    return { toUIMessageStream: () => wrapped };
  }

  // ── Test-specific public methods ───────────────────────────────
  // These are callable via DurableObject RPC stubs (no @callable needed).

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

  private _multiChunks: string[] | null = null;

  async setMultiChunkResponse(chunks: string[]): Promise<void> {
    this._multiChunks = chunks;
  }

  async clearMultiChunkResponse(): Promise<void> {
    this._multiChunks = null;
  }

  override getModel(): LanguageModel {
    if (this._multiChunks) {
      return createMultiChunkMockModel(this._multiChunks);
    }
    return createMockModel(this._response);
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

// ── ThinkConfigInSessionAgent ────────────────────────────────
// Reproduces GH-1309: getConfig() inside configureSession() should
// not throw "no such table: assistant_config".

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
  private _responseLog: ChatResponseResult[] = [];
  private _capturedTurnContexts: Array<{
    continuation?: boolean;
    body?: RpcJsonObject;
  }> = [];

  override getModel(): LanguageModel {
    return createMockModel("Programmatic response");
  }

  override onChatResponse(result: ChatResponseResult): void {
    this._responseLog.push(result);
  }

  override beforeTurn(ctx: TurnContext): void {
    this._capturedTurnContexts.push({
      continuation: ctx.continuation,
      body: ctx.body as RpcJsonObject | undefined
    });
  }

  async testSaveMessages(msgs: UIMessage[]): Promise<SaveMessagesResult> {
    return this.saveMessages(msgs);
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

  async getStoredMessages(): Promise<UIMessage[]> {
    return this.getMessages();
  }

  async getResponseLog(): Promise<ChatResponseResult[]> {
    return this._responseLog;
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
