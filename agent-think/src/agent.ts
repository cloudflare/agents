/**
 * ThinkAgent — one Think Durable Object per GitHub issue.
 *
 * Owns a `@cloudflare/workspace.Workspace` with two backends behind a
 * single `shell.exec`:
 *
 *   - "container" (default) CloudflareContainerBackend — wsd over
 *                 capnweb. Full Linux with a real toolchain and
 *                 network: `gh` + `git` (authenticated as the app),
 *                 `npm`, `node`, `curl`, `jq`, `wrangler`. All GitHub,
 *                 network, and build/deploy work happens here.
 *   - "shell"     WorkerBackend — just-bash in a Dynamic Worker.
 *                 Cold-start fast, but NO real binaries and no public
 *                 network. Only cheap text tooling (cat/grep/sed/jq).
 *
 * gh-app calls `dispatch()` (see index.ts) with the issue
 * coordinates, a free-form `instruction` ("reproduce this", "open a
 * PR fixing it", …), and a short-lived GitHub App installation token.
 * `setContext` stores it; `start` authenticates `gh`/`git` in the
 * container with the token, then runs one agent turn.
 *
 * Skills are mounted read-only from R2 at /workspace/.agents/skills;
 * both `reproduce` and `open-pr` ship in the bucket, and the model
 * picks the matching one(s) from the instruction — there is no fixed
 * verb.
 */

import type {
  ToolCallResultContext,
  WorkspaceLike as ThinkWorkspaceLike
} from "@cloudflare/think";
import { Think } from "@cloudflare/think";
import {
  type DurableObjectStorageLike,
  R2Bucket,
  Workspace,
  WorkspaceProxy,
  WorkspaceServiceProxy,
  type WorkspaceStub
} from "@cloudflare/workspace";
import { CloudflareContainerBackend } from "@cloudflare/workspace/backends/container";
import { WorkerBackend } from "@cloudflare/workspace/backends/worker";
import { type ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { resolveContainerId } from "./pool";
import { createExecTool } from "./tools/exec";
import {
  createEditTool,
  createReadTool,
  createWriteTool,
  type WorkspaceLike as FsWorkspaceLike,
  WorkspaceFileStore
} from "./tools/fs/index";

export { WorkspaceProxy, WorkspaceServiceProxy };

const CONTEXT_KEY = "agent-think-context";
const REPO_ROOT = "/workspace/repo";
// Kimi K2.7 Code — Moonshot's coding-tuned model on Workers AI. Better
// tool-calling + code reasoning than k2.6 for the reproduce/fix loop.
const MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";

/** Per-issue run context, set by `dispatch` before the turn is submitted. */
export interface RunContext {
  repo: string;
  issueNumber: number;
  /** Free-form instruction the user typed after `@agent-think`. */
  instruction: string;
  /** Short-lived GitHub App installation token. */
  installationToken: string;
}

class ThinkBase extends Think<Env> {}

export class ThinkAgent extends ThinkBase {
  // Think's own chat recovery IS the durability layer now (no Workflow):
  // submitMessages persists the turn and Think resumes it across a DO
  // eviction. Left at the default (enabled).

  /** repro/pr can be long: clone, install, deploy or fix, verify. */
  override maxSteps = 60;

  /** We expose our own `exec` tool; skip Think's built-in bash. */
  override workspaceBash = false;

  readonly #containerBackend: CloudflareContainerBackend;
  readonly #workspaceFs: Workspace;
  #context: RunContext | null = null;
  /**
   * The installation token the container's `gh`/`git` is currently
   * authenticated with. Instance state, not persisted: a DO eviction
   * mid-turn just re-runs the (idempotent) auth on the next model call.
   * Compared against the context token so a fresh dispatch on the same
   * issue (new short-lived token) re-authenticates automatically.
   */
  #authedToken: string | null = null;

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
      backends: [
        new WorkerBackend({
          id: "shell",
          loader: env.LOADER,
          workspace: workspaceRef,
          ctx
        }),
        this.#containerBackend
      ],
      // Skills mounted read-only. R2 keys live under `.agents/`, e.g.
      // `.agents/skills/reproduce/SKILL.md`; the prefix is stripped so
      // the agent reads /workspace/.agents/skills/reproduce/SKILL.md.
      mounts: {
        "/workspace/.agents": R2Bucket(env.R2_SKILLS, { prefix: ".agents/" })
      }
    });

    this.workspace = adaptToThinkWorkspace(
      this.#workspaceFs
    ) as unknown as ThinkWorkspaceLike;

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
  }

  async getContext(): Promise<RunContext | null> {
    return this.#context;
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
    const submission = await this.submitMessages(
      [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            {
              type: "text",
              text:
                "Carry out the user's instruction for this issue now. Read the matching " +
                "skill under /workspace/.agents/skills first and follow it end to end, " +
                "then reply with the structured result that skill specifies."
            }
          ]
        }
      ],
      {
        // Native dedup: a redelivered webhook (same repo#issue) returns the
        // existing submission instead of starting a duplicate turn.
        idempotencyKey: `${ctx.repo}#${ctx.issueNumber}`,
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

  async gitDiff(): Promise<string> {
    await this.#workspaceFs.ready();
    return this.#workspaceFs.git.diff({ dir: REPO_ROOT });
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

  // ── Think hooks ────────────────────────────────────────────────

  override getModel() {
    // Route through the account's default AI Gateway so model calls get
    // Gateway-side retries, caching, and observability. `gateway.id` is the
    // gateway name; "default" exists on every account.
    return createWorkersAI({
      binding: this.env.AI,
      gateway: { id: "default" }
    })(MODEL_ID);
  }

  override async beforeTurn() {
    // Container gh/git auth runs here — inside the durable turn — rather
    // than in start(), so dispatch stays fast and a slow container attach
    // can't be killed by the caller's cancellation (see start()).
    await this.#ensureGitAuth();
    return { maxOutputTokens: 16384 };
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

  // ── Lifecycle logging: reconstruct a run from the deployed logs ──
  //
  // These are the Think turn-lifecycle overrides (not the submission-observer
  // interface). afterToolCall fires per tool; onChatResponse when the turn's
  // assistant message is persisted; onChatError on a turn failure.

  override async afterToolCall(hook: ToolCallResultContext): Promise<void> {
    this.#log("tool", {
      tool: hook.toolName,
      ok: hook.success,
      ms: Math.round(hook.durationMs),
      ...(hook.success ? {} : { error: String(hook.error).slice(0, 500) })
    });
  }

  override async onChatResponse(): Promise<void> {
    this.#log("turn:done", {
      assistantChars: collectAssistantText(this.messages).length
    });
  }

  override onChatError(error: unknown, ctx?: { stage?: string }): unknown {
    this.#log("turn:error", {
      stage: ctx?.stage,
      error: String(error).slice(0, 800)
    });
    return error;
  }

  override getSystemPrompt(): string {
    const ctx = this.#context;
    return [
      `You are agent-think, acting as the agent-think GitHub App (not any user).`,
      `You are working on issue #${ctx?.issueNumber} in ${ctx?.repo}.`,
      "",
      "The user invoked you with this instruction:",
      `  ${ctx?.instruction || "(no instruction — default to reproducing the issue)"}`,
      "",
      "Two skills are available under /workspace/.agents/skills:",
      "  - reproduce/SKILL.md — reproduce the issue in a minimal project,",
      "    deploy it, verify the symptom, and report findings on the issue.",
      "  - open-pr/SKILL.md   — locate the root cause, make the minimal fix,",
      "    verify it, and open a PR that closes the issue.",
      "",
      "Decide from the instruction which skill(s) to follow (one, or reproduce",
      "then open-pr if asked to fix what you repro). Read the matching SKILL.md",
      "first and follow it exactly, including the structured result it specifies.",
      "",
      "Environment:",
      `  - The repo should be worked on under ${REPO_ROOT}.`,
      "  - `gh`, `git`, `curl`, `npm`, `node`, `wrangler` all live on the",
      "    `container` backend, which is the only one with a real toolchain and",
      "    network. `gh` and `git` are ALREADY AUTHENTICATED there as the app",
      "    (via `gh auth login` + `gh auth setup-git`). Do NOT print, echo, or",
      "    re-configure the token.",
      "  - IMPORTANT: run every `gh`, `git`, `npm`, `curl`, and `wrangler`",
      '    command on the `container` backend — exec({ command, backend: "container" }).',
      "    The `shell` backend has none of them and no network; it is only for",
      "    cat/grep/sed/jq-style text work.",
      "  - The dedicated read/write/edit tools operate on the same workspace",
      "    files the container sees, so prefer them for file I/O.",
      "",
      "When done, reply with the structured summary the skill specifies."
    ].join("\n");
  }

  override getTools(): ToolSet {
    const ctx = this.#context;
    if (!ctx) return {} as ToolSet;
    const store = new WorkspaceFileStore(adaptToFsWorkspace(this.#workspaceFs));
    const ws = this.#workspaceFs;
    return {
      read: createReadTool({ store, maxBytes: 32 * 1024, maxLines: 800 }),
      write: createWriteTool({ store }),
      edit: createEditTool({ store }),
      exec: createExecTool({
        workspace: ws,
        maxBytes: 32 * 1024,
        backends: {
          shell: {
            description:
              "just-bash in a Dynamic Worker. Cold-start fast, no container, no " +
              "public network, and NO real binaries. Only cat/grep/sed/awk/jq/" +
              "find-style text tooling. It has NO `gh`, `git`, `npm`, `curl`, or " +
              "`wrangler` — do not use it for those."
          },
          container: {
            description:
              "Cloudflare Container (full Linux) with a real toolchain and public " +
              "network: `gh` and `git` (already authenticated as the app), plus " +
              "`npm`, `node`, `curl`, `jq`, `wrangler`. Use this for EVERYTHING " +
              "that touches GitHub, the network, or a real binary — cloning, " +
              "`gh issue`/`gh pr`, `npm install`, `wrangler deploy`, test runs."
          }
        },
        // Default to the container: repro/pr work is almost entirely real
        // toolchain + network, so the shell backend is the exception, not the
        // rule. (It's still available for cheap text munging.)
        defaultBackend: "container"
      })
    };
  }
}

// ── Adapters (from examples/think) ─────────────────────────────────

function adaptToFsWorkspace(ws: Workspace): FsWorkspaceLike {
  return ws as unknown as FsWorkspaceLike;
}

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

function collectAssistantText(
  messages: ReadonlyArray<{
    role: string;
    parts: Array<{ type: string; text?: string }>;
  }>
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const text = m.parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("")
      .trim();
    if (text.length > 0) return text;
  }
  return "";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
