import { routeAgentRequest, callable, getAgentByName } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { Workspace } from "@cloudflare/shell";
import { createWorkersAI } from "workers-ai-provider";
import {
  streamText,
  generateText,
  convertToModelMessages,
  pruneMessages,
  isStepCount,
  type LanguageModel
} from "ai";
import { KernelStore } from "./kernel/store";
import { ExoCore } from "./kernel/harness";
import { createMockModel } from "./kernel/mock-model";
import {
  INITIAL_STATE,
  JOURNAL_TAIL_LIMIT,
  type ExoState,
  type ForkOrigin,
  type HarnessPolicy,
  type JournalEntry,
  type Json,
  type LoadedHarness,
  type VersionInfo
} from "./kernel/types";

/**
 * Narrow RPC surface for parent → child fork delivery. The full stub type
 * trips TS instantiation-depth limits (see src/tests/kernel.test.ts).
 */
interface AdoptableKernel {
  adoptGenesis(origin: ForkOrigin): Promise<{ version: number; sha: string }>;
}

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

  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "ws",
    name: () => this.name
  });

  #store: KernelStore | undefined;
  #core: ExoCore | undefined;

  store(): KernelStore {
    this.#store ??= new KernelStore((strings, ...values) =>
      this.sql(strings, ...values)
    );
    return this.#store;
  }

  core(): ExoCore {
    this.#core ??= new ExoCore({
      workspace: this.workspace,
      store: this.store(),
      loader: this.env.LOADER,
      name: () => this.name,
      // Absent in offline dev and tests — the core then skips pushing.
      artifacts: this.env.ARTIFACTS,
      adoptChild: async (childName, origin) => {
        const child = await getAgentByName(this.env.ExoKernel, childName);
        return (child as unknown as AdoptableKernel).adoptGenesis(origin);
      },
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

    store.appendJournal("turn_start", {
      source: "chat",
      version: store.activeVersion()
    });

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: this.resolveModel(loaded.policy),
      system: this.systemPrompt(loaded),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: core.buildTools(loaded),
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
    const core = this.core();
    await core.ensureGenesis();
    const loaded = await core.loadHarness();
    const store = this.store();

    store.appendJournal("turn_start", {
      source: "prompt",
      version: store.activeVersion()
    });

    const result = await generateText({
      model: this.resolveModel(loaded.policy),
      system: this.systemPrompt(loaded),
      messages: [{ role: "user", content: text }],
      tools: core.buildTools(loaded),
      stopWhen: isStepCount(loaded.policy.maxSteps ?? 8)
    });

    store.appendJournal("turn_end", { source: "prompt" });
    this.refreshSyncedState();

    const toolCalls = result.steps.flatMap((step) =>
      step.toolCalls.map((call) => ({
        toolName: call.toolName,
        input: call.input as Json
      }))
    );
    return { text: result.text, toolCalls };
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

  /** Fixed kernel preamble + the agent's own (editable) identity file. */
  systemPrompt(loaded: LoadedHarness): string {
    const version = this.store().activeVersion();
    const toolList = loaded.tools
      .map((t) => `- ${t.name} (${t.file}): ${t.description}`)
      .join("\n");
    return [
      "## Kernel briefing (fixed, not editable)",
      "",
      "You are a self-modifying agent. Your evolvable source lives in your",
      "workspace under /harness and is hot-loaded every turn:",
      "- /harness/identity.md — your identity and operating rules (the section after this briefing)",
      '- /harness/policy.json — model policy, e.g. {"model": "workers-ai:<id>", "maxSteps": 8}',
      "- /harness/tools/*.js — your harness tools (ES modules; see tools/echo.js for the format)",
      "",
      "To change yourself: edit those files with write_file, then call",
      "activate_harness to validate and commit a new version. If a broken edit",
      "stops the harness from loading, the kernel auto-restores the last",
      "activated version. rollback_harness restores any earlier version.",
      "Your journal is append-only and survives everything; use journal_note",
      "for anything your future self should know.",
      "",
      `Active harness version: v${version}`,
      loaded.tools.length > 0
        ? `Harness tools currently loaded:\n${toolList}`
        : "No harness tools are currently loaded.",
      "",
      "## Identity (from /harness/identity.md — yours to edit)",
      "",
      loaded.identity
    ].join("\n");
  }

  refreshSyncedState(): void {
    // Fire-and-forget: state sync is a UI mirror, never load-bearing.
    void this.#refreshSyncedState().catch(() => {});
  }

  async #refreshSyncedState(): Promise<void> {
    const store = this.store();
    const files = await this.workspace.glob("/harness/**");
    const versions = store.listVersions();
    const active = versions[versions.length - 1];
    this.setState({
      activeVersion: active?.version ?? 0,
      activeSha: active?.sha ?? "",
      versions,
      journalTail: store.journalTail(JOURNAL_TAIL_LIMIT),
      harnessFiles: files
        .filter((f) => f.type === "file")
        .map((f) => ({ path: f.path, size: f.size }))
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
    return this.workspace.readFile(path);
  }

  @callable()
  async listWorkspaceFiles(
    path: string
  ): Promise<{ path: string; name: string; type: string; size: number }[]> {
    const entries = await this.workspace.readDir(path);
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
