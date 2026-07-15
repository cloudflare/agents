import { routeAgentRequest } from "../src/adapters/cloudflare/routing.js";
import { hostAgent } from "../src/adapters/cloudflare/shell.js";
import { Think } from "../src/app/think.js";
import { action, type Action } from "../src/domain/actions/actions.js";
import {
  defaultContextOverflowClassifier,
  type ChatErrorClassification
} from "../src/domain/reliability/recovery/overflow.js";
import { stableHash } from "../src/kernel/ids.js";
import { callable } from "../src/domain/runtime/rpc/callable.js";
import type { ChatMessage } from "../src/domain/messages/model.js";
import type { StoredEvent } from "../src/domain/events/log.js";
import type {
  ChatErrorContext,
  StreamCallback
} from "../src/app/think.js";
import { tool, type ToolSet } from "../src/domain/tools/types.js";
import type { SessionBuilder } from "../src/domain/session/builder.js";
import type { TurnContext } from "../src/domain/turn/loop.js";
import type {
  ModelChunk,
  ModelClient,
  ModelRequest
} from "../src/ports/model.js";
import { z } from "zod";

type RecoveryContextLogEntry = {
  streamId: string;
  requestId: string;
  partialText: string;
};

type RecoveryStatus = {
  recoveryCount: number;
  contexts: RecoveryContextLogEntry[];
  messageCount: number;
  assistantMessages: number;
};

type AgentToolRunStatus = {
  runId: string;
  status: string;
  error: string | null;
};

const RECOVERY_CONTEXTS_KEY = "test:recovery-contexts";
const RECOVERY_BEHAVIOR_KEY = "test:recovery-behavior";
const BEFORE_TURN_ERROR_KEY = "test:before-turn-error";
const ON_ERROR_LOG_KEY = "test:on-error-log";
const ON_CHAT_ERROR_LOG_KEY = "test:on-chat-error-log";
const AGENT_TOOL_RUNS_KEY = "test:agent-tool-runs";
const TOOL_ROLLBACK_TOTAL_STEPS = 30;
const TOOL_ROLLBACK_EXEC_DELAY_MS = 600;
const ACTION_PAUSE_EXEC_COUNT_KEY = "test:action-pause-exec-count";
const ACTION_PAUSE_ACK = "approved and acknowledged";
const LEDGER_RECOVERY_EXEC_COUNT_KEY = "test:ledger-recovery-exec-count";
const LEDGER_RECOVERY_KEY = "ledger-recovery-key";
const LEDGER_RECOVERY_MESSAGE = "ledger work";
const LEDGER_RECOVERY_ACK = "ledger action acknowledged";

type ToolLoopMode = "rollback" | "persist-false";
type OverflowMode = "recover" | "exhaust" | "proactive";
type OverflowChatOutcome = {
  done: boolean;
  error: string | null;
  compactionCount: number;
  compactionReasons: string[];
  modelCalls: number;
  assistantMessages: number;
  finalText: string;
  errorClassification: string | null;
};
type SubmissionView = { status: string; error: string | null } | null;
type InternalSubmissionRow = {
  submissionId: string;
  seq: number;
  status: string;
  acceptedAt: number;
  startedAt?: number;
  settledAt?: number;
  error?: string;
  messages: ChatMessage[];
};

function countToolResults(request: ModelRequest): number {
  return request.messages
    .filter((message) => message.role === "tool")
    .reduce((count, message) => count + message.content.length, 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSlowE2EMockModel(): ModelClient {
  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        if (request.signal?.aborted) {
          throw new Error("aborted");
        }
        yield { type: "text-delta", text: `chunk${i + 1} ` };
      }
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20 }
      };
    }
  };
}

function createToolLoopMockModel(totalSteps: number): ModelClient {
  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      const nextIndex = countToolResults(request) + 1;
      if (nextIndex > totalSteps) {
        yield { type: "text-delta", text: "DONE" };
        yield {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5 }
        };
        return;
      }
      yield {
        type: "tool-call",
        toolCallId: `tc-${nextIndex}`,
        toolName: "recordStep",
        input: { index: nextIndex }
      };
      yield {
        type: "finish",
        finishReason: "tool-calls",
        usage: { inputTokens: 10, outputTokens: 5 }
      };
    }
  };
}

function createStallThenStreamMockModel(nextCall: () => number): ModelClient {
  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      const stallThisCall = nextCall() === 1;
      yield { type: "text-delta", text: "partial " };
      if (stallThisCall) {
        await new Promise<void>((resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => reject(request.signal?.reason ?? new Error("aborted")),
            { once: true }
          );
        });
        return;
      }
      yield { type: "text-delta", text: "RECOVERED" };
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 }
      };
    }
  };
}

function createContextOverflowModel(
  nextCall: () => number,
  mode: "recover" | "exhaust"
): ModelClient {
  return {
    async *stream(): AsyncIterable<ModelChunk> {
      const overflow = mode === "exhaust" || nextCall() === 1;
      if (overflow) {
        yield { type: "text-delta", text: "partial answer before overflow" };
        throw new Error(
          "AI_APICallError: prompt is too long: 213450 tokens > 200000 maximum"
        );
      }
      yield { type: "text-delta", text: "recovered after compaction" };
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 10 }
      };
    }
  };
}

function createProactiveUsageModel(): ModelClient {
  let callCount = 0;
  return {
    async *stream(): AsyncIterable<ModelChunk> {
      callCount++;
      if (callCount === 1) {
        yield {
          type: "tool-call",
          toolCallId: "tc-echo",
          toolName: "echo",
          input: { message: "ping" }
        };
        yield {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 10, outputTokens: 5 }
        };
        return;
      }
      yield { type: "text-delta", text: "answered with headroom to spare" };
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 10 }
      };
    }
  };
}

function createActionPauseMockModel(): ModelClient {
  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      const hasToolResult = countToolResults(request) > 0;
      if (!hasToolResult) {
        yield {
          type: "tool-call",
          toolCallId: "ap1",
          toolName: "pauseAction",
          input: { message: "deploy me" }
        };
        yield {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 10, outputTokens: 5 }
        };
        return;
      }
      yield { type: "text-delta", text: ACTION_PAUSE_ACK };
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 10 }
      };
    }
  };
}

function createLedgerActionMockModel(): ModelClient {
  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      const hasToolResult = countToolResults(request) > 0;
      if (!hasToolResult) {
        yield {
          type: "tool-call",
          toolCallId: "al1",
          toolName: "slowAction",
          input: { message: LEDGER_RECOVERY_MESSAGE }
        };
        yield {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 10, outputTokens: 5 }
        };
        return;
      }
      yield { type: "text-delta", text: LEDGER_RECOVERY_ACK };
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 10 }
      };
    }
  };
}

function textOf(message: ChatMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function chunkTextFrom(stored: StoredEvent): string {
  const event = stored.event;
  if (event.type !== "chunk") return "";
  const chunk = event.chunk;
  return chunk.type === "text-delta" ? chunk.delta : "";
}

class CollectingChatCallback implements StreamCallback {
  doneCalled = false;
  errorMessage: string | null = null;

  onStart(): void {}
  onEvent(): void {}
  onDone(): void {
    this.doneCalled = true;
  }
  onError(error: unknown): void {
    this.errorMessage = error instanceof Error ? error.message : String(error);
  }
}

abstract class ToolLoopBaseAgent extends Think {
  override chatRecovery = true;
  override maxSteps = 500;
  override workspaceTools = false;

  protected abstract readonly loopMode: ToolLoopMode;

  protected override getModel(): ModelClient {
    return createToolLoopMockModel(TOOL_ROLLBACK_TOTAL_STEPS);
  }

  protected override getSystemPrompt(): string {
    return "Record each step in order using the recordStep tool.";
  }

  protected override getTools(): ToolSet {
    return {
      recordStep: tool({
        description: "Record a step by its index.",
        inputSchema: z.object({ index: z.number() }),
        execute: async ({ index }: { index: number }): Promise<{
          recorded: number;
        }> => {
          const rows = this.host.store.get<number[]>("test:tool-ledger") ?? [];
          this.host.store.put("test:tool-ledger", [...rows, index]);
          await sleep(TOOL_ROLLBACK_EXEC_DELAY_MS);
          return { recorded: index };
        }
      })
    };
  }

  override onChatRecovery = async (): Promise<void> => {
    const n = this.host.store.get<number>("tool:recovery-count") ?? 0;
    this.host.store.put("tool:recovery-count", n + 1);
    void this.loopMode;
  };

  protected toolRows(): number[] {
    return this.host.store.get<number[]>("test:tool-ledger") ?? [];
  }

  protected recoveryCount(): number {
    return this.host.store.get<number>("tool:recovery-count") ?? 0;
  }

  protected async loopStatus(): Promise<{
    totalExecutions: number;
    uniqueIndices: number;
    maxIndex: number;
    duplicates: Array<{ index: number; count: number }>;
    recoveryCount: number;
    assistantMessages: number;
    hasFiberRows: boolean;
    settledToolPartsInTranscript?: number;
  }> {
    const rows = this.toolRows();
    const counts = new Map<number, number>();
    for (const index of rows) {
      counts.set(index, (counts.get(index) ?? 0) + 1);
    }
    const messages = await this.getMessages();
    const assistant = messages.filter((m) => m.role === "assistant");
    const settledToolPartsInTranscript = assistant.reduce((sum, message) => {
      return (
        sum +
        message.parts.filter((part) => {
          const maybe = part as {
            type?: unknown;
            output?: unknown;
            state?: unknown;
          };
          return (
            typeof maybe.type === "string" &&
            maybe.type.startsWith("tool-") &&
            (maybe.output !== undefined || maybe.state === "output-available")
          );
        }).length
      );
    }, 0);
    return {
      totalExecutions: rows.length,
      uniqueIndices: counts.size,
      maxIndex: rows.reduce((max, index) => Math.max(max, index), 0),
      duplicates: [...counts]
        .filter(([, count]) => count > 1)
        .map(([index, count]) => ({ index, count })),
      recoveryCount: this.recoveryCount(),
      assistantMessages: assistant.length,
      hasFiberRows: this.listFibers({
        name: "chat-turn",
        status: ["pending", "running", "interrupted"]
      }).length > 0,
      settledToolPartsInTranscript
    };
  }
}

class ThinkToolRollbackE2EAgentImpl extends ToolLoopBaseAgent {
  protected readonly loopMode = "rollback";

  @callable()
  async getLedgerStatus(): Promise<{
    totalExecutions: number;
    uniqueIndices: number;
    maxIndex: number;
    duplicates: Array<{ index: number; count: number }>;
    recoveryCount: number;
    assistantMessages: number;
    hasFiberRows: boolean;
  }> {
    const status = await this.loopStatus();
    return {
      totalExecutions: status.totalExecutions,
      uniqueIndices: status.uniqueIndices,
      maxIndex: status.maxIndex,
      duplicates: status.duplicates,
      recoveryCount: status.recoveryCount,
      assistantMessages: status.assistantMessages,
      hasFiberRows: status.hasFiberRows
    };
  }
}

class ThinkPersistFalseE2EAgentImpl extends ToolLoopBaseAgent {
  protected readonly loopMode = "persist-false";

  @callable()
  async getPersistFalseStatus(): Promise<{
    totalExecutions: number;
    uniqueIndices: number;
    maxIndex: number;
    recoveryCount: number;
    assistantMessages: number;
    settledToolPartsInTranscript: number;
    hasFiberRows: boolean;
  }> {
    const status = await this.loopStatus();
    return {
      totalExecutions: status.totalExecutions,
      uniqueIndices: status.uniqueIndices,
      maxIndex: status.maxIndex,
      recoveryCount: status.recoveryCount,
      assistantMessages: status.assistantMessages,
      settledToolPartsInTranscript: status.settledToolPartsInTranscript ?? 0,
      hasFiberRows: status.hasFiberRows
    };
  }
}

function createSingleTaskModel(): ModelClient {
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
          toolCallId: "task-1",
          toolName: "runTask",
          input: { taskId: 1 }
        };
        yield { type: "finish", finishReason: "tool-calls" };
        return;
      }
      yield { type: "text-delta", text: "task complete" };
      yield { type: "finish", finishReason: "stop" };
    }
  };
}

const CHILD_TASK_RUN_ID = "agent-tool:task-1";
const SLOW_CHILD_TOTAL_STEPS = 60;
const SLOW_CHILD_EXEC_DELAY_MS = 2700;

type ChildLedgerStatus = {
  totalExecutions: number;
  uniqueIndices: number;
  maxIndex: number;
  duplicates: Array<{ index: number; count: number }>;
  recoveryCount: number;
  hasFiberRows: boolean;
};

class ThinkTaskParentE2EAgentImpl extends Think {
  override chatRecovery = true;
  override maxSteps = 50;
  override workspaceTools = false;

  protected override getModel(): ModelClient {
    return createSingleTaskModel();
  }

  protected override getSystemPrompt(): string {
    return "Run the seeding task exactly once using runTask.";
  }

  protected override getTools(): ToolSet {
    return {
      runTask: this.agentTool("ThinkToolRollbackE2EAgent", {
        description: "Run the seeding task as a child agent.",
        inputSchema: z.object({ taskId: z.number() })
      })
    };
  }

  override onChatRecovery = async (): Promise<void> => {
    const n = this.host.store.get<number>("parent:recovery-count") ?? 0;
    this.host.store.put("parent:recovery-count", n + 1);
  };

  @callable()
  async getTaskStatus(): Promise<{
    parentTaskExecutions: number;
    parentRecoveries: number;
    parentHasFiberRows: boolean;
    child: ChildLedgerStatus | null;
  }> {
    return {
      parentTaskExecutions: this.listSubAgents("ThinkToolRollbackE2EAgent").length,
      parentRecoveries:
        this.host.store.get<number>("parent:recovery-count") ?? 0,
      parentHasFiberRows: this.hasChatFiberRows(),
      child: await this.readToolRollbackChild()
    };
  }

  protected hasChatFiberRows(): boolean {
    return (
      this.listFibers({
        name: "chat-turn",
        status: ["pending", "running", "interrupted"]
      }).length > 0
    );
  }

  protected async readToolRollbackChild(): Promise<ChildLedgerStatus | null> {
    try {
      return await this.subAgent(
        "ThinkToolRollbackE2EAgent",
        CHILD_TASK_RUN_ID
      ).call<ChildLedgerStatus>("getLedgerStatus", []);
    } catch {
      return null;
    }
  }
}

class ThinkAgentToolNaturalParentE2EAgentImpl extends ThinkTaskParentE2EAgentImpl {
  @callable()
  override async getTaskStatus(): Promise<{
    parentTaskExecutions: number;
    parentRecoveries: number;
    parentHasFiberRows: boolean;
    parentChildStatus: string | null;
    child: ChildLedgerStatus | null;
  }> {
    const run = this.inspectAgentToolRun(CHILD_TASK_RUN_ID);
    return {
      parentTaskExecutions: this.listSubAgents("ThinkToolRollbackE2EAgent").length,
      parentRecoveries:
        this.host.store.get<number>("parent:recovery-count") ?? 0,
      parentHasFiberRows: this.hasChatFiberRows(),
      parentChildStatus: run?.status ?? null,
      child: await this.readToolRollbackChild()
    };
  }
}

class ThinkSlowChildE2EAgentImpl extends ToolLoopBaseAgent {
  protected readonly loopMode = "rollback";

  protected override getModel(): ModelClient {
    return createToolLoopMockModel(SLOW_CHILD_TOTAL_STEPS);
  }

  protected override getTools(): ToolSet {
    return {
      recordStep: tool({
        description: "Record a step by its index.",
        inputSchema: z.object({ index: z.number() }),
        execute: async ({ index }: { index: number }): Promise<{
          recorded: number;
        }> => {
          const rows = this.host.store.get<number[]>("test:tool-ledger") ?? [];
          this.host.store.put("test:tool-ledger", [...rows, index]);
          await sleep(SLOW_CHILD_EXEC_DELAY_MS);
          return { recorded: index };
        }
      })
    };
  }

  @callable()
  async getLedgerStatus(): Promise<ChildLedgerStatus> {
    const status = await this.loopStatus();
    return {
      totalExecutions: status.totalExecutions,
      uniqueIndices: status.uniqueIndices,
      maxIndex: status.maxIndex,
      duplicates: status.duplicates,
      recoveryCount: status.recoveryCount,
      hasFiberRows: status.hasFiberRows
    };
  }
}

class ThinkSlowChildParentE2EAgentImpl extends Think {
  override chatRecovery = true;
  override maxSteps = 50;
  override workspaceTools = false;

  protected override getModel(): ModelClient {
    return createSingleTaskModel();
  }

  protected override getSystemPrompt(): string {
    return "Run the seeding task exactly once using runTask.";
  }

  protected override getTools(): ToolSet {
    return {
      runTask: this.agentTool("ThinkSlowChildE2EAgent", {
        description: "Run the seeding task as a child agent.",
        inputSchema: z.object({ taskId: z.number() })
      })
    };
  }

  override onChatRecovery = async (): Promise<void> => {
    const n = this.host.store.get<number>("parent:recovery-count") ?? 0;
    this.host.store.put("parent:recovery-count", n + 1);
  };

  @callable()
  async getTaskStatus(): Promise<{
    parentRecoveries: number;
    parentHasFiberRows: boolean;
    parentChildStatus: string | null;
    parentChildError: string | null;
    child: {
      maxIndex: number;
      uniqueIndices: number;
      recoveryCount: number;
      hasFiberRows: boolean;
    } | null;
  }> {
    const run = this.inspectAgentToolRun(CHILD_TASK_RUN_ID);
    const child = await this.readSlowChild();
    return {
      parentRecoveries:
        this.host.store.get<number>("parent:recovery-count") ?? 0,
      parentHasFiberRows:
        this.listFibers({
          name: "chat-turn",
          status: ["pending", "running", "interrupted"]
        }).length > 0,
      parentChildStatus: run?.status ?? null,
      parentChildError: run?.error ?? null,
      child:
        child === null
          ? null
          : {
              maxIndex: child.maxIndex,
              uniqueIndices: child.uniqueIndices,
              recoveryCount: child.recoveryCount,
              hasFiberRows: child.hasFiberRows
            }
    };
  }

  private async readSlowChild(): Promise<ChildLedgerStatus | null> {
    try {
      return await this.subAgent(
        "ThinkSlowChildE2EAgent",
        CHILD_TASK_RUN_ID
      ).call<ChildLedgerStatus>("getLedgerStatus", []);
    } catch {
      return null;
    }
  }
}

class ThinkStallRecoveryE2EAgentImpl extends Think {
  override chatRecovery = true;
  override chatStreamStallTimeoutMs = 2000;
  override workspaceTools = false;
  private inferenceCount = 0;

  protected override getModel(): ModelClient {
    return createStallThenStreamMockModel(() => ++this.inferenceCount);
  }

  protected override getSystemPrompt(): string {
    return "Stall-recovery e2e agent.";
  }

  @callable()
  async getStallStatus(): Promise<{
    assistantMessages: number;
    finalText: string;
    hasFiberRows: boolean;
  }> {
    const messages = await this.getMessages();
    const assistant = messages.filter((m) => m.role === "assistant");
    const final = assistant[assistant.length - 1];
    return {
      assistantMessages: assistant.length,
      finalText: final ? textOf(final) : "",
      hasFiberRows: this.listFibers({
        name: "chat-turn",
        status: ["pending", "running", "interrupted"]
      }).length > 0
    };
  }
}

class ThinkContextOverflowE2EAgentImpl extends Think {
  override maxSteps = 4;
  override workspaceTools = false;
  private inferenceCount = 0;
  private mode: OverflowMode = "recover";
  private compactionCount = 0;
  private compactionReasons: string[] = [];
  private modelCalls = 0;
  private errorClassification: string | null = null;

  protected override getModel(): ModelClient {
    this.modelCalls++;
    if (this.mode === "proactive") return createProactiveUsageModel();
    return createContextOverflowModel(
      () => ++this.inferenceCount,
      this.mode === "exhaust" ? "exhaust" : "recover"
    );
  }

  protected override getSystemPrompt(): string {
    return "You are a context-overflow recovery e2e agent.";
  }

  protected override getTools(): ToolSet {
    if (this.mode !== "proactive") return {};
    return {
      echo: tool({
        description: "Echo a message back.",
        inputSchema: z.object({ message: z.string() }),
        execute: ({ message }: { message: string }): string => `pong: ${message}`
      })
    };
  }

  override classifyChatError = (
    error: unknown
  ): ChatErrorClassification | void => defaultContextOverflowClassifier(error);

  override onChatError = async (
    _error: unknown,
    ctx: ChatErrorContext
  ): Promise<void> => {
    this.errorClassification = ctx.classification ?? null;
  };

  protected override configureSession(builder: SessionBuilder): SessionBuilder {
    return builder.onCompaction(async () => "compacted-summary", {
      protectHead: 0,
      tailTokenBudget: 1,
      minTailMessages: 1
    });
  }

  @callable()
  async runOverflowChat(
    message: string,
    mode: OverflowMode
  ): Promise<OverflowChatOutcome> {
    this.mode = mode;
    this.inferenceCount = 0;
    this.compactionCount = 0;
    this.compactionReasons = [];
    this.modelCalls = 0;
    this.errorClassification = null;
    const unsubscribe = this.bus.subscribe("chat", (event) => {
      if (event.type !== "chat:context:compacted") return;
      this.compactionCount++;
      const reason = event.payload.reason;
      if (typeof reason === "string") this.compactionReasons.push(reason);
    });

    this.contextOverflow =
      mode === "proactive"
        ? { proactive: { maxInputTokens: 10 } }
        : { reactive: true };

    try {
      this.seedOverflowHistory();
      const cb = new CollectingChatCallback();
      await this.chat(message, cb);
      const assistant = (await this.getMessages()).filter(
        (m) => m.role === "assistant"
      );
      const final = assistant[assistant.length - 1];
      return {
        done: cb.doneCalled,
        error: cb.errorMessage,
        compactionCount: this.compactionCount,
        compactionReasons: this.compactionReasons,
        modelCalls: this.modelCalls,
        assistantMessages: assistant.length,
        finalText: final ? textOf(final) : "",
        errorClassification: this.errorClassification
      };
    } finally {
      unsubscribe();
    }
  }

  private seedOverflowHistory(): void {
    const user: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: "earlier question" }]
    };
    const assistant: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: "earlier answer" }]
    };
    this.host.store.put(`think:sess:main:msg:${user.id}`, {
      message: user,
      parentId: null
    });
    this.host.store.put(`think:sess:main:msg:${assistant.id}`, {
      message: assistant,
      parentId: user.id
    });
    this.host.store.put("think:sess:main:children:__root__", [user.id]);
    this.host.store.put(`think:sess:main:children:${user.id}`, [
      assistant.id
    ]);
    this.host.store.put("think:sess:main:leaf", assistant.id);
  }
}

class ThinkSubmissionRecoveryE2EAgentImpl extends Think {
  override chatRecovery = true;
  override workspaceTools = false;

  protected override getModel(): ModelClient {
    return createSlowE2EMockModel();
  }

  protected override getSystemPrompt(): string {
    return "Submission recovery e2e agent.";
  }

  constructor(host: ConstructorParameters<typeof Think>[0]) {
    super(host);
    this.bus.subscribe("chat", (event) => {
      if (
        event.type !== "chat:submission:accepted" &&
        event.type !== "chat:submission:started" &&
        event.type !== "chat:submission:settled"
      ) {
        return;
      }
      const submissionId = event.payload.submissionId;
      if (typeof submissionId !== "string") return;
      const inspected = this.inspectSubmission(submissionId);
      const status =
        event.type === "chat:submission:settled" &&
        typeof event.payload.status === "string"
          ? event.payload.status
          : inspected?.status;
      if (!status) return;
      this.appendStatusLog(`${submissionId}:${status}`);
    });
  }

  @callable()
  async startSubmission(submissionId: string, text: string): Promise<string> {
    const result = await this.submitMessages(
      [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text }]
        }
      ],
      { submissionId }
    );
    return result.submissionId;
  }

  @callable()
  async seedRunningSubmission(
    submissionId: string,
    _requestId: string,
    _applied: boolean
  ): Promise<void> {
    const seq = (this.host.store.get<number>("think:subm:seq") ?? 0) + 1;
    this.host.store.put("think:subm:seq", seq);
    const row: InternalSubmissionRow = {
      submissionId,
      seq,
      status: "running",
      acceptedAt: this.host.clock.now(),
      startedAt: this.host.clock.now(),
      messages: [
        {
          id: `seed-${submissionId}`,
          role: "user",
          parts: [{ type: "text", text: "seeded submission" }]
        }
      ]
    };
    this.host.store.put(`think:subm:rec:${submissionId}`, row);
    this.appendStatusLog(`${submissionId}:running`);
  }

  @callable()
  async getSubmission(submissionId: string): Promise<SubmissionView> {
    const row = this.inspectSubmission(submissionId);
    return row ? { status: row.status, error: row.error ?? null } : null;
  }

  @callable()
  async getStatusLog(): Promise<string[]> {
    return this.host.store.get<string[]>("test:submission-status-log") ?? [];
  }

  @callable()
  async getMessageCount(): Promise<number> {
    return (await this.getMessages()).length;
  }

  @callable()
  async hasFiberRows(): Promise<boolean> {
    return (
      this.listFibers({
        name: "chat-turn",
        status: ["pending", "running", "interrupted"]
      }).length > 0
    );
  }

  private appendStatusLog(entry: string): void {
    const log = this.host.store.get<string[]>("test:submission-status-log") ?? [];
    this.host.store.put("test:submission-status-log", [...log, entry]);
  }
}

class ThinkActionPauseRecoveryE2EAgentImpl extends Think {
  override chatRecovery = true;
  override maxSteps = 6;
  override workspaceTools = false;

  protected override getModel(): ModelClient {
    return createActionPauseMockModel();
  }

  protected override getSystemPrompt(): string {
    return "Durable-pause action recovery e2e agent.";
  }

  protected override getActions(): Record<string, Action> {
    return {
      pauseAction: action({
        name: "pauseAction",
        description: "A durable-pause action awaiting human approval",
        inputSchema: z.object({ message: z.string() }),
        kind: "durable-pause",
        approval: true,
        approvalSummary: "Deploy the thing",
        approvalRisk: "high",
        permissions: ["deploy:run"],
        execute: async ({ message }: { message: string }): Promise<string> => {
          const n = this.host.store.get<number>(ACTION_PAUSE_EXEC_COUNT_KEY) ?? 0;
          this.host.store.put(ACTION_PAUSE_EXEC_COUNT_KEY, n + 1);
          return `deployed: ${message}`;
        }
      })
    };
  }

  @callable()
  async startActionPauseTurn(prompt: string): Promise<{ done: boolean }> {
    const cb = new CollectingChatCallback();
    await this.chat(prompt, cb);
    return { done: cb.doneCalled };
  }

  @callable()
  async pendingCount(): Promise<number> {
    return this.pendingApprovals().length;
  }

  @callable()
  async firstPendingJson(): Promise<string | null> {
    const pending = this.pendingApprovals();
    if (!pending[0]) return null;
    const executionId = pending[0].executionId.replace(
      /^exec_/,
      "actpause_"
    );
    return JSON.stringify({
      ...pending[0],
      executionId,
      source: "action",
      descriptor: pending[0].descriptor
    });
  }

  @callable()
  async approveFirstPending(): Promise<{
    executionId: string | null;
    result: string;
  }> {
    const pending = this.pendingApprovals();
    const first = pending[0];
    if (!first) return { executionId: null, result: "none" };
    const result = await this.approveExecution(first.executionId);
    return {
      executionId: first.executionId.replace(/^exec_/, "actpause_"),
      result: JSON.stringify(result)
    };
  }

  @callable()
  async getExecCount(): Promise<number> {
    return this.host.store.get<number>(ACTION_PAUSE_EXEC_COUNT_KEY) ?? 0;
  }

  @callable()
  async getFinalText(): Promise<string> {
    return (await this.getMessages())
      .filter((m) => m.role === "assistant")
      .map(textOf)
      .join("");
  }
}

class ThinkActionLedgerRecoveryE2EAgentImpl extends Think {
  override maxSteps = 6;
  override actionLedgerPendingRetryLeaseMs = 1000;
  override workspaceTools = false;

  protected override getModel(): ModelClient {
    return createLedgerActionMockModel();
  }

  protected override getSystemPrompt(): string {
    return "Action ledger recovery e2e agent.";
  }

  protected override getActions(): Record<string, Action> {
    return {
      slowAction: action({
        name: "slowAction",
        description: "An idempotent action with a recorded side effect",
        inputSchema: z.object({ message: z.string() }),
        idempotencyKey: LEDGER_RECOVERY_KEY,
        execute: async ({ message }: { message: string }): Promise<string> => {
          const n =
            this.host.store.get<number>(LEDGER_RECOVERY_EXEC_COUNT_KEY) ?? 0;
          this.host.store.put(LEDGER_RECOVERY_EXEC_COUNT_KEY, n + 1);
          return `did: ${message}`;
        }
      })
    };
  }

  @callable()
  async seedStalePendingRow(): Promise<void> {
    const past = Date.now() - 600_000;
    this.host.store.put("think:action:ledger:slowAction:ledger-recovery-key", {
      status: "pending",
      inputHash: stableHash({ message: LEDGER_RECOVERY_MESSAGE }),
      createdAt: past
    });
  }

  @callable()
  async runLedgerActionTurn(prompt: string): Promise<{ done: boolean }> {
    const cb = new CollectingChatCallback();
    await this.chat(prompt, cb);
    return { done: cb.doneCalled };
  }

  @callable()
  async listLedgerRows(): Promise<
    Array<{ key: string; status: string; updated_at: number }>
  > {
    return [
      ...this.host.store
        .list<{ status: string; createdAt: number; settledAt?: number }>({
          prefix: "think:action:ledger:"
        })
        .entries()
    ].map(([key, row]) => ({
      key: `action:${key.slice("think:action:ledger:".length)}`,
      status: row.status,
      updated_at: row.settledAt ?? row.createdAt
    }));
  }

  @callable()
  async getExecCount(): Promise<number> {
    return this.host.store.get<number>(LEDGER_RECOVERY_EXEC_COUNT_KEY) ?? 0;
  }

  @callable()
  async getFinalText(): Promise<string> {
    return (await this.getMessages())
      .filter((m) => m.role === "assistant")
      .map(textOf)
      .join("");
  }
}

class ThinkRecoveryE2EAgentImpl extends Think {
  override chatRecovery = true;

  protected override getModel(): ModelClient {
    return createSlowE2EMockModel();
  }

  protected override getSystemPrompt(): string {
    return "You are a test assistant for recovery testing.";
  }

  override beforeTurn = async (_ctx: TurnContext): Promise<void> => {
    const error = this.host.store.get<string>(BEFORE_TURN_ERROR_KEY);
    if (!error) return;
    this.host.store.delete(BEFORE_TURN_ERROR_KEY);
    throw new Error(error);
  };

  override onChatRecovery = async (ctx: {
    requestId: string;
    incidentId: string;
    attempt: number;
  }): Promise<void> => {
    const contexts =
      this.host.store.get<RecoveryContextLogEntry[]>(RECOVERY_CONTEXTS_KEY) ??
      [];
    contexts.push({
      streamId: ctx.incidentId,
      requestId: ctx.requestId,
      partialText: this.partialTextFor(ctx.requestId)
    });
    this.host.store.put(RECOVERY_CONTEXTS_KEY, contexts);

    // The rebuilt recovery hook currently observes but does not decide
    // continue/stop; keep the original fixture knob persisted for triage.
    void (
      this.host.store.get<"continue" | "stop">(RECOVERY_BEHAVIOR_KEY) ??
      "stop"
    );
  };

  override onChatError = async (
    error: unknown,
    _ctx: ChatErrorContext
  ): Promise<void> => {
    const log = this.host.store.get<string[]>(ON_CHAT_ERROR_LOG_KEY) ?? [];
    const message = error instanceof Error ? error.message : String(error);
    this.host.store.put(ON_CHAT_ERROR_LOG_KEY, [...log, message]);
  };

  private partialTextFor(requestId: string): string {
    const read = this.events().read(0);
    if (read.kind === "gap") return "";
    return read.events
      .filter((stored) => {
        const event = stored.event;
        return event.type === "chunk" && event.requestId === requestId;
      })
      .map(chunkTextFrom)
      .join("");
  }

  @callable()
  async getRecoveryStatus(): Promise<RecoveryStatus> {
    const messages = await this.getMessages();
    const contexts =
      this.host.store.get<RecoveryContextLogEntry[]>(RECOVERY_CONTEXTS_KEY) ??
      [];
    return {
      recoveryCount: contexts.length,
      contexts,
      messageCount: messages.length,
      assistantMessages: messages.filter((m) => m.role === "assistant").length
    };
  }

  @callable()
  async setRecoveryBehavior(behavior: "continue" | "stop"): Promise<void> {
    this.host.store.put(RECOVERY_BEHAVIOR_KEY, behavior);
  }

  @callable()
  async throwBeforeNextTurn(message: string): Promise<void> {
    this.host.store.put(BEFORE_TURN_ERROR_KEY, message);
  }

  @callable()
  async getOnErrorLog(): Promise<string[]> {
    return this.host.store.get<string[]>(ON_ERROR_LOG_KEY) ?? [];
  }

  @callable()
  async getOnChatErrorLog(): Promise<string[]> {
    return this.host.store.get<string[]>(ON_CHAT_ERROR_LOG_KEY) ?? [];
  }

  @callable()
  async hasFiberRows(): Promise<boolean> {
    return this.listFibers({
      name: "chat-turn",
      status: ["pending", "running", "interrupted"]
    }).length > 0;
  }

  @callable()
  async inspectRun(_runId: string): Promise<{
    status: string;
    output?: string;
    error?: string;
  } | null> {
    const hasFibers = await this.hasFiberRows();
    const messages = await this.getMessages();
    const assistantText = messages
      .filter((message) => message.role === "assistant")
      .map(textOf)
      .join("");
    if (assistantText.length > 0 && !hasFibers) {
      return { status: "completed", output: assistantText };
    }
    if (hasFibers) return { status: "running" };
    return null;
  }
}

class ThinkRecoveryHelperAgentImpl extends ThinkRecoveryE2EAgentImpl {}

class ThinkRecoveryHelperParentImpl extends Think {
  protected override getModel(): ModelClient {
    return createSlowE2EMockModel();
  }

  @callable()
  async startHelperChatTurn(
    helperName: string,
    prompt: string
  ): Promise<string> {
    const helper = this.subAgent("ThinkRecoveryHelperAgent", helperName);

    let markReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });

    const callback: StreamCallback = {
      onStart: () => {},
      onEvent: (event: unknown) => {
        if (
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "text-delta"
        ) {
          markReady();
        }
      },
      onDone: () => markReady(),
      onError: (error: unknown) => {
        markReady();
        console.error("[test] helper chat callback error:", error);
      }
    };

    void helper.call("chat", [prompt, callback]).catch(console.error);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race<void>([
        ready,
        new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Timed out waiting for helper chat chunk")),
            5000
          );
        })
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    return "started";
  }

  @callable()
  async startHelperAgentToolRun(
    runId: string,
    prompt: string
  ): Promise<string> {
    const child = this.subAgent("ThinkRecoveryHelperAgent", runId);
    await child.call("setRecoveryBehavior", ["continue"]);
    this.putAgentToolRun({ runId, status: "running", error: null });

    const callback: StreamCallback = {
      onStart: () => {},
      onEvent: () => {},
      onDone: () => {
        this.putAgentToolRun({ runId, status: "completed", error: null });
      },
      onError: (error: unknown) => {
        this.putAgentToolRun({
          runId,
          status: "error",
          error: error instanceof Error ? error.message : String(error)
        });
      },
      onInterrupted: () => {}
    };

    void child.call("chat", [prompt, callback]).catch((error: unknown) => {
      this.putAgentToolRun({
        runId,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return runId;
  }

  @callable()
  async getAgentToolRuns(): Promise<AgentToolRunStatus[]> {
    const rows = this.agentToolRuns();
    const next: AgentToolRunStatus[] = [];
    for (const row of rows) {
      if (row.status !== "running") {
        next.push(row);
        continue;
      }
      const observed = await this.subAgent(
        "ThinkRecoveryHelperAgent",
        row.runId
      ).call<{ status: string; output?: string; error?: string } | null>(
        "inspectRun",
        [row.runId]
      );
      if (observed?.status === "completed") {
        next.push({ runId: row.runId, status: "completed", error: null });
      } else if (observed?.status === "error") {
        next.push({
          runId: row.runId,
          status: "error",
          error: observed.error ?? "child reported failure"
        });
      } else {
        next.push(row);
      }
    }
    this.host.store.put(AGENT_TOOL_RUNS_KEY, next);
    return next;
  }

  @callable()
  async helperHasFiberRows(helperName: string): Promise<boolean> {
    return this.subAgent("ThinkRecoveryHelperAgent", helperName).call<boolean>(
      "hasFiberRows",
      []
    );
  }

  @callable()
  async getHelperRecoveryStatus(helperName: string): Promise<RecoveryStatus> {
    return this.subAgent("ThinkRecoveryHelperAgent", helperName).call(
      "getRecoveryStatus",
      []
    );
  }

  private agentToolRuns(): AgentToolRunStatus[] {
    return this.host.store.get<AgentToolRunStatus[]>(AGENT_TOOL_RUNS_KEY) ?? [];
  }

  private putAgentToolRun(row: AgentToolRunStatus): void {
    const rows = this.agentToolRuns().filter((entry) => entry.runId !== row.runId);
    rows.push(row);
    this.host.store.put(AGENT_TOOL_RUNS_KEY, rows);
  }
}

const ThinkRecoveryE2EAgentBase = hostAgent(ThinkRecoveryE2EAgentImpl);
export class ThinkRecoveryE2EAgent extends ThinkRecoveryE2EAgentBase {}

const ThinkRecoveryHelperAgentBase = hostAgent(ThinkRecoveryHelperAgentImpl);
export class ThinkRecoveryHelperAgent extends ThinkRecoveryHelperAgentBase {}

const ThinkRecoveryHelperParentBase = hostAgent(
  ThinkRecoveryHelperParentImpl
);
export class ThinkRecoveryHelperParent extends ThinkRecoveryHelperParentBase {}

const ThinkToolRollbackE2EAgentBase = hostAgent(ThinkToolRollbackE2EAgentImpl);
export class ThinkToolRollbackE2EAgent extends ThinkToolRollbackE2EAgentBase {}

const ThinkPersistFalseE2EAgentBase = hostAgent(ThinkPersistFalseE2EAgentImpl);
export class ThinkPersistFalseE2EAgent extends ThinkPersistFalseE2EAgentBase {}

const ThinkTaskParentE2EAgentBase = hostAgent(ThinkTaskParentE2EAgentImpl);
export class ThinkTaskParentE2EAgent extends ThinkTaskParentE2EAgentBase {}

const ThinkAgentToolNaturalParentE2EAgentBase = hostAgent(
  ThinkAgentToolNaturalParentE2EAgentImpl
);
export class ThinkAgentToolNaturalParentE2EAgent extends ThinkAgentToolNaturalParentE2EAgentBase {}

const ThinkSlowChildE2EAgentBase = hostAgent(ThinkSlowChildE2EAgentImpl);
export class ThinkSlowChildE2EAgent extends ThinkSlowChildE2EAgentBase {}

const ThinkSlowChildParentE2EAgentBase = hostAgent(
  ThinkSlowChildParentE2EAgentImpl
);
export class ThinkSlowChildParentE2EAgent extends ThinkSlowChildParentE2EAgentBase {}

const ThinkStallRecoveryE2EAgentBase = hostAgent(
  ThinkStallRecoveryE2EAgentImpl
);
export class ThinkStallRecoveryE2EAgent extends ThinkStallRecoveryE2EAgentBase {}

const ThinkContextOverflowE2EAgentBase = hostAgent(
  ThinkContextOverflowE2EAgentImpl
);
export class ThinkContextOverflowE2EAgent extends ThinkContextOverflowE2EAgentBase {}

const ThinkSubmissionRecoveryE2EAgentBase = hostAgent(
  ThinkSubmissionRecoveryE2EAgentImpl
);
export class ThinkSubmissionRecoveryE2EAgent extends ThinkSubmissionRecoveryE2EAgentBase {}

const ThinkActionPauseRecoveryE2EAgentBase = hostAgent(
  ThinkActionPauseRecoveryE2EAgentImpl
);
export class ThinkActionPauseRecoveryE2EAgent extends ThinkActionPauseRecoveryE2EAgentBase {}

const ThinkActionLedgerRecoveryE2EAgentBase = hostAgent(
  ThinkActionLedgerRecoveryE2EAgentImpl
);
export class ThinkActionLedgerRecoveryE2EAgent extends ThinkActionLedgerRecoveryE2EAgentBase {}

function normalizeOriginalAcronymSlug(request: Request): Request {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/agents/think-recovery-e2-e-agent/")) {
    url.pathname = url.pathname.replace(
      "/agents/think-recovery-e2-e-agent/",
      "/agents/ThinkRecoveryE2EAgent/"
    );
    return new Request(url, request);
  }
  return request;
}

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    const normalized = normalizeOriginalAcronymSlug(request);
    return (
      (await routeAgentRequest(normalized, env)) ??
      new Response("rebuild e2e test worker")
    );
  }
};
