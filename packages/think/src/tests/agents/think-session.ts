import type { LanguageModel, UIMessage } from "ai";
import { tool } from "ai";
import { Think } from "../../think";
import type {
  StreamCallback,
  StreamableResult,
  ChatMessageOptions,
  ChatResponseResult,
  SaveMessagesResult,
  ChatRecoveryContext,
  ChatRecoveryOptions
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

// ── Mock LanguageModel (v3 format) ──────────────────────────────

let _mockCallCount = 0;

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
            finishReason: "stop",
            usage: { inputTokens: 10, outputTokens: 5 }
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
            finishReason: "stop",
            usage: { inputTokens: 10, outputTokens: chunks.length }
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
// path, not a copy. Overrides only what's needed for test control:
// getModel(), onChatError(), and onChatMessage() (for error injection).

export class ThinkTestAgent extends Think {
  private _response = "Hello from the assistant!";
  private _chatErrorLog: string[] = [];
  private _errorConfig: {
    afterChunks: number;
    message: string;
  } | null = null;
  private _responseLog: ChatResponseResult[] = [];

  // ── Think overrides ─────────────────────────────────────

  override onChatError(error: unknown): unknown {
    const msg = error instanceof Error ? error.message : String(error);
    this._chatErrorLog.push(msg);
    return error;
  }

  override onChatResponse(result: ChatResponseResult): void {
    this._responseLog.push(result);
  }

  /**
   * Override onChatMessage to optionally inject mid-stream errors.
   * When _errorConfig is set, wraps the stream to throw after N chunks.
   * Otherwise delegates to the real Think implementation.
   */
  override async onChatMessage(
    options?: ChatMessageOptions
  ): Promise<StreamableResult> {
    const result = await super.onChatMessage(options);
    if (!this._errorConfig) return result;

    const config = this._errorConfig;
    const originalStream = result.toUIMessageStream();

    // Wrap as an AsyncIterable that delivers N chunks then throws.
    // This avoids TransformStream/pipeTo which cause unhandled rejections.
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
    const { system } = await this.assembleContext();
    return system;
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
    const { system } = await this.assembleContext();
    return system;
  }
}

// ── ThinkConfigTestAgent ────────────────────────────────────
// Tests dynamic configuration persistence.

type TestConfig = {
  theme: string;
  maxTokens: number;
};

export class ThinkConfigTestAgent extends Think<Cloudflare.Env, TestConfig> {
  override getModel(): LanguageModel {
    return createMockModel("Config agent response");
  }

  async setTestConfig(config: TestConfig): Promise<void> {
    this.configure(config);
  }

  async getTestConfig(): Promise<TestConfig | null> {
    return this.getConfig();
  }
}

// ── ThinkToolsTestAgent ───────────────────────────────────
// Extends Think with tools configured for tool integration testing.

export class ThinkToolsTestAgent extends Think {
  override getModel(): LanguageModel {
    return createMockModel("I'll check the time.");
  }

  override getTools() {
    return {
      get_time: tool({
        description: "Get current time",
        inputSchema: z.object({}),
        execute: async () => new Date().toISOString()
      })
    };
  }

  override getMaxSteps(): number {
    return 3;
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

// ── ThinkProgrammaticTestAgent ──────────────────────────────
// Tests saveMessages, continueLastTurn, and body persistence.

export class ThinkProgrammaticTestAgent extends Think {
  private _responseLog: ChatResponseResult[] = [];
  private _capturedOptions: Array<{
    continuation?: boolean;
    body?: Record<string, unknown>;
  }> = [];

  override getModel(): LanguageModel {
    return createMockModel("Programmatic response");
  }

  override onChatResponse(result: ChatResponseResult): void {
    this._responseLog.push(result);
  }

  override async onChatMessage(
    options?: ChatMessageOptions
  ): Promise<StreamableResult> {
    if (options) {
      this._capturedOptions.push({
        continuation: options.continuation,
        body: options.body
      });
    }
    return super.onChatMessage(options);
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
    Array<{ continuation?: boolean; body?: Record<string, unknown> }>
  > {
    return this._capturedOptions;
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

// ── ThinkSanitizeTestAgent ──────────────────────────────────
// Tests the sanitizeMessageForPersistence hook.

export class ThinkSanitizeTestAgent extends Think {
  override getModel(): LanguageModel {
    return createMockModel("The SECRET password is SECRET123");
  }

  override sanitizeMessageForPersistence(message: UIMessage): UIMessage {
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (part.type === "text") {
          const textPart = part as { type: "text"; text: string };
          return {
            ...textPart,
            text: textPart.text.replace(/SECRET/g, "[REDACTED]")
          };
        }
        return part;
      }) as UIMessage["parts"]
    };
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

// ── ThinkRecoveryTestAgent ──────────────────────────────────
// Tests unstable_chatRecovery, fiber wrapping, onChatRecovery hook.

export class ThinkRecoveryTestAgent extends Think {
  override unstable_chatRecovery = true;

  private _recoveryContexts: Array<{
    recoveryData: unknown;
    partialText: string;
    streamId: string;
  }> = [];
  private _recoveryOverride: ChatRecoveryOptions = {};
  private _onChatMessageCallCount = 0;
  private _stashData: unknown = null;
  private _stashResult: { success: boolean; error?: string } | null = null;

  override getModel(): LanguageModel {
    return createMockModel("Continued response.");
  }

  override async onChatMessage(
    options?: ChatMessageOptions
  ): Promise<StreamableResult> {
    this._onChatMessageCallCount++;

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

    return super.onChatMessage(options);
  }

  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    this._recoveryContexts.push({
      recoveryData: ctx.recoveryData,
      partialText: ctx.partialText,
      streamId: ctx.streamId
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

  async getOnChatMessageCallCount(): Promise<number> {
    return this._onChatMessageCallCount;
  }

  async getRecoveryContexts(): Promise<
    Array<{ recoveryData: unknown; partialText: string; streamId: string }>
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
// Same as ThinkRecoveryTestAgent but with unstable_chatRecovery = false.

export class ThinkNonRecoveryTestAgent extends Think {
  override unstable_chatRecovery = false;
  private _onChatMessageCallCount = 0;

  override getModel(): LanguageModel {
    return createMockModel("Continued response.");
  }

  override async onChatMessage(
    options?: ChatMessageOptions
  ): Promise<StreamableResult> {
    this._onChatMessageCallCount++;
    return super.onChatMessage(options);
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

  async getOnChatMessageCallCount(): Promise<number> {
    return this._onChatMessageCallCount;
  }
}
