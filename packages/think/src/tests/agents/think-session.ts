import type { LanguageModel, UIMessage } from "ai";
import { tool } from "ai";
import { Think } from "../../think";
import type {
  StreamCallback,
  StreamableResult,
  ChatMessageOptions,
  Session
} from "../../think";
import { sanitizeMessage, enforceRowSizeLimit } from "agents/chat";
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

  // ── Think overrides ─────────────────────────────────────

  override onChatError(error: unknown): unknown {
    const msg = error instanceof Error ? error.message : String(error);
    this._chatErrorLog.push(msg);
    return error;
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
        // Should not be called for abort
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

  async setMaxPersistedMessages(max: number | null): Promise<void> {
    this.maxPersistedMessages = max ?? undefined;
  }

  async getChatErrorLog(): Promise<string[]> {
    return this._chatErrorLog;
  }

  async getSessionInfo(): Promise<Session | null> {
    return this.getSession();
  }

  // ── Static method proxies for unit testing ─────────────────────

  async sanitizeMessage(msg: UIMessage): Promise<UIMessage> {
    return sanitizeMessage(msg);
  }

  async enforceRowSizeLimit(msg: UIMessage): Promise<UIMessage> {
    return enforceRowSizeLimit(msg);
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
