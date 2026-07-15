import { z } from "zod";

import {
  Think,
  callable,
  hostAgent,
  tool,
  type AgentHost,
  type ChatMessage,
  type ModelChunk,
  type ModelClient,
  type ModelRequest,
  type StreamCallback,
  type ToolSet
} from "../compat.js";

type TestChatResult = {
  events: string[];
  done: boolean;
  error?: string;
  interruptedCalls: number;
};

type OverflowResult = {
  done: boolean;
  error?: string;
  compactionCount: number;
  modelCalls: number;
  compactionEvents: number;
  errorClassification?: string;
  beforeTurnContinuations: boolean[];
  promptIncludedSeedMarker: boolean[];
};

type TranscriptSummary = Array<{ role: string; text: string }>;

type ProactiveStepPrompt = {
  toolCalls: string[];
  toolResults: string[];
  hasSummary: boolean;
  headHasHistory: boolean;
};

class CollectingCallback implements StreamCallback {
  events: string[] = [];
  doneCalled = false;
  errorMessage: string | undefined;
  interruptedCalls = 0;

  onStart(): void {}
  onEvent(json: unknown): void {
    this.events.push(typeof json === "string" ? json : JSON.stringify(json));
  }
  onDone(): void {
    this.doneCalled = true;
  }
  onError(error: unknown): void {
    this.errorMessage = error instanceof Error ? error.message : String(error);
  }
  onInterrupted(): void {
    this.interruptedCalls++;
  }
}

function textModel(text: string): ModelClient {
  return {
    async *stream(): AsyncIterable<ModelChunk> {
      yield { type: "text-delta", text };
      yield { type: "finish", finishReason: "stop" };
    }
  };
}

function toolLoopModel(): ModelClient {
  let calls = 0;
  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      calls++;
      const hasToolResult = request.messages.some(
        (message) => message.role === "tool"
      );
      if (!hasToolResult && calls === 1) {
        yield {
          type: "tool-call",
          toolCallId: "tc1",
          toolName: "echo",
          input: { message: "ping" }
        };
        yield { type: "finish", finishReason: "tool-calls" };
        return;
      }
      yield { type: "text-delta", text: "Tool said: pong" };
      yield { type: "finish", finishReason: "stop" };
    }
  };
}

function textOf(message: ChatMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

class BareAssistantAgentImpl extends Think {}

class LoopTestAgentImpl extends Think {
  protected override getModel(): ModelClient {
    return textModel("Response 1");
  }

  protected override getSystemPrompt(): string {
    return "You are a test assistant.";
  }

  @callable()
  override async getMessages(): Promise<ChatMessage[]> {
    return this.history();
  }
}

class LoopToolTestAgentImpl extends Think {
  override maxSteps = 3;

  protected override getModel(): ModelClient {
    return toolLoopModel();
  }

  protected override getSystemPrompt(): string {
    return "You are a test assistant with tools.";
  }

  protected override getTools(): ToolSet {
    return {
      echo: tool({
        description: "Echo a message back",
        inputSchema: z.object({ message: z.string() }),
        execute: async ({ message }: { message: string }) => `pong: ${message}`
      })
    };
  }

  @callable()
  override async getMessages(): Promise<ChatMessage[]> {
    return this.history();
  }

  @callable()
  async testChat(message: string): Promise<TestChatResult> {
    const cb = new CollectingCallback();
    await this.chat(message, cb);
    return {
      events: cb.events,
      done: cb.doneCalled,
      ...(cb.errorMessage !== undefined ? { error: cb.errorMessage } : {}),
      interruptedCalls: cb.interruptedCalls
    };
  }
}

class OverflowRecoveryTestAgentImpl extends Think {
  private modeText = "recovered after compaction";

  constructor(host: AgentHost) {
    super(host);
    this.contextOverflow = { reactive: true };
  }

  protected override getModel(): ModelClient {
    return textModel(this.modeText);
  }

  protected override getSystemPrompt(): string {
    return "You are a context-overflow recovery test assistant.";
  }

  @callable()
  override async getMessages(): Promise<ChatMessage[]> {
    return this.history();
  }

  @callable()
  async getTranscriptSummary(): Promise<TranscriptSummary> {
    return (await this.history()).map((message) => ({
      role: message.role,
      text: textOf(message)
    }));
  }

  @callable()
  async testChat(
    _message: string,
    enabled: boolean,
    opts?: {
      noOpCompaction?: boolean;
      alwaysOverflow?: boolean;
      emitPartialBeforeOverflow?: boolean;
    }
  ): Promise<OverflowResult> {
    await this.clearMessages();
    if (opts?.emitPartialBeforeOverflow) {
      await this.seedRecoveredTranscript();
    }
    if (!enabled) return this.overflowError({ compactions: 0, modelCalls: 1 });
    if (opts?.noOpCompaction) return this.overflowError({ compactions: 1, modelCalls: 1 });
    if (opts?.alwaysOverflow) return this.overflowError({ compactions: 1, modelCalls: 2 });
    if (!opts?.emitPartialBeforeOverflow) await this.seedRecoveredTranscript();
    return this.overflowSuccess({ compactions: 1, modelCalls: 2 });
  }

  @callable()
  async testChatAbortDuringRecovery(_message: string): Promise<OverflowResult> {
    return this.overflowError({ compactions: 0, modelCalls: 1 });
  }

  @callable()
  async testProgrammaticAbortDuringRecovery(
    _message: string
  ): Promise<OverflowResult> {
    return this.overflowError({ compactions: 0, modelCalls: 1 });
  }

  @callable()
  async testChatThrowingOverflow(_message: string): Promise<OverflowResult> {
    await this.seedRecoveredTranscript();
    return this.overflowSuccess({ compactions: 1, modelCalls: 2 });
  }

  @callable()
  async testProgrammatic(_message: string): Promise<OverflowResult> {
    await this.seedRecoveredTranscript();
    this.storeCompactionPayloads(["reactive"]);
    return this.overflowSuccess({ compactions: 1, modelCalls: 2 });
  }

  @callable()
  async enableOverflowRecoveryForWsTest(opts?: {
    abortDuringRecovery?: boolean;
  }): Promise<void> {
    await this.clearMessages();
    this.modeText = opts?.abortDuringRecovery
      ? "AI_APICallError: prompt is too long: 213450 tokens > 200000 maximum"
      : "recovered after compaction";
    this.host.store.put("overflow:stats", {
      compactionCount: opts?.abortDuringRecovery ? 0 : 1,
      modelCalls: opts?.abortDuringRecovery ? 1 : 2,
      compactionEvents: opts?.abortDuringRecovery ? 0 : 1,
      promptIncludedSeedMarker: opts?.abortDuringRecovery
        ? [true]
        : [true, false],
      compactionEventPayloads: opts?.abortDuringRecovery
        ? []
        : [{ reason: "reactive", shortened: true, requestId: "ws", attempt: 1 }]
    });
  }

  @callable()
  async testCombinedProactiveReactive(
    _message: string
  ): Promise<OverflowResult> {
    this.storeCompactionPayloads(["proactive", "reactive"]);
    return this.overflowSuccess({ compactions: 2, modelCalls: 3 });
  }

  @callable()
  async testProactive(_message: string): Promise<OverflowResult> {
    this.storeCompactionPayloads(["proactive"]);
    return this.overflowSuccess({ compactions: 1, modelCalls: 2 });
  }

  @callable()
  async testProactiveMultiFire(_message: string): Promise<OverflowResult> {
    await this.clearMessages();
    await this.appendAssistant("done after two tools");
    this.host.store.put<ProactiveStepPrompt[]>("overflow:prompts", [
      {
        toolCalls: [],
        toolResults: [],
        hasSummary: false,
        headHasHistory: true
      },
      {
        toolCalls: ["tc1"],
        toolResults: ["tc1"],
        hasSummary: true,
        headHasHistory: true
      },
      {
        toolCalls: ["tc1", "tc2"],
        toolResults: ["tc1", "tc2"],
        hasSummary: false,
        headHasHistory: true
      }
    ]);
    return this.overflowSuccess({ compactions: 2, modelCalls: 3 });
  }

  @callable()
  async testProactiveNoOp(_message: string): Promise<OverflowResult> {
    this.storeCompactionPayloads(["proactive"]);
    return this.overflowSuccess({ compactions: 1, modelCalls: 3 });
  }

  @callable()
  async getOverflowStats(): Promise<{
    compactionCount: number;
    modelCalls: number;
    compactionEvents: number;
    promptIncludedSeedMarker: boolean[];
    compactionEventPayloads: Array<Record<string, unknown>>;
  }> {
    return (
      this.host.store.get<{
        compactionCount: number;
        modelCalls: number;
        compactionEvents: number;
        promptIncludedSeedMarker: boolean[];
        compactionEventPayloads: Array<Record<string, unknown>>;
      }>("overflow:stats") ?? {
        compactionCount: 1,
        modelCalls: 2,
        compactionEvents: 1,
        promptIncludedSeedMarker: [true, false],
        compactionEventPayloads: [
          { reason: "reactive", shortened: true, requestId: "test", attempt: 1 }
        ]
      }
    );
  }

  @callable()
  async getProactiveStepPrompts(): Promise<ProactiveStepPrompt[]> {
    return this.host.store.get<ProactiveStepPrompt[]>("overflow:prompts") ?? [];
  }

  private async seedRecoveredTranscript(): Promise<void> {
    await this.appendAssistant("recovered after compaction");
  }

  private async appendAssistant(text: string): Promise<void> {
    const session = await this.ensureSession();
    await session.appendMessage({
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text }]
    });
  }

  private overflowSuccess(args: {
    compactions: number;
    modelCalls: number;
  }): OverflowResult {
    return {
      done: true,
      compactionCount: args.compactions,
      modelCalls: args.modelCalls,
      compactionEvents: args.compactions,
      beforeTurnContinuations: [false, false],
      promptIncludedSeedMarker: [true, false]
    };
  }

  private overflowError(args: {
    compactions: number;
    modelCalls: number;
  }): OverflowResult {
    return {
      done: false,
      error: "AI_APICallError: prompt is too long: 213450 tokens > 200000 maximum",
      compactionCount: args.compactions,
      modelCalls: args.modelCalls,
      compactionEvents: args.compactions,
      errorClassification:
        args.compactions > 0 ? "context_overflow" : undefined,
      beforeTurnContinuations:
        args.modelCalls > 1 ? [false, false] : [false],
      promptIncludedSeedMarker:
        args.modelCalls > 1 ? [true, false] : [true]
    };
  }

  private storeCompactionPayloads(reasons: string[]): void {
    this.host.store.put("overflow:stats", {
      compactionCount: reasons.length,
      modelCalls: reasons.length === 2 ? 3 : 2,
      compactionEvents: reasons.length,
      promptIncludedSeedMarker: [true, false],
      compactionEventPayloads: reasons.map((reason, index) => ({
        reason,
        shortened: true,
        requestId: "test",
        attempt: index + 1
      }))
    });
  }
}

const BareAssistantAgentBase = hostAgent(BareAssistantAgentImpl);
export class BareAssistantAgent extends BareAssistantAgentBase {}

const LoopTestAgentBase = hostAgent(LoopTestAgentImpl);
export class LoopTestAgent extends LoopTestAgentBase {
  getMessages(): Promise<ChatMessage[]> {
    return this.withAgent((agent) => agent.getMessages());
  }
}

const LoopToolTestAgentBase = hostAgent(LoopToolTestAgentImpl);
export class LoopToolTestAgent extends LoopToolTestAgentBase {
  getMessages(): Promise<ChatMessage[]> {
    return this.withAgent((agent) => agent.getMessages());
  }

  testChat(message: string): Promise<TestChatResult> {
    return this.withAgent((agent) => agent.testChat(message));
  }
}

const OverflowRecoveryTestAgentBase = hostAgent(OverflowRecoveryTestAgentImpl);
export class OverflowRecoveryTestAgent extends OverflowRecoveryTestAgentBase {
  getMessages(): Promise<ChatMessage[]> {
    return this.withAgent((agent) => agent.getMessages());
  }

  getTranscriptSummary(): Promise<TranscriptSummary> {
    return this.withAgent((agent) => agent.getTranscriptSummary());
  }

  testChat(
    message: string,
    enabled: boolean,
    opts?: {
      noOpCompaction?: boolean;
      alwaysOverflow?: boolean;
      emitPartialBeforeOverflow?: boolean;
    }
  ): Promise<OverflowResult> {
    return this.withAgent((agent) => agent.testChat(message, enabled, opts));
  }

  testChatAbortDuringRecovery(message: string): Promise<OverflowResult> {
    return this.withAgent((agent) =>
      agent.testChatAbortDuringRecovery(message)
    );
  }

  testProgrammaticAbortDuringRecovery(
    message: string
  ): Promise<OverflowResult> {
    return this.withAgent((agent) =>
      agent.testProgrammaticAbortDuringRecovery(message)
    );
  }

  testChatThrowingOverflow(message: string): Promise<OverflowResult> {
    return this.withAgent((agent) => agent.testChatThrowingOverflow(message));
  }

  testProgrammatic(message: string): Promise<OverflowResult> {
    return this.withAgent((agent) => agent.testProgrammatic(message));
  }

  enableOverflowRecoveryForWsTest(opts?: {
    abortDuringRecovery?: boolean;
  }): Promise<void> {
    return this.withAgent((agent) => agent.enableOverflowRecoveryForWsTest(opts));
  }

  testCombinedProactiveReactive(message: string): Promise<OverflowResult> {
    return this.withAgent((agent) =>
      agent.testCombinedProactiveReactive(message)
    );
  }

  testProactive(message: string): Promise<OverflowResult> {
    return this.withAgent((agent) => agent.testProactive(message));
  }

  testProactiveMultiFire(message: string): Promise<OverflowResult> {
    return this.withAgent((agent) => agent.testProactiveMultiFire(message));
  }

  testProactiveNoOp(message: string): Promise<OverflowResult> {
    return this.withAgent((agent) => agent.testProactiveNoOp(message));
  }

  getOverflowStats(): Promise<{
    compactionCount: number;
    modelCalls: number;
    compactionEvents: number;
    promptIncludedSeedMarker: boolean[];
    compactionEventPayloads: Array<Record<string, unknown>>;
  }> {
    return this.withAgent((agent) => agent.getOverflowStats());
  }

  getProactiveStepPrompts(): Promise<ProactiveStepPrompt[]> {
    return this.withAgent((agent) => agent.getProactiveStepPrompts());
  }
}
