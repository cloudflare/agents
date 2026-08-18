import { routeAgentRequest, callable, getAgentByName } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
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
import pythonModules from "@cloudflare/computer/shell/python";
import sqliteModules from "@cloudflare/computer/shell/sqlite";
import fileModules from "@cloudflare/computer/shell/file";
import { createWorkersAI } from "workers-ai-provider";
import {
  streamText,
  generateText,
  convertToModelMessages,
  pruneMessages,
  isStepCount,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type UIMessage
} from "ai";
import { KernelStore } from "./kernel/store";
import {
  artifactsSessionId,
  ExoCore,
  type ExoWorkspace
} from "./kernel/harness";
import { createMockModel } from "./kernel/mock-model";
import {
  INITIAL_STATE,
  JOURNAL_TAIL_LIMIT,
  TASK_BOUNDS,
  type ContextSnapshot,
  type ExoState,
  type ForkOrigin,
  type HarnessPolicy,
  type JournalEntry,
  type Json,
  type LoadedHarness,
  type TaskInfo,
  type VersionInfo
} from "./kernel/types";

/**
 * Narrow RPC surface for parent → child fork delivery. The full stub type
 * trips TS instantiation-depth limits (see src/tests/kernel.test.ts).
 */
interface AdoptableKernel {
  adoptGenesis(origin: ForkOrigin): Promise<{ version: number; sha: string }>;
}

// Loopback plumbing for @cloudflare/computer: the worker-shell isolate
// reaches the host workspace through ctx.exports.WorkspaceServiceProxy;
// WorkspaceProxy carries a (future) container backend's egress.
export { WorkspaceProxy, WorkspaceServiceProxy };

/**
 * ExoKernel — the stable, non-self-modifiable layer of an exo-style agent.
 *
 * It owns the append-only journal, the version ledger, the Workspace, and
 * the turn loop. Everything the agent "is" (identity prompt, model policy,
 * tools) lives as files under /harness in the Workspace and is hot-loaded
 * on every turn — see src/kernel/harness.ts.
 */
export class ExoKernel extends AIChatAgent<Env, ExoState> {
  initialState = INITIAL_STATE;

  #workspace: ExoWorkspace | undefined;
  #store: KernelStore | undefined;
  #core: ExoCore | undefined;

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
            pythonModules,
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
    const { system, estimatedTokens } = this.assembleSystem(
      loaded,
      memory,
      messages
    );
    const tools = core.buildTools(loaded);
    this.captureContext(
      "chat",
      loaded,
      system,
      messages,
      tools,
      estimatedTokens,
      memory?.length ?? 0
    );

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: this.resolveModel(loaded.policy),
      system,
      messages,
      tools,
      stopWhen: isStepCount(loaded.policy.maxSteps ?? 8),
      onFinish: () => {
        store.appendJournal("turn_end", { source: "chat" });
        this.refreshSyncedState();
      }
    });

    return result.toUIMessageStreamResponse();
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
    const { system, estimatedTokens } = this.assembleSystem(
      loaded,
      memory,
      messages
    );
    const tools = core.buildTools(loaded, {
      allowScheduling: source !== "task"
    });
    this.captureContext(
      source,
      loaded,
      system,
      messages,
      tools,
      estimatedTokens,
      memory?.length ?? 0
    );

    const result = await generateText({
      model: this.resolveModel(loaded.policy),
      system,
      messages,
      tools,
      stopWhen: isStepCount(loaded.policy.maxSteps ?? 8)
    });

    store.appendJournal("turn_end", { source });
    this.refreshSyncedState();

    const toolCalls = result.steps.flatMap((step) =>
      step.toolCalls.map((call) => ({
        toolName: call.toolName,
        input: call.input as Json
      }))
    );
    return { text: result.text, toolCalls };
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
    memoryChars: number
  ): void {
    try {
      this.store().saveContextSnapshot({
        ts: Date.now(),
        source,
        model: this.env.MODEL_OVERRIDE || loaded.policy.model,
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

  resolveModel(policy: HarnessPolicy): LanguageModel {
    const spec = this.env.MODEL_OVERRIDE || policy.model;
    if (spec === "mock") {
      return createMockModel();
    }
    if (spec.startsWith("workers-ai:")) {
      const workersai = createWorkersAI({ binding: this.env.AI });
      return workersai(spec.slice("workers-ai:".length));
    }
    throw new Error(
      `Unknown model "${spec}" — use "mock" or "workers-ai:<model-id>"`
    );
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
      '- /harness/policy.json — model policy, e.g. {"model": "workers-ai:<id>", "maxSteps": 8}',
      contextLine,
      "- /harness/tools/*.js — your harness tools (ES modules; see tools/echo.js for the format)",
      "",
      "To change yourself: edit those files with write_file, then call",
      "activate_harness to validate and commit a new version. If a broken edit",
      "stops the harness from loading, the kernel auto-restores the last",
      "activated version. rollback_harness restores any earlier version.",
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
      "awk, jq, curl, python, sqlite) plus `git` and `artifacts` commands",
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
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
