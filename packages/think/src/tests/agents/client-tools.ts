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
import type { ChatResponseResult, MessageConcurrency } from "../../think";
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
  private _useServerApprovalTool = false;
  private _serverApprovalToolExecutions = 0;
  private _serverApprovalToolFails = false;
  private _slowDelayMs = 40;
  private _slowChunkCount = 4;
  private _responseLog: ChatResponseResult[] = [];

  override onChatResponse(result: ChatResponseResult): void {
    this._responseLog.push(result);
  }

  async getResponseLog(): Promise<ChatResponseResult[]> {
    return this._responseLog;
  }

  getModel(): LanguageModel {
    if (this._useSlowStream)
      return createSlowMockModel(this._slowDelayMs, this._slowChunkCount);
    if (this._useSlowClientToolStream)
      return createSlowClientToolMockModel(
        this._slowClientToolDelayMs,
        this._slowClientToolGaps
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
}
