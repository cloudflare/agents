/**
 * ThinkAgent — one Think Durable Object per GitHub issue.
 *
 * Owns a `@cloudflare/workspace.Workspace` whose container backend has sync
 * disabled. The container's /workspace is authoritative: repos, .git,
 * node_modules, builds, logs, and scratch data never enter the ThinkAgent DO.
 *
 * gh-app calls `dispatch()` (see index.ts) with the issue
 * coordinates, a free-form `instruction` ("reproduce this", "open a
 * PR fixing it", …), and a short-lived GitHub App installation token.
 * `setContext` stores it; `start` authenticates `gh`/`git` in the
 * container with the token, then runs one agent turn.
 *
 * Skills use Think's native R2 SkillSource and activation tools, independent
 * of the coding Workspace filesystem.
 */

import type {
  ChatRecoveryExhaustedContext,
  ChatResponseResult,
  Session,
  ToolCallResultContext,
  TurnContext,
  WorkspaceLike as ThinkWorkspaceLike
} from "@cloudflare/think";
import { skills, Think } from "@cloudflare/think";
import {
  type DurableObjectStorageLike,
  Workspace,
  WorkspaceProxy,
  WorkspaceServiceProxy,
  type WorkspaceStub
} from "@cloudflare/workspace";
import { CloudflareContainerBackend } from "@cloudflare/workspace/backends/container";
import type { LanguageModel, ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { openai } from "workers-ai-provider/openai";
import { getAgentByName } from "agents";
import type { CommandCenterAgent } from "./command-center";
import { releaseContainer, resolveContainerId } from "./pool";
import { createBashTool } from "./tools/bash";
import {
  ContainerFileStore,
  ContainerLocalBackend,
  quote,
  repoDirectory
} from "./container-workspace";
import {
  createEditTool,
  createReadTool,
  createWriteTool
} from "./tools/fs/index";
import {
  buildRunEnvelope,
  buildRunTelemetry,
  type RunTarget
} from "./run-context";
import { RunLifecycle, type RunOutcome } from "./run-lifecycle";
import { AGENT_THINK_MAX_STEPS, classifyTurnOutcome } from "./turn-outcome";

export { WorkspaceProxy, WorkspaceServiceProxy };

const CONTEXT_KEY = "agent-think-context";
// resetSession aborts the isolate AFTER its RPC response has been delivered;
// this is the grace window for that ack, not a tuning knob.
const RESET_ABORT_DELAY_MS = 100;
// GPT-5.5 (medium reasoning) through AI Gateway's model catalog — Unified
// Billing over the AI binding, no provider key. `reasoning_effort` is a
// first-class workers-ai-provider model setting forwarded into the request
// (verified live: completion_tokens_details.reasoning_tokens > 0).
// Fallback if unified-billing credits run dry (gateway 402s):
// MODEL_ID = "@cf/moonshotai/kimi-k2.7-code" bills via Workers AI instead.
const MODEL_ID = "openai/gpt-5.5";
const REASONING_EFFORT = "medium";

/** Per-issue run context, set by `dispatch` before the turn is submitted. */
export interface RunContext extends RunTarget {
  /** Short-lived GitHub App installation token. */
  installationToken: string;
}

/**
 * Register agent-think's identity and operating contract as durable, read-only
 * Session context. Unlike getSystemPrompt(), this block remains present when
 * Think adds its own skills catalog context.
 */
export function configureAgentThinkSession(
  session: Session,
  getContext: () => RunContext | null
): Session {
  return session.withContext("agent-think", {
    description: "Run identity, user instruction, and operating contract.",
    provider: {
      get: async () => agentThinkInstructions(getContext())
    }
  });
}

function agentThinkInstructions(ctx: RunContext | null): string | null {
  if (!ctx) return null;
  return [
    "You are agent-think, acting as the agent-think GitHub App (not any user).",
    `You are working on issue #${ctx.issueNumber} in ${ctx.repo}.`,
    "",
    "The user invoked you with this instruction:",
    `  ${ctx.instruction || "(no instruction — default to reproducing the issue)"}`,
    "",
    ...(ctx.commentId
      ? [
          "FIRST ACTION — prove you are alive: add a 🚀 reaction to the",
          "comment that triggered you, then continue with the task:",
          `  bash({ command: "gh api repos/${ctx.repo}/issues/comments/${ctx.commentId}/reactions -f content=rocket", backend: "container" })`,
          "(👀 was added when your trigger was seen; your 🚀 tells the",
          "humans the agent itself is running.)",
          ""
        ]
      : []),
    "Two skills are available through Think's skill catalog:",
    "  - reproduce — reproduce and report an issue.",
    "  - open-pr   — locate, fix, verify, and open a PR.",
    "",
    "Decide which skill matches the instruction and activate it before acting.",
    "Follow it exactly, including the structured result it specifies.",
    "",
    "Environment:",
    `  - Clone ${ctx.repo} to ${repoDirectory(ctx.repo)}.`,
    "    Keep .git, node_modules, builds, and logs in their normal locations",
    "    there. /workspace/temp is available for scratch data.",
    "  - /workspace is container-local and is NEVER synchronized through the",
    "    Agent Durable Object.",
    "  - `gh`, `git`, `curl`, `npm`, `node`, and `wrangler` run in the",
    "    container. `gh` and `git` are ALREADY AUTHENTICATED there as the app",
    "    (via `gh auth login` + `gh auth setup-git`). Do NOT print, echo, or",
    "    re-configure the token.",
    "  - The dedicated read/write/edit tools operate on the same container",
    "    filesystem, so prefer them for file content operations.",
    "",
    "When done, reply with the structured summary the skill specifies."
  ].join("\n");
}

class ThinkBase extends Think<Env> {}

export class ThinkAgent extends ThinkBase {
  /** Agent-think has no media attachment store; drop aged inline media. */
  override mediaEviction = { externalizeToWorkspace: false };

  // Think's own chat recovery is the durability layer. Its terminal hook must
  // also release agent-think's external resources and command-center status.
  override chatRecovery = {
    onExhausted: (ctx: ChatRecoveryExhaustedContext) =>
      this.#finishRun("error", `Recovery exhausted: ${ctx.reason}`)
  };

  /** repro/pr can be long: clone, install, deploy or fix, verify. */
  override maxSteps = AGENT_THINK_MAX_STEPS;

  /**
   * We expose our own `bash` tool (two exec backends); skip Think's
   * built-in just-bash. Note: even if this flag is ever flipped back,
   * getTools() spreads after the workspace tools, so our `bash` would
   * silently shadow Think's — desired, but worth knowing.
   */
  override workspaceBash = false;

  readonly #containerBackend: CloudflareContainerBackend;
  readonly #workspaceFs: Workspace;
  readonly #runLifecycle: RunLifecycle;
  #context: RunContext | null = null;
  /**
   * The installation token the container's `gh`/`git` is currently
   * authenticated with. Instance state, not persisted: a DO eviction
   * mid-turn just re-runs the (idempotent) auth on the next model call.
   * Compared against the context token so a fresh dispatch on the same
   * issue (new short-lived token) re-authenticates automatically.
   */
  #authedToken: string | null = null;
  #reportTail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // This Agent DO OWNS the Workspace (SQLite VFS state); the container is a
    // SEPARATE `Sandbox` DO handed out by the warm pool. The backend's
    // `container` factory dials the pool per-connect and returns a Sandbox
    // stub, so the compute host is decoupled from this DO's lifecycle and can
    // be pre-warmed / recycled independently. (Aron's hackspace pattern.)
    const workspaceRef = { binding: "ThinkAgent", id: ctx.id.toString() };
    this.#containerBackend = new CloudflareContainerBackend({
      id: "container",
      container: async () => {
        const uuid = await resolveContainerId(env, ctx.id.toString());
        return env.Sandbox.get(env.Sandbox.idFromName(uuid));
      },
      workspace: workspaceRef
    });
    this.#workspaceFs = new Workspace({
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      backends: [new ContainerLocalBackend(this.#containerBackend)]
    });

    this.workspace = adaptToThinkWorkspace(
      this.#workspaceFs
    ) as unknown as ThinkWorkspaceLike;
    this.#runLifecycle = new RunLifecycle({
      env,
      sessionId: ctx.id.toString(),
      workspace: this.#workspaceFs,
      reportTerminal: (outcome) => this.#recordTerminal(outcome),
      log: (event, data) => this.#log(event, data),
      fork: (effect) => this.ctx.waitUntil(effect)
    });

    this.ctx.blockConcurrencyWhile(async () => {
      this.#context =
        (await this.ctx.storage.get<RunContext>(CONTEXT_KEY)) ?? null;
    });
  }

  /**
   * wsd (running in the Sandbox container) dials back over the loopback
   * WorkspaceProxy egress with path `/ws` to reach the Workspace that lives in
   * THIS Agent DO. Forwarded here by the Worker fetch handler.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      return this.#containerBackend.handleFetch(request);
    }
    return super.fetch(request);
  }

  async getWorkspace(): Promise<WorkspaceStub> {
    await this.#workspaceFs.ready();
    return this.#workspaceFs.stub();
  }

  // ── Control surface (called from index.ts dispatch) ────────────

  async setContext(context: RunContext): Promise<void> {
    this.#context = context;
    await this.ctx.storage.put(CONTEXT_KEY, context);
    // The context block provider reads #context. Re-freeze it for every
    // dispatch so a re-mention on the same issue sees the latest instruction.
    await this.session.refreshSystemPrompt();
  }

  async getContext(): Promise<RunContext | null> {
    return this.#context;
  }

  /**
   * Operator escape hatch: wipe this session back to a clean slate. For
   * poisoned sessions — e.g. an unbounded bash-output backlog that OOMs the
   * DO and then CPU-death-loops every wake before recovery can run (see
   * PLANS/agents/agent-think-1845-rca.md). Drops ALL durable state (messages,
   * workspace VFS, submissions), releases the container assignment, and
   * aborts the isolate so the next dispatch starts completely fresh.
   * RPC-only; deliberately not exposed over HTTP in production.
   */
  async resetSession(): Promise<void> {
    this.#log("session-reset", {});
    await this.#workspaceFs.close();
    await releaseContainer(this.env, this.ctx.id.toString());
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // Abort after the RPC returns so the caller gets its ack; the next
    // request builds a fresh isolate over the now-empty storage.
    setTimeout(() => this.ctx.abort(), RESET_ABORT_DELAY_MS);
  }

  /**
   * Kick off the agent turn using Think's native durable submission —
   * no Workflow, no poll loop. `submitMessages` persists the turn and
   * Think drains it in the background (its own DO alarm), surviving
   * eviction; progress and the terminal state are observed via the
   * onStart/onEvent/onDone/onError hooks below (which is also where
   * structured logging happens).
   *
   * Deliberately does NO container work: gh-app calls dispatch from a
   * `waitUntil` that the runtime cancels ~30s after its webhook response,
   * and a container attach (cold boot + wsd readiness) can take longer
   * than that. Container gh/git auth happens inside the durable turn
   * instead (see `beforeTurn` -> `#ensureGitAuth`), where there is no
   * caller left to cancel it.
   *
   * Returns the submission id so the caller can correlate logs.
   */
  async start(): Promise<string> {
    const ctx = this.#context;
    if (!ctx) throw new Error("setContext() must be called before start()");
    this.#log("start", {
      repo: ctx.repo,
      issue: ctx.issueNumber,
      instruction: ctx.instruction
    });
    this.#report((commandCenter) =>
      commandCenter.recordDispatch({
        session: this.name,
        repo: ctx.repo,
        issueNumber: ctx.issueNumber,
        instruction: ctx.instruction,
        issueTitle: ctx.issueTitle,
        requestedBy: ctx.requestedBy
      })
    );
    const submission = await this.submitMessages(
      [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            {
              type: "text",
              text: buildRunEnvelope(ctx)
            }
          ]
        }
      ],
      {
        // Idempotency is per TRIGGERING COMMENT, not per issue: a retried
        // dispatch for the same comment returns the existing submission, but
        // a new @agent-think mention on the same issue starts a fresh turn.
        // (A per-issue key silently swallowed every re-mention once the
        // first turn completed — accepted:false, nothing runs.) Webhook
        // redeliveries never even reach dispatch: gh-app dedups them in KV
        // before calling us. Dev dispatches without a commentId get a random
        // key, i.e. every /dev/dispatch is a fresh turn.
        idempotencyKey:
          ctx.commentId !== undefined
            ? `${ctx.repo}#${ctx.issueNumber}#comment-${ctx.commentId}`
            : crypto.randomUUID(),
        metadata: { source: "gh-app", instruction: ctx.instruction }
      }
    );
    this.#log("submitted", {
      submissionId: submission.submissionId,
      accepted: submission.accepted
    });
    return submission.submissionId;
  }

  /**
   * Authenticate the container's `gh` + `git` with the installation
   * token. Runs on the container backend (the one with a real `gh`,
   * `git`, `curl`, and network).
   *
   * The token is piped to `gh auth login --with-token` via stdin from
   * a file, so it is written to `~/.config/gh/hosts.yml` (which `gh`
   * reads on every non-interactive invocation) and never appears in a
   * process argument, shell history, or a model prompt. `gh auth
   * setup-git` then registers `gh` as git's credential helper for
   * github.com, so `git clone`/`push` over https authenticate too.
   */
  async #authenticateGit(token: string): Promise<void> {
    // Write the token to a 0600 file, feed it to `gh auth login` over
    // stdin, then remove it. `printf %s` avoids a trailing newline.
    const script = [
      "set -e",
      "umask 077",
      `printf %s ${shellQuote(token)} > ~/.gh_token`,
      "gh auth login --with-token < ~/.gh_token",
      "gh auth setup-git",
      "rm -f ~/.gh_token",
      'git config --global user.name "agent-think[bot]"',
      'git config --global user.email "agent-think[bot]@users.noreply.github.com"'
    ].join("\n");
    // Wrap in the SDK-native retry (jittered exponential backoff, 3 attempts):
    // container cold-start + first network call is the flakiest step.
    const result = await this.retry(async () => {
      const handle = await this.#workspaceFs.shell.exec(script, {
        encoding: "utf8",
        backend: "container"
      });
      const r = await handle.result();
      if (r.exitCode !== 0) {
        throw new Error(
          `gh auth setup failed (${r.exitCode}): ${r.stderr || r.stdout}`
        );
      }
      return r;
    });
    this.#log("git-auth-exit", { exitCode: result.exitCode });
  }

  /** Dev/e2e proof that container files are not pulled into the host DO VFS. */
  async debugWorkspaceIsolation(): Promise<{
    containerFileExists: boolean;
    hostVfsContainsFile: boolean;
  }> {
    const path = `/workspace/temp/isolation-${crypto.randomUUID()}/node_modules/probe.txt`;
    const handle = await this.#workspaceFs.shell.exec(
      `mkdir -p ${quote(path.slice(0, path.lastIndexOf("/")))} && printf container-only > ${quote(path)}`,
      { encoding: "utf8", backend: "container" }
    );
    const result = await handle.result();
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);

    const verify = await this.#workspaceFs.shell.exec(
      `test -f ${quote(path)}`,
      { encoding: "utf8", backend: "container" }
    );
    const containerFileExists = (await verify.result()).exitCode === 0;

    let hostVfsContainsFile = true;
    try {
      await this.#workspaceFs.fs.stat(path);
    } catch (error) {
      hostVfsContainsFile = !isEnoent(error);
    }
    return { containerFileExists, hostVfsContainsFile };
  }

  /** Dev/e2e readback: the current message log for this session. */
  async debugMessages(): Promise<
    Array<{ role: string; parts: Array<{ type: string; text?: string }> }>
  > {
    return this.messages as unknown as Array<{
      role: string;
      parts: Array<{ type: string; text?: string }>;
    }>;
  }

  // ── Structured logging ────────────────────────────────────────
  //
  // Every line is one JSON object prefixed with `agent-think`, so a whole run
  // can be reconstructed from `wrangler tail` after the fact. The session
  // (repo#issue) is always attached so concurrent runs stay separable.

  #log(event: string, data: Record<string, unknown>): void {
    const ctx = this.#context;
    const session = ctx ? `${ctx.repo}#${ctx.issueNumber}` : "unknown";
    console.log(`agent-think ${JSON.stringify({ event, session, ...data })}`);
  }

  /**
   * Fire-and-forget lifecycle reporting to the command-center registry
   * (singleton CommandCenterAgent, name "main"). Deliberately not awaited on
   * the run path and errors are swallowed: the command center observes runs,
   * it must never be able to break one.
   */
  #report(
    fn: (
      cc: Awaited<ReturnType<typeof getAgentByName<Env, CommandCenterAgent>>>
    ) => Promise<unknown>
  ): void {
    // Serialize observer updates without awaiting them on the run path. This
    // preserves dispatch → tools → terminal ordering for fast turns while a
    // slow/broken Command Center can never block or fail the actual run.
    this.#reportTail = this.#reportTail
      .then(() =>
        getAgentByName<Env, CommandCenterAgent>(this.env.CommandCenter, "main")
      )
      .then(fn)
      .then(() => undefined)
      .catch((err) =>
        this.#log("report-error", { error: String(err).slice(0, 200) })
      );
    this.ctx.waitUntil(this.#reportTail);
  }

  // ── Think hooks ────────────────────────────────────────────────

  override configureSession(session: Session): Session {
    return configureAgentThinkSession(session, () => this.#context);
  }

  override getModel(): LanguageModel {
    // Route through the account's default AI Gateway so model calls get
    // Gateway-side retries, caching, and observability. The `openai` provider
    // plugin lets the `openai/...` catalog slug dispatch through the gateway
    // delegate (OpenAI wire format over the AI binding, Unified Billing).
    return createWorkersAI({
      binding: this.env.AI,
      gateway: { id: "default" },
      providers: [openai]
      // DelegateCallOptions' typing lags the runtime: the model reads
      // settings.reasoning_effort and forwards it into the request (verified
      // live — completion_tokens_details.reasoning_tokens > 0 at "medium").
    })(MODEL_ID, {
      reasoning_effort: REASONING_EFFORT
    } as Parameters<ReturnType<typeof createWorkersAI>>[1]);
  }

  override getSkills() {
    return [
      skills.r2(this.env.R2_SKILLS, {
        prefix: ".agents/skills/",
        refreshIntervalMs: 0
      })
    ];
  }

  override async beforeTurn(ctx: TurnContext) {
    // Container auth is scoped: no Workspace transport remains open while the
    // model is thinking, so infrastructure /ws cannot become the turn root.
    await this.#runLifecycle.withWorkspace(() => this.#ensureGitAuth());
    return {
      maxOutputTokens: 16384,
      ...(this.#context
        ? {
            experimental_telemetry: buildRunTelemetry(
              this.#context,
              this.name,
              this.constructor.name
            )
          }
        : {}),
      // Only our four tools reach the model (read/write/edit/bash — pi's
      // codingTools shape, Claude Code's names). Think merges its workspace
      // built-ins (list/find/grep/delete) unconditionally; this allowlist
      // makes the AI SDK drop their definitions from the provider request
      // entirely (~600 prompt tokens reclaimed per call). ls/grep/rm/find
      // happen through `bash`. Keep Think's native skill activation tools when
      // its R2 catalog is available.
      activeTools: [
        ...Object.keys(this.getTools()),
        ...["activate_skill", "read_skill_resource"].filter(
          (name) => name in ctx.tools
        )
      ]
    };
  }

  /**
   * Authenticate the container's `gh`/`git` with the current context
   * token, once per token. Runs before every model call (beforeTurn), so
   * a turn that outlives its short-lived token picks up the fresh one a
   * re-dispatch stored via setContext. Throws on failure — Think surfaces
   * it through onChatError and the turn errors visibly in the thread.
   */
  async #ensureGitAuth(): Promise<void> {
    const ctx = this.#context;
    if (!ctx?.installationToken || this.#authedToken === ctx.installationToken)
      return;
    await this.#workspaceFs.ready();
    await this.#authenticateGit(ctx.installationToken);
    this.#authedToken = ctx.installationToken;
    this.#log("git-auth-ok", {});
  }

  async #finishRun(outcome: "done" | "error", error?: string): Promise<void> {
    await this.#runLifecycle.finish(
      outcome === "done"
        ? { status: "done" }
        : { status: "error", error: error ?? "Agent run failed" }
    );
  }

  async #recordTerminal(outcome: RunOutcome): Promise<void> {
    this.#report((commandCenter) =>
      commandCenter.recordTurn({
        session: this.name,
        outcome: outcome.status,
        ...(outcome.status === "error"
          ? { error: outcome.error.slice(0, 300) }
          : {})
      })
    );
  }

  // ── Lifecycle logging: reconstruct a run from the deployed logs ──
  //
  // These are the Think turn-lifecycle overrides (not the submission-observer
  // interface). afterToolCall fires per tool; onChatResponse when the turn's
  // assistant message is persisted; onChatError on a turn failure.

  override async afterToolCall(hook: ToolCallResultContext): Promise<void> {
    this.#report((cc) =>
      cc.recordTool({ session: this.name, ok: hook.success })
    );
    this.#log("tool", {
      tool: hook.toolName,
      ok: hook.success,
      ms: Math.round(hook.durationMs),
      ...(hook.success ? {} : { error: String(hook.error).slice(0, 500) })
    });
  }

  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    const terminal = classifyTurnOutcome(result, this.maxSteps);
    await this.#finishRun(terminal.outcome, terminal.error);
    this.#log(terminal.outcome === "done" ? "turn:done" : "turn:error", {
      reason: terminal.reason,
      steps: terminal.steps,
      maxSteps: this.maxSteps,
      assistantChars: terminal.assistantChars,
      finalStepHasToolCall: terminal.finalStepHasToolCall,
      ...(terminal.error ? { error: terminal.error.slice(0, 800) } : {})
    });
  }

  override onChatError(error: unknown, ctx?: { stage?: string }): unknown {
    const message = String(error);
    // Some setup failures never reach onChatResponse. Cleanup immediately;
    // a later durable recovery begins a fresh lease and may overwrite the
    // command-center status with success.
    this.ctx.waitUntil(
      this.#finishRun("error", message).catch((cleanupError) =>
        this.#log("turn-cleanup-error", {
          error: String(cleanupError).slice(0, 300)
        })
      )
    );
    this.#log("turn:error", {
      stage: ctx?.stage,
      error: message.slice(0, 800)
    });
    return error;
  }

  override getTools(): ToolSet {
    if (!this.#context) return {} as ToolSet;
    const store = new ContainerFileStore(this.#workspaceFs.shell);
    return this.#runLifecycle.scopeTools({
      read: createReadTool({ store, maxBytes: 32 * 1024, maxLines: 800 }),
      write: createWriteTool({ store }),
      edit: createEditTool({ store }),
      bash: createBashTool({
        workspace: this.#workspaceFs,
        maxBytes: 32 * 1024,
        backends: {
          container: {
            description:
              "Cloudflare Container (full Linux) with a real toolchain and public " +
              "network. /workspace is container-local: .git, node_modules, build " +
              "outputs, logs, and scratch data never enter the Agent DO."
          }
        },
        defaultBackend: "container"
      })
    });
  }
}

// ── Adapters (from examples/think) ─────────────────────────────────

function adaptToThinkWorkspace(ws: Workspace) {
  return {
    async readFile(path: string): Promise<string | null> {
      try {
        return await ws.fs.readFile(path, "utf8");
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async writeFile(path: string, content: string): Promise<void> {
      await ws.fs.writeFile(path, new TextEncoder().encode(content));
    },
    async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
      await ws.fs.mkdir(path, opts?.recursive ? { recursive: true } : {});
    },
    async rm(
      path: string,
      opts?: { recursive?: boolean; force?: boolean }
    ): Promise<void> {
      await ws.fs.rm(path, {
        ...(opts?.recursive ? { recursive: true as const } : {}),
        ...(opts?.force ? { force: true as const } : {})
      });
    },
    async stat(path: string) {
      try {
        const s = await ws.fs.stat(path);
        return {
          path,
          name: path.split("/").pop() ?? path,
          type: s.isDirectory ? ("directory" as const) : ("file" as const),
          size: s.size,
          modifiedAt: new Date(s.mtime),
          isDirectory: s.isDirectory,
          isFile: s.isFile
        };
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async readDir(dir: string) {
      const entries = await ws.fs.readdir(dir);
      return entries.map((e) => ({
        path: `${dir}/${e.name}`,
        name: e.name,
        type: e.isDirectory ? ("directory" as const) : ("file" as const),
        size: 0,
        modifiedAt: new Date(0),
        isDirectory: e.isDirectory,
        isFile: e.isFile
      }));
    },
    async readFileBytes(path: string): Promise<Uint8Array | null> {
      try {
        const stream = await ws.fs.readFile(path);
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream) chunks.push(chunk);
        const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          out.set(chunk, offset);
          offset += chunk.length;
        }
        return out;
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    // Think's built-in find/grep tools call glob with model-supplied
    // patterns. ws.fs.find matches a glob relative to a base directory, so
    // split the pattern at its first wildcard segment into base + rest.
    // Relative patterns root at /workspace (where all agent work lives).
    async glob(pattern: string) {
      const absolute = pattern.startsWith("/")
        ? pattern
        : `/workspace/${pattern}`;
      const segments = absolute.split("/").filter(Boolean);
      const baseParts: string[] = [];
      let i = 0;
      for (; i < segments.length && !/[*?[\]{]/.test(segments[i]); i++) {
        baseParts.push(segments[i]);
      }
      const rest = segments.slice(i).join("/");
      const toInfo = (
        path: string,
        isDirectory: boolean,
        size = 0,
        mtime = 0
      ) => ({
        path,
        name: path.split("/").pop() ?? path,
        type: isDirectory ? ("directory" as const) : ("file" as const),
        size,
        modifiedAt: new Date(mtime),
        isDirectory,
        isFile: !isDirectory
      });
      try {
        if (rest.length === 0) {
          // No wildcards: a literal path — stat it directly.
          const path = `/${baseParts.join("/")}`;
          const s = await ws.fs.stat(path);
          return [toInfo(path, s.isDirectory, s.size, s.mtime)];
        }
        const base = baseParts.length === 0 ? "/" : `/${baseParts.join("/")}`;
        const entries = await ws.fs.find(base, rest);
        return entries.map((e) => toInfo(e.path, e.type === "dir"));
      } catch (err) {
        if (isEnoent(err)) return [];
        throw err;
      }
    }
  };
}

function isEnoent(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  if (e.code === "ENOENT") return true;
  return typeof e.message === "string" && /ENOENT|no such/i.test(e.message);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
