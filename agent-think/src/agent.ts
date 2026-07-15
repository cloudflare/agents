/**
 * ThinkAgent — one Think Durable Object per GitHub issue.
 *
 * Owns Think transcript/submission state and resolves the same-named
 * WorkspaceAgent over RPC. WorkspaceAgent exclusively owns Workspace/VFS and
 * its backend connections; Think internals and file tools share its stub.
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
  ChatRecoveryContext,
  ChatRecoveryExhaustedContext,
  ChatRecoveryOptions,
  ChatResponseResult,
  Session,
  ToolCallResultContext,
  TurnContext,
  WorkspaceLike as ThinkWorkspaceLike
} from "@cloudflare/think";
import { skills, Think } from "@cloudflare/think";
import type { WorkspaceAgent } from "./workspace-agent";
import type { LanguageModel, ToolSet } from "ai";
import { getAgentByName } from "agents";
import type { CommandCenterAgent } from "./command-center";
import { createAgentThinkModel } from "./model";
import { createBashTool } from "./tools/bash";
import {
  createEditTool,
  createReadTool,
  createWriteTool,
  WorkspaceFileStore
} from "./tools/fs/index";
import {
  buildRunEnvelope,
  buildRunTelemetry,
  repoDirectory,
  type RunTarget
} from "./run-context";
import { AGENT_THINK_MAX_STEPS, classifyTurnOutcome } from "./turn-outcome";

const CONTEXT_KEY = "agent-think-context";
// resetSession aborts the isolate AFTER its RPC response has been delivered;
// this is the grace window for that ack, not a tuning knob.
const RESET_ABORT_DELAY_MS = 100;

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
    "  - read/write/edit call the durable Workspace VFS directly. The lightweight",
    "    shell also operates on that VFS; container bash uses the mounted tree.",
    "  - Paths outside /workspace are container-local. Put long logs in /temp and",
    "    inspect them with container bash so they do not enter the VFS.",
    "  - bash defaults to the lightweight shell backend. Select container for gh,",
    "    npm, node, network access, native binaries, builds, tests, and deploys.",
    "  - `gh`, `git`, `curl`, `npm`, `node`, and `wrangler` run in the",
    "    container. `gh` and `git` are ALREADY AUTHENTICATED there as the app",
    "    (via `gh auth login` + `gh auth setup-git`). Do NOT print, echo, or",
    "    re-configure the token.",
    "  - Prefer the dedicated read/write/edit tools for file content operations.",
    "",
    "When done, reply with the structured summary the skill specifies."
  ].join("\n");
}

export type AgentThinkEnv = Omit<Env, "GITHUB_AUTH"> & {
  CLOUDFLARE_AIG_TOKEN?: string;
  GITHUB_AUTH: Env["GITHUB_AUTH"] & {
    mintInstallationToken(repo: string): Promise<string>;
  };
};

class ThinkBase extends Think<AgentThinkEnv> {}

type RemoteWorkspace = Awaited<
  ReturnType<DurableObjectStub<WorkspaceAgent>["getWorkspace"]>
>;

export class ThinkAgent extends ThinkBase {
  // Think's own chat recovery is the durability layer. Its terminal hook must
  // also release agent-think's external resources and command-center status.
  override chatRecovery = {
    onExhausted: (ctx: ChatRecoveryExhaustedContext) =>
      this.#finishRun("error", `Recovery exhausted: ${ctx.reason}`)
  };

  /** repro/pr can be long: clone, install, deploy or fix, verify. */
  override maxSteps = AGENT_THINK_MAX_STEPS;

  /** We expose our own container-backed `bash`; omit Think's `code` tool. */
  override codeTool = false;

  readonly #workspaceAgent: DurableObjectStub<WorkspaceAgent>;
  #workspaceReady: Promise<RemoteWorkspace> | null = null;
  #context: RunContext | null = null;
  /**
   * The installation token the container's `gh`/`git` is currently
   * authenticated with. Instance state, not persisted: a DO eviction
   * mid-turn just re-runs the (idempotent) auth on the next model call.
   * Compared against the context token so a fresh dispatch on the same
   * issue (new short-lived token) re-authenticates automatically.
   */
  #authedToken: string | null = null;
  #cleanupPromise: Promise<void> | null = null;
  #reportTail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: AgentThinkEnv) {
    super(ctx, env);
    // Resolve the Workspace object by the exact same stable name used for the
    // Think session. No random IDs and no VFS construction against Think SQL.
    this.#workspaceAgent = env.WorkspaceAgent.get(
      env.WorkspaceAgent.idFromName(this.name)
    );
    // Do not call getWorkspace here: dispatch must submit without attaching a
    // container. The first durable turn operation resolves it lazily.
    this.workspace = adaptToThinkWorkspace(() =>
      this.#getWorkspace()
    ) as unknown as ThinkWorkspaceLike;

    this.ctx.blockConcurrencyWhile(async () => {
      this.#context =
        (await this.ctx.storage.get<RunContext>(CONTEXT_KEY)) ?? null;
    });
  }

  #getWorkspace(): Promise<RemoteWorkspace> {
    if (!this.#workspaceReady) {
      this.#workspaceReady = this.#workspaceAgent.getWorkspace();
    }
    return this.#workspaceReady;
  }

  async #disposeWorkspaceStub(): Promise<void> {
    const workspaceReady = this.#workspaceReady;
    this.#workspaceReady = null;
    if (!workspaceReady) return;
    try {
      const workspace = await workspaceReady;
      workspace[Symbol.dispose]();
    } catch {
      // A failed owner RPC may also invalidate the returned stub. There is
      // nothing left to dispose in that case; the next turn obtains a new one.
    }
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

  /** Test/diagnostic proof of the stable Think-session → Workspace mapping. */
  async debugWorkspaceIdentity(): Promise<{ id: string }> {
    return this.#workspaceAgent.debugIdentity();
  }

  async refreshInstallationToken(installationToken: string): Promise<void> {
    const context = this.#context;
    if (!context)
      throw new Error("Run context is unavailable for this session");
    this.#context = { ...context, installationToken };
    await this.ctx.storage.put(CONTEXT_KEY, this.#context);
    this.#authedToken = null;
  }

  /**
   * Operator escape hatch: wipe this session back to a clean slate. For
   * poisoned sessions — e.g. an unbounded bash-output backlog that OOMs the
   * DO and then CPU-death-loops every wake before recovery can run (see
   * PLANS/agents/agent-think-1845-rca.md). Independently resets WorkspaceAgent
   * (VFS/backend/container) and this object (messages/submissions), then aborts
   * both isolates so the next dispatch starts completely fresh.
   * RPC-only; deliberately not exposed over HTTP in production.
   */
  async resetSession(): Promise<void> {
    this.#log("session-reset", {});
    let workspaceError: unknown;
    try {
      await this.#workspaceAgent.resetWorkspace();
    } catch (error) {
      workspaceError = error;
    } finally {
      await this.#disposeWorkspaceStub();
    }
    // Think cleanup is independent: even a failed Workspace RPC must not leave
    // poisoned transcript/submission SQL behind (and vice versa).
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // Abort after the RPC returns so the caller gets its ack; the next
    // request builds a fresh isolate over the now-empty storage.
    setTimeout(() => this.ctx.abort(), RESET_ABORT_DELAY_MS);
    if (workspaceError) throw workspaceError;
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
  async continueRun(): Promise<string> {
    const context = this.#context;
    if (!context) {
      throw new Error("Run context is unavailable for this session");
    }
    const submission = await this.submitMessages(
      [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            {
              type: "text",
              text:
                "Continue the interrupted run from the existing transcript and workspace. " +
                "Inspect the last completed tool result before taking another action."
            }
          ]
        }
      ],
      {
        idempotencyKey: crypto.randomUUID(),
        metadata: { source: "command-center", instruction: "continue" }
      }
    );
    this.#log("continued", { submissionId: submission.submissionId });
    return submission.submissionId;
  }

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
      await this.#getWorkspace();
      const r = await this.#workspaceAgent.exec(script, {
        encoding: "utf8",
        backend: "container"
      });
      if (r.exitCode !== 0) {
        throw new Error(
          `gh auth setup failed (${r.exitCode}): ${r.stderr || r.stdout}`
        );
      }
      return r;
    });
    this.#log("git-auth-exit", { exitCode: result.exitCode });
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
    return createAgentThinkModel(this.env.CLOUDFLARE_AIG_TOKEN);
  }

  override getSkills() {
    return [
      skills.r2(this.env.R2_SKILLS, {
        prefix: ".agents/skills/",
        refreshIntervalMs: 0
      })
    ];
  }

  protected override async onChatRecovery(
    _ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    this.#report((commandCenter) =>
      commandCenter.recordRecovery({ session: this.name })
    );
    return {};
  }

  override async beforeTurn(ctx: TurnContext) {
    if (ctx.continuation) {
      this.#report((commandCenter) =>
        commandCenter.recordRunning({ session: this.name })
      );
    }
    // A recovery may start after terminal cleanup released the previous
    // container. Wait for that cleanup, then reconnect and authenticate the
    // container chosen for this continuation.
    if (this.#cleanupPromise) {
      await this.#cleanupPromise;
      this.#cleanupPromise = null;
    }
    await this.#ensureGitAuth();
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
    await this.#authenticateGit(ctx.installationToken);
    this.#authedToken = ctx.installationToken;
    this.#log("git-auth-ok", {});
  }

  #finishRun(outcome: "done" | "error", error?: string): Promise<void> {
    if (this.#cleanupPromise) return this.#cleanupPromise;

    const cleanup = this.#cleanupTurn(outcome, error).finally(() => {
      this.#authedToken = null;
    });
    this.#cleanupPromise = cleanup;
    return cleanup;
  }

  async #cleanupTurn(outcome: "done" | "error", error?: string): Promise<void> {
    const cleanupErrors: unknown[] = [];
    try {
      await this.#workspaceAgent.closeWorkspace();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    } finally {
      await this.#disposeWorkspaceStub();
    }
    this.#report((commandCenter) =>
      commandCenter.recordTurn({
        session: this.name,
        outcome,
        ...(outcome === "error"
          ? { error: (error ?? "Agent run failed").slice(0, 300) }
          : {})
      })
    );

    if (cleanupErrors.length > 0) {
      this.#log("turn-cleanup-error", {
        errors: cleanupErrors.map((cleanupError) =>
          String(cleanupError).slice(0, 300)
        )
      });
    }
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
    // a later durable recovery may claim a fresh container and overwrite the
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
    const store = new WorkspaceFileStore(
      adaptToFileWorkspace(() => this.#getWorkspace())
    );
    const hasShell = Boolean(this.env.LOADER);
    const backends = {
      ...(hasShell
        ? {
            shell: {
              description:
                "Lightweight /workspace VFS shell for text and file operations. " +
                "Use it for ls, find, grep, cat, sed, and other built-ins."
            }
          }
        : {}),
      container: {
        description:
          "Cloudflare Container with full Linux, gh, npm, node, native binaries, " +
          "network access, builds, tests, deploy tooling, and local /temp."
      }
    };
    return {
      read: createReadTool({ store, maxBytes: 32 * 1024, maxLines: 800 }),
      write: createWriteTool({ store }),
      edit: createEditTool({ store }),
      bash: createBashTool({
        // Keep exec inside the owner DO. This plain RPC avoids carrying the
        // alpha.11 nested exec-handle stub into Think's isolate and preserves
        // timeoutMs, which is published on Workspace.shell but not its stub.
        workspace: {
          shell: {
            exec: async (command, options) => ({
              result: () => this.#workspaceAgent.exec(command, options)
            })
          }
        },
        maxBytes: 32 * 1024,
        backends,
        defaultBackend: hasShell ? "shell" : "container"
      })
    };
  }
}

// ── Adapters (from examples/think) ─────────────────────────────────

function adaptToFileWorkspace(
  getWorkspace: () => Promise<RemoteWorkspace>
): ConstructorParameters<typeof WorkspaceFileStore>[0] {
  const fs = async () =>
    (await getWorkspace()).fs as unknown as ConstructorParameters<
      typeof WorkspaceFileStore
    >[0]["fs"];
  return {
    fs: {
      stat: async (path) => (await fs()).stat(path),
      readFile: async (path, options?: { offset?: number; length?: number }) =>
        (await fs()).readFile(path, options ?? {}),
      writeFile: async (path, content, options) =>
        (await fs()).writeFile(path, content, options),
      mkdir: async (path, options) => (await fs()).mkdir(path, options),
      rm: async (path, options) => (await fs()).rm(path, options),
      readdir: async (path) => (await fs()).readdir(path)
    }
  };
}

function adaptToThinkWorkspace(getWorkspace: () => Promise<RemoteWorkspace>) {
  const fs = async () =>
    (await getWorkspace()).fs as unknown as ConstructorParameters<
      typeof WorkspaceFileStore
    >[0]["fs"] & {
      readFile(path: string, encoding: "utf8"): Promise<string>;
      find(
        directory: string,
        pattern?: string
      ): Promise<Array<{ path: string; type: "file" | "dir" }>>;
    };
  return {
    async readFile(path: string): Promise<string | null> {
      try {
        return await (await fs()).readFile(path, "utf8");
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async writeFile(path: string, content: string): Promise<void> {
      await (await fs()).writeFile(path, new TextEncoder().encode(content));
    },
    async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
      await (
        await fs()
      ).mkdir(path, opts?.recursive ? { recursive: true } : {});
    },
    async rm(
      path: string,
      opts?: { recursive?: boolean; force?: boolean }
    ): Promise<void> {
      await (
        await fs()
      ).rm(path, {
        ...(opts?.recursive ? { recursive: true as const } : {}),
        ...(opts?.force ? { force: true as const } : {})
      });
    },
    async stat(path: string) {
      try {
        const s = await (await fs()).stat(path);
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
      const entries = await (await fs()).readdir(dir);
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
        const stream = await (await fs()).readFile(path);
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
          const s = await (await fs()).stat(path);
          return [toInfo(path, s.isDirectory, s.size, s.mtime)];
        }
        const base = baseParts.length === 0 ? "/" : `/${baseParts.join("/")}`;
        const entries = await (await fs()).find(base, rest);
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
