/**
 * ExoCore — the stable kernel's harness machinery.
 *
 * The kernel owns: the append-only journal, the version ledger, and this
 * loader. The agent owns everything under /harness in its Workspace
 * (@cloudflare/computer — a SQLite-backed virtual filesystem in the DO)
 * and can rewrite it freely; the kernel re-loads that "self" from the
 * live files on every turn (hot reload), validates it in an isolated
 * dynamic Worker, and auto-restores the last activated version if the
 * live files fail to load.
 */

import type {
  ThinkWorkspaceCompatibility,
  Workspace
} from "@cloudflare/computer";
import { createArtifact } from "@cloudflare/computer/artifacts";
import { jsonSchema, tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import type { KernelStore } from "./store";
import { SEED_FILES } from "./seed";
import {
  CONTEXT_POLICY_BOUNDS,
  DEFAULT_CONTEXT_POLICY,
  HARNESS_RUNTIME_HOOK_NAMES,
  type ContextPolicy,
  type ForkOrigin,
  type ForkParent,
  type HarnessPolicy,
  type HarnessRuntimeHookName,
  type HarnessRuntimeManifest,
  type HarnessRuntimeToolCall,
  type HarnessRuntimeToolDecision,
  type HarnessRuntimeToolResult,
  type HarnessToolManifest,
  type LoadedHarness,
  type TurnSource
} from "./types";

/**
 * The computer Workspace with its Think-compatibility filesystem surface
 * (readFile → string|null, writeFile, readDir, glob, rm, mkdir, stat) —
 * enabled with `useThink: true` at construction.
 */
export type ExoWorkspace = Workspace & Required<ThinkWorkspaceCompatibility>;

const GIT_AUTHOR = { name: "Exo Kernel", email: "exo@cloudflare.dev" };
const HARNESS_PREFIX = "/harness/";
const TOOL_TIMEOUT_MS = 20_000;
const EXEC_TIMEOUT_MS = 30_000;
const EXEC_OUTPUT_CLAMP = 8_000;
const ARTIFACTS_REMOTE_NAME = "artifacts";
const ARTIFACTS_TOKEN_TTL_SECONDS = 15 * 60;
/** The agent's mirror repo, locally named within its Artifacts session. */
const SELF_REPO = "self";

/**
 * Derive a stable, valid Artifacts session id from an agent name. The
 * prefix separates environments (exo-prod vs exo-dev) so a deployed agent
 * and a local dev agent with the same name never share a mirror. Session
 * ids may contain letters, digits, ".", "_", and "-", but never "__"
 * (the facade's scope separator) — the mirror repo is stored in the
 * namespace as `<sessionId>__self`.
 */
export function artifactsSessionId(agentName: string, prefix = "exo"): string {
  const cleaned = agentName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/_{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63);
  return `${prefix}-${cleaned.length > 0 ? cleaned : "agent"}`;
}

function clampNumber(
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number }
): number {
  const n =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(Math.round(n), bounds.min), bounds.max);
}

function clampText(text: string, max = EXEC_OUTPUT_CLAMP): string {
  return text.length > max ? `${text.slice(0, max)}…(truncated)` : text;
}

/**
 * Parse /harness/context.json into a clamped ContextPolicy. Missing file →
 * defaults (older selves keep working); invalid JSON → throw (feeds the
 * same auto-rollback path as a broken policy.json); out-of-bounds values →
 * silently clamped into the kernel's hard bounds.
 */
export function parseContextPolicy(raw: string | undefined): ContextPolicy {
  if (raw === undefined) return DEFAULT_CONTEXT_POLICY;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `/harness/context.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return {
    keepMessages: clampNumber(
      parsed.keepMessages,
      DEFAULT_CONTEXT_POLICY.keepMessages,
      CONTEXT_POLICY_BOUNDS.keepMessages
    ),
    tokenTarget: clampNumber(
      parsed.tokenTarget,
      DEFAULT_CONTEXT_POLICY.tokenTarget,
      CONTEXT_POLICY_BOUNDS.tokenTarget
    ),
    memoryFile:
      typeof parsed.memoryFile === "string" && parsed.memoryFile.startsWith("/")
        ? parsed.memoryFile
        : DEFAULT_CONTEXT_POLICY.memoryFile,
    memoryMaxChars: clampNumber(
      parsed.memoryMaxChars,
      DEFAULT_CONTEXT_POLICY.memoryMaxChars,
      CONTEXT_POLICY_BOUNDS.memoryMaxChars
    )
  };
}

function isArtifactsNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "NOT_FOUND") return true;
  // In local dev the remote binding proxy flattens ArtifactsError into a
  // plain Error, dropping the structured code — fall back to the message.
  return (
    typeof message === "string" &&
    (message.includes("Repository not found") || message.includes("not found"))
  );
}

interface BuildToolsOptions {
  source: TurnSource;
  allowScheduling?: boolean;
  beforeToolCall?: (
    call: HarnessRuntimeToolCall
  ) => Promise<HarnessRuntimeToolDecision | undefined>;
  afterToolCall?: (
    result: HarnessRuntimeToolResult
  ) => Promise<{ output: unknown } | undefined>;
}

export interface ExoCoreOptions {
  workspace: ExoWorkspace;
  store: KernelStore;
  /** Stable agent name; used to derive the per-agent Artifacts session. */
  name: () => string;
  /**
   * Optional raw Artifacts binding. When present, genesis and every
   * successful activation push the workspace git history to the agent's
   * session-scoped mirror repo (best-effort). When absent (offline dev,
   * tests) pushes are skipped. The raw binding is also used for fork —
   * the session facade deliberately excludes cross-session operations.
   */
  artifacts?: Artifacts;
  /** Environment prefix for Artifacts session ids (default "exo"). */
  repoPrefix?: string;
  /**
   * Deliver a fork genesis to a (fresh) sibling agent. Wired by the owner
   * to a cross-DO RPC call; the child applies it via adoptGenesis().
   */
  adoptChild: (
    childName: string,
    origin: ForkOrigin
  ) => Promise<{ version: number; sha: string }>;
  /**
   * Create a persistent self-scheduled task (wired to this.schedule on
   * the owner, which also enforces the kernel's task rails).
   */
  scheduleTask: (input: {
    instruction: string;
    when:
      | { kind: "delay"; seconds: number }
      | { kind: "at"; time: Date }
      | {
          kind: "cron";
          cron: string;
        };
  }) => Promise<{ id: string; kind: string; spec: string }>;
  /** Cancel a self-scheduled task by id. */
  cancelTask: (id: string) => Promise<boolean>;
  /** Called after any mutation so the owner can refresh synced UI state. */
  onMutation: () => void;
}

export class ExoCore {
  readonly workspace: ExoWorkspace;
  readonly store: KernelStore;
  #name: () => string;
  #artifactsBinding: Artifacts | undefined;
  #repoPrefix: string;
  #adoptChild: ExoCoreOptions["adoptChild"];
  #scheduleTask: ExoCoreOptions["scheduleTask"];
  #cancelTask: ExoCoreOptions["cancelTask"];
  #onMutation: () => void;
  #genesis: Promise<void> | undefined;

  constructor(options: ExoCoreOptions) {
    this.workspace = options.workspace;
    this.store = options.store;
    this.#name = options.name;
    this.#artifactsBinding = options.artifacts;
    this.#repoPrefix = options.repoPrefix ?? "exo";
    this.#adoptChild = options.adoptChild;
    this.#scheduleTask = options.scheduleTask;
    this.#cancelTask = options.cancelTask;
    this.#onMutation = options.onMutation;
  }

  sessionId(): string {
    return artifactsSessionId(this.#name(), this.#repoPrefix);
  }

  /** Session-scoped Artifacts facade (repo + token lifecycle). */
  #artifactsFacade() {
    if (!this.#artifactsBinding) return undefined;
    return createArtifact(this.#artifactsBinding, this.sessionId());
  }

  /** Write a file, creating parent directories as needed. */
  async #write(path: string, content: string): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir.length > 0) {
      await this.workspace.mkdir(dir, { recursive: true });
    }
    await this.workspace.writeFile(path, content);
  }

  /** Idempotent: seed the workspace and commit version 1 on first contact. */
  ensureGenesis(): Promise<void> {
    this.#genesis ??= this.#runGenesis();
    return this.#genesis;
  }

  async #runGenesis(): Promise<void> {
    if (this.store.activeVersion() > 0) return;
    for (const [path, content] of Object.entries(SEED_FILES)) {
      await this.#write(path, content);
    }
    const git = this.workspace.git;
    await git.init({ defaultBranch: "main" });
    await git.add({ paths: [], all: true });
    const { oid } = await git.commit({
      message: "genesis: seed harness v1",
      author: GIT_AUTHOR
    });
    const files = await this.readHarnessFiles();
    const version = this.store.insertVersion(oid, "genesis", files);
    this.store.appendJournal("genesis", {
      version: version.version,
      sha: oid,
      files: Object.keys(files)
    });
    // Every agent gets a repo from birth, so a fork source always exists.
    await this.#pushToArtifacts(version.version, oid);
    this.#onMutation();
  }

  /** Glob that tolerates a not-yet-created base directory. */
  async globHarness(): Promise<
    { path: string; type: "file" | "directory"; size: number }[]
  > {
    try {
      return await this.workspace.glob("/harness/**");
    } catch {
      return [];
    }
  }

  async readHarnessFiles(): Promise<Record<string, string>> {
    const entries = await this.globHarness();
    const files: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.type !== "file") continue;
      const content = await this.workspace.readFile(entry.path);
      if (content !== null) files[entry.path] = content;
    }
    return files;
  }

  /**
   * Load the live harness. If the live files are broken (bad JSON, syntax
   * errors, invalid tool modules), restore the last activated version and
   * retry once — the exo "sandbox rewind" with the journal left intact.
   */
  async loadHarness(): Promise<LoadedHarness> {
    try {
      return await this.#loadOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.appendJournal("harness_load_failed", { error: message });
      const active = this.store.activeVersion();
      const snapshot = active > 0 ? this.store.versionFiles(active) : null;
      if (!snapshot) {
        this.#onMutation();
        throw error;
      }
      await this.restoreFiles(snapshot);
      this.store.appendJournal("harness_rollback", {
        toVersion: active,
        reason: "load_failed",
        error: message
      });
      this.#onMutation();
      return await this.#loadOnce();
    }
  }

  async #loadOnce(): Promise<LoadedHarness> {
    const files = await this.readHarnessFiles();

    const identity = files["/harness/identity.md"];
    if (!identity) throw new Error("/harness/identity.md is missing");

    const policyRaw = files["/harness/policy.json"];
    if (!policyRaw) throw new Error("/harness/policy.json is missing");
    let policy: HarnessPolicy;
    try {
      policy = JSON.parse(policyRaw) as HarnessPolicy;
    } catch (error) {
      throw new Error(
        `/harness/policy.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (typeof policy.model !== "string" || policy.model.length === 0) {
      throw new Error('/harness/policy.json must set a string "model"');
    }

    const context = parseContextPolicy(files["/harness/context.json"]);

    const toolPaths = Object.keys(files).filter(
      (path) => path.startsWith("/harness/tools/") && path.endsWith(".js")
    );
    const tools = await this.#loadToolManifests(toolPaths);
    const runtime = files["/harness/runtime.js"]
      ? await this.#loadRuntimeManifest()
      : null;

    return { identity, policy, context, tools, runtime, files };
  }

  /**
   * Read the agent's working memory (clamped to the policy's injection
   * budget; the tail wins so the most recent compactions survive).
   */
  async readMemory(context: ContextPolicy): Promise<string | null> {
    if (context.memoryMaxChars === 0) return null;
    const content = await this.workspace.readFile(context.memoryFile);
    if (!content || content.trim().length === 0) return null;
    if (content.length <= context.memoryMaxChars) return content;
    return `…(older memory clipped; full file at ${context.memoryFile})\n${content.slice(-context.memoryMaxChars)}`;
  }

  /**
   * Record a compaction: append the agent-authored summary to its memory
   * file NOW, journal the request, and flag the transcript cut to be
   * applied by the kernel at the start of the next chat turn (mutating the
   * transcript mid-turn would race the streaming pipeline). The journal is
   * never touched — nothing is truly forgotten, only demoted.
   */
  async requestCompaction(
    context: ContextPolicy,
    summary: string,
    keepLast: number
  ): Promise<{ memoryFile: string; keepLast: number; memoryChars: number }> {
    const stamp = new Date().toISOString();
    const existing = (await this.workspace.readFile(context.memoryFile)) ?? "";
    const block = `## ${stamp} — compacted from transcript\n\n${summary.trim()}\n`;
    const updated =
      existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${block}` : block;
    await this.#write(context.memoryFile, updated);
    this.store.setPendingCompaction({
      keepLast,
      memoryFile: context.memoryFile,
      requestedTs: Date.now()
    });
    this.store.appendJournal("history_compacted", {
      phase: "requested",
      keepLast,
      memoryFile: context.memoryFile,
      summaryChars: summary.length
    });
    this.#onMutation();
    return {
      memoryFile: context.memoryFile,
      keepLast,
      memoryChars: updated.length
    };
  }

  /**
   * Import every tool module inside an isolated dynamic Worker (the
   * worker-javascript backend resolves the imports straight from the
   * durable filesystem) and return validated manifests. A single broken
   * module fails the whole load — deliberately: it is the signal for the
   * auto-rollback path.
   */
  async #loadToolManifests(
    toolPaths: string[]
  ): Promise<HarnessToolManifest[]> {
    if (toolPaths.length === 0) return [];
    const imports = toolPaths
      .map((path) => {
        const rel = path.slice(HARNESS_PREFIX.length);
        return `
  {
    const mod = await import(${JSON.stringify(`.${path}`)});
    const def = mod.default;
    if (!def || typeof def !== "object") {
      throw new Error(${JSON.stringify(rel)} + ": missing default export object");
    }
    if (typeof def.name !== "string" || def.name.length === 0) {
      throw new Error(${JSON.stringify(rel)} + ": tool needs a string name");
    }
    if (typeof def.run !== "function") {
      throw new Error(${JSON.stringify(rel)} + ": tool needs a run() function");
    }
    manifests.push({
      file: ${JSON.stringify(rel)},
      name: def.name,
      description: String(def.description ?? ""),
      inputSchema: def.inputSchema ?? { type: "object", properties: {} }
    });
  }`;
      })
      .join("\n");
    const source = `export default async function main() {
  const manifests = [];
${imports}
  return manifests;
}`;
    using handle = await this.workspace.runtime.exec(source, {
      backend: "worker-javascript",
      cwd: "/",
      encoding: "utf8",
      timeoutMs: TOOL_TIMEOUT_MS
    });
    const result = await handle.result();
    if (result.exitCode !== 0) {
      throw new Error(
        `harness tools failed to load: ${clampText(result.stderr || result.stdout || "unknown error", 1000)}`
      );
    }
    const manifests = (result.value ?? []) as unknown as HarnessToolManifest[];
    const seen = new Set<string>();
    for (const manifest of manifests) {
      if (seen.has(manifest.name)) {
        throw new Error(`duplicate tool name "${manifest.name}"`);
      }
      seen.add(manifest.name);
    }
    return manifests;
  }

  /** Validate the optional self-editable turn runtime inside its isolate. */
  async #loadRuntimeManifest(): Promise<HarnessRuntimeManifest> {
    const source = `import runtime from "./harness/runtime.js";
export default async function main() {
  if (!runtime || typeof runtime !== "object") {
    throw new Error("runtime.js: default export must be an object");
  }
  const known = ${JSON.stringify(HARNESS_RUNTIME_HOOK_NAMES)};
  const hooks = [];
  for (const name of known) {
    if (runtime[name] === undefined) continue;
    if (typeof runtime[name] !== "function") {
      throw new Error("runtime.js: " + name + " must be a function");
    }
    hooks.push(name);
  }
  return { file: "runtime.js", hooks };
}`;
    using handle = await this.workspace.runtime.exec(source, {
      backend: "worker-javascript",
      cwd: "/",
      encoding: "utf8",
      timeoutMs: TOOL_TIMEOUT_MS
    });
    const result = await handle.result();
    if (result.exitCode !== 0) {
      throw new Error(
        `harness runtime failed to load: ${clampText(result.stderr || result.stdout || "unknown error", 1000)}`
      );
    }
    // SAFETY: the isolate constructs this value exclusively from the fixed
    // hook-name tuple after checking every included property is a function.
    return result.value as unknown as HarnessRuntimeManifest;
  }

  /** Execute one hook from /harness/runtime.js with a scoped host bridge. */
  async runRuntimeHook(
    runtime: HarnessRuntimeManifest,
    hook: HarnessRuntimeHookName,
    event: unknown,
    capabilityToken: string
  ): Promise<unknown> {
    if (!runtime.hooks.includes(hook)) return undefined;
    const source = `import runtime from "./harness/runtime.js";
import { call } from "ws:kernel";
export default async function main(input) {
  const invoke = (method, value) => call(method, input.capabilityToken, value);
  const host = {
    infer: (request) => invoke("infer", request),
    readMessages: () => invoke("readMessages"),
    appendMessages: (messages) => invoke("appendMessages", messages),
    executeTool: (name, input) => invoke("executeTool", { name, input }),
    journal: (text) => invoke("journal", text),
    readJournal: (limit) => invoke("readJournal", limit),
    scheduleTask: (request) => invoke("scheduleTask", request),
    cancelTask: (id) => invoke("cancelTask", id)
  };
  return await runtime[input.hook](input.event, host);
}`;
    using handle = await this.workspace.runtime.exec(source, {
      backend: "worker-javascript",
      cwd: "/",
      encoding: "utf8",
      // SAFETY: Workspace runtime input is JSON data, but its generic backend
      // surface cannot express this per-execution payload.
      input: {
        hook,
        event: toWorkspaceRuntimeValue(event),
        capabilityToken
      } as never,
      timeoutMs: TOOL_TIMEOUT_MS
    });
    const result = await handle.result();
    if (result.exitCode !== 0) {
      throw new Error(
        `runtime ${hook} failed: ${clampText(result.stderr || result.stdout || "unknown error", 1000)}`
      );
    }
    return result.value;
  }

  /** Overwrite /harness with the given snapshot (deleting extra files). */
  async restoreFiles(snapshot: Record<string, string>): Promise<void> {
    const current = await this.globHarness();
    for (const entry of current) {
      if (entry.type !== "file") continue;
      if (!(entry.path in snapshot)) {
        await this.workspace.rm(entry.path);
      }
    }
    for (const [path, content] of Object.entries(snapshot)) {
      await this.#write(path, content);
    }
  }

  /**
   * Validate the live harness, commit it to git, and record a new version.
   * Throws (with a useful message) if the live harness fails validation —
   * activation is the safety gate, so a broken self never becomes a version.
   */
  async activate(note: string): Promise<{
    version: number;
    sha: string;
    liveTools: string[];
    runtimeHooks: HarnessRuntimeHookName[];
  }> {
    const loaded = await this.#loadOnce();
    const git = this.workspace.git;
    await git.add({ paths: [], all: true });
    const { oid } = await git.commit({
      message: `activate: ${note}`,
      author: GIT_AUTHOR
    });
    const harnessOnly: Record<string, string> = {};
    for (const [path, content] of Object.entries(loaded.files)) {
      harnessOnly[path] = content;
    }
    const version = this.store.insertVersion(oid, note, harnessOnly);
    this.store.appendJournal("harness_upgrade", {
      version: version.version,
      sha: oid,
      note
    });
    await this.#pushToArtifacts(version.version, oid);
    this.#onMutation();
    return {
      version: version.version,
      sha: oid,
      liveTools: loaded.tools.map((t) => t.name),
      runtimeHooks: loaded.runtime?.hooks ?? []
    };
  }

  /**
   * Best-effort mirror of the workspace git history to the agent's
   * session-scoped Artifacts repo. Skipped silently when no binding is
   * bound (offline dev, tests); any failure is journaled and never fails
   * the activation itself.
   */
  async #pushToArtifacts(version: number, sha: string): Promise<void> {
    const facade = this.#artifactsFacade();
    if (!facade) return;
    try {
      const { remote, token } = await this.#ensureArtifactsRepo(facade);
      const git = this.workspace.git;
      await git.remoteAdd({
        name: ARTIFACTS_REMOTE_NAME,
        url: remote,
        force: true
      });
      // Force: the Artifacts repo is a mirror of this agent's current
      // history. A rebuilt local state (fresh genesis against a surviving
      // remote repo) must still be able to publish.
      const result = await git.push({
        remote: ARTIFACTS_REMOTE_NAME,
        ref: "main",
        force: true,
        onAuth: () => ({ username: "x", password: token })
      });
      if (!result.ok) {
        throw new Error(
          `push rejected: ${result.error ?? JSON.stringify(result.refs)}`
        );
      }
      this.store.setVersionPush(version, remote, sha);
      this.store.appendJournal("artifacts_push", { version, sha, remote });
    } catch (error) {
      this.store.appendJournal("artifacts_push_failed", {
        version,
        sha,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Get (or create) the agent's session-scoped mirror repo ("self") and a
   * short-lived write token, via the createArtifact facade.
   */
  async #ensureArtifactsRepo(
    facade: ReturnType<typeof createArtifact>
  ): Promise<{ remote: string; token: string }> {
    try {
      const info = await facade.get(SELF_REPO);
      const token = await facade.createToken(
        SELF_REPO,
        "write",
        ARTIFACTS_TOKEN_TTL_SECONDS
      );
      return { remote: info.remote, token: token.plaintext };
    } catch (error) {
      if (!isArtifactsNotFound(error)) throw error;
      const created = await facade.create(SELF_REPO, {
        description: `exo-harness agent "${this.#name()}" harness history`
      });
      return { remote: created.remote, token: created.token };
    }
  }

  /**
   * Restore an old version's files and activate the result as a NEW version.
   * History only moves forward: the journal and the ledger both record the
   * rollback rather than rewriting what happened.
   */
  async rollbackTo(
    targetVersion: number
  ): Promise<{ version: number; sha: string }> {
    const snapshot = this.store.versionFiles(targetVersion);
    if (!snapshot) {
      throw new Error(`version ${targetVersion} does not exist`);
    }
    await this.restoreFiles(snapshot);
    const result = await this.activate(`rollback to v${targetVersion}`);
    this.store.appendJournal("harness_rollback", {
      toVersion: targetVersion,
      asVersion: result.version,
      reason: "requested"
    });
    this.#onMutation();
    return result;
  }

  /**
   * Fork the current ACTIVATED self into a new agent. With Artifacts
   * bound, this forks the agent's mirror repo (real git lineage — the
   * child's repo records `source: artifacts:…`); without it, the
   * activated file snapshot is handed over directly. Only activated
   * selves are forkable: the live working tree is not part of history.
   *
   * Fork is cross-session, which the facade deliberately excludes, so it
   * uses the raw binding with explicit `<session>__self` names.
   */
  async forkSelf(childName: string): Promise<{
    child: string;
    version: number;
    sha: string;
    origin: ForkOrigin["kind"];
  }> {
    const name = childName.trim();
    if (!name) throw new Error("fork needs a non-empty agent name");
    if (name === this.#name()) throw new Error("cannot fork onto yourself");

    const active = this.store.versionInfo(this.store.activeVersion());
    if (!active) throw new Error("nothing to fork: no activated version yet");
    const parent: ForkParent = {
      name: this.#name(),
      version: active.version,
      sha: active.sha
    };

    let origin: ForkOrigin;
    if (this.#artifactsBinding) {
      // Make sure the mirror is current before forking it (retries a
      // previously failed push; normally genesis/activate already pushed).
      if (active.pushedSha !== active.sha) {
        await this.#pushToArtifacts(active.version, active.sha);
        const refreshed = this.store.versionInfo(active.version);
        if (refreshed?.pushedSha !== active.sha) {
          throw new Error(
            "could not push the current self to Artifacts before forking (see journal)"
          );
        }
      }
      const parentSession = this.sessionId();
      const childSession = artifactsSessionId(name, this.#repoPrefix);
      const parentRepo = `${parentSession}__${SELF_REPO}`;
      const childRepo = `${childSession}__${SELF_REPO}`;
      const repo = await this.#artifactsBinding.get(parentRepo);
      const forked = await repo.fork(childRepo, {
        description: `fork of ${parentSession} v${active.version} for agent "${name}"`
      });
      origin = {
        kind: "artifacts",
        repoName: SELF_REPO,
        remote: forked.remote,
        parent
      };
    } else {
      const files = this.store.versionFiles(active.version);
      if (!files) throw new Error(`version ${active.version} has no snapshot`);
      origin = { kind: "files", files, parent };
    }

    const child = await this.#adoptChild(name, origin);
    this.store.appendJournal("fork", {
      child: name,
      origin: origin.kind,
      fromVersion: active.version,
      fromSha: active.sha,
      childVersion: child.version,
      childSha: child.sha,
      ...(origin.kind === "artifacts" ? { remote: origin.remote } : {})
    });
    this.#onMutation();
    return {
      child: name,
      version: child.version,
      sha: child.sha,
      origin: origin.kind
    };
  }

  /**
   * Receive a fork genesis (runs in the CHILD agent). Clones the forked
   * Artifacts repo (full history) or commits the handed-over snapshot,
   * then records v1 with the lineage in both the ledger and the journal.
   */
  async adoptGenesis(
    origin: ForkOrigin
  ): Promise<{ version: number; sha: string }> {
    if (this.store.activeVersion() > 0) {
      throw new Error(
        `agent "${this.#name()}" already has a history; fork onto a fresh name`
      );
    }
    const note = `fork of ${origin.parent.name} v${origin.parent.version}`;
    const git = this.workspace.git;
    let sha: string;
    if (origin.kind === "artifacts") {
      const facade = this.#artifactsFacade();
      if (!facade) {
        throw new Error("artifacts binding required to adopt a repo fork");
      }
      // The fork already created this child's session repo; mint our own
      // read token rather than carrying one across the RPC boundary.
      const token = await facade.createToken(
        SELF_REPO,
        "read",
        ARTIFACTS_TOKEN_TTL_SECONDS
      );
      await git.clone({
        url: origin.remote,
        dir: "/",
        headers: {
          Authorization: `Basic ${btoa(`x:${token.plaintext}`)}`
        }
      });
      const head = await git.log({ depth: 1 });
      if (!head[0]) throw new Error("forked repo has no commits");
      sha = head[0].oid;
    } else {
      await this.restoreFiles(origin.files);
      await git.init({ defaultBranch: "main" });
      await git.add({ paths: [], all: true });
      const committed = await git.commit({
        message: `genesis: ${note}`,
        author: GIT_AUTHOR
      });
      sha = committed.oid;
    }
    const files = await this.readHarnessFiles();
    const version = this.store.insertVersion(sha, note, files);
    if (origin.kind === "artifacts") {
      // The forked repo already contains exactly this history.
      this.store.setVersionPush(version.version, origin.remote, sha);
    }
    this.store.appendJournal("genesis", {
      version: version.version,
      sha,
      origin: origin.kind,
      parent: origin.parent.name,
      parentVersion: origin.parent.version,
      parentSha: origin.parent.sha,
      files: Object.keys(files)
    });
    this.#onMutation();
    return { version: version.version, sha };
  }

  /**
   * Execute one harness tool inside an isolated dynamic Worker. The tool
   * module is imported straight from the durable filesystem; it gets
   * Workspace-backed node:fs/promises and the ws:journal capability.
   */
  async runHarnessTool(
    manifest: HarnessToolManifest,
    input: unknown
  ): Promise<unknown> {
    const source = `import def from ${JSON.stringify(`./${HARNESS_PREFIX.slice(1)}${manifest.file}`)};
export default async function main(input) {
  return await def.run(input);
}`;
    using handle = await this.workspace.runtime.exec(source, {
      backend: "worker-javascript",
      cwd: "/",
      encoding: "utf8",
      input: (input ?? {}) as never,
      timeoutMs: TOOL_TIMEOUT_MS
    });
    const result = await handle.result();
    if (result.exitCode !== 0) {
      return {
        error: clampText(result.stderr || result.stdout || "tool failed", 1000)
      };
    }
    return result.stdout.trim().length > 0
      ? { result: result.value ?? null, logs: clampText(result.stdout, 1000) }
      : { result: result.value ?? null };
  }

  /** Run a shell command on the worker-shell backend. */
  async execShell(
    command: string,
    timeoutMs = EXEC_TIMEOUT_MS
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    using handle = await this.workspace.runtime.exec(command, {
      backend: "worker-shell",
      cwd: "/",
      encoding: "utf8",
      timeoutMs
    });
    const result = await handle.result();
    return {
      exitCode: result.exitCode,
      stdout: clampText(result.stdout),
      stderr: clampText(result.stderr)
    };
  }

  /**
   * Build the full ToolSet for a turn: the fixed kernel bootstrap surface
   * plus one entry per live harness tool. Every execute is wrapped with
   * journaling. Task CREATION is only exposed on human-initiated turns
   * (`allowScheduling`) — a scheduled turn cannot schedule more tasks.
   */
  buildTools(loaded: LoadedHarness, opts: BuildToolsOptions): ToolSet {
    const allowScheduling = opts.allowScheduling ?? true;
    const journaled = <TInput, TOutput>(
      name: string,
      fn: (input: TInput) => Promise<TOutput>
    ) => this.#journaled(name, fn, opts);
    const tools: ToolSet = {
      read_file: tool({
        description:
          "Read a file from the workspace (including your own /harness source)",
        inputSchema: z.object({
          path: z.string().describe("Absolute path, e.g. /harness/identity.md")
        }),
        execute: journaled("read_file", async ({ path }) => {
          const content = await this.workspace.readFile(path);
          return content === null
            ? { error: `not found: ${path}` }
            : { path, content };
        })
      }),
      write_file: tool({
        description:
          "Write a file in the workspace. Writing under /harness edits your own source; call activate_harness afterwards to commit a new version.",
        inputSchema: z.object({
          path: z.string().describe("Absolute path"),
          content: z.string().describe("Full new file content")
        }),
        execute: journaled("write_file", async ({ path, content }) => {
          await this.#write(path, content);
          this.store.appendJournal("file_write", {
            path,
            bytes: content.length
          });
          this.#onMutation();
          return { path, bytesWritten: content.length };
        })
      }),
      list_files: tool({
        description: "List files and directories at a workspace path",
        inputSchema: z.object({
          path: z.string().describe("Absolute directory path, e.g. /harness")
        }),
        execute: journaled("list_files", async ({ path }) => {
          const entries = await this.workspace.readDir(path);
          return entries.map((e) => ({
            path: e.path,
            type: e.type,
            size: e.size
          }));
        })
      }),
      delete_file: tool({
        description: "Delete a workspace file",
        inputSchema: z.object({
          path: z.string().describe("Absolute path to delete")
        }),
        execute: journaled("delete_file", async ({ path }) => {
          await this.workspace.rm(path);
          this.store.appendJournal("file_delete", { path });
          this.#onMutation();
          return { path, deleted: true };
        })
      }),
      exec: tool({
        description:
          "Run a shell command in your workspace (just-bash in an isolated Dynamic Worker — fast, no container). Built-ins include cat, grep, sed, awk, jq, curl, sqlite3, file, and a `js` command for quick JavaScript, plus `git` and `artifacts` commands that run host-side against your workspace and mirror. No node or python. Your files live at / (e.g. /harness, /memory, /scratch).",
        inputSchema: z.object({
          command: z.string().describe("The shell command to run")
        }),
        execute: journaled("exec", async ({ command }) => {
          return this.execShell(command);
        })
      }),
      activate_harness: tool({
        description:
          "Validate the live /harness files, commit them, and make them the new active version. Do this after editing your own source.",
        inputSchema: z.object({
          note: z
            .string()
            .describe("Short human-readable summary of what changed")
        }),
        execute: journaled("activate_harness", async ({ note }) => {
          try {
            const result = await this.activate(note);
            return {
              ...result,
              hint: "Tools added or changed this turn are callable NOW via run_harness_tool; first-class tools and runtime hooks refresh from the next turn."
            };
          } catch (error) {
            return {
              error: `activation failed: ${error instanceof Error ? error.message : String(error)}`
            };
          }
        })
      }),
      rollback_harness: tool({
        description:
          "Restore a previous harness version (forward-only: the rollback itself becomes a new version)",
        inputSchema: z.object({
          version: z.number().int().describe("Version number to restore")
        }),
        execute: journaled("rollback_harness", async ({ version }) => {
          try {
            return await this.rollbackTo(version);
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : String(error)
            };
          }
        })
      }),
      compact_history: tool({
        description:
          "Distill older conversation into your durable working memory. Write the summary yourself — whatever your future self needs. The kernel appends it to your memory file (injected into your system prompt every turn), then truncates the chat transcript at the start of the next turn, keeping the most recent messages. The journal is never affected.",
        inputSchema: z.object({
          summary: z
            .string()
            .min(1)
            .max(8000)
            .describe(
              "Agent-authored summary of what is worth remembering from the conversation being dropped"
            ),
          keepLast: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("How many recent messages to keep (default 6)")
        }),
        execute: journaled("compact_history", async ({ summary, keepLast }) => {
          return this.requestCompaction(loaded.context, summary, keepLast ?? 6);
        })
      }),
      run_harness_tool: tool({
        description:
          "Run one of YOUR harness tools by name against the LIVE /harness — including a tool you created or changed this very turn (first-class functions only refresh at turn start; this bridge always reloads). Input is passed to the tool's run().",
        inputSchema: z.object({
          name: z
            .string()
            .describe("The tool's name (from its default export)"),
          input: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Input object for the tool, matching its inputSchema")
        }),
        execute: journaled("run_harness_tool", async ({ name, input }) => {
          const live = await this.#loadOnce();
          const manifest = live.tools.find((t) => t.name === name);
          if (!manifest) {
            return {
              error: `no harness tool named "${name}" in the live harness (have: ${live.tools.map((t) => t.name).join(", ") || "none"})`
            };
          }
          return this.runHarnessTool(manifest, input);
        })
      }),
      journal_note: tool({
        description:
          "Annotate your permanent event journal — the append-only record of what happened and why (decisions, experiment outcomes, reasoning at the time). It survives rollbacks, compaction, and memory edits, but is NOT injected into your context: future turns only see it via read_journal. For facts you need to actively carry between turns, write to your memory file instead.",
        inputSchema: z.object({
          text: z.string().describe("The note to record")
        }),
        execute: journaled("journal_note", async ({ text }) => {
          const id = this.store.appendJournal("note", {
            text,
            source: "agent"
          });
          this.#onMutation();
          return { ok: true, id };
        })
      }),
      list_tasks: tool({
        description:
          "List your self-scheduled tasks (instruction, cadence, state, run counts). Tasks run as autonomous turns outside the chat.",
        inputSchema: z.object({}),
        execute: journaled("list_tasks", async () => {
          return this.store.listTasks();
        })
      }),
      cancel_task: tool({
        description: "Cancel one of your self-scheduled tasks by id",
        inputSchema: z.object({
          id: z.string().describe("Task id (from list_tasks)")
        }),
        execute: journaled("cancel_task", async ({ id }) => {
          const cancelled = await this.#cancelTask(id);
          return cancelled
            ? { id, cancelled: true }
            : { error: `no active task ${id}` };
        })
      }),
      read_journal: tool({
        description:
          "Read the most recent entries from your append-only journal — your full history of events: turns, tool calls, upgrades, rollbacks, pushes, compactions, and your own notes. Use it to reconstruct what happened and why.",
        inputSchema: z.object({
          limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe("How many entries (default 20)")
        }),
        execute: journaled("read_journal", async ({ limit }) => {
          return this.store.journalTail(limit ?? 20);
        })
      })
    };

    if (allowScheduling) {
      tools.schedule_task = tool({
        description:
          "Give your future self work: schedule an autonomous turn that runs your instruction later — once (after a delay or at a time) or repeatedly (cron). Scheduled turns run outside the chat with your full harness and tools, and are journaled. Provide exactly one of delaySeconds, at, or cron.",
        inputSchema: z.object({
          instruction: z
            .string()
            .min(1)
            .max(4000)
            .describe("The instruction your future self will run"),
          delaySeconds: z
            .number()
            .int()
            .min(30)
            .max(30 * 24 * 3600)
            .optional()
            .describe("Run once, this many seconds from now"),
          at: z.string().optional().describe("Run once, at this ISO 8601 time"),
          cron: z
            .string()
            .optional()
            .describe('Run repeatedly on a cron expression, e.g. "0 3 * * *"')
        }),
        execute: journaled(
          "schedule_task",
          async ({ instruction, delaySeconds, at, cron }) => {
            const provided = [delaySeconds, at, cron].filter(
              (v) => v !== undefined
            );
            if (provided.length !== 1) {
              return {
                error: "provide exactly one of delaySeconds, at, or cron"
              };
            }
            let when: Parameters<ExoCoreOptions["scheduleTask"]>[0]["when"];
            if (delaySeconds !== undefined) {
              when = { kind: "delay", seconds: delaySeconds };
            } else if (at !== undefined) {
              const time = new Date(at);
              if (
                Number.isNaN(time.getTime()) ||
                time.getTime() <= Date.now()
              ) {
                return { error: `"at" must be a future ISO 8601 time` };
              }
              when = { kind: "at", time };
            } else {
              when = { kind: "cron", cron: cron as string };
            }
            try {
              return await this.#scheduleTask({ instruction, when });
            } catch (error) {
              return {
                error: error instanceof Error ? error.message : String(error)
              };
            }
          }
        )
      });
    }

    for (const manifest of loaded.tools) {
      if (manifest.name in tools) {
        this.store.appendJournal("error", {
          message: `harness tool "${manifest.name}" shadows a kernel tool; skipped`
        });
        continue;
      }
      tools[manifest.name] = tool({
        description: `${manifest.description} (harness tool from ${manifest.file})`,
        inputSchema: jsonSchema<Record<string, unknown>>(
          manifest.inputSchema as Parameters<typeof jsonSchema>[0]
        ),
        execute: journaled(manifest.name, (input) =>
          this.runHarnessTool(manifest, input)
        )
      });
    }

    return tools;
  }

  /** Wrap tool execution with journal records and evolvable runtime control. */
  #journaled<TInput, TOutput>(
    name: string,
    fn: (input: TInput) => Promise<TOutput>,
    opts: BuildToolsOptions
  ): (
    input: TInput,
    options: ToolExecutionOptions<unknown>
  ) => Promise<unknown> {
    return async (input: TInput, options: ToolExecutionOptions<unknown>) => {
      const decision = await opts.beforeToolCall?.({
        source: opts.source,
        tool: name,
        toolCallId: options.toolCallId,
        input,
        messages: options.messages
      });
      // SAFETY: runtime input replacement is intentionally dynamic. The tool
      // implementation remains the trust boundary and converts failures into
      // ordinary tool errors below.
      const effectiveInput =
        decision?.action === "allow" && decision.input !== undefined
          ? (decision.input as TInput)
          : input;
      this.store.appendJournal("tool_call", {
        tool: name,
        input: preview(effectiveInput)
      });

      let output: unknown;
      if (decision?.action === "block") {
        output = { error: decision.reason };
      } else if (decision?.action === "substitute") {
        output = decision.output;
      } else {
        try {
          output = await fn(effectiveInput);
        } catch (error) {
          output = {
            error: error instanceof Error ? error.message : String(error)
          };
        }
      }

      const transformed = await opts.afterToolCall?.({
        source: opts.source,
        tool: name,
        toolCallId: options.toolCallId,
        input: effectiveInput,
        messages: options.messages,
        output
      });
      if (transformed) output = transformed.output;
      const failed =
        typeof output === "object" &&
        output !== null &&
        "error" in output &&
        output.error !== undefined;
      this.store.appendJournal("tool_result", {
        tool: name,
        ok: !failed,
        output: preview(output)
      });
      this.#onMutation();
      return output;
    };
  }
}

/** Strip undefined/provider-only fields before crossing the runtime boundary. */
function toWorkspaceRuntimeValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  return JSON.parse(serialized) as unknown;
}

/** Compact JSON preview for journal entries. */
function preview(value: unknown): string {
  let json: string;
  try {
    json = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  } catch {
    json = String(value);
  }
  return json.length > 500 ? `${json.slice(0, 500)}…` : json;
}
