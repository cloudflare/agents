/**
 * E2E test worker — Think agents for e2e testing.
 * TestAssistant: real Workers AI with workspace tools.
 * ThinkRecoveryE2EAgent: mock slow stream with chatRecovery for kill/restart testing.
 */
import { createWorkersAI } from "workers-ai-provider";
import { Agent, callable, routeAgentRequest } from "agents";
import { agentTool } from "agents/agent-tools";
import { RpcTarget } from "cloudflare:workers";
import { tool } from "ai";
import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { z } from "zod";
import { Think, Workspace } from "../think";
import type {
  ChatRecoveryContext,
  ChatRecoveryOptions,
  StreamCallback,
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
  ThinkTaskParentE2EAgent: DurableObjectNamespace<ThinkTaskParentE2EAgent>;
  ThinkAgentToolNaturalParentE2EAgent: DurableObjectNamespace<ThinkAgentToolNaturalParentE2EAgent>;
  AI: Ai;
  R2: R2Bucket;
};

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

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
