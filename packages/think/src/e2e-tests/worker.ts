/**
 * E2E test worker — Think agents for e2e testing.
 * TestAssistant: real Workers AI with workspace tools.
 * ThinkRecoveryE2EAgent: mock slow stream with chatRecovery for kill/restart testing.
 */
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { Agent, callable, routeAgentRequest } from "agents";
import type { FiberContext } from "agents";
import { agentTool } from "agents/agent-tools";
import type { Adapter } from "chat";
import {
  chatSdkMessenger,
  defineMessengers,
  messengerReplySnapshot,
  MESSENGER_REPLY_FIBER_NAME,
  type MessengerEvent,
  type ThinkMessengers
} from "../messengers";
import { RpcTarget } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import { tool } from "ai";
import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { z } from "zod";
import { Session } from "agents/experimental/memory/session";
import type { ObservabilityEvent } from "agents/observability";
import { Think, Workspace, defaultContextOverflowClassifier } from "../think";
import { ThinkWorkflow, type ThinkWorkflowStep } from "../workflows";
import type {
  ChatErrorClassification,
  ChatErrorContext,
  ChatRecoveryContext,
  ChatRecoveryOptions,
  StreamCallback,
  ThinkSubmissionInspection,
  TurnConfig,
  TurnContext
} from "../think";

type Env = {
  TestAssistant: DurableObjectNamespace<TestAssistant>;
  ThinkRecoveryE2EAgent: DurableObjectNamespace<ThinkRecoveryE2EAgent>;
  ThinkRecoveryHelperParent: DurableObjectNamespace<ThinkRecoveryHelperParent>;
  ThinkRecoveryHelperAgent: DurableObjectNamespace<ThinkRecoveryHelperAgent>;
  ThinkToolRollbackE2EAgent: DurableObjectNamespace<ThinkToolRollbackE2EAgent>;
  ThinkPersistFalseE2EAgent: DurableObjectNamespace<ThinkPersistFalseE2EAgent>;
  ThinkStallRecoveryE2EAgent: DurableObjectNamespace<ThinkStallRecoveryE2EAgent>;
  ThinkTaskParentE2EAgent: DurableObjectNamespace<ThinkTaskParentE2EAgent>;
  ThinkAgentToolNaturalParentE2EAgent: DurableObjectNamespace<ThinkAgentToolNaturalParentE2EAgent>;
  ThinkSlowChildE2EAgent: DurableObjectNamespace<ThinkSlowChildE2EAgent>;
  ThinkSlowChildParentE2EAgent: DurableObjectNamespace<ThinkSlowChildParentE2EAgent>;
  ThinkContextOverflowE2EAgent: DurableObjectNamespace<ThinkContextOverflowE2EAgent>;
  ThinkSubmissionRecoveryE2EAgent: DurableObjectNamespace<ThinkSubmissionRecoveryE2EAgent>;
  ThinkMessengerRecoveryE2EAgent: DurableObjectNamespace<ThinkMessengerRecoveryE2EAgent>;
  ThinkWorkflowRecoveryE2EAgent: DurableObjectNamespace<ThinkWorkflowRecoveryE2EAgent>;
  TestStructuredAgent: DurableObjectNamespace<TestStructuredAgent>;
  STEP_PROMPT_WORKFLOW: Workflow;
  AI: Ai;
  R2: R2Bucket;
  // Optional — only set when the corresponding key is exported in the test env.
  // The OpenAI/Anthropic legs of the structured-output e2e skip when absent.
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
};

/** Providers exercised by the cross-provider structured-output e2e (#1685). */
type StructuredProvider = "workers-ai" | "openai" | "anthropic";
const STRUCTURED_PROVIDER_KEY = "test:structured-provider";

// AI SDK v3 LanguageModel spec helpers (mirror tests/agents/assistant-agent-loop.ts).
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

/**
 * Deterministic agentic-loop model for rollback testing. Each step it counts
 * how many `recordStep` results already exist in the prompt and emits the NEXT
 * `recordStep(index)` tool call — so the step it picks is driven entirely by the
 * conversation history the recovery path reconstructs. If recovery loses a
 * completed step, this model re-emits a lower index, which the non-idempotent
 * ledger surfaces as a duplicate row (the "rollback depth" signal).
 */
function createToolLoopMockModel(totalSteps: number): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-tool-loop",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream(options: Record<string, unknown>) {
      const messages = (options as { prompt?: unknown[] }).prompt ?? [];
      const completed = messages.filter(
        (m): m is Record<string, unknown> =>
          typeof m === "object" &&
          m !== null &&
          (m as Record<string, unknown>).role === "tool"
      ).length;
      const nextIndex = completed + 1;

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (nextIndex > totalSteps) {
            controller.enqueue({ type: "text-start", id: "done" });
            controller.enqueue({
              type: "text-delta",
              id: "done",
              delta: "DONE"
            });
            controller.enqueue({ type: "text-end", id: "done" });
            controller.enqueue({
              type: "finish",
              finishReason: v3FinishReason("stop"),
              usage: v3Usage(10, 5)
            });
          } else {
            const id = `tc-${nextIndex}`;
            const input = JSON.stringify({ index: nextIndex });
            controller.enqueue({
              type: "tool-input-start",
              id,
              toolName: "recordStep"
            });
            controller.enqueue({ type: "tool-input-delta", id, delta: input });
            controller.enqueue({ type: "tool-input-end", id });
            controller.enqueue({
              type: "tool-call",
              toolCallId: id,
              toolName: "recordStep",
              input
            });
            controller.enqueue({
              type: "finish",
              finishReason: v3FinishReason("tool-calls"),
              usage: v3Usage(10, 5)
            });
          }
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

const TOOL_ROLLBACK_TOTAL_STEPS = 30;
const TOOL_ROLLBACK_EXEC_DELAY_MS = 600;

/**
 * Recovery + non-idempotent tool agent for measuring rollback DEPTH under rapid
 * kill/restart churn. One long turn → many `recordStep` tool steps; each
 * execution appends a ledger row. A completed step that re-runs after an
 * eviction shows up as a duplicate index.
 */
export class ThinkToolRollbackE2EAgent extends Think<Env> {
  static options = { keepAliveIntervalMs: 2_000 };
  override chatRecovery = true;
  override maxSteps = 500;
  private _ledgerReady = false;

  override getModel(): LanguageModel {
    return createToolLoopMockModel(TOOL_ROLLBACK_TOTAL_STEPS);
  }

  override getSystemPrompt(): string {
    return "Record each step in order using the recordStep tool.";
  }

  override getTools(): ToolSet {
    return {
      recordStep: tool({
        description: "Record a step by its index.",
        inputSchema: z.object({ index: z.number() }),
        execute: async ({ index }) => {
          this._ensureLedger();
          this
            .sql`INSERT INTO tool_ledger (idx, at) VALUES (${index}, ${Date.now()})`;
          // Widen the in-flight window so a SIGKILL can land mid-execution.
          await new Promise((r) => setTimeout(r, TOOL_ROLLBACK_EXEC_DELAY_MS));
          return { recorded: index };
        }
      })
    };
  }

  override async onChatRecovery(): Promise<ChatRecoveryOptions> {
    const n = (await this.ctx.storage.get<number>("tool:recovery-count")) ?? 0;
    await this.ctx.storage.put("tool:recovery-count", n + 1);
    return { continue: true };
  }

  private _ensureLedger(): void {
    if (this._ledgerReady) return;
    this
      .sql`CREATE TABLE IF NOT EXISTS tool_ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, idx INTEGER, at INTEGER)`;
    this._ledgerReady = true;
  }

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
    this._ensureLedger();
    const rows = this.sql<{ idx: number; count: number }>`
      SELECT idx, COUNT(*) as count FROM tool_ledger GROUP BY idx ORDER BY idx
    `;
    const fiberRows = this.sql<{ c: number }>`
      SELECT COUNT(*) as c FROM cf_agents_runs
    `;
    return {
      totalExecutions: rows.reduce((n, r) => n + r.count, 0),
      uniqueIndices: rows.length,
      maxIndex: rows.reduce((m, r) => Math.max(m, r.idx), 0),
      duplicates: rows
        .filter((r) => r.count > 1)
        .map((r) => ({ index: r.idx, count: r.count })),
      recoveryCount:
        (await this.ctx.storage.get<number>("tool:recovery-count")) ?? 0,
      assistantMessages: this.messages.filter((m) => m.role === "assistant")
        .length,
      hasFiberRows: (fiberRows[0]?.c ?? 0) > 0
    };
  }

  @callable()
  override async getMessages(): Promise<UIMessage[]> {
    return this.messages;
  }
}

/**
 * #1631 (R1) e2e: a `recordStep` tool loop whose `onChatRecovery` returns
 * `{ persist: false, continue: false }` — the explicit "stop this turn"
 * override. Under a real SIGKILL, recovery fires and returns persist:false;
 * R1 guarantees the SETTLED tool results produced before the kill are still
 * preserved in the durable transcript (never dropped), while continue:false
 * stops the turn (no re-run). This proves the persist:false no-loss default
 * survives a REAL process kill, not just a unit-seeded incident.
 */
export class ThinkPersistFalseE2EAgent extends Think<Env> {
  static options = { keepAliveIntervalMs: 2_000 };
  override chatRecovery = true;
  override maxSteps = 500;
  private _ledgerReady = false;

  override getModel(): LanguageModel {
    return createToolLoopMockModel(TOOL_ROLLBACK_TOTAL_STEPS);
  }

  override getSystemPrompt(): string {
    return "Record each step in order using the recordStep tool.";
  }

  override getTools(): ToolSet {
    return {
      recordStep: tool({
        description: "Record a step by its index.",
        inputSchema: z.object({ index: z.number() }),
        execute: async ({ index }) => {
          this._ensureLedger();
          this
            .sql`INSERT INTO tool_ledger (idx, at) VALUES (${index}, ${Date.now()})`;
          await new Promise((r) => setTimeout(r, TOOL_ROLLBACK_EXEC_DELAY_MS));
          return { recorded: index };
        }
      })
    };
  }

  override async onChatRecovery(): Promise<ChatRecoveryOptions> {
    const n = (await this.ctx.storage.get<number>("tool:recovery-count")) ?? 0;
    await this.ctx.storage.put("tool:recovery-count", n + 1);
    // Explicit "stop this turn" — but R1 must STILL preserve the settled work.
    return { persist: false, continue: false };
  }

  private _ensureLedger(): void {
    if (this._ledgerReady) return;
    this
      .sql`CREATE TABLE IF NOT EXISTS tool_ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, idx INTEGER, at INTEGER)`;
    this._ledgerReady = true;
  }

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
    this._ensureLedger();
    const rows = this.sql<{ idx: number; count: number }>`
      SELECT idx, COUNT(*) as count FROM tool_ledger GROUP BY idx ORDER BY idx
    `;
    const fiberRows = this.sql<{ c: number }>`
      SELECT COUNT(*) as c FROM cf_agents_runs
    `;
    const assistant = this.messages.filter((m) => m.role === "assistant");
    const settledToolPartsInTranscript = assistant.reduce((n, m) => {
      return (
        n +
        m.parts.filter((p) => {
          const part = p as {
            type?: unknown;
            output?: unknown;
            state?: unknown;
          };
          return (
            typeof part.type === "string" &&
            part.type.startsWith("tool-") &&
            (part.output !== undefined || part.state === "output-available")
          );
        }).length
      );
    }, 0);
    return {
      totalExecutions: rows.reduce((n, r) => n + r.count, 0),
      uniqueIndices: rows.length,
      maxIndex: rows.reduce((m, r) => Math.max(m, r.idx), 0),
      recoveryCount:
        (await this.ctx.storage.get<number>("tool:recovery-count")) ?? 0,
      assistantMessages: assistant.length,
      settledToolPartsInTranscript,
      hasFiberRows: (fiberRows[0]?.c ?? 0) > 0
    };
  }
}

type RecoveryContextLogEntry = {
  streamId: string;
  requestId: string;
  partialText: string;
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

export class TestAssistant extends Think<Env> {
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.R2,
    name: () => this.name
  });

  getModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.6",
      { sessionAffinity: this.sessionAffinity }
    );
  }

  getSystemPrompt(): string {
    return `You are a helpful assistant with access to a workspace filesystem.
You can read, write, edit, find, grep, and delete files.
When asked to write a file, use the write tool. When asked to read a file, use the read tool.
Always respond concisely.`;
  }

  @callable()
  override async getMessages(): Promise<UIMessage[]> {
    return this.messages;
  }
}

/**
 * Slow mock model that streams chunks with delays — used for kill/restart
 * testing. The model takes long enough that SIGKILL will interrupt it.
 */
function createSlowE2EMockModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-slow-e2e",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented");
    },
    doStream() {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t-slow" });
          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 500));
            controller.enqueue({
              type: "text-delta",
              id: "t-slow",
              delta: `chunk${i + 1} `
            });
          }
          controller.enqueue({ type: "text-end", id: "t-slow" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 10, outputTokens: 20 }
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

export class ThinkRecoveryE2EAgent extends Think<Env> {
  override chatRecovery = true;

  override getModel(): LanguageModel {
    return createSlowE2EMockModel();
  }

  override getSystemPrompt(): string {
    return "You are a test assistant for recovery testing.";
  }

  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    const contexts =
      (await this.ctx.storage.get<RecoveryContextLogEntry[]>(
        RECOVERY_CONTEXTS_KEY
      )) ?? [];
    contexts.push({
      streamId: ctx.streamId,
      requestId: ctx.requestId,
      partialText: ctx.partialText
    });
    await this.ctx.storage.put(RECOVERY_CONTEXTS_KEY, contexts);

    const behavior =
      (await this.ctx.storage.get<"continue" | "stop">(
        RECOVERY_BEHAVIOR_KEY
      )) ?? "stop";
    return { continue: behavior === "continue" };
  }

  override async beforeTurn(_ctx: TurnContext): Promise<TurnConfig | void> {
    const error = await this.ctx.storage.get<string>(BEFORE_TURN_ERROR_KEY);
    if (!error) return;
    await this.ctx.storage.delete(BEFORE_TURN_ERROR_KEY);
    throw new Error(error);
  }

  override async onError(error: unknown): Promise<void> {
    const log = (await this.ctx.storage.get<string[]>(ON_ERROR_LOG_KEY)) ?? [];
    log.push(error instanceof Error ? error.message : String(error));
    await this.ctx.storage.put(ON_ERROR_LOG_KEY, log);
  }

  override onChatError(error: unknown): unknown {
    const message = error instanceof Error ? error.message : String(error);
    this.ctx.storage
      .get<string[]>(ON_CHAT_ERROR_LOG_KEY)
      .then((log = []) =>
        this.ctx.storage.put(ON_CHAT_ERROR_LOG_KEY, [...log, message])
      )
      .catch(console.error);
    return error;
  }

  @callable()
  async getRecoveryStatus(): Promise<{
    recoveryCount: number;
    contexts: Array<{
      streamId: string;
      requestId: string;
      partialText: string;
    }>;
    messageCount: number;
    assistantMessages: number;
  }> {
    const messages = await this.getMessages();
    const contexts =
      (await this.ctx.storage.get<RecoveryContextLogEntry[]>(
        RECOVERY_CONTEXTS_KEY
      )) ?? [];
    return {
      recoveryCount: contexts.length,
      contexts,
      messageCount: messages.length,
      assistantMessages: messages.filter((m) => m.role === "assistant").length
    };
  }

  @callable()
  async setRecoveryBehavior(behavior: "continue" | "stop"): Promise<void> {
    await this.ctx.storage.put(RECOVERY_BEHAVIOR_KEY, behavior);
  }

  @callable()
  async throwBeforeNextTurn(message: string): Promise<void> {
    await this.ctx.storage.put(BEFORE_TURN_ERROR_KEY, message);
  }

  @callable()
  async getOnErrorLog(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>(ON_ERROR_LOG_KEY)) ?? [];
  }

  @callable()
  async getOnChatErrorLog(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>(ON_CHAT_ERROR_LOG_KEY)) ?? [];
  }

  @callable()
  async hasFiberRows(): Promise<boolean> {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    return rows[0].count > 0;
  }
}

/**
 * #1626 stall-recovery: the FIRST inference streams a little text then hangs
 * forever (a parked provider/transport); later inferences stream a full
 * response. With `chatStreamStallTimeoutMs` armed + chatRecovery on, the
 * watchdog aborts the hung first attempt and routes it into bounded recovery;
 * the scheduled continuation (a later, non-stalling inference) completes the
 * turn — instead of failing terminally.
 */
function createStallThenStreamMockModel(nextCall: () => number): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-stall-then-stream",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented");
    },
    doStream() {
      // The counter lives on the agent instance (survives the stall, which does
      // NOT restart the isolate), so only the FIRST inference stalls; the
      // recovery continuation streams to completion.
      const stallThisCall = nextCall() === 1;
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t-stall" });
          controller.enqueue({
            type: "text-delta",
            id: "t-stall",
            delta: "partial "
          });
          if (stallThisCall) {
            // Park forever — the inactivity watchdog must abort this attempt.
            await new Promise(() => {});
            return;
          }
          controller.enqueue({
            type: "text-delta",
            id: "t-stall",
            delta: "RECOVERED"
          });
          controller.enqueue({ type: "text-end", id: "t-stall" });
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

export class ThinkStallRecoveryE2EAgent extends Think<Env> {
  static options = { keepAliveIntervalMs: 2_000 };
  override chatRecovery = true;
  // Small window so the e2e is fast: the first inference hangs, the watchdog
  // fires within ~2s, and the scheduled continuation completes the turn.
  override chatStreamStallTimeoutMs = 2_000;
  private _inferenceCount = 0;

  override getModel(): LanguageModel {
    return createStallThenStreamMockModel(() => ++this._inferenceCount);
  }

  override getSystemPrompt(): string {
    return "Stall-recovery e2e agent.";
  }

  @callable()
  async getStallStatus(): Promise<{
    assistantMessages: number;
    finalText: string;
    hasFiberRows: boolean;
  }> {
    const assistant = this.messages.filter((m) => m.role === "assistant");
    const final = assistant[assistant.length - 1];
    const finalText = final
      ? final.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("")
      : "";
    const fiberRows = this.sql<{ c: number }>`
      SELECT COUNT(*) as c FROM cf_agents_runs
    `;
    return {
      assistantMessages: assistant.length,
      finalText,
      hasFiberRows: (fiberRows[0]?.c ?? 0) > 0
    };
  }

  @callable()
  override async getMessages(): Promise<UIMessage[]> {
    return this.messages;
  }
}

/**
 * Deterministic parent model: call `runTask` once, then finish. Used to test
 * whether an eviction while a `task` (child-agent) step is in flight causes the
 * parent to re-run the task — and thus re-run the entire child turn.
 */
function createSingleTaskMockModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-single-task",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream(options: Record<string, unknown>) {
      const messages = (options as { prompt?: unknown[] }).prompt ?? [];
      const hasToolResult = messages.some(
        (m): m is Record<string, unknown> =>
          typeof m === "object" &&
          m !== null &&
          (m as Record<string, unknown>).role === "tool"
      );
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (!hasToolResult) {
            const id = "task-1";
            const input = JSON.stringify({ taskId: 1 });
            controller.enqueue({
              type: "tool-input-start",
              id,
              toolName: "runTask"
            });
            controller.enqueue({ type: "tool-input-delta", id, delta: input });
            controller.enqueue({ type: "tool-input-end", id });
            controller.enqueue({
              type: "tool-call",
              toolCallId: id,
              toolName: "runTask",
              input
            });
            controller.enqueue({
              type: "finish",
              finishReason: v3FinishReason("tool-calls"),
              usage: v3Usage(10, 5)
            });
          } else {
            controller.enqueue({ type: "text-start", id: "done" });
            controller.enqueue({
              type: "text-delta",
              id: "done",
              delta: "DONE"
            });
            controller.enqueue({ type: "text-end", id: "done" });
            controller.enqueue({
              type: "finish",
              finishReason: v3FinishReason("stop"),
              usage: v3Usage(10, 5)
            });
          }
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

const CHILD_TASK_RUN_ID = "child-task-1";

/**
 * Parent agent whose single turn calls a `runTask` tool that drives a child
 * agent (`ThinkToolRollbackE2EAgent`, a long ledger tool-loop) via
 * `runAgentTool`. Lets us measure whether one in-flight `task` step re-runs the
 * whole child turn (the "amplification" hypothesis) under eviction.
 */
export class ThinkTaskParentE2EAgent extends Think<Env> {
  static options = { keepAliveIntervalMs: 2_000 };
  override chatRecovery = true;
  override maxSteps = 50;

  override getModel(): LanguageModel {
    return createSingleTaskMockModel();
  }

  override getSystemPrompt(): string {
    return "Run the seeding task exactly once using runTask.";
  }

  override getTools(): ToolSet {
    return {
      runTask: tool({
        description: "Run the seeding task as a child agent.",
        inputSchema: z.object({ taskId: z.number() }),
        execute: async ({ taskId }) => {
          this
            .sql`CREATE TABLE IF NOT EXISTS parent_task_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER)`;
          this.sql`INSERT INTO parent_task_log (at) VALUES (${Date.now()})`;
          // Stable runId → runAgentTool is idempotent by design (the "correct"
          // pattern). The question is whether eviction defeats that under churn.
          const result = await this.runAgentTool(ThinkToolRollbackE2EAgent, {
            runId: CHILD_TASK_RUN_ID,
            input: `seed task ${taskId}`
          });
          return { childStatus: result.status };
        }
      })
    };
  }

  override async onChatRecovery(): Promise<ChatRecoveryOptions> {
    const n =
      (await this.ctx.storage.get<number>("parent:recovery-count")) ?? 0;
    await this.ctx.storage.put("parent:recovery-count", n + 1);
    return { continue: true };
  }

  @callable()
  async getTaskStatus(): Promise<{
    parentTaskExecutions: number;
    parentRecoveries: number;
    parentHasFiberRows: boolean;
    child: {
      totalExecutions: number;
      uniqueIndices: number;
      maxIndex: number;
      duplicates: Array<{ index: number; count: number }>;
      recoveryCount: number;
      hasFiberRows: boolean;
    } | null;
  }> {
    this
      .sql`CREATE TABLE IF NOT EXISTS parent_task_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER)`;
    const parentRuns =
      this.sql<{ c: number }>`SELECT COUNT(*) as c FROM parent_task_log`[0]
        ?.c ?? 0;
    const fiberRows = this.sql<{ c: number }>`
      SELECT COUNT(*) as c FROM cf_agents_runs
    `;
    let child: {
      totalExecutions: number;
      uniqueIndices: number;
      maxIndex: number;
      duplicates: Array<{ index: number; count: number }>;
      recoveryCount: number;
      hasFiberRows: boolean;
    } | null = null;
    try {
      const childStub = await this.subAgent(
        ThinkToolRollbackE2EAgent,
        CHILD_TASK_RUN_ID
      );
      const ledger = await childStub.getLedgerStatus();
      child = {
        totalExecutions: ledger.totalExecutions,
        uniqueIndices: ledger.uniqueIndices,
        maxIndex: ledger.maxIndex,
        duplicates: ledger.duplicates,
        recoveryCount: ledger.recoveryCount,
        hasFiberRows: ledger.hasFiberRows
      };
    } catch {
      child = null;
    }
    return {
      parentTaskExecutions: parentRuns,
      parentRecoveries:
        (await this.ctx.storage.get<number>("parent:recovery-count")) ?? 0,
      parentHasFiberRows: (fiberRows[0]?.c ?? 0) > 0,
      child
    };
  }
}

// The stable runId agentTool() derives from the mock model's tool call id
// ("task-1") — `agent-tool:${toolCallId}`. getTaskStatus uses it to find the
// child facet.
const NATURAL_CHILD_TASK_RUN_ID = "agent-tool:task-1";

/**
 * Same shape as {@link ThinkTaskParentE2EAgent}, but the seeding task is wired
 * through `agentTool()` — the NATURAL path that does not hand-pick a stable
 * runId (#1630). Before the fix, `agentTool()` minted a fresh `nanoid` per
 * call, so a turn re-run by recovery spawned a brand-new child and re-ran the
 * whole ledger ("amplification"). After the fix, `agentTool()` derives a stable
 * runId from the (recovery-preserved) tool call id, so the re-issue re-attaches
 * to the same idempotent child instead of re-running its work.
 */
export class ThinkAgentToolNaturalParentE2EAgent extends Think<Env> {
  static options = { keepAliveIntervalMs: 2_000 };
  override chatRecovery = true;
  override maxSteps = 50;

  override getModel(): LanguageModel {
    return createSingleTaskMockModel();
  }

  override getSystemPrompt(): string {
    return "Run the seeding task exactly once using runTask.";
  }

  override getTools(): ToolSet {
    return {
      runTask: agentTool(ThinkToolRollbackE2EAgent, {
        description: "Run the seeding task as a child agent.",
        inputSchema: z.object({ taskId: z.number() })
      })
    };
  }

  override async onChatRecovery(): Promise<ChatRecoveryOptions> {
    const n =
      (await this.ctx.storage.get<number>("parent:recovery-count")) ?? 0;
    await this.ctx.storage.put("parent:recovery-count", n + 1);
    return { continue: true };
  }

  @callable()
  async getTaskStatus(): Promise<{
    parentTaskExecutions: number;
    parentRecoveries: number;
    parentHasFiberRows: boolean;
    parentChildStatus: string | null;
    child: {
      totalExecutions: number;
      uniqueIndices: number;
      maxIndex: number;
      duplicates: Array<{ index: number; count: number }>;
      recoveryCount: number;
      hasFiberRows: boolean;
    } | null;
  }> {
    const parentRunRows = this.sql<{ c: number }>`
      SELECT COUNT(*) as c FROM cf_agent_tool_runs
    `;
    // The status the PARENT collected for the child run (#1630 / N6): after a
    // real eviction the child self-heals its durable submission and the parent
    // re-attaches and collects `completed` — not `interrupted` (abandoned).
    const parentChildRunRows = this.sql<{ status: string }>`
      SELECT status FROM cf_agent_tool_runs
      WHERE run_id = ${NATURAL_CHILD_TASK_RUN_ID}
      LIMIT 1
    `;
    const fiberRows = this.sql<{ c: number }>`
      SELECT COUNT(*) as c FROM cf_agents_runs
    `;
    let child: {
      totalExecutions: number;
      uniqueIndices: number;
      maxIndex: number;
      duplicates: Array<{ index: number; count: number }>;
      recoveryCount: number;
      hasFiberRows: boolean;
    } | null = null;
    try {
      const childStub = await this.subAgent(
        ThinkToolRollbackE2EAgent,
        NATURAL_CHILD_TASK_RUN_ID
      );
      const ledger = await childStub.getLedgerStatus();
      child = {
        totalExecutions: ledger.totalExecutions,
        uniqueIndices: ledger.uniqueIndices,
        maxIndex: ledger.maxIndex,
        duplicates: ledger.duplicates,
        recoveryCount: ledger.recoveryCount,
        hasFiberRows: ledger.hasFiberRows
      };
    } catch {
      child = null;
    }
    return {
      // The agentTool() path doesn't write a parent_task_log; the parent run
      // row count is the closest analogue to "how many times the task ran".
      parentTaskExecutions: parentRunRows[0]?.c ?? 0,
      parentRecoveries:
        (await this.ctx.storage.get<number>("parent:recovery-count")) ?? 0,
      parentHasFiberRows: (fiberRows[0]?.c ?? 0) > 0,
      parentChildStatus: parentChildRunRows[0]?.status ?? null,
      child
    };
  }
}

// ── Re-attach budget bug: a deploy-interrupted child that is HEALTHY but needs
// longer than the parent's re-attach budget to finish is sealed `interrupted`.
//
// The re-attach budget (`DEFAULT_AGENT_TOOL_REATTACH_TIMEOUT_MS`, 120s) is a
// flat wall-clock timer that is NOT reset by child forward-progress, and the
// child facet cannot self-drive its own recovery (facets share the root isolate
// and cannot arm a physical alarm). So a parent that re-attaches after a deploy
// abandons a child that is still healthily advancing once the 120s elapse.
//
// Unlike the other task agents, these deliberately use the PRODUCTION-DEFAULT
// keepAlive (30s) — the `keepAliveIntervalMs: 2_000` override the rollback/task
// agents use drives facet recovery ~15x faster and masks this bug.
const SLOW_CHILD_TOTAL_STEPS = 60;
// ~2.7s/step × 60 ≈ 162s of continuous child work — comfortably beyond the
// parent's 120s re-attach budget, so the budget always expires before the
// (healthy) child reaches its terminal result.
const SLOW_CHILD_EXEC_DELAY_MS = 2_700;

/**
 * A long child tool-loop (same shape as {@link ThinkToolRollbackE2EAgent}) whose
 * recovered turn legitimately takes longer than the parent's 120s re-attach
 * budget. Production-default keepAlive (no 2s override).
 */
export class ThinkSlowChildE2EAgent extends Think<Env> {
  override chatRecovery = true;
  override maxSteps = 200;
  private _ledgerReady = false;

  override getModel(): LanguageModel {
    return createToolLoopMockModel(SLOW_CHILD_TOTAL_STEPS);
  }

  override getSystemPrompt(): string {
    return "Record each step in order using the recordStep tool.";
  }

  override getTools(): ToolSet {
    return {
      recordStep: tool({
        description: "Record a step by its index.",
        inputSchema: z.object({ index: z.number() }),
        execute: async ({ index }) => {
          this._ensureLedger();
          this
            .sql`INSERT INTO tool_ledger (idx, at) VALUES (${index}, ${Date.now()})`;
          await new Promise((r) => setTimeout(r, SLOW_CHILD_EXEC_DELAY_MS));
          return { recorded: index };
        }
      })
    };
  }

  override async onChatRecovery(): Promise<ChatRecoveryOptions> {
    const n = (await this.ctx.storage.get<number>("tool:recovery-count")) ?? 0;
    await this.ctx.storage.put("tool:recovery-count", n + 1);
    return { continue: true };
  }

  private _ensureLedger(): void {
    if (this._ledgerReady) return;
    this
      .sql`CREATE TABLE IF NOT EXISTS tool_ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, idx INTEGER, at INTEGER)`;
    this._ledgerReady = true;
  }

  @callable()
  async getLedgerStatus(): Promise<{
    totalExecutions: number;
    uniqueIndices: number;
    maxIndex: number;
    duplicates: Array<{ index: number; count: number }>;
    recoveryCount: number;
    hasFiberRows: boolean;
  }> {
    this._ensureLedger();
    const rows = this.sql<{ idx: number; count: number }>`
      SELECT idx, COUNT(*) as count FROM tool_ledger GROUP BY idx ORDER BY idx
    `;
    const fiberRows = this.sql<{ c: number }>`
      SELECT COUNT(*) as c FROM cf_agents_runs
    `;
    return {
      totalExecutions: rows.reduce((n, r) => n + r.count, 0),
      uniqueIndices: rows.length,
      maxIndex: rows.reduce((m, r) => Math.max(m, r.idx), 0),
      duplicates: rows
        .filter((r) => r.count > 1)
        .map((r) => ({ index: r.idx, count: r.count })),
      recoveryCount:
        (await this.ctx.storage.get<number>("tool:recovery-count")) ?? 0,
      hasFiberRows: (fiberRows[0]?.c ?? 0) > 0
    };
  }
}

/**
 * Parent that drives {@link ThinkSlowChildE2EAgent} via the natural `agentTool()`
 * path (stable runId `agent-tool:task-1`). Production-default keepAlive. A single
 * deploy mid-child is enough to expose the budget bug: the parent re-attaches,
 * the budget elapses while the child is still advancing, and the run is sealed
 * `interrupted` instead of `completed`.
 */
export class ThinkSlowChildParentE2EAgent extends Think<Env> {
  override chatRecovery = true;
  override maxSteps = 50;

  override getModel(): LanguageModel {
    return createSingleTaskMockModel();
  }

  override getSystemPrompt(): string {
    return "Run the seeding task exactly once using runTask.";
  }

  override getTools(): ToolSet {
    return {
      runTask: agentTool(ThinkSlowChildE2EAgent, {
        description: "Run the seeding task as a child agent.",
        inputSchema: z.object({ taskId: z.number() })
      })
    };
  }

  override async onChatRecovery(): Promise<ChatRecoveryOptions> {
    const n =
      (await this.ctx.storage.get<number>("parent:recovery-count")) ?? 0;
    await this.ctx.storage.put("parent:recovery-count", n + 1);
    return { continue: true };
  }

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
    const parentChildRunRows = this.sql<{
      status: string;
      error_message: string | null;
    }>`
      SELECT status, error_message FROM cf_agent_tool_runs
      WHERE run_id = ${NATURAL_CHILD_TASK_RUN_ID}
      LIMIT 1
    `;
    const fiberRows = this.sql<{ c: number }>`
      SELECT COUNT(*) as c FROM cf_agents_runs
    `;
    let child: {
      maxIndex: number;
      uniqueIndices: number;
      recoveryCount: number;
      hasFiberRows: boolean;
    } | null = null;
    try {
      const childStub = await this.subAgent(
        ThinkSlowChildE2EAgent,
        NATURAL_CHILD_TASK_RUN_ID
      );
      const ledger = await childStub.getLedgerStatus();
      child = {
        maxIndex: ledger.maxIndex,
        uniqueIndices: ledger.uniqueIndices,
        recoveryCount: ledger.recoveryCount,
        hasFiberRows: ledger.hasFiberRows
      };
    } catch {
      child = null;
    }
    return {
      parentRecoveries:
        (await this.ctx.storage.get<number>("parent:recovery-count")) ?? 0,
      parentHasFiberRows: (fiberRows[0]?.c ?? 0) > 0,
      parentChildStatus: parentChildRunRows[0]?.status ?? null,
      parentChildError: parentChildRunRows[0]?.error_message ?? null,
      child
    };
  }
}

export class ThinkRecoveryHelperAgent extends ThinkRecoveryE2EAgent {}

export class ThinkRecoveryHelperParent extends Agent<Env> {
  static options = { keepAliveIntervalMs: 2_000 };

  @callable()
  async startHelperChatTurn(
    helperName: string,
    prompt: string
  ): Promise<string> {
    const helper = await this.subAgent(ThinkRecoveryHelperAgent, helperName);

    let markReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });

    class HelperChatCallback extends RpcTarget implements StreamCallback {
      onStart(): void {
        // The RPC callback surface is fixed; this test only waits for chunks.
      }

      onEvent(json: string): void {
        try {
          const chunk = JSON.parse(json) as { type?: string; delta?: string };
          if (chunk.type === "text-delta" && chunk.delta) {
            markReady();
          }
        } catch {
          // Ignore malformed test chunks.
        }
      }

      onDone(): void {
        markReady();
      }

      onError(error: string): void {
        markReady();
        console.error("[test] helper chat callback error:", error);
      }
    }

    const callback = new HelperChatCallback();
    void helper.chat(prompt, callback).catch(console.error);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race<void>([
        ready,
        new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Timed out waiting for helper chat chunk")),
            5_000
          );
        })
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
    return "started";
  }

  @callable()
  async startHelperAgentToolRun(
    runId: string,
    prompt: string
  ): Promise<string> {
    // #1630: a parent that re-attaches to a still-running child after a deploy
    // must follow it to its REAL terminal instead of abandoning it as
    // `interrupted`. The child facet is named by `runId` (runAgentTool resolves
    // it via subAgent(cls, runId)), so configure it to self-heal (continue) on
    // recovery BEFORE starting the run — the re-attached parent then collects
    // `completed`, not an abandoned interrupt.
    const child = await this.subAgent(ThinkRecoveryHelperAgent, runId);
    await child.setRecoveryBehavior("continue");

    void this.runAgentTool(ThinkRecoveryHelperAgent, {
      runId,
      input: prompt
    }).catch((error) => {
      console.error("[test] helper agent-tool run failed:", error);
    });

    for (let i = 0; i < 20; i++) {
      const rows = this.getAgentToolRuns();
      if (rows.some((row) => row.runId === runId)) return runId;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error("Timed out waiting for helper agent-tool row");
  }

  @callable()
  getAgentToolRuns(): AgentToolRunStatus[] {
    return this.sql<AgentToolRunStatus>`
      SELECT run_id as runId, status, error_message as error
      FROM cf_agent_tool_runs
      ORDER BY started_at ASC
    `;
  }

  @callable()
  async helperHasFiberRows(helperName: string): Promise<boolean> {
    const helper = await this.subAgent(ThinkRecoveryHelperAgent, helperName);
    return helper.hasFiberRows();
  }

  @callable()
  async getHelperRecoveryStatus(helperName: string): Promise<{
    recoveryCount: number;
    contexts: Array<{
      streamId: string;
      requestId: string;
      partialText: string;
    }>;
    messageCount: number;
    assistantMessages: number;
  }> {
    const helper = await this.subAgent(ThinkRecoveryHelperAgent, helperName);
    return helper.getRecoveryStatus();
  }
}

/**
 * Cross-provider regression fixture for issue #1685: `step.prompt({ output })`
 * must return a schema-shaped object on Workers AI, OpenAI, and Anthropic.
 *
 * The provider is selected per-instance (persisted so it survives the workflow
 * event re-entry / hibernation) and read synchronously in `getModel()`.
 */
export class TestStructuredAgent extends Think<Env> {
  static options = { keepAliveIntervalMs: 2_000 };
  override maxSteps = 6;
  private _provider: StructuredProvider = "workers-ai";

  override async onStart(): Promise<void> {
    const stored = (await this.ctx.storage.get(STRUCTURED_PROVIDER_KEY)) as
      | StructuredProvider
      | undefined;
    if (stored) this._provider = stored;
  }

  override getModel(): LanguageModel {
    switch (this._provider) {
      case "openai":
        return createOpenAI({ apiKey: this.env.OPENAI_API_KEY })("gpt-4o-mini");
      case "anthropic":
        return createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY })(
          "claude-haiku-4-5"
        );
      default:
        return createWorkersAI({ binding: this.env.AI })(
          "@cf/moonshotai/kimi-k2.6",
          { sessionAffinity: this.sessionAffinity }
        );
    }
  }

  override getSystemPrompt(): string {
    return "You are a helpful assistant.";
  }

  @callable()
  async setTestProvider(provider: StructuredProvider): Promise<void> {
    this._provider = provider;
    await this.ctx.storage.put(STRUCTURED_PROVIDER_KEY, provider);
  }

  /**
   * Run the structured-prompt workflow and poll to a terminal state, returning
   * the workflow's output (the validated object) or the failure details.
   */
  @callable()
  async runStructuredPrompt(
    prompt: string,
    mode?: "greeting" | "tool"
  ): Promise<{
    status: string;
    output?: unknown;
    error?: string;
  }> {
    const id = await this.runWorkflow("STEP_PROMPT_WORKFLOW", { prompt, mode });
    for (let i = 0; i < 90; i++) {
      const status = await this.getWorkflowStatus("STEP_PROMPT_WORKFLOW", id);
      if (status.status === "complete") {
        return { status: "complete", output: status.output };
      }
      if (status.status === "errored" || status.status === "terminated") {
        return {
          status: status.status,
          error: JSON.stringify(status.error ?? status.output ?? status)
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return { status: "timeout" };
  }
}

const GREETING_SCHEMA = z.object({
  greeting: z.string()
});
const WORD_SCHEMA = z.object({
  word: z.string()
});

/**
 * `ThinkWorkflow` that issues a single structured `step.prompt`. In `greeting`
 * mode it is the exact shape from issue #1685 (no real tool use needed). In
 * `tool` mode the prompt forces the agent to use its workspace tools before
 * answering, exercising the full agentic `toolChoice: "required"` path that
 * terminates with the synthetic final-answer tool.
 */
export class StepPromptWorkflow extends ThinkWorkflow<TestStructuredAgent> {
  async run(
    event: WorkflowEvent<unknown>,
    step: ThinkWorkflowStep
  ): Promise<unknown> {
    const { prompt, mode } = event.payload as {
      prompt: string;
      mode?: "greeting" | "tool";
    };
    if (mode === "tool") {
      return step.prompt("structured-word", {
        prompt,
        output: WORD_SCHEMA
      });
    }
    return step.prompt("structured-greeting", {
      prompt,
      output: GREETING_SCHEMA
    });
  }
}

// ── Context-overflow compaction recovery (in-process; no kills) ──────
//
// Exercises Think's opt-in `contextOverflow` recovery end-to-end inside the
// real Workers runtime (no process kills needed): a mock model surfaces an
// in-stream provider context-overflow error, and Think's reactive backstop
// compacts + retries (or, when exhausted, surfaces the overflow terminally).
// The proactive path keys off model-reported usage crossing a headroom budget.

/**
 * Deterministic context-overflow model. The inference-call counter lives on the
 * agent instance (passed in via `nextCall`), so the FIRST inference can overflow
 * and the scheduled reactive retry (a LATER inference) can succeed — without
 * relying on prompt contents. In `exhaust` mode every inference overflows, so
 * the reactive retry budget is spent and the turn terminalizes.
 */
function createContextOverflowModel(
  nextCall: () => number,
  mode: "recover" | "exhaust"
): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-context-overflow",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream() {
      const overflow = mode === "exhaust" || nextCall() === 1;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (overflow) {
            // A realistic overflow: the model streams a little text, THEN the
            // provider rejects the now-too-long prompt. The AI SDK surfaces the
            // rejection as an in-stream error part (not a throw), which Think's
            // overflow seam recognizes via `classifyChatError`.
            controller.enqueue({ type: "text-start", id: "t-partial" });
            controller.enqueue({
              type: "text-delta",
              id: "t-partial",
              delta: "partial answer before overflow"
            });
            controller.enqueue({ type: "text-end", id: "t-partial" });
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
 * Proactive-guard model: step 1 emits an `echo` tool call reporting high input
 * usage; the proactive guard reads that usage before step 2 and compacts in
 * place (heading off the overflow). Step 2 then streams a normal answer.
 */
function createProactiveUsageModel(): LanguageModel {
  let callCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-proactive-usage",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream() {
      callCount++;
      const step = callCount;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (step === 1) {
            const id = "tc-echo";
            const input = JSON.stringify({ message: "ping" });
            controller.enqueue({
              type: "tool-input-start",
              id,
              toolName: "echo"
            });
            controller.enqueue({ type: "tool-input-delta", id, delta: input });
            controller.enqueue({ type: "tool-input-end", id });
            controller.enqueue({
              type: "tool-call",
              toolCallId: id,
              toolName: "echo",
              input
            });
            // Report high input usage so the proactive guard trips before step 2.
            controller.enqueue({
              type: "finish",
              finishReason: v3FinishReason("tool-calls"),
              usage: v3Usage(10, 5)
            });
          } else {
            controller.enqueue({ type: "text-start", id: "t-ok" });
            controller.enqueue({
              type: "text-delta",
              id: "t-ok",
              delta: "answered with headroom to spare"
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

/** In-process StreamCallback: collects the terminal outcome of a chat turn. */
class CollectingChatCallback implements StreamCallback {
  doneCalled = false;
  errorMessage: string | null = null;
  onStart(): void {}
  onEvent(): void {}
  onDone(): void {
    this.doneCalled = true;
  }
  onError(error: string): void {
    this.errorMessage = error;
  }
}

/**
 * Context-overflow recovery e2e agent. A single configurable agent covers the
 * reactive recover/exhaust paths and the proactive guard. `contextOverflow` and
 * the active model are selected per-run via `runOverflowChat`, so each test case
 * targets a fresh DO instance with its own behavior.
 */
export class ThinkContextOverflowE2EAgent extends Think<Env> {
  static options = { keepAliveIntervalMs: 2_000 };
  override maxSteps = 4;
  private _inferenceCount = 0;
  private _mode: OverflowMode = "recover";
  private _compactionCount = 0;
  private _compactionReasons: string[] = [];
  private _modelCalls = 0;
  private _errorClassification: string | null = null;

  override getModel(): LanguageModel {
    this._modelCalls++;
    if (this._mode === "proactive") return createProactiveUsageModel();
    return createContextOverflowModel(
      () => ++this._inferenceCount,
      this._mode === "exhaust" ? "exhaust" : "recover"
    );
  }

  override getSystemPrompt(): string {
    return "You are a context-overflow recovery e2e agent.";
  }

  override getTools(): ToolSet {
    if (this._mode !== "proactive") return {};
    return {
      echo: tool({
        description: "Echo a message back.",
        inputSchema: z.object({ message: z.string() }),
        execute: async ({ message }: { message: string }) => `pong: ${message}`
      })
    };
  }

  // Think ships no provider-specific matching; delegate to the exported default
  // classifier so the in-stream "prompt is too long" error is recognized.
  override classifyChatError(
    error: unknown,
    _ctx?: ChatErrorContext
  ): ChatErrorClassification | void {
    return defaultContextOverflowClassifier(error);
  }

  override onChatError(error: unknown, ctx?: ChatErrorContext): unknown {
    this._errorClassification = ctx?.classification ?? null;
    return super.onChatError(error, ctx);
  }

  override _emit(
    type: ObservabilityEvent["type"],
    payload: Record<string, unknown> = {}
  ): void {
    if (type === "chat:context:compacted") {
      this._compactionCount++;
      const reason = payload.reason;
      if (typeof reason === "string") this._compactionReasons.push(reason);
    }
    super._emit(type, payload);
  }

  override configureSession(session: Session): Session {
    // Collapse the first message so a non-empty tail always survives — enough to
    // prove compaction shortened history and the reactive retry can proceed.
    return session.onCompaction(async (messages) => {
      if (messages.length < 2) return null;
      return {
        summary: "compacted-summary",
        fromMessageId: messages[0].id,
        toMessageId: messages[0].id
      };
    });
  }

  @callable()
  async runOverflowChat(
    message: string,
    mode: OverflowMode
  ): Promise<OverflowChatOutcome> {
    this._mode = mode;
    this._inferenceCount = 0;
    this._compactionCount = 0;
    this._compactionReasons = [];
    this._modelCalls = 0;
    this._errorClassification = null;

    this.contextOverflow =
      mode === "proactive"
        ? { proactive: { maxInputTokens: 10 } }
        : { reactive: true };

    // Seed a prior turn so the compaction range always leaves a usable tail.
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

    const cb = new CollectingChatCallback();
    await this.chat(message, cb);

    const assistant = this.messages.filter((m) => m.role === "assistant");
    const final = assistant[assistant.length - 1];
    const finalText = final
      ? final.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("")
      : "";

    return {
      done: cb.doneCalled,
      error: cb.errorMessage,
      compactionCount: this._compactionCount,
      compactionReasons: this._compactionReasons,
      modelCalls: this._modelCalls,
      assistantMessages: assistant.length,
      finalText,
      errorClassification: this._errorClassification
    };
  }

  @callable()
  override async getMessages(): Promise<UIMessage[]> {
    return this.messages;
  }
}

// ── Submission recovery on start ────────────────────────────────────
//
// Exercises `_recoverSubmissionsOnStart`, which runs as part of the DO start
// sequence and reconciles `running` durable submissions left behind by an
// eviction. Three transitions are covered:
//   - messages NOT applied → re-enqueue as `pending`
//   - messages applied but the turn is NOT recoverable → `error`
//   - messages applied AND the chat turn is recoverable → left running, the
//     scheduled continuation drives it to `completed`
//
// The not-applied / applied-but-not-recoverable cases are seeded deterministically
// via SQL (no kill-timing race), then a real process restart triggers recovery.
// The recoverable case uses a genuine in-flight submission + mid-stream SIGKILL.

const SUBMISSION_STATUS_LOG_KEY = "test:submission-status-log";

export class ThinkSubmissionRecoveryE2EAgent extends Think<Env> {
  static options = { keepAliveIntervalMs: 2_000 };
  override chatRecovery = true;

  override getModel(): LanguageModel {
    return createSlowE2EMockModel();
  }

  override getSystemPrompt(): string {
    return "Submission recovery e2e agent.";
  }

  // Continue an interrupted turn so a recoverable submission can complete.
  override async onChatRecovery(): Promise<ChatRecoveryOptions> {
    return { continue: true };
  }

  // Record every submission status transition so a test can assert the
  // recovery transition even if a later drain advances the row again.
  override async onSubmissionStatus(
    submission: ThinkSubmissionInspection
  ): Promise<void> {
    const log =
      (await this.ctx.storage.get<string[]>(SUBMISSION_STATUS_LOG_KEY)) ?? [];
    log.push(`${submission.submissionId}:${submission.status}`);
    await this.ctx.storage.put(SUBMISSION_STATUS_LOG_KEY, log);
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

  /**
   * Seed a `running` submission row directly (no model turn), simulating a
   * submission left mid-flight by an eviction. `applied: false` leaves
   * `messages_applied_at` NULL with a message id absent from history (the
   * not-applied → pending path); `applied: true` marks messages applied with no
   * recoverable fiber/continuation (the applied → error path).
   */
  @callable()
  async seedRunningSubmission(
    submissionId: string,
    requestId: string,
    applied: boolean
  ): Promise<void> {
    // Ensure the submissions table exists (inspect goes through the ensure path).
    await this.inspectSubmission(submissionId);
    const now = Date.now();
    const messagesJson = JSON.stringify([
      {
        id: `seed-${submissionId}`,
        role: "user",
        parts: [{ type: "text", text: "seeded submission" }]
      }
    ]);
    this.sql`
      INSERT INTO cf_think_submissions (
        submission_id, idempotency_key, request_id, stream_id, status,
        messages_json, metadata_json, error_message, created_at,
        messages_applied_at, started_at, completed_at
      )
      VALUES (
        ${submissionId}, NULL, ${requestId}, NULL, 'running',
        ${messagesJson}, NULL, NULL, ${now},
        ${applied ? now : null}, ${now}, NULL
      )
    `;
  }

  @callable()
  async getSubmission(
    submissionId: string
  ): Promise<{ status: string; error: string | null } | null> {
    const row = await this.inspectSubmission(submissionId);
    return row ? { status: row.status, error: row.error ?? null } : null;
  }

  @callable()
  async getStatusLog(): Promise<string[]> {
    return (
      (await this.ctx.storage.get<string[]>(SUBMISSION_STATUS_LOG_KEY)) ?? []
    );
  }

  @callable()
  async getMessageCount(): Promise<number> {
    return this.messages.length;
  }

  @callable()
  async hasFiberRows(): Promise<boolean> {
    const rows = this.sql<{ c: number }>`
      SELECT COUNT(*) as c FROM cf_agents_runs
    `;
    return (rows[0]?.c ?? 0) > 0;
  }
}

// ── Messenger reply fiber recovery ──────────────────────────────────
//
// Exercises the MESSENGER_REPLY_FIBER_NAME recovery delegation: a messenger
// reply fiber interrupted by an eviction is recovered on restart through
// `_handleInternalFiberRecovery` → `ThinkMessengerRuntime.handleFiberRecovery`.
//  - `accepted` snapshot → "answer" mode: the reply is resumed (the model turn
//    re-runs and posts the answer to the thread).
//  - `streaming` snapshot → "apologize" mode: an interrupted message is posted.
//
// The reply fiber is seeded by genuinely starting it (it stashes the target
// stage and parks), then a real mid-fiber SIGKILL leaves the orphaned run row.
// On restart, the boot fiber-recovery sweep drives the messenger recovery, which
// posts through an in-memory fake `chat` adapter that records into agent SQL.

const FAKE_MESSENGER_ID = "fake";
const FAKE_THREAD_ID = "fake:thread";
const FAKE_INTERRUPTED_TEXT = "Reply interrupted, please retry.";

function makeMessengerReplyEvent(): MessengerEvent {
  return {
    capabilities: { canStream: true },
    kind: "mention",
    message: {
      attachments: [],
      author: {
        fullName: "E2E User",
        userId: "fake:user",
        userName: "e2e"
      },
      id: "message-1",
      isMention: true,
      providerMessageId: "message-1",
      text: "tell me a long messenger story"
    },
    messengerId: FAKE_MESSENGER_ID,
    provider: "fake",
    thread: {
      id: FAKE_THREAD_ID,
      isDirectMessage: false,
      providerThreadId: FAKE_THREAD_ID,
      title: "General"
    }
  };
}

function makeMessengerThreadSnapshot(): Record<string, unknown> {
  return {
    _type: "chat:Thread",
    adapterName: "fake",
    channelId: FAKE_THREAD_ID,
    id: FAKE_THREAD_ID,
    isDM: false
  };
}

export class ThinkMessengerRecoveryE2EAgent extends Think<Env> {
  static options = { keepAliveIntervalMs: 2_000 };
  // The reply-fiber recovery is independent of chatRecovery; keep chatRecovery
  // off so the answer-mode recovery turn does not spawn nested chat fibers.
  override chatRecovery = false;

  override getModel(): LanguageModel {
    return createSlowE2EMockModel();
  }

  override getSystemPrompt(): string {
    return "Messenger reply recovery e2e agent.";
  }

  override getMessengers(): ThinkMessengers {
    return defineMessengers({
      fake: chatSdkMessenger({
        adapter: this._recordingAdapter(),
        conversation: "self",
        delivery: { interruptedResponseText: FAKE_INTERRUPTED_TEXT },
        provider: "fake",
        userName: "fake_bot",
        verifyWebhook: false
      })
    });
  }

  private _ensurePostsTable(): void {
    this
      .sql`CREATE TABLE IF NOT EXISTS messenger_posts (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, content TEXT, at INTEGER)`;
  }

  private _recordPost(kind: string, message: unknown): void {
    this._ensurePostsTable();
    const content =
      typeof message === "string" ? message : JSON.stringify(message);
    this.sql`
      INSERT INTO messenger_posts (kind, content, at)
      VALUES (${kind}, ${content}, ${Date.now()})
    `;
  }

  // In-memory `chat` adapter: records every posted/edited message into agent
  // SQL so the recovery outcome is observable after a restart.
  private _recordingAdapter(): Adapter {
    return {
      addReaction: () => Promise.resolve(),
      channelIdFromThreadId: (threadId: string) => threadId,
      decodeThreadId: (threadId: string) => threadId,
      deleteMessage: () => Promise.resolve(),
      editMessage: (
        _threadId: string,
        _messageId: string,
        message: unknown
      ) => {
        this._recordPost("edit", message);
        return Promise.resolve({
          id: "edited",
          raw: {},
          threadId: FAKE_THREAD_ID
        });
      },
      encodeThreadId: (threadId: string) => String(threadId),
      fetchMessages: () => Promise.resolve({ messages: [] }),
      fetchThread: (threadId: string) =>
        Promise.resolve({
          channelId: threadId,
          id: threadId,
          isDM: false,
          metadata: {}
        }),
      handleWebhook: () => Promise.resolve(new Response("messenger")),
      initialize: () => Promise.resolve(),
      name: "fake",
      parseMessage: () => {
        throw new Error("parseMessage is not used by this e2e");
      },
      postMessage: (threadId: string, message: unknown) => {
        this._recordPost("post", message);
        return Promise.resolve({ id: "posted", raw: {}, threadId });
      },
      removeReaction: () => Promise.resolve(),
      userName: "fake_bot"
    } as unknown as Adapter;
  }

  @callable()
  async startReplyFiber(mode: "answer" | "apologize"): Promise<string> {
    const stage = mode === "answer" ? "accepted" : "streaming";
    const event = makeMessengerReplyEvent();
    const thread = makeMessengerThreadSnapshot();
    const result = await this.startFiber(
      MESSENGER_REPLY_FIBER_NAME,
      async (fiber: FiberContext) => {
        // Stash the target stage, then park so a SIGKILL captures exactly this
        // stage (the real reply work is performed by recovery on restart).
        fiber.stash(messengerReplySnapshot(stage, event, thread));
        await new Promise((resolve) => setTimeout(resolve, 60_000));
      },
      {
        idempotencyKey: `messenger:fake:${mode}`,
        metadata: { messengerId: FAKE_MESSENGER_ID, threadId: FAKE_THREAD_ID },
        waitForCompletion: false
      }
    );
    return result.fiberId;
  }

  @callable()
  async getPostedMessages(): Promise<string[]> {
    this._ensurePostsTable();
    return this.sql<{ content: string }>`
      SELECT content FROM messenger_posts ORDER BY seq ASC
    `.map((row) => row.content);
  }

  @callable()
  async hasFiberRows(): Promise<boolean> {
    const rows = this.sql<{ c: number }>`
      SELECT COUNT(*) as c FROM cf_agents_runs
    `;
    return (rows[0]?.c ?? 0) > 0;
  }
}

// ── Workflow-turn recovery + notification drain replay ──────────────
//
// A `ThinkWorkflow` `step.prompt` creates a durable submission (the "workflow
// turn") with workflow-prompt metadata, then waits for the completion event the
// submission delivers through the workflow-notification drain. This exercises:
//  - the happy path: a deterministic mock structured turn completes, the
//    notification is drained, and the workflow resumes + completes
//  - recovery: the workflow turn interrupted mid-stream is recovered on restart
//    and the workflow-notification drain replays the result
//
// The model is a deterministic mock that ends the structured turn by calling the
// synthetic `think_final_answer` tool (no user tools → that exact name) with a
// schema-shaped greeting. It streams the tool input in slow deltas so a SIGKILL
// can land mid-turn.

const WORKFLOW_GREETING = "hello from a recovered workflow turn";

function createStructuredGreetingModel(chunkDelayMs: number): LanguageModel {
  const input = JSON.stringify({ greeting: WORKFLOW_GREETING });
  // Split the JSON into a handful of pieces so the tool-input streams over a
  // window (keeps the stream active + gives a mid-turn kill window).
  const pieces: string[] = [];
  const size = Math.max(1, Math.ceil(input.length / 10));
  for (let i = 0; i < input.length; i += size) {
    pieces.push(input.slice(i, i + size));
  }
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-structured-greeting",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream() {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          const id = "fa";
          controller.enqueue({
            type: "tool-input-start",
            id,
            toolName: "think_final_answer"
          });
          for (const piece of pieces) {
            await new Promise((r) => setTimeout(r, chunkDelayMs));
            controller.enqueue({ type: "tool-input-delta", id, delta: piece });
          }
          controller.enqueue({ type: "tool-input-end", id });
          controller.enqueue({
            type: "tool-call",
            toolCallId: id,
            toolName: "think_final_answer",
            input
          });
          controller.enqueue({
            type: "finish",
            finishReason: v3FinishReason("tool-calls"),
            usage: v3Usage(10, 5)
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

export class ThinkWorkflowRecoveryE2EAgent extends Think<Env> {
  static options = { keepAliveIntervalMs: 2_000 };
  override chatRecovery = true;
  override maxSteps = 4;

  override getModel(): LanguageModel {
    return createStructuredGreetingModel(500);
  }

  override getSystemPrompt(): string {
    return "Workflow-turn recovery e2e agent.";
  }

  override async onChatRecovery(): Promise<ChatRecoveryOptions> {
    return { continue: true };
  }

  @callable()
  async startGreetingWorkflow(): Promise<string> {
    return this.runWorkflow("STEP_PROMPT_WORKFLOW", {
      prompt: "Greet the user.",
      mode: "greeting"
    });
  }

  @callable()
  async inspectWorkflowRun(
    id: string
  ): Promise<{ status: string; output: unknown; error: string | null }> {
    const status = await this.getWorkflowStatus("STEP_PROMPT_WORKFLOW", id);
    return {
      status: status.status,
      output: status.output ?? null,
      error: status.error ? JSON.stringify(status.error) : null
    };
  }

  @callable()
  async getNotificationStats(): Promise<{ total: number; delivered: number }> {
    this
      .sql`CREATE TABLE IF NOT EXISTS cf_think_workflow_notifications (notification_id TEXT PRIMARY KEY, submission_id TEXT, workflow_name TEXT, workflow_id TEXT, event_type TEXT, payload_json TEXT, attempts INTEGER, last_error TEXT, created_at INTEGER, updated_at INTEGER, delivered_at INTEGER)`;
    const total =
      this.sql<{ c: number }>`
        SELECT COUNT(*) as c FROM cf_think_workflow_notifications
      `[0]?.c ?? 0;
    const delivered =
      this.sql<{ c: number }>`
        SELECT COUNT(*) as c FROM cf_think_workflow_notifications
        WHERE delivered_at IS NOT NULL
      `[0]?.c ?? 0;
    return { total, delivered };
  }

  @callable()
  async hasFiberRows(): Promise<boolean> {
    const rows = this.sql<{ c: number }>`
      SELECT COUNT(*) as c FROM cf_agents_runs
    `;
    return (rows[0]?.c ?? 0) > 0;
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
