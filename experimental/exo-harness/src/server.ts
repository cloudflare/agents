import { callable, getAgentByName } from "agents";
import {
  AIChatAgent,
  type ChatResponseResult,
  type OnChatMessageOptions
} from "@cloudflare/ai-chat";
import {
  Workspace,
  WorkspaceProxy,
  WorkspaceServiceProxy,
  type DurableObjectStorageLike,
  type WorkspaceStub
} from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createGitClient } from "@cloudflare/computer/git";
import curlModules from "@cloudflare/computer/shell/curl";
import jqModules from "@cloudflare/computer/shell/jq";
// NOT the python group: it is a stub that errors in the Workers runtime
// ("not available in browser environments").
import jsExecModules from "@cloudflare/computer/shell/js-exec";
import sqliteModules from "@cloudflare/computer/shell/sqlite";
import fileModules from "@cloudflare/computer/shell/file";
import { createWorkersAI } from "workers-ai-provider";
import {
  streamText,
  generateText,
  convertToModelMessages,
  pruneMessages,
  isStepCount,
  modelMessageSchema,
  validateUIMessages,
  type LanguageModel,
  type ModelMessage,
  type PrepareStepFunction,
  type StreamTextTransform,
  type TextStreamPart,
  type ToolSet,
  type UIMessage
} from "ai";
import { z } from "zod";
import {
  accessSubjectAgentName,
  createAccessRequestAuthenticator,
  parseAccessAuthenticationConfig
} from "./access-auth";
import { KernelStore } from "./kernel/store";
import {
  artifactsSessionId,
  ExoCore,
  type ExoWorkspace
} from "./kernel/harness";
import {
  createExoGatewayOpenAIModel,
  parseModelSpec,
  publicModelError
} from "./kernel/model";
import { createMockModel } from "./kernel/mock-model";
import {
  INITIAL_STATE,
  JOURNAL_TAIL_LIMIT,
  TASK_BOUNDS,
  type ContextSnapshot,
  type ExoState,
  type ForkOrigin,
  type HarnessPolicy,
  type HarnessRuntimeHookName,
  type HarnessRuntimeToolCall,
  type HarnessRuntimeToolDecision,
  type HarnessRuntimeToolResult,
  type JournalEntry,
  type Json,
  type LoadedHarness,
  type TaskInfo,
  type TurnSource,
  type VersionInfo
} from "./kernel/types";

/**
 * Narrow RPC surface for parent → child fork delivery. The full stub type
 * trips TS instantiation-depth limits (see src/tests/kernel.test.ts).
 */
interface AdoptableKernel {
  adoptGenesis(origin: ForkOrigin): Promise<{ version: number; sha: string }>;
}

const RUNTIME_TURN_PATCH_SCHEMA = z
  .object({
    system: z.string().max(100_000).optional(),
    appendSystem: z.string().max(16_000).optional(),
    messages: z.array(modelMessageSchema).max(200).optional(),
    appendMessages: z.array(modelMessageSchema).max(50).optional(),
    model: z.string().min(1).max(200).optional(),
    activeTools: z.array(z.string()).max(100).optional(),
    toolChoice: z.enum(["auto", "none", "required"]).optional(),
    maxSteps: z.number().int().min(1).max(50).optional()
  })
  .strict();

const RUNTIME_TOOL_DECISION_SCHEMA = z.discriminatedUnion("action", [
  z.object({ action: z.literal("allow"), input: z.unknown().optional() }),
  z.object({ action: z.literal("block"), reason: z.string().max(2000) }),
  z.object({ action: z.literal("substitute"), output: z.unknown() })
]);

const RUNTIME_TOOL_RESULT_PATCH_SCHEMA = z
  .object({ output: z.unknown() })
  .strict();
const RUNTIME_OUTPUT_PATCH_SCHEMA = z
  .object({ text: z.string().max(100_000) })
  .strict();
const RUNTIME_EXECUTE_TOOL_SCHEMA = z
  .object({
    name: z.string().min(1).max(100),
    input: z.unknown()
  })
  .strict();
const RUNTIME_INFER_SCHEMA = z
  .object({
    prompt: z.string().min(1).max(100_000),
    system: z.string().max(32_000).optional(),
    maxOutputTokens: z.number().int().min(1).max(4000).optional()
  })
  .strict();
const RUNTIME_SCHEDULE_SCHEMA = z
  .object({
    instruction: z.string().min(1).max(4000),
    delaySeconds: z
      .number()
      .int()
      .min(30)
      .max(30 * 24 * 3600)
      .optional(),
    at: z.string().optional(),
    cron: z.string().optional()
  })
  .strict()
  .refine(
    ({ delaySeconds, at, cron }) =>
      [delaySeconds, at, cron].filter((value) => value !== undefined).length ===
      1,
    { message: "provide exactly one of delaySeconds, at, or cron" }
  );

const MAX_RUNTIME_INFERENCES_PER_HOOK = 4;

type RuntimeTurnPatch = z.infer<typeof RUNTIME_TURN_PATCH_SCHEMA>;
type ExoPrepareStepContext = Parameters<PrepareStepFunction<ToolSet>>[0];

interface RuntimeCapabilityContext {
  hook: HarnessRuntimeHookName;
  loaded: LoadedHarness;
  source: TurnSource;
  allowScheduling: boolean;
  sideInferenceCount: number;
}

interface RuntimeTurnConfig {
  system: string;
  messages: ModelMessage[];
  model: LanguageModel;
  modelSpec: string;
  activeTools?: string[];
  toolChoice?: "auto" | "none" | "required";
  maxSteps: number;
}

/** Runtime bindings plus the managed team AI Gateway secret. */
export type ExoHarnessEnv = Env & {
  CLOUDFLARE_AIG_TOKEN?: string;
};

let accessAuthenticator:
  | ReturnType<typeof createAccessRequestAuthenticator>
  | undefined;

function configuredAccessAuthenticator(
  env: ExoHarnessEnv
): ReturnType<typeof createAccessRequestAuthenticator> | Response {
  if (accessAuthenticator) return accessAuthenticator;
  const parsed = parseAccessAuthenticationConfig(env);
  if (!parsed.ok) {
    return new Response(parsed.error.message, { status: 500 });
  }
  accessAuthenticator = createAccessRequestAuthenticator(parsed.config);
  return accessAuthenticator;
}

// Loopback plumbing for @cloudflare/computer: the worker-shell isolate
// reaches the host workspace through ctx.exports.WorkspaceServiceProxy;
// WorkspaceProxy carries a (future) container backend's egress.
export { WorkspaceProxy, WorkspaceServiceProxy };

/**
 * ExoKernel — the stable, non-self-modifiable layer of an exo-style agent.
 *
 * It owns the append-only journal, version ledger, Workspace, and protected
 * turn rails. Everything the agent "is" (identity, model policy, tools, and
 * runtime orchestration) lives under /harness and is hot-loaded
 * on every turn — see src/kernel/harness.ts.
 */
export class ExoKernel extends AIChatAgent<ExoHarnessEnv, ExoState> {
  /** Keep the Access-derived Durable Object name out of client protocol messages. */
  static options = { sendIdentityOnConnect: false };

  initialState = INITIAL_STATE;

  #workspace: ExoWorkspace | undefined;
  #store: KernelStore | undefined;
  #core: ExoCore | undefined;
  #workersai: ReturnType<typeof createWorkersAI> | undefined;
  #runtimeCapabilities = new Map<string, RuntimeCapabilityContext>();
  #chatHarnessByRequest = new Map<string, LoadedHarness>();

  /**
   * The agent's computer: a SQLite-backed virtual filesystem with two
   * isolate execution backends — just-bash (worker-shell, with host-side
   * git + artifacts commands) and ES modules (worker-javascript, which
   * runs the harness tools with Workspace-backed node:fs and the
   * ws:journal capability). Lazy: sessionId derives from the agent name.
   */
  ws(): ExoWorkspace {
    this.#workspace ??= new Workspace({
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
      sessionId: artifactsSessionId(
        this.name,
        this.env.ARTIFACTS_REPO_PREFIX || "exo"
      ),
      git: createGitClient(),
      defaultGitIdentity: { name: "Exo Kernel", email: "exo@cloudflare.dev" },
      // Absent in offline dev and tests: the shell's `artifacts` command
      // then fails with a clear "not configured" error.
      artifacts: this.env.ARTIFACTS
        ? { binding: this.env.ARTIFACTS }
        : undefined,
      useThink: true,
      backends: [
        new WorkerShellBackend({
          id: "worker-shell",
          loader: this.env.LOADER,
          workspace: { binding: "ExoKernel", id: this.ctx.id.toString() },
          ctx: this.ctx,
          commands: [
            curlModules,
            jqModules,
            jsExecModules,
            sqliteModules,
            fileModules
          ]
        }),
        new WorkerJavaScriptBackend({
          id: "worker-javascript",
          loader: this.env.LOADER,
          // The harness lives at /harness (not the default /workspace).
          root: "/",
          access: "read-write",
          defaultTimeoutMs: 20_000,
          trustedModules: {
            "ws:journal": {
              call: async (method, args) => {
                if (method !== "note") {
                  throw new Error(`unknown ws:journal method "${method}"`);
                }
                this.store().appendJournal("note", {
                  text: String(args[0] ?? ""),
                  source: "tool"
                });
                this.refreshSyncedState();
                return { ok: true };
              }
            },
            "ws:kernel": {
              call: async (method, args) => {
                const value = await this.#callRuntimeCapability(method, args);
                // SAFETY: every capability result is structured-clone data;
                // the backend's recursive value type is not exported.
                return value as never;
              }
            }
          }
        })
      ]
    }) as ExoWorkspace;
    return this.#workspace;
  }

  /**
   * Loopback for the worker-shell isolate: WorkspaceServiceProxy dispatches
   * here so in-isolate commands (including `git` and `artifacts`) can reach
   * the host workspace.
   */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    const workspace = this.ws();
    await workspace.ready();
    return workspace.stub();
  }

  /** Dispatch one call from a hook-scoped ws:kernel capability. */
  async #callRuntimeCapability(
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const capabilityToken = z.string().parse(args[0]);
    const context = this.#runtimeCapabilities.get(capabilityToken);
    if (!context) throw new Error("runtime capability expired");
    const value = args[1];

    switch (method) {
      case "infer": {
        const input = RUNTIME_INFER_SCHEMA.parse(value);
        if (context.sideInferenceCount >= MAX_RUNTIME_INFERENCES_PER_HOOK) {
          throw new Error(
            `runtime hooks may start at most ${MAX_RUNTIME_INFERENCES_PER_HOOK} side inferences`
          );
        }
        context.sideInferenceCount += 1;
        const limit = this.store().reserveModelInvocation("runtime", 0);
        if (limit) throw limit;
        const result = await generateText({
          model: this.resolveModel(context.loaded.policy),
          system: input.system,
          prompt: input.prompt,
          maxOutputTokens: input.maxOutputTokens ?? 1200
        });
        return { text: result.text, finishReason: result.finishReason };
      }
      case "readMessages":
        return this.messages;
      case "appendMessages": {
        if (context.hook !== "beforeTurn" && context.hook !== "afterTurn") {
          throw new Error(
            "appendMessages is available only during beforeTurn and afterTurn"
          );
        }
        const messages = await validateUIMessages<UIMessage>({
          messages: value
        });
        const messageIds = new Set(this.messages.map((message) => message.id));
        for (const message of messages) {
          if (messageIds.has(message.id)) {
            throw new Error("appendMessages requires new message ids");
          }
          messageIds.add(message.id);
        }
        await this.persistMessages([...this.messages, ...messages]);
        return { ok: true, count: messages.length };
      }
      case "executeTool": {
        const input = RUNTIME_EXECUTE_TOOL_SCHEMA.parse(value);
        const tools = this.core().buildTools(context.loaded, {
          source: context.source,
          allowScheduling: context.allowScheduling
        });
        const selected = tools[input.name];
        if (!selected?.execute) {
          throw new Error(`unknown or non-executable tool "${input.name}"`);
        }
        // SAFETY: runtime-requested tool inputs are deliberately dynamic; the
        // journal wrapper converts schema/implementation failures to output.
        return selected.execute(
          input.input as never,
          {
            toolCallId: `runtime-${crypto.randomUUID()}`,
            messages: [],
            context: undefined
          } as never
        );
      }
      case "journal": {
        const text = z.string().min(1).max(8000).parse(value);
        this.store().appendJournal("note", { text, source: "runtime" });
        this.refreshSyncedState();
        return { ok: true };
      }
      case "readJournal": {
        const limit = z.number().int().min(1).max(200).default(50).parse(value);
        return this.store().journalTail(limit);
      }
      case "scheduleTask": {
        if (!context.allowScheduling) {
          throw new Error("scheduled turns cannot create more schedules");
        }
        const input = RUNTIME_SCHEDULE_SCHEMA.parse(value);
        if (input.delaySeconds !== undefined) {
          return this.scheduleTaskImpl({
            instruction: input.instruction,
            when: { kind: "delay", seconds: input.delaySeconds }
          });
        }
        if (input.at !== undefined) {
          const timestamp = Date.parse(input.at);
          if (!Number.isFinite(timestamp)) {
            throw new Error("at must be an ISO-8601 timestamp");
          }
          return this.scheduleTaskImpl({
            instruction: input.instruction,
            when: { kind: "at", time: new Date(timestamp) }
          });
        }
        if (input.cron !== undefined) {
          return this.scheduleTaskImpl({
            instruction: input.instruction,
            when: { kind: "cron", cron: input.cron }
          });
        }
        throw new Error("schedule is missing a time selector");
      }
      case "cancelTask":
        return this.cancelTaskById(z.string().min(1).parse(value));
      default:
        throw new Error(`unknown ws:kernel method "${method}"`);
    }
  }

  store(): KernelStore {
    this.#store ??= new KernelStore((strings, ...values) =>
      this.sql(strings, ...values)
    );
    return this.#store;
  }

  core(): ExoCore {
    this.#core ??= new ExoCore({
      workspace: this.ws(),
      store: this.store(),
      name: () => this.name,
      // Absent in offline dev and tests — the core then skips pushing.
      artifacts: this.env.ARTIFACTS,
      // Environment split: prod and local dev agents get separate mirrors.
      repoPrefix: this.env.ARTIFACTS_REPO_PREFIX || "exo",
      adoptChild: async (childName, origin) => {
        const child = await getAgentByName(this.env.ExoKernel, childName);
        return (child as unknown as AdoptableKernel).adoptGenesis(origin);
      },
      scheduleTask: (input) => this.scheduleTaskImpl(input),
      cancelTask: (id) => this.cancelTaskById(id),
      onMutation: () => this.refreshSyncedState()
    });
    return this.#core;
  }

  maxPersistedMessages = 200;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const core = this.core();
    await core.ensureGenesis();
    const loaded = await core.loadHarness();
    const store = this.store();

    // Apply any compaction requested last turn BEFORE assembling context,
    // so the cut and its marker are part of what the model now sees.
    await this.#applyPendingCompaction();

    store.appendJournal("turn_start", {
      source: "chat",
      version: store.activeVersion()
    });

    const memory = await core.readMemory(loaded.context);
    const messages = pruneMessages({
      messages: await convertToModelMessages(this.messages),
      toolCalls: "before-last-2-messages",
      reasoning: "before-last-message"
    }).slice(-loaded.context.keepMessages);
    const { system } = this.assembleSystem(loaded, memory, messages);
    const tools = core.buildTools(loaded, {
      source: "chat",
      beforeToolCall: (call) => this.#runtimeBeforeToolCall(loaded, call),
      afterToolCall: (result) => this.#runtimeAfterToolCall(loaded, result)
    });
    const turn = await this.#runtimeBeforeTurn(
      loaded,
      "chat",
      system,
      messages,
      tools
    );
    this.captureContext(
      "chat",
      loaded,
      turn.system,
      turn.messages,
      tools,
      Math.round(
        (turn.system.length + JSON.stringify(turn.messages).length) / 4
      ),
      memory?.length ?? 0,
      turn.modelSpec
    );

    if (options?.requestId) {
      this.#chatHarnessByRequest.set(options.requestId, loaded);
    }
    const result = streamText({
      abortSignal: options?.abortSignal,
      model: turn.model,
      system: turn.system,
      messages: turn.messages,
      tools,
      activeTools: turn.activeTools,
      toolChoice: turn.toolChoice,
      stopWhen: isStepCount(turn.maxSteps),
      prepareStep: this.#runtimePrepareStep(loaded, "chat", tools),
      experimental_transform: this.#runtimeStreamTransform(loaded, "chat"),
      onFinish: () => {
        store.appendJournal("turn_end", { source: "chat" });
        this.refreshSyncedState();
      },
      onError: ({ error }) => {
        this.#journalTurnError("chat", publicModelError(error));
      }
    });

    return result.toUIMessageStreamResponse({
      onError: publicModelError
    });
  }

  /** Run the evolvable post-turn hook after AIChatAgent persists the reply. */
  protected async onChatResponse(result: ChatResponseResult): Promise<void> {
    const loaded =
      this.#chatHarnessByRequest.get(result.requestId) ??
      (await this.core().loadHarness());
    this.#chatHarnessByRequest.delete(result.requestId);
    await this.#runtimeAfterTurn(loaded, "chat", {
      status: result.status,
      requestId: result.requestId,
      continuation: result.continuation,
      message: result.message,
      ...(result.error !== undefined && {
        error: publicModelError(result.error)
      })
    });
  }

  /**
   * One-shot, non-streaming turn outside the chat transcript. Used by the
   * test suite and handy as a CLI-ish probe. Runs the identical harness
   * load + tool surface as the chat path.
   */
  @callable()
  async prompt(text: string): Promise<{
    text: string;
    toolCalls: { toolName: string; input: Json }[];
  }> {
    return this.#runOneShotTurn("prompt", text);
  }

  /**
   * Shared out-of-band turn runner for prompt() and scheduled tasks.
   * Scheduled turns cannot create further tasks (human-initiated only).
   */
  async #runOneShotTurn(
    source: "prompt" | "task",
    text: string
  ): Promise<{ text: string; toolCalls: { toolName: string; input: Json }[] }> {
    const core = this.core();
    await core.ensureGenesis();
    const loaded = await core.loadHarness();
    const store = this.store();

    store.appendJournal("turn_start", {
      source,
      version: store.activeVersion()
    });

    const memory = await core.readMemory(loaded.context);
    const messages: ModelMessage[] = [{ role: "user", content: text }];
    const { system } = this.assembleSystem(loaded, memory, messages);
    const tools = core.buildTools(loaded, {
      source,
      allowScheduling: source !== "task",
      beforeToolCall: (call) => this.#runtimeBeforeToolCall(loaded, call),
      afterToolCall: (result) => this.#runtimeAfterToolCall(loaded, result)
    });
    const turn = await this.#runtimeBeforeTurn(
      loaded,
      source,
      system,
      messages,
      tools
    );
    this.captureContext(
      source,
      loaded,
      turn.system,
      turn.messages,
      tools,
      Math.round(
        (turn.system.length + JSON.stringify(turn.messages).length) / 4
      ),
      memory?.length ?? 0,
      turn.modelSpec
    );

    let result;
    try {
      result = await generateText({
        model: turn.model,
        system: turn.system,
        messages: turn.messages,
        tools,
        activeTools: turn.activeTools,
        toolChoice: turn.toolChoice,
        stopWhen: isStepCount(turn.maxSteps),
        prepareStep: this.#runtimePrepareStep(loaded, source, tools)
      });
    } catch (error) {
      this.#journalTurnError(source, publicModelError(error));
      throw error;
    }

    const toolCalls = result.steps.flatMap((step) =>
      step.toolCalls.map((call) => ({
        toolName: call.toolName,
        input: call.input as Json
      }))
    );
    const outputText = await this.#runtimeTransformOutput(
      loaded,
      source,
      result.text
    );
    store.appendJournal("turn_end", { source });
    await this.#runtimeAfterTurn(loaded, source, {
      status: "completed",
      text: outputText,
      toolCalls
    });
    this.refreshSyncedState();
    return { text: outputText, toolCalls };
  }

  /** Create a persistent self-scheduled task (kernel rails enforced). */
  async scheduleTaskImpl(input: {
    instruction: string;
    when:
      | { kind: "delay"; seconds: number }
      | { kind: "at"; time: Date }
      | { kind: "cron"; cron: string };
  }): Promise<{ id: string; kind: TaskInfo["kind"]; spec: string }> {
    const store = this.store();
    if (store.countActiveTasks() >= TASK_BOUNDS.maxActiveTasks) {
      throw new Error(
        `task limit reached (${TASK_BOUNDS.maxActiveTasks} active) — cancel one first`
      );
    }
    const payload = { instruction: input.instruction };
    let kind: TaskInfo["kind"];
    let spec: string;
    let scheduled: { id: string };
    switch (input.when.kind) {
      case "delay":
        kind = "delay";
        spec = `${input.when.seconds}s`;
        scheduled = await this.schedule(
          input.when.seconds,
          "runScheduledTask",
          payload
        );
        break;
      case "at":
        kind = "at";
        spec = input.when.time.toISOString();
        scheduled = await this.schedule(
          input.when.time,
          "runScheduledTask",
          payload
        );
        break;
      case "cron":
        kind = "cron";
        spec = input.when.cron;
        scheduled = await this.schedule(
          input.when.cron,
          "runScheduledTask",
          payload,
          { idempotent: false }
        );
        break;
      default: {
        const _exhaustive: never = input.when;
        throw new Error(`unknown schedule kind ${JSON.stringify(_exhaustive)}`);
      }
    }
    store.insertTask({
      id: scheduled.id,
      instruction: input.instruction,
      kind,
      spec
    });
    store.appendJournal("task_scheduled", {
      taskId: scheduled.id,
      kind,
      spec,
      instruction: input.instruction.slice(0, 300)
    });
    this.refreshSyncedState();
    return { id: scheduled.id, kind, spec };
  }

  /** Cancel an active task: SDK schedule + registry + journal. */
  @callable()
  async cancelTaskById(id: string): Promise<boolean> {
    const store = this.store();
    const task = store.taskById(id);
    if (!task || task.state !== "active") return false;
    await this.cancelSchedule(id);
    store.setTaskState(id, "cancelled");
    store.appendJournal("task_cancelled", { taskId: id });
    this.refreshSyncedState();
    return true;
  }

  /**
   * Schedule callback: run one autonomous turn with the stored
   * instruction. Kernel rails: global min interval between firings, a
   * daily run budget, and auto-disable (loudly journaled) after
   * consecutive failures — otherwise cron semantics: failures never
   * cancel the schedule.
   */
  async runScheduledTask(
    payload: { instruction: string },
    schedule?: { id: string }
  ): Promise<void> {
    const store = this.store();
    const taskId = schedule?.id ?? "";
    const task = store.taskById(taskId);
    if (!task || task.state !== "active") {
      store.appendJournal("task_skipped", { taskId, reason: "not_active" });
      this.refreshSyncedState();
      return;
    }
    const lastRun = store.lastTaskRunTs();
    if (
      lastRun !== null &&
      Date.now() - lastRun < TASK_BOUNDS.minMsBetweenRuns
    ) {
      store.appendJournal("task_skipped", { taskId, reason: "rate_limited" });
      this.refreshSyncedState();
      return;
    }
    if (
      store.journalCountSince("task_run", Date.now() - 86_400_000) >=
      TASK_BOUNDS.maxRunsPerDay
    ) {
      store.appendJournal("task_skipped", { taskId, reason: "daily_budget" });
      this.refreshSyncedState();
      return;
    }

    store.appendJournal("task_run", {
      taskId,
      instruction: payload.instruction.slice(0, 300)
    });
    try {
      await this.#runOneShotTurn("task", payload.instruction);
      store.recordTaskRun(taskId, true);
      if (task.kind !== "cron") {
        store.setTaskState(taskId, "done");
      }
    } catch (error) {
      store.recordTaskRun(taskId, false);
      const message = error instanceof Error ? error.message : String(error);
      store.appendJournal("task_failed", { taskId, error: message });
      const updated = store.taskById(taskId);
      if (
        (updated?.consecutiveFailures ?? 0) >=
        TASK_BOUNDS.disableAfterConsecutiveFailures
      ) {
        await this.cancelSchedule(taskId);
        store.setTaskState(taskId, "disabled");
        store.appendJournal("task_disabled", {
          taskId,
          afterConsecutiveFailures: updated?.consecutiveFailures ?? 0
        });
      }
    }
    this.refreshSyncedState();
  }

  /**
   * Record the exact context assembled for the model this turn — the
   * glass-skull Context tab reads it back. Diagnostic only: never fails
   * the turn.
   */
  captureContext(
    source: ContextSnapshot["source"],
    loaded: LoadedHarness,
    system: string,
    messages: ModelMessage[],
    tools: ToolSet,
    estimatedTokens: number,
    memoryChars: number,
    modelSpec = this.env.MODEL_OVERRIDE || loaded.policy.model
  ): void {
    try {
      this.store().saveContextSnapshot({
        ts: Date.now(),
        source,
        model: modelSpec,
        system,
        messages: messages as unknown as Json,
        tools: Object.entries(tools).map(([name, t]) => ({
          name,
          description: typeof t.description === "string" ? t.description : ""
        })),
        contextPolicy: loaded.context,
        estimatedTokens,
        memoryChars
      });
    } catch {
      // never let diagnostics break a turn
    }
  }

  /**
   * Apply a compaction requested last turn: truncate the persisted chat
   * transcript to the requested tail and insert a visible marker message.
   * Runs at chat-turn start (mutating the transcript mid-turn would race
   * the streaming pipeline). The journal and memory file were already
   * written when the compaction was requested.
   */
  async #applyPendingCompaction(): Promise<void> {
    const store = this.store();
    const pending = store.takePendingCompaction();
    if (!pending) return;
    const keep = Math.max(1, pending.keepLast);
    const dropped = this.messages.length - keep;
    if (dropped <= 0) {
      store.appendJournal("history_compacted", {
        phase: "applied",
        dropped: 0,
        keptLast: this.messages.length
      });
      return;
    }
    const kept = this.messages.slice(-keep);
    // Two persists: stale-row deletion only triggers when the incoming set
    // is a subset of server state, so the cut and the (new) marker message
    // cannot share a write.
    await this.persistMessages(kept, [], { _deleteStaleRows: true });
    const marker: UIMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [
        {
          type: "text",
          text: `⌁ Compacted ${dropped} older message${dropped === 1 ? "" : "s"} into ${pending.memoryFile} (kept last ${keep}).`
        }
      ]
    };
    await this.persistMessages([...kept, marker]);
    store.appendJournal("history_compacted", {
      phase: "applied",
      dropped,
      keptLast: keep,
      memoryFile: pending.memoryFile
    });
    this.refreshSyncedState();
  }

  /**
   * Build the full system prompt (briefing + identity + injected memory)
   * and estimate the turn's context size; when the estimate exceeds the
   * agent's own token target, append a pressure nudge — the kernel never
   * compacts on its own.
   */
  assembleSystem(
    loaded: LoadedHarness,
    memory: string | null,
    messages: ModelMessage[]
  ): { system: string; estimatedTokens: number } {
    const base = this.systemPrompt(loaded, memory);
    const estimatedTokens = Math.round(
      (base.length + JSON.stringify(messages).length) / 4
    );
    if (estimatedTokens <= loaded.context.tokenTarget) {
      return { system: base, estimatedTokens };
    }
    const system = [
      base,
      "",
      `Context pressure: this turn is ~${estimatedTokens} tokens, over your target of ${loaded.context.tokenTarget} (/harness/context.json). Consider compact_history to distill older conversation into memory.`
    ].join("\n");
    return { system, estimatedTokens };
  }

  async #runtimeBeforeTurn(
    loaded: LoadedHarness,
    source: TurnSource,
    system: string,
    messages: ModelMessage[],
    tools: ToolSet
  ): Promise<RuntimeTurnConfig> {
    const hasHook = loaded.runtime?.hooks.includes("beforeTurn") ?? false;
    const raw = await this.#runRuntimeHook(loaded, "beforeTurn", source, {
      source,
      system,
      messages,
      tools: Object.keys(tools),
      model: this.env.MODEL_OVERRIDE || loaded.policy.model,
      maxSteps: loaded.policy.maxSteps ?? 8
    });
    const patch = this.#parseRuntimeTurnPatch("beforeTurn", raw);
    const baseMessages =
      source === "chat" && hasHook
        ? pruneMessages({
            messages: await convertToModelMessages(this.messages),
            toolCalls: "before-last-2-messages",
            reasoning: "before-last-message"
          }).slice(-loaded.context.keepMessages)
        : messages;
    const { model, modelSpec } = this.#runtimeModelSelection(
      loaded,
      patch?.model,
      "beforeTurn"
    );
    return {
      system:
        patch?.system ??
        (patch?.appendSystem ? `${system}\n\n${patch.appendSystem}` : system),
      messages: [
        ...(patch?.messages ?? baseMessages),
        ...(patch?.appendMessages ?? [])
      ],
      model,
      modelSpec,
      activeTools: patch?.activeTools?.filter((name) => name in tools),
      toolChoice: patch?.toolChoice,
      maxSteps: patch?.maxSteps ?? loaded.policy.maxSteps ?? 8
    };
  }

  #runtimePrepareStep(
    loaded: LoadedHarness,
    source: TurnSource,
    tools: ToolSet
  ): PrepareStepFunction<ToolSet> {
    return async (step: ExoPrepareStepContext) => {
      const error = this.store().reserveModelInvocation(
        source,
        step.stepNumber
      );
      if (error) throw error;
      const raw = await this.#runRuntimeHook(loaded, "beforeStep", source, {
        source,
        stepNumber: step.stepNumber,
        instructions: step.instructions,
        messages: step.messages,
        steps: step.steps.map((previous) => ({
          text: previous.text,
          finishReason: previous.finishReason,
          toolCalls: previous.toolCalls,
          toolResults: previous.toolResults
        }))
      });
      const patch = this.#parseRuntimeTurnPatch("beforeStep", raw);
      if (!patch) return {};
      const instructions =
        patch.system ??
        (patch.appendSystem
          ? `${typeof step.instructions === "string" ? step.instructions : ""}\n\n${patch.appendSystem}`
          : undefined);
      const model = patch.model
        ? this.#runtimeModelSelection(loaded, patch.model, "beforeStep").model
        : undefined;
      return {
        ...(model && { model }),
        ...(instructions !== undefined && { instructions }),
        ...(patch.messages && { messages: patch.messages }),
        ...(patch.appendMessages && {
          messages: [
            ...(patch.messages ?? step.messages),
            ...patch.appendMessages
          ]
        }),
        ...(patch.activeTools && {
          activeTools: patch.activeTools.filter((name) => name in tools)
        }),
        ...(patch.toolChoice && { toolChoice: patch.toolChoice })
      };
    };
  }

  async #runtimeBeforeToolCall(
    loaded: LoadedHarness,
    call: HarnessRuntimeToolCall
  ): Promise<HarnessRuntimeToolDecision | undefined> {
    const raw = await this.#runRuntimeHook(
      loaded,
      "beforeToolCall",
      call.source,
      call
    );
    if (raw === undefined || raw === null) return undefined;
    const parsed = RUNTIME_TOOL_DECISION_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      this.#recordRuntimeError("beforeToolCall", parsed.error.message);
      return undefined;
    }
    return parsed.data;
  }

  async #runtimeAfterToolCall(
    loaded: LoadedHarness,
    result: HarnessRuntimeToolResult
  ): Promise<{ output: unknown } | undefined> {
    const raw = await this.#runRuntimeHook(
      loaded,
      "afterToolCall",
      result.source,
      result
    );
    if (raw === undefined || raw === null) return undefined;
    const parsed = RUNTIME_TOOL_RESULT_PATCH_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      this.#recordRuntimeError("afterToolCall", parsed.error.message);
      return undefined;
    }
    return parsed.data;
  }

  async #runtimeTransformOutput(
    loaded: LoadedHarness,
    source: TurnSource,
    text: string
  ): Promise<string> {
    const raw = await this.#runRuntimeHook(loaded, "transformOutput", source, {
      source,
      text
    });
    if (raw === undefined || raw === null) return text;
    const parsed = RUNTIME_OUTPUT_PATCH_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      this.#recordRuntimeError("transformOutput", parsed.error.message);
      return text;
    }
    return parsed.data.text;
  }

  #runtimeStreamTransform(
    loaded: LoadedHarness,
    source: TurnSource
  ): StreamTextTransform<ToolSet> | undefined {
    if (!loaded.runtime?.hooks.includes("transformOutput")) return undefined;
    return () => {
      let buffered: TextStreamPart<ToolSet>[] | null = null;
      let text = "";
      return new TransformStream<
        TextStreamPart<ToolSet>,
        TextStreamPart<ToolSet>
      >({
        transform: async (chunk, controller) => {
          if (chunk.type === "text-start" && buffered === null) {
            buffered = [chunk];
            text = "";
            return;
          }
          if (buffered === null) {
            controller.enqueue(chunk);
            return;
          }
          buffered.push(chunk);
          if (chunk.type === "text-delta") text += chunk.text;
          if (chunk.type !== "text-end") return;

          const transformed = await this.#runtimeTransformOutput(
            loaded,
            source,
            text
          );
          let emittedText = false;
          for (const part of buffered) {
            if (part.type === "text-delta") {
              if (!emittedText) {
                emittedText = true;
                if (transformed) {
                  controller.enqueue({ ...part, text: transformed });
                }
              }
            } else {
              if (part.type === "text-end" && !emittedText && transformed) {
                controller.enqueue({
                  type: "text-delta",
                  id: part.id,
                  providerMetadata: part.providerMetadata,
                  text: transformed
                });
              }
              controller.enqueue(part);
            }
          }
          buffered = null;
          text = "";
        },
        flush: (controller) => {
          for (const part of buffered ?? []) controller.enqueue(part);
        }
      });
    };
  }

  async #runtimeAfterTurn(
    loaded: LoadedHarness,
    source: TurnSource,
    event: Record<string, unknown>
  ): Promise<void> {
    await this.#runRuntimeHook(loaded, "afterTurn", source, {
      source,
      ...event
    });
  }

  async #runRuntimeHook(
    loaded: LoadedHarness,
    hook: HarnessRuntimeHookName,
    source: TurnSource,
    event: unknown
  ): Promise<unknown> {
    if (!loaded.runtime?.hooks.includes(hook)) return undefined;
    const capabilityToken = crypto.randomUUID();
    this.#runtimeCapabilities.set(capabilityToken, {
      hook,
      loaded,
      source,
      allowScheduling: source !== "task",
      sideInferenceCount: 0
    });
    try {
      return await this.core().runRuntimeHook(
        loaded.runtime,
        hook,
        event,
        capabilityToken
      );
    } catch (error) {
      this.#recordRuntimeError(
        hook,
        error instanceof Error ? error.message : String(error)
      );
      return undefined;
    } finally {
      this.#runtimeCapabilities.delete(capabilityToken);
    }
  }

  #runtimeModelSelection(
    loaded: LoadedHarness,
    requested: string | undefined,
    hook: "beforeTurn" | "beforeStep"
  ): { model: LanguageModel; modelSpec: string } {
    const defaultSpec = this.env.MODEL_OVERRIDE || loaded.policy.model;
    if (!requested || this.env.MODEL_OVERRIDE) {
      return {
        model: this.resolveModel(loaded.policy),
        modelSpec: defaultSpec
      };
    }
    try {
      return {
        model: this.resolveModel({ ...loaded.policy, model: requested }),
        modelSpec: requested
      };
    } catch (error) {
      this.#recordRuntimeError(
        hook,
        `invalid model override: ${error instanceof Error ? error.message : String(error)}`
      );
      return {
        model: this.resolveModel(loaded.policy),
        modelSpec: defaultSpec
      };
    }
  }

  #parseRuntimeTurnPatch(
    hook: "beforeTurn" | "beforeStep",
    raw: unknown
  ): RuntimeTurnPatch | undefined {
    if (raw === undefined || raw === null) return undefined;
    const parsed = RUNTIME_TURN_PATCH_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      this.#recordRuntimeError(hook, parsed.error.message);
      return undefined;
    }
    return parsed.data;
  }

  #recordRuntimeError(hook: HarnessRuntimeHookName, message: string): void {
    this.store().appendJournal("error", {
      source: "runtime",
      hook,
      message: message.slice(0, 2000)
    });
  }

  resolveModel(policy: HarnessPolicy): LanguageModel {
    const spec = this.env.MODEL_OVERRIDE || policy.model;
    const parsed = parseModelSpec(spec);
    switch (parsed.kind) {
      case "mock":
        return createMockModel();
      case "workers-ai":
        return this.workersAI()(parsed.id);
      case "openai":
        return this.openaiResponses(parsed.id);
      default: {
        const _exhaustive: never = parsed;
        throw new Error(`unhandled model kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /** Workers AI provider for `@cf/...` models selected by harness policy. */
  workersAI(): ReturnType<typeof createWorkersAI> {
    if (!this.env.AI) {
      throw new Error(
        "This model needs the Workers AI binding. Use MODEL_OVERRIDE=mock offline, or start with wrangler.jsonc / wrangler.dev.jsonc."
      );
    }
    this.#workersai ??= createWorkersAI({ binding: this.env.AI });
    return this.#workersai;
  }

  /** OpenAI Responses model authenticated through the managed team gateway. */
  openaiResponses(modelId: string): LanguageModel {
    return createExoGatewayOpenAIModel(modelId, this.env.CLOUDFLARE_AIG_TOKEN);
  }

  #journalTurnError(source: string, message: string): void {
    this.store().appendJournal("error", { source, message });
    this.refreshSyncedState();
  }

  /**
   * Fixed kernel preamble + the agent's own (editable) identity file +
   * its self-maintained working memory.
   */
  systemPrompt(loaded: LoadedHarness, memory: string | null = null): string {
    const version = this.store().activeVersion();
    const toolList = loaded.tools
      .map((t) => `- ${t.name} (${t.file}): ${t.description}`)
      .join("\n");
    const ctx = loaded.context;
    // Only claim the file exists when it does — agents born before the
    // context milestone run on kernel defaults until they create it.
    const contextLine =
      "/harness/context.json" in loaded.files
        ? "- /harness/context.json — your context policy: message window, memory injection, token target"
        : `- /harness/context.json — not present in your harness; kernel defaults are in effect (keepMessages ${ctx.keepMessages}, tokenTarget ${ctx.tokenTarget}, memory ${ctx.memoryFile} up to ${ctx.memoryMaxChars} chars). Create the file (then activate_harness) to set your own.`;
    const sections = [
      "## Kernel briefing (fixed, not editable)",
      "",
      "You are a self-modifying agent. Your evolvable source lives in your",
      "workspace under /harness and is hot-loaded every turn:",
      "- /harness/identity.md — your identity and operating rules (the section after this briefing)",
      '- /harness/policy.json — model policy, e.g. {"model": "openai/gpt-5.6-terra", "maxSteps": 8} (Workers AI: "workers-ai:@cf/<id>"; openai/* uses the managed Responses API)',
      contextLine,
      "- /harness/tools/*.js — your harness tools (ES modules; see tools/echo.js for the format)",
      "- /harness/runtime.js — optional default-export object controlling beforeTurn, beforeStep, beforeToolCall, afterToolCall, transformOutput, and afterTurn",
      "  Hooks receive (event, host). host supports infer (up to four calls per hook), executeTool, readMessages, appendMessages, journal, readJournal, scheduleTask, and cancelTask; runtime.js can import node:fs for its own files.",
      "  beforeTurn/beforeStep may return system/messages/appendMessages/model/activeTools/toolChoice; beforeTurn may also set maxSteps. Tool hooks may block, substitute, or replace output; transformOutput returns { text }.",
      "",
      "To change yourself: edit those files with write_file, then call",
      "activate_harness to validate and commit a new version. If a broken edit",
      "stops the harness from loading, the kernel auto-restores the last",
      "activated version. rollback_harness restores any earlier version.",
      "Your first-class tool functions refresh at turn start, so a tool you",
      "add or change mid-turn is not yet a function — call it immediately",
      "with run_harness_tool (it always runs against the live /harness).",
      "",
      "Remembering: facts you must carry into future turns belong in",
      `${loaded.context.memoryFile} — it is injected into this prompt every`,
      "turn. Write it directly with write_file, or use compact_history to",
      "distill older conversation into it while trimming your finite chat",
      "transcript. The journal (journal_note / read_journal) is your",
      "append-only record of events — durable forever, but NOT injected;",
      "use it for what happened, not for what you must remember.",
      "",
      "You can give your future self work with schedule_task (once or on a",
      "cron); scheduled turns run autonomously outside the chat with your",
      "full harness, and everything they do is journaled. New tasks can",
      "only be created in human-initiated turns.",
      "",
      "You also have a shell (the exec tool): just-bash in an isolated",
      "Dynamic Worker over your own filesystem, with text tools (grep, sed,",
      "awk, jq, curl, sqlite) plus a `js` command, and `git` and `artifacts`",
      "that run host-side against your workspace and its mirror.",
      "",
      `Active harness version: v${version}`,
      loaded.tools.length > 0
        ? `Harness tools currently loaded:\n${toolList}`
        : "No harness tools are currently loaded.",
      "",
      "## Identity (from /harness/identity.md — yours to edit)",
      "",
      loaded.identity
    ];
    if (memory) {
      sections.push(
        "",
        `## Working memory (from ${loaded.context.memoryFile} — maintain it with compact_history or write_file)`,
        "",
        memory
      );
    }
    return sections.join("\n");
  }

  refreshSyncedState(): void {
    // Fire-and-forget: state sync is a UI mirror, never load-bearing.
    void this.#refreshSyncedState().catch(() => {});
  }

  async #refreshSyncedState(): Promise<void> {
    const store = this.store();
    const files = await this.core().globHarness();
    const versions = store.listVersions();
    const active = versions[versions.length - 1];

    // Join task registry with the live SDK schedules for next-run times.
    const nextRuns = new Map<string, number>();
    for (const schedule of this.getSchedules()) {
      // Schedule rows store epoch seconds; normalize to ms defensively.
      const time = schedule.time < 1e12 ? schedule.time * 1000 : schedule.time;
      nextRuns.set(schedule.id, time);
    }
    const tasks = store.listTasks().map((task) => ({
      ...task,
      nextRunTs:
        task.state === "active" ? (nextRuns.get(task.id) ?? null) : null
    }));

    this.setState({
      activeVersion: active?.version ?? 0,
      activeSha: active?.sha ?? "",
      versions,
      journalTail: store.journalTail(JOURNAL_TAIL_LIMIT),
      harnessFiles: files
        .filter((f) => f.type === "file")
        .map((f) => ({ path: f.path, size: f.size })),
      tasks
    });
  }

  // ── UI + test surface ─────────────────────────────────────────────

  @callable()
  async boot(): Promise<ExoState> {
    await this.core().ensureGenesis();
    await this.#refreshSyncedState();
    return this.state;
  }

  @callable()
  async getFileContent(path: string): Promise<string | null> {
    return this.ws().readFile(path);
  }

  @callable()
  async listWorkspaceFiles(
    path: string
  ): Promise<{ path: string; name: string; type: string; size: number }[]> {
    const entries = await this.ws().readDir(path);
    return entries.map((e) => ({
      path: e.path,
      name: e.name,
      type: e.type,
      size: e.size
    }));
  }

  @callable()
  async getVersionFiles(
    version: number
  ): Promise<Record<string, string> | null> {
    return this.store().versionFiles(version);
  }

  @callable()
  async getVersions(): Promise<VersionInfo[]> {
    return this.store().listVersions();
  }

  @callable()
  async getJournal(beforeId?: number, limit = 100): Promise<JournalEntry[]> {
    const store = this.store();
    return beforeId
      ? store.journalBefore(beforeId, limit)
      : store.journalTail(limit);
  }

  /** Raw model context assembled at the start of the most recent turn. */
  @callable()
  async getContextSnapshot(): Promise<ContextSnapshot | null> {
    return this.store().contextSnapshot();
  }

  /**
   * Destroy this agent entirely — journal, versions, memory, tasks, chat,
   * workspace. The next contact runs a fresh genesis. The Artifacts mirror
   * repo is NOT deleted; the reborn agent force-pushes over it. The
   * underlying destroy() aborts this instance, so the RPC may not return
   * cleanly — callers should treat it as fire-and-forget.
   */
  @callable()
  async resetAgent(): Promise<void> {
    await this.destroy();
  }

  /** Receive a fork genesis from a parent agent (cross-DO RPC). */
  @callable()
  async adoptGenesis(
    origin: ForkOrigin
  ): Promise<{ version: number; sha: string }> {
    return this.core().adoptGenesis(origin);
  }

  @callable()
  async rollbackFromUi(
    version: number
  ): Promise<{ version: number; sha: string }> {
    await this.core().ensureGenesis();
    return this.core().rollbackTo(version);
  }
}

export default {
  async fetch(request: Request, env: ExoHarnessEnv, ctx: ExecutionContext) {
    const pathname = new URL(request.url).pathname;
    if (pathname !== "/agent") {
      return new Response("Not found", { status: 404 });
    }

    const authenticator = configuredAccessAuthenticator(env);
    if (authenticator instanceof Response) return authenticator;
    const authenticated = await authenticator(request, ctx.access);
    if (!authenticated.ok) return authenticated.response;

    const agent = await getAgentByName(
      env.ExoKernel,
      accessSubjectAgentName(authenticated.identity.subject)
    );
    return agent.fetch(request);
  }
} satisfies ExportedHandler<ExoHarnessEnv>;
