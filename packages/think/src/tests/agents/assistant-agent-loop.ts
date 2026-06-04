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
  StepContext,
  TurnContext
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

/**
 * A model that issues two sequential tool calls (steps 1 and 2) before
 * answering with text (step 3). Each tool-call step reports
 * `usage.inputTokens = 10`, so with a low `maxInputTokens` the proactive guard
 * trips before BOTH step 2 and step 3 — exercising the multi-fire splice /
 * re-baseline path (`_turnModelMessageBaseline`) that a single-fire run never
 * reaches. Keys its behavior off the model-call count (not prompt inspection)
 * so a mid-turn recompaction does not change which step it is on.
 */
function createTwoToolThenTextModel(
  onCall?: (options: unknown) => void
): LanguageModel {
  let callCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-two-tool-model",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream(options: Record<string, unknown>) {
      onCall?.(options);
      callCount++;
      const step = callCount;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (step <= 2) {
            const id = `tc${step}`;
            controller.enqueue({
              type: "tool-input-start",
              id,
              toolName: "echo"
            });
            controller.enqueue({
              type: "tool-input-delta",
              id,
              delta: JSON.stringify({ message: `ping-${step}` })
            });
            controller.enqueue({ type: "tool-input-end", id });
            controller.enqueue({
              type: "tool-call",
              toolCallId: id,
              toolName: "echo",
              input: JSON.stringify({ message: `ping-${step}` })
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
              delta: "done after two tools"
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
 * Marker text seeded into the conversation before an overflow turn. The mock
 * model overflows **while this marker is still present in the prompt**, so a
 * turn only stops overflowing once compaction has actually removed the seeded
 * messages from what is sent. This makes the test verify compaction
 * *effectiveness* (the retry sends a genuinely shorter, summarized prompt) — not
 * just the retry plumbing — and guards against a regression where the in-memory
 * message cache is not refreshed after `session.compact()` (the retry would
 * then resend the marker and overflow forever).
 */
const SEED_OVERFLOW_MARKER = "earlier question";

function promptIncludesMarker(options: unknown): boolean {
  const prompt = (options as { prompt?: unknown[] })?.prompt ?? [];
  return JSON.stringify(prompt).includes(SEED_OVERFLOW_MARKER);
}

/**
 * Inspect a provider prompt (the model-message array the AI SDK is about to
 * send) and extract the tool-call/tool-result IDs and whether the recompacted
 * head summary is present. Lets a test assert that a mid-turn compaction splice
 * preserved tool pairing (every `tool-call` has a matching `tool-result`) and
 * actually substituted the recompacted head — not just that the turn finished.
 */
function extractToolPairing(options: unknown): {
  toolCalls: string[];
  toolResults: string[];
  hasSummary: boolean;
  headHasHistory: boolean;
} {
  const prompt =
    (options as { prompt?: Array<{ content?: unknown }> })?.prompt ?? [];
  const toolCalls: string[] = [];
  const toolResults: string[] = [];
  for (const msg of prompt) {
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: string; toolCallId?: string };
      if (p.type === "tool-call" && p.toolCallId) toolCalls.push(p.toolCallId);
      if (p.type === "tool-result" && p.toolCallId) {
        toolResults.push(p.toolCallId);
      }
    }
  }
  const json = JSON.stringify(prompt);
  return {
    toolCalls,
    toolResults,
    hasSummary: json.includes("compacted-summary"),
    // The recompacted head was prepended (not dropped): the seeded conversation
    // tail survives in every step's prompt.
    headHasHistory: json.includes("earlier answer")
  };
}

/**
 * A model that overflows (surfacing the AI SDK in-stream "prompt is too long"
 * error part, not a throw) **while the seeded marker is still in the prompt**,
 * and returns normal text once compaction has removed it. `alwaysOverflow`
 * forces an overflow on every call regardless — modelling a turn whose single
 * remaining message still exceeds the window, so compaction cannot save it.
 */
function createOverflowThenOkModel(
  onCall?: (options: unknown) => void,
  alwaysOverflow = false,
  emitPartialBeforeOverflow = false
): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-overflow-model",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream(options: Record<string, unknown>) {
      onCall?.(options);
      const overflow = alwaysOverflow || promptIncludesMarker(options);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (overflow) {
            // Model a realistic overflow: the model streams some assistant
            // text first, THEN the provider rejects the now-too-long prompt
            // mid-turn. The AI SDK surfaces the rejection as an in-stream error
            // part, not a throw. The streamed text accumulates into a partial
            // assistant message before the error lands.
            if (emitPartialBeforeOverflow) {
              controller.enqueue({ type: "text-start", id: "t-partial" });
              controller.enqueue({
                type: "text-delta",
                id: "t-partial",
                delta: "partial answer before overflow"
              });
              controller.enqueue({ type: "text-end", id: "t-partial" });
            }
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

/**
 * Exercises BOTH overflow layers in a single turn (the recommended config):
 * - Call 1: a tool call reporting `usage.inputTokens = 10`, which trips the
 *   proactive guard before step 2 (proactive compaction #1).
 * - Call 2 (step 2): an in-stream overflow error the proactive compaction could
 *   not prevent — the reactive backstop catches it (compaction #2) and retries.
 * - Call 3 (retry, step 1): succeeds with text.
 *
 * Proves the proactive guard and the reactive backstop cooperate: proactive
 * fires, the turn still overflows, reactive recovers it. Keyed off call count.
 */
function createProactiveThenReactiveModel(
  onCall?: (options: unknown) => void
): LanguageModel {
  let callCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-proactive-then-reactive-model",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream(options: Record<string, unknown>) {
      onCall?.(options);
      callCount++;
      const step = callCount;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (step === 1) {
            const id = "tc1";
            controller.enqueue({
              type: "tool-input-start",
              id,
              toolName: "echo"
            });
            controller.enqueue({
              type: "tool-input-delta",
              id,
              delta: JSON.stringify({ message: "ping" })
            });
            controller.enqueue({ type: "tool-input-end", id });
            controller.enqueue({
              type: "tool-call",
              toolCallId: id,
              toolName: "echo",
              input: JSON.stringify({ message: "ping" })
            });
            // Report high input usage so the proactive guard trips before step 2.
            controller.enqueue({
              type: "finish",
              finishReason: v3FinishReason("tool-calls"),
              usage: v3Usage(10, 5)
            });
          } else if (step === 2) {
            // Proactive compaction did not save the turn — overflow anyway.
            controller.enqueue({
              type: "error",
              error: new Error(
                "AI_APICallError: prompt is too long: 213450 tokens > 200000 maximum"
              )
            });
          } else {
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
          }
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

/**
 * A model whose `doStream` THROWS (rejects) on overflow rather than emitting an
 * in-stream `{ type: "error" }` part — the "top-level provider rejection" shape.
 * Returns normal text once the seeded marker is gone (after compaction).
 *
 * The recovery seam only fires on in-stream error parts, so this test asserts
 * the changeset's central AI-SDK assumption: `streamText` re-enqueues even a
 * thrown/rejected `doStream` as a `{ type: "error" }` fullStream part, so the
 * seam catches it and recovery still runs. If the SDK ever stopped doing this,
 * this test would fail — surfacing a real gap rather than a silent regression.
 */
function createThrowingThenOkModel(
  onCall?: (options: unknown) => void
): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-throwing-overflow-model",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream(options: Record<string, unknown>) {
      onCall?.(options);
      if (promptIncludesMarker(options)) {
        // Top-level rejection (not an in-stream error part).
        return Promise.reject(
          new Error(
            "AI_APICallError: prompt is too long: 213450 tokens > 200000 maximum"
          )
        );
      }
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
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
  /** `ctx.continuation` seen by `beforeTurn` on each attempt of the turn. */
  beforeTurnContinuations: boolean[];
  /** Whether each model call's prompt still contained the seeded marker. */
  promptIncludedSeedMarker: boolean[];
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
  proactiveMultiFire = false;
  compactionNoOp = false;
  alwaysOverflow = false;
  emitPartialBeforeOverflow = false;
  abortDuringRecovery = false;
  combinedProactiveReactive = false;
  throwOnOverflow = false;
  compactionEvents = 0;
  errorClassification?: string;
  beforeTurnContinuations: boolean[] = [];
  promptIncludedSeedMarker: boolean[] = [];
  /** Full payload of each `chat:context:compacted` event (observability contract). */
  compactionEventPayloads: Array<Record<string, unknown>> = [];
  /** Tool-call/result pairing + recompacted-head presence per model step (multi-fire). */
  proactiveStepPrompts: Array<{
    toolCalls: string[];
    toolResults: string[];
    hasSummary: boolean;
    headHasHistory: boolean;
  }> = [];
  private _model?: LanguageModel;

  override maxSteps = 3;

  override beforeTurn(ctx: TurnContext): void {
    this.beforeTurnContinuations.push(ctx.continuation);
  }

  override _emit(
    type: ObservabilityEvent["type"],
    payload: Record<string, unknown> = {}
  ): void {
    if (type === "chat:context:compacted") {
      this.compactionEvents++;
      this.compactionEventPayloads.push(payload);
    }
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
    // Only used in proactive / combined mode to drive a multi-step turn so
    // `beforeStep` sees a prior step's model-reported usage and the guard fires.
    if (!this.proactiveMode && !this.combinedProactiveReactive) return {};
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
      // Record each model invocation: count (to assert a retry happened) and,
      // for the overflow model, whether the seeded marker was still in the
      // prompt (to assert compaction actually removed it on the retry).
      const onCall = (options?: unknown) => {
        this.modelCalls++;
        if (this.proactiveMultiFire) {
          // Capture the spliced prompt's tool pairing + recompacted-head
          // presence per step, so the multi-fire test can assert structural
          // integrity (not just a clean completion).
          this.proactiveStepPrompts.push(extractToolPairing(options));
        } else if (!this.proactiveMode) {
          this.promptIncludedSeedMarker.push(promptIncludesMarker(options));
        }
      };
      this._model = this.throwOnOverflow
        ? createThrowingThenOkModel(onCall)
        : this.combinedProactiveReactive
          ? createProactiveThenReactiveModel(onCall)
          : this.proactiveMultiFire
            ? createTwoToolThenTextModel(onCall)
            : this.proactiveMode
              ? createMockToolModel(onCall)
              : createOverflowThenOkModel(
                  onCall,
                  this.alwaysOverflow,
                  this.emitPartialBeforeOverflow
                );
    }
    return this._model;
  }

  override classifyChatError(
    error: unknown,
    ctx?: ChatErrorContext
  ): ChatErrorClassification | void {
    const text = error instanceof Error ? error.message : String(error);
    if (
      /prompt is too long|context length|context_length_exceeded/i.test(text)
    ) {
      // Abort-during-recovery seam: classifyChatError is consulted at the
      // overflow stream seam (synchronously, before the driver decides to
      // compact and retry). Cancelling the in-flight turn here via the threaded
      // ctx.requestId lets the test deterministically simulate a user abort
      // landing between the overflow and the retry.
      if (this.abortDuringRecovery && ctx?.requestId) {
        this.cancelChat(ctx.requestId);
      }
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

  /**
   * Returns the final persisted transcript as compact `role:text` tuples so a
   * test can assert the shape after a recovery (e.g. that a reactive retry does
   * not leave an orphan truncated assistant message behind).
   */
  async getTranscriptSummary(): Promise<Array<{ role: string; text: string }>> {
    return this.messages.map((m) => ({
      role: m.role,
      text: m.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("")
    }));
  }

  async testChat(
    message: string,
    enabled: boolean,
    opts?: {
      noOpCompaction?: boolean;
      alwaysOverflow?: boolean;
      emitPartialBeforeOverflow?: boolean;
    }
  ): Promise<OverflowChatResult> {
    this.contextOverflow = { reactive: enabled };
    this.compactionNoOp = opts?.noOpCompaction ?? false;
    this.alwaysOverflow = opts?.alwaysOverflow ?? false;
    this.emitPartialBeforeOverflow = opts?.emitPartialBeforeOverflow ?? false;
    this.compactionCount = 0;
    this.modelCalls = 0;
    this.compactionEvents = 0;
    this.errorClassification = undefined;
    this.beforeTurnContinuations = [];
    this.promptIncludedSeedMarker = [];
    this.compactionEventPayloads = [];
    this.proactiveStepPrompts = [];

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
      errorClassification: this.errorClassification,
      beforeTurnContinuations: this.beforeTurnContinuations,
      promptIncludedSeedMarker: this.promptIncludedSeedMarker
    };
  }

  /**
   * Reactive recovery is enabled, but the turn is aborted at the overflow seam
   * (classifyChatError cancels the in-flight request). The driver must NOT
   * compact or retry an aborted turn — it falls through to the terminal
   * delivery instead. Asserts the abort responsiveness fix: no compaction, no
   * second model call.
   */
  async testChatAbortDuringRecovery(
    message: string
  ): Promise<OverflowChatResult> {
    this.contextOverflow = { reactive: true };
    this.compactionNoOp = false;
    this.alwaysOverflow = false;
    this.emitPartialBeforeOverflow = false;
    this.abortDuringRecovery = true;
    this.compactionCount = 0;
    this.modelCalls = 0;
    this.compactionEvents = 0;
    this.errorClassification = undefined;
    this.beforeTurnContinuations = [];
    this.promptIncludedSeedMarker = [];
    this.compactionEventPayloads = [];
    this.proactiveStepPrompts = [];

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
      errorClassification: this.errorClassification,
      beforeTurnContinuations: this.beforeTurnContinuations,
      promptIncludedSeedMarker: this.promptIncludedSeedMarker
    };
  }

  /**
   * Enable reactive recovery and seed a prior turn, for driving the WebSocket
   * turn path (`_handleChatRequest` → `_streamResult`) from a test that sends a
   * raw chat-request frame rather than calling `chat()`.
   */
  async enableOverflowRecoveryForWsTest(opts?: {
    abortDuringRecovery?: boolean;
  }): Promise<void> {
    this.contextOverflow = { reactive: true };
    this.compactionNoOp = false;
    this.proactiveMode = false;
    this.abortDuringRecovery = opts?.abortDuringRecovery ?? false;
    this.compactionCount = 0;
    this.modelCalls = 0;
    this.compactionEvents = 0;
    this.errorClassification = undefined;
    this.beforeTurnContinuations = [];
    this.promptIncludedSeedMarker = [];
    this.compactionEventPayloads = [];
    this.proactiveStepPrompts = [];

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
    promptIncludedSeedMarker: boolean[];
    compactionEventPayloads: Array<Record<string, unknown>>;
  }> {
    return {
      compactionCount: this.compactionCount,
      modelCalls: this.modelCalls,
      compactionEvents: this.compactionEvents,
      promptIncludedSeedMarker: this.promptIncludedSeedMarker,
      compactionEventPayloads: this.compactionEventPayloads
    };
  }

  /** Per-step tool pairing + recompacted-head presence (multi-fire proactive). */
  async getProactiveStepPrompts(): Promise<
    Array<{
      toolCalls: string[];
      toolResults: string[];
      hasSummary: boolean;
      headHasHistory: boolean;
    }>
  > {
    return this.proactiveStepPrompts;
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
    this.beforeTurnContinuations = [];
    this.promptIncludedSeedMarker = [];
    this.compactionEventPayloads = [];
    this.proactiveStepPrompts = [];
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
      errorClassification: this.errorClassification,
      beforeTurnContinuations: this.beforeTurnContinuations,
      promptIncludedSeedMarker: this.promptIncludedSeedMarker
    };
  }

  /**
   * Drives a 3-step tool turn (two tool calls, then text) with the proactive
   * guard budget low enough that the prior step's usage trips it before BOTH
   * step 2 and step 3. With `maxRetries: 2` the guard may compact twice in one
   * run, exercising the multi-fire splice / re-baseline path
   * (`_turnModelMessageBaseline`) that a single-fire run never reaches. A clean
   * completion proves the second splice did not corrupt the prompt (e.g. drop a
   * tool result or duplicate the recompacted head).
   */
  async testProactiveMultiFire(message: string): Promise<OverflowChatResult> {
    this.proactiveMode = true;
    this.proactiveMultiFire = true;
    this.compactionNoOp = false;
    this.compactionCount = 0;
    this.modelCalls = 0;
    this.compactionEvents = 0;
    this.errorClassification = undefined;
    this.beforeTurnContinuations = [];
    this.promptIncludedSeedMarker = [];
    this.compactionEventPayloads = [];
    this.proactiveStepPrompts = [];
    // Budget 10 with the default 0.9 headroom (threshold 9): each tool-call
    // step reports usage.inputTokens = 10, so the guard trips before step 2 AND
    // step 3. proactive.maxCompactions: 2 lets it compact on both (independent
    // of the reactive maxRetries budget).
    this.contextOverflow = {
      proactive: { maxInputTokens: 10, maxCompactions: 2 }
    };

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
      errorClassification: this.errorClassification,
      beforeTurnContinuations: this.beforeTurnContinuations,
      promptIncludedSeedMarker: this.promptIncludedSeedMarker
    };
  }

  /**
   * Drives the 3-step tool turn with the proactive guard but a no-op compaction
   * and the DEFAULT budget (`maxRetries` unset → proactive cap 1). The guard
   * trips before step 2, attempts compaction (a no-op), consumes its single
   * slot, and emits exactly one `chat:context:compacted` event. Before step 3
   * the cap is already spent, so it must NOT attempt again — locking the bound
   * that a persistent no-op cannot emit/compact on every step. The turn still
   * completes (proactive failure is best-effort; the step proceeds uncompacted).
   */
  async testProactiveNoOp(message: string): Promise<OverflowChatResult> {
    this.proactiveMode = true;
    this.proactiveMultiFire = true;
    this.compactionNoOp = true;
    this.compactionCount = 0;
    this.modelCalls = 0;
    this.compactionEvents = 0;
    this.errorClassification = undefined;
    this.beforeTurnContinuations = [];
    this.promptIncludedSeedMarker = [];
    this.compactionEventPayloads = [];
    this.proactiveStepPrompts = [];
    // Default budget: maxRetries unset → proactive cap = max(1, 1) = 1.
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
      errorClassification: this.errorClassification,
      beforeTurnContinuations: this.beforeTurnContinuations,
      promptIncludedSeedMarker: this.promptIncludedSeedMarker
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
    this.beforeTurnContinuations = [];
    this.promptIncludedSeedMarker = [];
    this.compactionEventPayloads = [];
    this.proactiveStepPrompts = [];

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
      errorClassification: this.errorClassification,
      beforeTurnContinuations: this.beforeTurnContinuations,
      promptIncludedSeedMarker: this.promptIncludedSeedMarker
    };
  }

  /**
   * Programmatic (`saveMessages`) twin of the abort-during-recovery test: the
   * turn is cancelled at the overflow seam, so the driver must skip compaction
   * and the retry and surface the overflow terminally.
   */
  async testProgrammaticAbortDuringRecovery(
    message: string
  ): Promise<OverflowChatResult> {
    this.contextOverflow = { reactive: true };
    this.compactionNoOp = false;
    this.proactiveMode = false;
    this.alwaysOverflow = false;
    this.abortDuringRecovery = true;
    this.compactionCount = 0;
    this.modelCalls = 0;
    this.compactionEvents = 0;
    this.errorClassification = undefined;
    this.beforeTurnContinuations = [];
    this.promptIncludedSeedMarker = [];
    this.compactionEventPayloads = [];
    this.proactiveStepPrompts = [];

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
      errorClassification: this.errorClassification,
      beforeTurnContinuations: this.beforeTurnContinuations,
      promptIncludedSeedMarker: this.promptIncludedSeedMarker
    };
  }

  /**
   * Drives a single turn with BOTH layers enabled: the proactive guard fires
   * before step 2, the turn still overflows, and the reactive backstop recovers
   * it. Verifies the two layers cooperate (the recommended config).
   */
  async testCombinedProactiveReactive(
    message: string
  ): Promise<OverflowChatResult> {
    this.combinedProactiveReactive = true;
    this.proactiveMode = true;
    this.compactionNoOp = false;
    this.compactionCount = 0;
    this.modelCalls = 0;
    this.compactionEvents = 0;
    this.errorClassification = undefined;
    this.beforeTurnContinuations = [];
    this.promptIncludedSeedMarker = [];
    this.compactionEventPayloads = [];
    this.proactiveStepPrompts = [];
    // Proactive guard trips on the step-1 usage (inputTokens 10 ≥ threshold 9);
    // reactive (default maxRetries 1) catches the residual step-2 overflow.
    this.contextOverflow = {
      reactive: true,
      proactive: { maxInputTokens: 10 }
    };

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
      errorClassification: this.errorClassification,
      beforeTurnContinuations: this.beforeTurnContinuations,
      promptIncludedSeedMarker: this.promptIncludedSeedMarker
    };
  }

  /**
   * Reactive recovery driven by a provider that REJECTS `doStream` (a top-level
   * throw) rather than emitting an in-stream error part. Asserts the AI SDK
   * re-enqueues the rejection as a `{ type: "error" }` fullStream part so the
   * recovery seam still catches it and the turn recovers.
   */
  async testChatThrowingOverflow(message: string): Promise<OverflowChatResult> {
    this.contextOverflow = { reactive: true };
    this.throwOnOverflow = true;
    this.compactionNoOp = false;
    this.proactiveMode = false;
    this.compactionCount = 0;
    this.modelCalls = 0;
    this.compactionEvents = 0;
    this.errorClassification = undefined;
    this.beforeTurnContinuations = [];
    this.promptIncludedSeedMarker = [];
    this.compactionEventPayloads = [];
    this.proactiveStepPrompts = [];

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
      errorClassification: this.errorClassification,
      beforeTurnContinuations: this.beforeTurnContinuations,
      promptIncludedSeedMarker: this.promptIncludedSeedMarker
    };
  }
}
