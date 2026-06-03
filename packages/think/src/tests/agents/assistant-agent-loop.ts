/**
 * Test agents for the Think agentic loop.
 *
 * Uses a mock LanguageModelV3 that works in the Workers runtime
 * without needing a real LLM provider.
 */

import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { Session } from "agents/experimental/memory/session";
import type { ObservabilityEvent } from "agents/observability";
import { Think } from "../../think";
import type {
  ChatErrorClassification,
  ChatErrorContext,
  StreamCallback,
  ToolCallContext,
  ToolCallDecision,
  ToolCallResultContext,
  StepContext
} from "../../think";

type TestChatResult = {
  events: string[];
  done: boolean;
  error?: string;
  interruptedCalls: number;
};

class TestCollectingCallback implements StreamCallback {
  events: string[] = [];
  doneCalled = false;
  errorMessage?: string;
  interruptedCalls = 0;
  onStart(): void {}
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

// ── Mock LanguageModel ──────────────────────────────────────────────

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

let callCount = 0;

function createMockModel(): LanguageModel {
  callCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-model",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream() {
      callCount++;
      const currentCall = callCount;

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({
            type: "text-start",
            id: `text-${currentCall}`
          });
          controller.enqueue({
            type: "text-delta",
            id: `text-${currentCall}`,
            delta: `Response ${currentCall}`
          });
          controller.enqueue({
            type: "text-end",
            id: `text-${currentCall}`
          });
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

function createMockToolModel(onCall?: () => void): LanguageModel {
  let toolCallCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-tool-model",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream(options: Record<string, unknown>) {
      onCall?.();
      toolCallCount++;
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

          if (!hasToolResult && toolCallCount === 1) {
            controller.enqueue({
              type: "tool-input-start",
              id: "tc1",
              toolName: "echo"
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: "tc1",
              delta: JSON.stringify({ message: "ping" })
            });
            controller.enqueue({
              type: "tool-input-end",
              id: "tc1"
            });
            // v3 spec also requires an explicit `tool-call` chunk so the
            // streamText pipeline records a TypedToolCall on the StepResult.
            controller.enqueue({
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "echo",
              input: JSON.stringify({ message: "ping" })
            });
            controller.enqueue({
              type: "finish",
              finishReason: v3FinishReason("tool-calls"),
              usage: v3Usage(10, 5)
            });
          } else {
            controller.enqueue({
              type: "text-start",
              id: "t2"
            });
            controller.enqueue({
              type: "text-delta",
              id: "t2",
              delta: "Tool said: pong"
            });
            controller.enqueue({
              type: "text-end",
              id: "t2"
            });
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

// ── Test agent: bare (no getModel override) ─────────────────────────

export class BareAssistantAgent extends Think {}

// ── Test agent: uses default loop with mock model ───────────────────

export class LoopTestAgent extends Think {
  getModel(): LanguageModel {
    return createMockModel();
  }

  getSystemPrompt(): string {
    return "You are a test assistant.";
  }

  override async getMessages(): Promise<UIMessage[]> {
    return this.messages;
  }
}

// ── Test agent: uses default loop with tools ────────────────────────

export class LoopToolTestAgent extends Think {
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

  getModel(): LanguageModel {
    return createMockToolModel();
  }

  getSystemPrompt(): string {
    return "You are a test assistant with tools.";
  }

  getTools(): ToolSet {
    return {
      echo: tool({
        description: "Echo a message back",
        inputSchema: z.object({ message: z.string() }),
        execute: async ({ message }: { message: string }) => `pong: ${message}`
      })
    };
  }

  private _stepLog: Array<{
    finishReason: string;
    toolCallCount: number;
    toolResultCount: number;
  }> = [];

  override maxSteps = 3;

  override onStepFinish(ctx: StepContext): void {
    this._stepLog.push({
      finishReason: ctx.finishReason,
      toolCallCount: ctx.toolCalls.length,
      toolResultCount: ctx.toolResults.length
    });
  }

  override beforeToolCall(ctx: ToolCallContext): ToolCallDecision | void {
    this._beforeToolCallLog.push({
      toolName: ctx.toolName,
      inputJson: JSON.stringify(ctx.input)
    });
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

  override async getMessages(): Promise<UIMessage[]> {
    return this.messages;
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

  async getStepLog(): Promise<
    Array<{
      finishReason: string;
      toolCallCount: number;
      toolResultCount: number;
    }>
  > {
    return this._stepLog;
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
}

// ── Test agent: mid-turn context-overflow recovery ──────────────────

/**
 * A model whose first stream surfaces an in-stream provider error
 * ("prompt is too long" — the context-overflow class) and whose subsequent
 * streams return normal text. Models the failure where a long turn overflows
 * the context window before compaction can fire, then succeeds once history is
 * compacted and the turn is re-run.
 */
function createOverflowThenOkModel(
  onCall?: () => void,
  alwaysOverflow = false
): LanguageModel {
  let call = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-overflow-model",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream() {
      onCall?.();
      call++;
      const isFirst = call === 1 || alwaysOverflow;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (isFirst) {
            // Provider rejects the over-long prompt mid-turn. The AI SDK
            // surfaces this as an in-stream error part, not a throw.
            controller.enqueue({
              type: "error",
              error: new Error(
                "AI_APICallError: prompt is too long: 213450 tokens > 200000 maximum"
              )
            });
            controller.close();
            return;
          }
          controller.enqueue({ type: "text-start", id: "t-ok" });
          controller.enqueue({
            type: "text-delta",
            id: "t-ok",
            delta: "recovered after compaction"
          });
          controller.enqueue({ type: "text-end", id: "t-ok" });
          controller.enqueue({
            type: "finish",
            finishReason: v3FinishReason("stop"),
            usage: v3Usage(20, 10)
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

type OverflowChatResult = {
  done: boolean;
  error?: string;
  compactionCount: number;
  modelCalls: number;
  /** Count of `chat:context:compacted` observability events (dedupe guard). */
  compactionEvents: number;
  /** `ctx.classification` seen by `onChatError`, if it was invoked. */
  errorClassification?: string;
};

/**
 * Exercises the opt-in reactive compact-and-retry backstop. Each test method
 * toggles `contextOverflow.reactive` so a single agent can cover both the
 * recovers-and-succeeds and stays-terminal-when-off cases.
 */
export class OverflowRecoveryTestAgent extends Think {
  compactionCount = 0;
  modelCalls = 0;
  proactiveMode = false;
  compactionNoOp = false;
  alwaysOverflow = false;
  compactionEvents = 0;
  errorClassification?: string;
  private _model?: LanguageModel;

  override maxSteps = 3;

  override _emit(
    type: ObservabilityEvent["type"],
    payload: Record<string, unknown> = {}
  ): void {
    if (type === "chat:context:compacted") this.compactionEvents++;
    super._emit(type, payload);
  }

  override onChatError(error: unknown, ctx?: ChatErrorContext): unknown {
    this.errorClassification = ctx?.classification;
    return super.onChatError(error, ctx);
  }

  getSystemPrompt(): string {
    return "You are a context-overflow recovery test assistant.";
  }

  getTools(): ToolSet {
    // Only used in proactive mode to drive a multi-step turn so `beforeStep`
    // sees a prior step's model-reported usage and the guard can fire.
    if (!this.proactiveMode) return {};
    return {
      echo: tool({
        description: "Echo a message back",
        inputSchema: z.object({ message: z.string() }),
        execute: async ({ message }: { message: string }) => `pong: ${message}`
      })
    };
  }

  getModel(): LanguageModel {
    if (!this._model) {
      // Count model invocations so the test can assert a retry happened.
      const onCall = () => {
        this.modelCalls++;
      };
      this._model = this.proactiveMode
        ? createMockToolModel(onCall)
        : createOverflowThenOkModel(onCall, this.alwaysOverflow);
    }
    return this._model;
  }

  override classifyChatError(error: unknown): ChatErrorClassification | void {
    const text = error instanceof Error ? error.message : String(error);
    if (
      /prompt is too long|context length|context_length_exceeded/i.test(text)
    ) {
      return "context_overflow";
    }
  }

  override configureSession(session: Session): Session {
    return session.onCompaction(async (messages) => {
      this.compactionCount++;
      // `compactionNoOp` simulates a history that can't be shortened (e.g. one
      // tool result alone exceeds the window) so the reactive backstop must
      // fall through to a terminal error instead of looping.
      if (this.compactionNoOp) return null;
      // Collapse only the first message so a non-empty tail always survives —
      // enough to prove compaction shortened history and the retry can proceed.
      if (messages.length < 2) return null;
      return {
        summary: "compacted-summary",
        fromMessageId: messages[0].id,
        toMessageId: messages[0].id
      };
    });
  }

  override async getMessages(): Promise<UIMessage[]> {
    return this.messages;
  }

  async testChat(
    message: string,
    enabled: boolean,
    opts?: { noOpCompaction?: boolean; alwaysOverflow?: boolean }
  ): Promise<OverflowChatResult> {
    this.contextOverflow = { reactive: enabled };
    this.compactionNoOp = opts?.noOpCompaction ?? false;
    this.alwaysOverflow = opts?.alwaysOverflow ?? false;
    this.compactionCount = 0;
    this.modelCalls = 0;
    this.compactionEvents = 0;
    this.errorClassification = undefined;

    // Seed a prior turn so the compaction range leaves a usable tail.
    await this.session.appendMessage({
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: "earlier question" }]
    });
    await this.session.appendMessage({
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: "earlier answer" }]
    });

    const cb = new TestCollectingCallback();
    await this.chat(message, cb);
    return {
      done: cb.doneCalled,
      error: cb.errorMessage,
      compactionCount: this.compactionCount,
      modelCalls: this.modelCalls,
      compactionEvents: this.compactionEvents,
      errorClassification: this.errorClassification
    };
  }

  /**
   * Enable reactive recovery and seed a prior turn, for driving the WebSocket
   * turn path (`_handleChatRequest` → `_streamResult`) from a test that sends a
   * raw chat-request frame rather than calling `chat()`.
   */
  async enableOverflowRecoveryForWsTest(): Promise<void> {
    this.contextOverflow = { reactive: true };
    this.compactionNoOp = false;
    this.proactiveMode = false;
    this.compactionCount = 0;
    this.modelCalls = 0;
    this.compactionEvents = 0;
    this.errorClassification = undefined;

    await this.session.appendMessage({
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: "earlier question" }]
    });
    await this.session.appendMessage({
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: "earlier answer" }]
    });
  }

  async getOverflowStats(): Promise<{
    compactionCount: number;
    modelCalls: number;
    compactionEvents: number;
  }> {
    return {
      compactionCount: this.compactionCount,
      modelCalls: this.modelCalls,
      compactionEvents: this.compactionEvents
    };
  }

  /**
   * Drives a multi-step (tool) turn with the proactive guard set low enough
   * that the first step's model-reported usage trips it, so the guard compacts
   * mid-turn before the next step. Reactive backstop is left off to isolate the
   * proactive path.
   */
  async testProactive(message: string): Promise<OverflowChatResult> {
    this.proactiveMode = true;
    this.compactionNoOp = false;
    this.compactionCount = 0;
    this.modelCalls = 0;
    this.compactionEvents = 0;
    this.errorClassification = undefined;
    // The mock tool model reports usage.inputTokens = 10 on the first step;
    // a budget of 10 with the default 0.9 headroom (threshold 9) trips before
    // the second step. Reactive off isolates the proactive path.
    this.contextOverflow = { proactive: { maxInputTokens: 10 } };

    await this.session.appendMessage({
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: "earlier question" }]
    });
    await this.session.appendMessage({
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: "earlier answer" }]
    });

    const cb = new TestCollectingCallback();
    await this.chat(message, cb);
    return {
      done: cb.doneCalled,
      error: cb.errorMessage,
      compactionCount: this.compactionCount,
      modelCalls: this.modelCalls,
      compactionEvents: this.compactionEvents,
      errorClassification: this.errorClassification
    };
  }

  /**
   * Drives the programmatic turn path (`saveMessages` →
   * `_runProgrammaticMessagesTurn`) to verify overflow recovery extends there
   * too, not just the WebSocket / chat() paths.
   */
  async testProgrammatic(message: string): Promise<OverflowChatResult> {
    this.contextOverflow = { reactive: true };
    this.compactionNoOp = false;
    this.proactiveMode = false;
    this.alwaysOverflow = false;
    this.compactionCount = 0;
    this.modelCalls = 0;
    this.compactionEvents = 0;
    this.errorClassification = undefined;

    await this.session.appendMessage({
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: "earlier question" }]
    });
    await this.session.appendMessage({
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: "earlier answer" }]
    });

    const result = await this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: message }]
      }
    ]);

    return {
      done: result.status === "completed",
      error: result.status === "error" ? (result.error ?? "error") : undefined,
      compactionCount: this.compactionCount,
      modelCalls: this.modelCalls,
      compactionEvents: this.compactionEvents,
      errorClassification: this.errorClassification
    };
  }
}
