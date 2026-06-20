/**
 * Test agent for Think client-side tool support.
 *
 * Uses a mock model that emits tool calls on the first invocation
 * and text on subsequent invocations (after tool results are applied).
 */

import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { Think } from "../../think";
import type {
  ChatResponseResult,
  MessageConcurrency,
  StreamCallback
} from "../../think";
import { StreamAccumulator, type ClientToolSchema } from "agents/chat";

function createClientToolMockModel(): LanguageModel {
  let callCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-client-tool-model",
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
              id: "tc-client-1",
              toolName: "client_action"
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: "tc-client-1",
              delta: JSON.stringify({ action: "do_thing" })
            });
            controller.enqueue({
              type: "tool-input-end",
              id: "tc-client-1"
            });
            controller.enqueue({
              type: "finish",
              finishReason: "tool-calls",
              usage: { inputTokens: 10, outputTokens: 5 }
            });
          } else {
            controller.enqueue({ type: "text-start", id: "t-cont" });
            controller.enqueue({
              type: "text-delta",
              id: "t-cont",
              delta: "Continuation after tool"
            });
            controller.enqueue({ type: "text-end", id: "t-cont" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 20, outputTokens: 10 }
            });
          }

          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

// Emits a client tool call (`tc-client-1`), then keeps the stream OPEN for a
// while (a series of timed gaps) before finishing. That open window is the
// #1649 race: the `tool-input-available` chunk has already been broadcast to
// the client — which can resolve the tool and send `cf_agent_tool_result` —
// but the assistant message hasn't been persisted yet. On the continuation
// invocation it emits plain text.
function createSlowClientToolMockModel(
  delayMs: number,
  trailingGaps: number
): LanguageModel {
  let callCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-slow-client-tool",
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
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });

          if (!hasToolResult && callCount === 1) {
            controller.enqueue({
              type: "tool-input-start",
              id: "tc-client-1",
              toolName: "client_action"
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: "tc-client-1",
              delta: JSON.stringify({ action: "do_thing" })
            });
            controller.enqueue({
              type: "tool-input-end",
              id: "tc-client-1"
            });
            // Finalize the tool call NOW so the SDK emits `tool-input-available`
            // mid-stream (a tool part left at `input-streaming` is only promoted
            // at `finish`, which is too late to model the race).
            controller.enqueue({
              type: "tool-call",
              toolCallId: "tc-client-1",
              toolName: "client_action",
              input: JSON.stringify({ action: "do_thing" })
            });
            // Hold the stream open with trailing text so a client tool result
            // can arrive before the end-of-stream persist (the #1649 window).
            // Streaming real chunks (not silent gaps) keeps the stall watchdog
            // happy and guarantees the tool call is already in the accumulator.
            controller.enqueue({ type: "text-start", id: "t-trail" });
            for (let i = 0; i < trailingGaps; i++) {
              await new Promise((r) => setTimeout(r, delayMs));
              controller.enqueue({
                type: "text-delta",
                id: "t-trail",
                delta: "."
              });
            }
            controller.enqueue({ type: "text-end", id: "t-trail" });
            controller.enqueue({
              type: "finish",
              finishReason: "tool-calls",
              usage: { inputTokens: 10, outputTokens: 5 }
            });
          } else {
            controller.enqueue({ type: "text-start", id: "t-cont" });
            controller.enqueue({
              type: "text-delta",
              id: "t-cont",
              delta: "Continuation after tool"
            });
            controller.enqueue({ type: "text-end", id: "t-cont" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 20, outputTokens: 10 }
            });
          }

          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

// Reproduces #1649's headline race (abhagsain's debug-log analysis): the model
// emits parallel client tool calls SEQUENTIALLY within one step. It streams a
// FAST tool's `tool-input-available` first, then holds the stream open (trailing
// text gaps) before emitting a SLOW tool's call and finishing. The fast tool's
// result can therefore arrive at the server BEFORE the slow tool has even been
// streamed — so no batch check can see the slow sibling yet. On the continuation
// invocation (tool results present) it emits plain text.
function createMidStreamParallelToolModel(
  gapMs: number,
  gapsBeforeSlow: number,
  gapsAfterSlow: number
): LanguageModel {
  let callCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-midstream-parallel-tool",
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
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });

          if (!hasToolResult && callCount === 1) {
            // Fast tool — emitted and finalized FIRST.
            controller.enqueue({
              type: "tool-input-start",
              id: "tc-fast",
              toolName: "fast_tool"
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: "tc-fast",
              delta: JSON.stringify({ action: "fast" })
            });
            controller.enqueue({ type: "tool-input-end", id: "tc-fast" });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "tc-fast",
              toolName: "fast_tool",
              input: JSON.stringify({ action: "fast" })
            });
            // Hold the stream open with trailing text — the window during which
            // the client resolves `tc-fast` while `tc-slow` is NOT yet emitted.
            controller.enqueue({ type: "text-start", id: "t-mid" });
            for (let i = 0; i < gapsBeforeSlow; i++) {
              await new Promise((r) => setTimeout(r, gapMs));
              controller.enqueue({
                type: "text-delta",
                id: "t-mid",
                delta: "."
              });
            }
            // Slow tool — emitted only AFTER the gap.
            controller.enqueue({
              type: "tool-input-start",
              id: "tc-slow",
              toolName: "slow_tool"
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: "tc-slow",
              delta: JSON.stringify({ action: "slow" })
            });
            controller.enqueue({ type: "tool-input-end", id: "tc-slow" });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "tc-slow",
              toolName: "slow_tool",
              input: JSON.stringify({ action: "slow" })
            });
            // Keep the stream open after the slow tool too, so a client result
            // for it can also land mid-stream (the all-fast batch scenario).
            for (let i = 0; i < gapsAfterSlow; i++) {
              await new Promise((r) => setTimeout(r, gapMs));
              controller.enqueue({
                type: "text-delta",
                id: "t-mid",
                delta: "."
              });
            }
            controller.enqueue({ type: "text-end", id: "t-mid" });
            controller.enqueue({
              type: "finish",
              finishReason: "tool-calls",
              usage: { inputTokens: 10, outputTokens: 5 }
            });
          } else {
            controller.enqueue({ type: "text-start", id: "t-cont" });
            controller.enqueue({
              type: "text-delta",
              id: "t-cont",
              delta: "Continuation after parallel tools"
            });
            controller.enqueue({ type: "text-end", id: "t-cont" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 20, outputTokens: 10 }
            });
          }

          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

function createServerApprovalToolMockModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-server-approval-tool-model",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented");
    },
    doStream(options: Record<string, unknown>) {
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
          if (!hasToolResult) {
            controller.enqueue({
              type: "tool-input-start",
              id: "tc-server-approval-1",
              toolName: "updateTrigger"
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: "tc-server-approval-1",
              delta: JSON.stringify({ enabled: true })
            });
            controller.enqueue({
              type: "tool-input-end",
              id: "tc-server-approval-1"
            });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "tc-server-approval-1",
              toolName: "updateTrigger",
              input: JSON.stringify({ enabled: true })
            });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage: {
                inputTokens: {
                  total: 10,
                  noCache: 10,
                  cacheRead: 0,
                  cacheWrite: 0
                },
                outputTokens: { total: 5, text: 5, reasoning: 0 }
              }
            });
          } else {
            controller.enqueue({ type: "text-start", id: "t-approved" });
            controller.enqueue({
              type: "text-delta",
              id: "t-approved",
              delta: "Trigger updated"
            });
            controller.enqueue({ type: "text-end", id: "t-approved" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: {
                  total: 20,
                  noCache: 20,
                  cacheRead: 0,
                  cacheWrite: 0
                },
                outputTokens: { total: 10, text: 10, reasoning: 0 }
              }
            });
          }
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

function createSlowMockModel(
  delayMs: number,
  chunkCount: number
): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-slow",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented");
    },
    doStream() {
      let chunkIndex = 0;
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t-slow" });
          for (let i = 0; i < chunkCount; i++) {
            await new Promise((r) => setTimeout(r, delayMs));
            chunkIndex++;
            controller.enqueue({
              type: "text-delta",
              id: "t-slow",
              delta: `chunk${chunkIndex} `
            });
          }
          controller.enqueue({ type: "text-end", id: "t-slow" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 10, outputTokens: chunkCount }
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

// Like createClientToolMockModel, but emits a complete `tool-call` chunk so the
// AI SDK will execute the tool server-side when it has an `execute` (the RPC
// `chat()` client-tool executor path, #1709). On the continuation step (after a
// tool result is in the prompt) it emits plain text.
function createExecutableClientToolMockModel(): LanguageModel {
  let callCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-executable-client-tool",
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
            const input = JSON.stringify({ action: "do_thing" });
            controller.enqueue({
              type: "tool-input-start",
              id: "tc-client-1",
              toolName: "client_action"
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: "tc-client-1",
              delta: input
            });
            controller.enqueue({ type: "tool-input-end", id: "tc-client-1" });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "tc-client-1",
              toolName: "client_action",
              input
            });
            controller.enqueue({
              type: "finish",
              finishReason: "tool-calls",
              usage: { inputTokens: 10, outputTokens: 5 }
            });
          } else {
            controller.enqueue({ type: "text-start", id: "t-cont" });
            controller.enqueue({
              type: "text-delta",
              id: "t-cont",
              delta: "Continuation after tool"
            });
            controller.enqueue({ type: "text-end", id: "t-cont" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 20, outputTokens: 10 }
            });
          }

          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

// Emits a complete client-tool call (input-start/delta/end + tool-call) onto a
// stream controller. Shared by the parallel/multi-step executable mocks below.
function enqueueClientToolCall(
  controller: ReadableStreamDefaultController,
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>
): void {
  const json = JSON.stringify(input);
  controller.enqueue({ type: "tool-input-start", id: toolCallId, toolName });
  controller.enqueue({ type: "tool-input-delta", id: toolCallId, delta: json });
  controller.enqueue({ type: "tool-input-end", id: toolCallId });
  controller.enqueue({ type: "tool-call", toolCallId, toolName, input: json });
}

// Emits TWO client-tool calls in a single step, then text on the continuation.
// Exercises parallel server-side execution of caller-supplied client tools.
function createParallelExecutableClientToolMockModel(): LanguageModel {
  let callCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-parallel-executable-client-tool",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented");
    },
    doStream() {
      callCount++;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (callCount === 1) {
            enqueueClientToolCall(controller, "tc-par-1", "client_action", {
              action: "first"
            });
            enqueueClientToolCall(controller, "tc-par-2", "client_action_2", {
              action: "second"
            });
            controller.enqueue({
              type: "finish",
              finishReason: "tool-calls",
              usage: { inputTokens: 10, outputTokens: 5 }
            });
          } else {
            controller.enqueue({ type: "text-start", id: "t-par" });
            controller.enqueue({
              type: "text-delta",
              id: "t-par",
              delta: "Continuation after parallel tools"
            });
            controller.enqueue({ type: "text-end", id: "t-par" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 20, outputTokens: 10 }
            });
          }
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

// Emits a client-tool call on step 1, a DIFFERENT client-tool call on step 2
// (after the first result lands), then text on step 3. Exercises the executor
// being invoked across multiple sequential steps within one chat() turn.
function createMultiStepExecutableClientToolMockModel(): LanguageModel {
  let callCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-multistep-executable-client-tool",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented");
    },
    doStream() {
      callCount++;
      const step = callCount;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (step === 1) {
            enqueueClientToolCall(controller, "tc-ms-1", "client_action", {
              action: "one"
            });
            controller.enqueue({
              type: "finish",
              finishReason: "tool-calls",
              usage: { inputTokens: 10, outputTokens: 5 }
            });
          } else if (step === 2) {
            enqueueClientToolCall(controller, "tc-ms-2", "client_action_2", {
              action: "two"
            });
            controller.enqueue({
              type: "finish",
              finishReason: "tool-calls",
              usage: { inputTokens: 10, outputTokens: 5 }
            });
          } else {
            controller.enqueue({ type: "text-start", id: "t-ms" });
            controller.enqueue({
              type: "text-delta",
              id: "t-ms",
              delta: "Done after two steps"
            });
            controller.enqueue({ type: "text-end", id: "t-ms" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 20, outputTokens: 10 }
            });
          }
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

function createTextOnlyMockModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-text-only",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented");
    },
    doStream() {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({
            type: "text-delta",
            id: "t1",
            delta: "Hello"
          });
          controller.enqueue({ type: "text-end", id: "t1" });
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

export class ThinkClientToolsAgent extends Think {
  private _useTextOnly = false;
  private _useSlowStream = false;
  private _useSlowClientToolStream = false;
  private _slowClientToolDelayMs = 30;
  private _slowClientToolGaps = 12;
  private _useMidStreamParallelToolStream = false;
  private _midStreamParallelGapMs = 40;
  private _midStreamParallelGapsBeforeSlow = 20;
  private _midStreamParallelGapsAfterSlow = 10;
  private _useServerApprovalTool = false;
  private _serverApprovalToolExecutions = 0;
  private _serverApprovalToolFails = false;
  private _useExecutableClientTool = false;
  private _useParallelExecutableClientTool = false;
  private _useMultiStepExecutableClientTool = false;
  private _slowDelayMs = 40;
  private _slowChunkCount = 4;
  private _responseLog: ChatResponseResult[] = [];
  private _lastTurnToolNames: string[] = [];

  override beforeTurn(ctx: { tools: ToolSet }): void {
    this._lastTurnToolNames = Object.keys(ctx.tools);
  }

  async getLastTurnToolNames(): Promise<string[]> {
    return this._lastTurnToolNames;
  }

  override onChatResponse(result: ChatResponseResult): void {
    this._responseLog.push(result);
  }

  async getResponseLog(): Promise<ChatResponseResult[]> {
    return this._responseLog;
  }

  // Drive a directly-invoked `chat()` (e.g. a caller passing `onClientToolCall`
  // over RPC) through the executable client-tool mock.
  async enableExecutableClientToolForTest(): Promise<void> {
    this._useExecutableClientTool = true;
  }

  getModel(): LanguageModel {
    if (this._useParallelExecutableClientTool)
      return createParallelExecutableClientToolMockModel();
    if (this._useMultiStepExecutableClientTool)
      return createMultiStepExecutableClientToolMockModel();
    if (this._useExecutableClientTool)
      return createExecutableClientToolMockModel();
    if (this._useSlowStream)
      return createSlowMockModel(this._slowDelayMs, this._slowChunkCount);
    if (this._useSlowClientToolStream)
      return createSlowClientToolMockModel(
        this._slowClientToolDelayMs,
        this._slowClientToolGaps
      );
    if (this._useMidStreamParallelToolStream)
      return createMidStreamParallelToolModel(
        this._midStreamParallelGapMs,
        this._midStreamParallelGapsBeforeSlow,
        this._midStreamParallelGapsAfterSlow
      );
    if (this._useTextOnly) return createTextOnlyMockModel();
    if (this._useServerApprovalTool) return createServerApprovalToolMockModel();
    return createClientToolMockModel();
  }

  override getTools(): ToolSet {
    if (!this._useServerApprovalTool) return {};
    return {
      updateTrigger: tool({
        description: "Enable or disable a trigger",
        inputSchema: z.object({ enabled: z.boolean() }),
        needsApproval: true,
        execute: async ({ enabled }: { enabled: boolean }) => {
          this._serverApprovalToolExecutions++;
          if (this._serverApprovalToolFails) {
            throw new Error("Trigger update failed");
          }
          return { enabled };
        }
      })
    };
  }

  getSystemPrompt(): string {
    return "You are a test assistant with client tools.";
  }

  async setTextOnlyMode(value: boolean): Promise<void> {
    this._useTextOnly = value;
  }

  async setServerApprovalToolMode(value: boolean): Promise<void> {
    this._useServerApprovalTool = value;
  }

  async getServerApprovalToolExecutions(): Promise<number> {
    return this._serverApprovalToolExecutions;
  }

  async setServerApprovalToolFailure(value: boolean): Promise<void> {
    this._serverApprovalToolFails = value;
  }

  async setSlowStreamMode(
    enabled: boolean,
    delayMs?: number,
    chunkCount?: number
  ): Promise<void> {
    this._useSlowStream = enabled;
    if (delayMs !== undefined) this._slowDelayMs = delayMs;
    if (chunkCount !== undefined) this._slowChunkCount = chunkCount;
  }

  async setSlowClientToolStreamMode(
    enabled: boolean,
    delayMs?: number,
    trailingGaps?: number
  ): Promise<void> {
    this._useSlowClientToolStream = enabled;
    if (delayMs !== undefined) this._slowClientToolDelayMs = delayMs;
    if (trailingGaps !== undefined) this._slowClientToolGaps = trailingGaps;
  }

  async setMidStreamParallelToolMode(
    enabled: boolean,
    gapMs?: number,
    gapsBeforeSlow?: number,
    gapsAfterSlow?: number
  ): Promise<void> {
    this._useMidStreamParallelToolStream = enabled;
    if (gapMs !== undefined) this._midStreamParallelGapMs = gapMs;
    if (gapsBeforeSlow !== undefined)
      this._midStreamParallelGapsBeforeSlow = gapsBeforeSlow;
    if (gapsAfterSlow !== undefined)
      this._midStreamParallelGapsAfterSlow = gapsAfterSlow;
  }

  /**
   * The state of a tool part in the in-flight streaming accumulator, or
   * undefined if no stream is active or the call isn't present yet. Lets a
   * test deterministically wait until the streaming turn has exposed a tool
   * call (so it can send the result mid-stream) instead of racing on timing.
   */
  async streamingToolCallState(
    toolCallId: string
  ): Promise<string | undefined> {
    const acc = (
      this as unknown as {
        _streamingAssistant: {
          parts: Array<Record<string, unknown>>;
        } | null;
      }
    )._streamingAssistant;
    if (!acc) return undefined;
    const part = acc.parts.find((p) => p.toolCallId === toolCallId);
    return part?.state as string | undefined;
  }

  /**
   * Deterministic reproduction of the #1649 "result arrives before persist"
   * race without depending on stream timing: a client tool call lives ONLY in
   * the in-flight accumulator (not yet persisted), a tool result is applied,
   * then the stream's end-of-stream persist runs. Returns the persisted state
   * so the test can assert the result survived (`output-available`) rather than
   * being dropped and later repaired (`input-available` → errored).
   */
  async simulateMidStreamClientToolResult(opts: {
    toolCallId: string;
    output: string;
  }): Promise<{ state: string; output: string }> {
    const internal = this as unknown as {
      _streamingAssistant: StreamAccumulator | null;
      _applyToolResult(toolCallId: string, output: unknown): Promise<void>;
      _persistAssistantMessage(msg: UIMessage): Promise<void>;
    };

    const accumulator = new StreamAccumulator({
      messageId: crypto.randomUUID(),
      existingParts: [
        {
          type: "tool-client_action",
          toolCallId: opts.toolCallId,
          toolName: "client_action",
          state: "input-available",
          input: { action: "do_thing" }
        } as unknown as UIMessage["parts"][number]
      ]
    });

    // The assistant message exists ONLY in the accumulator — a storage read
    // would not find it (mirrors a turn mid-stream, before persist).
    internal._streamingAssistant = accumulator;
    // A client tool result arrives over the WebSocket while the stream is open.
    await internal._applyToolResult(opts.toolCallId, opts.output);
    // The stream ends and persists the accumulated message.
    await internal._persistAssistantMessage(accumulator.toMessage());
    internal._streamingAssistant = null;

    const messages = (await this.getMessages()) as UIMessage[];
    const part = messages
      .flatMap((m) => m.parts as Array<Record<string, unknown>>)
      .find((p) => p.toolCallId === opts.toolCallId);
    return {
      state: (part?.state as string) ?? "missing",
      output: (part?.output as string) ?? ""
    };
  }

  /**
   * Same mid-stream race as {@link simulateMidStreamClientToolResult}, but for
   * an approval response: an `approval-requested` part lives only in the
   * in-flight accumulator when the approval arrives. Confirms the fix covers
   * the approval path (shared `_applyToolUpdateToMessages`), not just results.
   */
  async simulateMidStreamClientToolApproval(opts: {
    toolCallId: string;
    approved: boolean;
  }): Promise<{ state: string }> {
    const internal = this as unknown as {
      _streamingAssistant: StreamAccumulator | null;
      _applyToolApproval(toolCallId: string, approved: boolean): Promise<void>;
      _persistAssistantMessage(msg: UIMessage): Promise<void>;
    };

    const accumulator = new StreamAccumulator({
      messageId: crypto.randomUUID(),
      existingParts: [
        {
          type: "tool-client_action",
          toolCallId: opts.toolCallId,
          toolName: "client_action",
          state: "approval-requested",
          input: { action: "do_thing" }
        } as unknown as UIMessage["parts"][number]
      ]
    });

    internal._streamingAssistant = accumulator;
    await internal._applyToolApproval(opts.toolCallId, opts.approved);
    await internal._persistAssistantMessage(accumulator.toMessage());
    internal._streamingAssistant = null;

    const messages = (await this.getMessages()) as UIMessage[];
    const part = messages
      .flatMap((m) => m.parts as Array<Record<string, unknown>>)
      .find((p) => p.toolCallId === opts.toolCallId);
    return { state: (part?.state as string) ?? "missing" };
  }

  async getCapturedClientTools(): Promise<ClientToolSchema[] | undefined> {
    return (
      this as unknown as { _lastClientTools: ClientToolSchema[] | undefined }
    )._lastClientTools;
  }

  /**
   * Recovery-classification probe (#1709). Seeds a persisted assistant message
   * holding a `client_action` tool part stuck at `input-available` — the orphan
   * an eviction leaves when the model emitted the call but `execute` never
   * finished. Returns whether recovery would treat it as a pending CLIENT
   * interaction (park forever, waiting for an SPA replay) vs a recoverable
   * orphan (repaired by `continueLastTurn`). When `polluteRegistry` is set it
   * first writes the tool name into `_lastClientTools`, simulating the (wrong)
   * behavior of persisting RPC client tools — proving the registry is the lever.
   */
  async probeClientToolOrphanPending(opts: {
    polluteRegistry: boolean;
  }): Promise<boolean> {
    const internal = this as unknown as {
      _lastClientTools: ClientToolSchema[] | undefined;
      _persistAssistantMessage: (msg: UIMessage) => Promise<void>;
      hasPendingInteraction: () => boolean;
    };

    if (opts.polluteRegistry) {
      internal._lastClientTools = [
        { name: "client_action", description: "A client tool" }
      ];
    } else {
      internal._lastClientTools = undefined;
    }

    await internal._persistAssistantMessage({
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [
        {
          type: "tool-client_action",
          toolCallId: "tc-orphan-1",
          toolName: "client_action",
          state: "input-available",
          input: { action: "do_thing" }
        } as unknown as UIMessage["parts"][number]
      ]
    });

    return internal.hasPendingInteraction();
  }

  // Demonstrates the `repairInterruptedToolPart` override: a client-resolved
  // `ask_user` (a question with no server execute) is preserved as a text part
  // carrying the prompt rather than flipped to a generic errored tool result.
  protected override repairInterruptedToolPart(
    part: UIMessage["parts"][number]
  ): UIMessage["parts"][number] {
    const record = part as Record<string, unknown>;
    if (record.type === "tool-ask_user") {
      const input = record.input as { prompt?: unknown } | undefined;
      const prompt = typeof input?.prompt === "string" ? input.prompt : "";
      if (prompt) {
        return { type: "text", text: prompt } as UIMessage["parts"][number];
      }
    }
    return super.repairInterruptedToolPart(part);
  }

  async repairToolTranscriptPartsForTest(
    messages: UIMessage[]
  ): Promise<UIMessage[]> {
    return (
      this as unknown as {
        _repairToolTranscriptParts(m: UIMessage[]): { messages: UIMessage[] };
      }
    )._repairToolTranscriptParts(messages).messages;
  }

  async persistToolCallMessage(messages: UIMessage[]): Promise<void> {
    for (const msg of messages) {
      await this.session.appendMessage(msg);
    }
  }

  /**
   * Drives two overlapping read-modify-write applies through the
   * interaction-apply queue (#1649). Each apply reads a shared counter, yields
   * across an async gap, then writes `read + 1`. Without serialization both
   * read 0 before either writes, so the result is 1 (one update clobbered).
   * With serialization the second apply waits for the first, yielding 2.
   * Returns the final counter value.
   */
  async testInteractionApplySerialization(): Promise<number> {
    let shared = 0;
    const rmw = (gapMs: number) => async () => {
      const read = shared;
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      shared = read + 1;
    };
    // First apply takes the longer gap so a second, un-serialized apply would
    // read + write the stale value before the first commits.
    const first = this._enqueueInteractionApply(rmw(30));
    const second = this._enqueueInteractionApply(rmw(0));
    await Promise.all([first, second]);
    return shared;
  }

  async getBranches(messageId: string): Promise<UIMessage[]> {
    return (await this.session.getBranches(messageId)) as UIMessage[];
  }

  async setMessageConcurrency(concurrency: MessageConcurrency): Promise<void> {
    this.messageConcurrency = concurrency;
  }

  isChatTurnActiveForTest(): boolean {
    return (this as unknown as { _turnQueue: { isActive: boolean } })._turnQueue
      .isActive;
  }

  getOverlappingSubmitCountForTest(): number {
    return (
      this as unknown as {
        _submitConcurrency: { overlappingSubmitCount: number };
      }
    )._submitConcurrency.overlappingSubmitCount;
  }

  waitUntilStableForTest(options?: { timeout?: number }): Promise<boolean> {
    return this.waitUntilStable(options);
  }

  async clearResponseLog(): Promise<void> {
    this._responseLog.length = 0;
  }

  /**
   * Snapshot the event-driven barrier's in-memory state (#1650). Lets a test
   * assert that an orphaned batch (a sibling result that never arrives, e.g. the
   * client disconnected mid-batch) leaves the continuation pending in memory but
   * does NOT pin the isolate: no drain in progress (`barrierActive` false) and no
   * armed coalesce timer (`timerArmed` false). The pending stays so the next
   * result — if it ever comes — can complete the batch.
   */
  async getContinuationBarrierState(): Promise<{
    hasPending: boolean;
    barrierActive: boolean;
    timerArmed: boolean;
  }> {
    const internal = this as unknown as {
      _continuation: { pending: unknown };
      _autoContinuation: {
        _timer: ReturnType<typeof setTimeout> | null;
        _barrierActive: boolean;
      };
    };
    return {
      hasPending: internal._continuation.pending != null,
      barrierActive: internal._autoContinuation._barrierActive,
      timerArmed: internal._autoContinuation._timer != null
    };
  }

  /**
   * Simulate the in-memory auto-continuation state being lost to eviction
   * WITHOUT touching the persisted transcript (#1650). A real eviction drops
   * `_continuation.pending` and the coalesce timer but leaves messages in
   * storage; the next tool-result event must re-create the pending state from
   * the persisted transcript and still fire exactly once when the batch is
   * complete (self-healing). This nulls the in-memory barrier state to model
   * that, so a test can assert the continuation survives an eviction mid-batch.
   */
  async evictInMemoryContinuationState(): Promise<void> {
    const internal = this as unknown as {
      _continuation: { pending: unknown };
      _autoContinuation: { reset(): void };
      _pendingInteractionPromise: Promise<boolean> | null;
      _interactionApplyTail: Promise<void>;
    };
    // reset() cancels the coalesce timer and clears the double-fire guard.
    internal._autoContinuation.reset();
    internal._continuation.pending = null;
    internal._pendingInteractionPromise = null;
    internal._interactionApplyTail = Promise.resolve();
  }

  /**
   * Probe that `waitUntilStable` does NOT report stable while an
   * auto-continuation is armed (#1650) — the behavior `@cloudflare/think`
   * converged onto from `@cloudflare/ai-chat`. Holds the barrier active (a drain
   * in flight against a controlled, not-yet-resolved apply) so the controller
   * stays armed without firing, then probes `waitUntilStable` with a short
   * deadline. Returns whether the continuation was armed, whether the
   * message-level interaction check was clear (proving the armed branch — not a
   * pending HITL — drove the result), and whether `waitUntilStable` reported
   * stable (it must NOT: it should wait out the armed window and time out).
   */
  async testWaitUntilStableHoldsForArmedContinuation(
    timeoutMs: number
  ): Promise<{
    hasArmedContinuation: boolean;
    messageInteractionPending: boolean;
    stable: boolean;
  }> {
    const internal = this as unknown as {
      _continuation: {
        pending: Record<string, unknown> | null;
        awaitingConnections: Map<string, unknown>;
      };
      _autoContinuation: { fireWhenStable(): void; reset(): void };
      _pendingInteractionPromise: Promise<boolean> | null;
      _interactionApplyTail: Promise<void>;
      _hasArmedContinuation(): boolean;
    };

    // Seed an unfired pending continuation (no message-level interaction, so the
    // waitUntilStable loop reaches the armed-continuation branch rather than the
    // HITL branch).
    internal._continuation.pending = {
      connection: undefined,
      connectionId: "armed-test",
      requestId: crypto.randomUUID(),
      clientTools: undefined,
      body: undefined,
      errorPrefix: "[Think] Auto-continuation failed:",
      prerequisite: null,
      pastCoalesce: false
    };

    // Drive the controller into an in-flight drain so it stays armed
    // (`barrierActive`) without firing: a non-null pending-interaction promise
    // makes fireWhenStable take the drain path, and a not-yet-resolved apply
    // tail keeps the drain (and thus the barrier) open for the probe.
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    internal._pendingInteractionPromise = new Promise<boolean>(() => {});
    internal._interactionApplyTail = drainGate;
    internal._autoContinuation.fireWhenStable();

    try {
      const hasArmedContinuation = internal._hasArmedContinuation();
      const messageInteractionPending = this.hasPendingInteraction();
      const stable = await this.waitUntilStable({ timeout: timeoutMs });
      return { hasArmedContinuation, messageInteractionPending, stable };
    } finally {
      // Clear pending first so the drain's post-completion re-check bails
      // without firing, then release the drain and reset the barrier.
      internal._continuation.pending = null;
      internal._continuation.awaitingConnections.clear();
      internal._pendingInteractionPromise = null;
      releaseDrain();
      internal._interactionApplyTail = Promise.resolve();
      internal._autoContinuation.reset();
    }
  }

  /**
   * Drive the sub-agent RPC `chat()` entry point with client tools (#1709).
   *
   * Collects the streamed events through a local StreamCallback and, when
   * `withExecutor` is set, records each client-tool invocation the model makes
   * and resolves it inline. Mirrors a parent agent delegating to this sub-agent
   * over RPC. Returns enough state to assert the round trip completed.
   */
  async runChatWithClientTools(
    message: string,
    opts?: {
      withExecutor?: boolean;
      executorThrows?: boolean;
      mode?: "single" | "parallel" | "multistep";
    }
  ): Promise<{
    executorCalls: Array<{ toolName: string; inputJson: string }>;
    done: boolean;
    error?: string;
    assistantText: string;
    toolPartStates: string[];
    toolCalls: Array<{ toolName: string; state: string }>;
  }> {
    const mode = opts?.mode ?? "single";
    if (mode === "parallel") {
      this._useParallelExecutableClientTool = true;
    } else if (mode === "multistep") {
      this._useMultiStepExecutableClientTool = true;
    } else {
      this._useExecutableClientTool = true;
    }

    const executorCalls: Array<{ toolName: string; inputJson: string }> = [];
    let done = false;
    let error: string | undefined;
    const callback: StreamCallback = {
      onStart() {},
      onEvent() {},
      onDone() {
        done = true;
      },
      onError(e: string) {
        error = e;
      }
    };

    // The parallel/multi-step mocks reference a second client tool; register
    // both so the model's calls resolve regardless of mode.
    const clientTools: ClientToolSchema[] = [
      {
        name: "client_action",
        description: "A client tool",
        parameters: {
          type: "object",
          properties: { action: { type: "string" } }
        }
      },
      {
        name: "client_action_2",
        description: "A second client tool",
        parameters: {
          type: "object",
          properties: { action: { type: "string" } }
        }
      }
    ];

    await this.chat(message, callback, {
      clientTools,
      onClientToolCall: opts?.withExecutor
        ? ({ toolName, input }: { toolName: string; input: unknown }) => {
            executorCalls.push({ toolName, inputJson: JSON.stringify(input) });
            if (opts?.executorThrows) {
              throw new Error("client tool executor failed");
            }
            return { ok: true, echoed: input };
          }
        : undefined
    });

    const messages = (await this.getMessages()) as UIMessage[];
    const assistantParts = messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.parts as Array<Record<string, unknown>>);
    const assistantText = assistantParts
      .filter((p) => p.type === "text")
      .map((p) => p.text as string)
      .join("");
    const toolParts = assistantParts.filter(
      (p) => typeof p.toolCallId === "string"
    );
    const toolPartStates = toolParts.map((p) => p.state as string);
    const toolCalls = toolParts.map((p) => ({
      toolName:
        typeof p.type === "string" && p.type.startsWith("tool-")
          ? p.type.slice("tool-".length)
          : ((p.toolName as string) ?? ""),
      state: p.state as string
    }));

    return {
      executorCalls,
      done,
      error,
      assistantText,
      toolPartStates,
      toolCalls
    };
  }
}
