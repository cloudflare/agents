/**
 * ExoCore — the stable kernel's harness machinery.
 *
 * The kernel owns: the append-only journal, the version ledger, and this
 * loader. The agent owns everything under /harness in its Workspace and can
 * rewrite it freely; the kernel re-loads that "self" from the live files on
 * every turn (hot reload), validates it in an isolated dynamic Worker, and
 * auto-restores the last activated version if the live files fail to load.
 */

import {
  DynamicWorkerExecutor,
  resolveProvider,
  type ResolvedProvider
} from "@cloudflare/codemode";
import { Workspace, WorkspaceFileSystem } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import { createGit } from "@cloudflare/shell/git";
import { jsonSchema, tool, type ToolSet } from "ai";
import { z } from "zod";
import type { KernelStore } from "./store";
import { SEED_FILES } from "./seed";
import type {
  HarnessPolicy,
  HarnessToolManifest,
  LoadedHarness
} from "./types";

type LoaderBinding = ConstructorParameters<
  typeof DynamicWorkerExecutor
>[0]["loader"];

const GIT_AUTHOR = { name: "Exo Kernel", email: "exo@cloudflare.dev" };
const HARNESS_PREFIX = "/harness/";
const TOOL_TIMEOUT_MS = 20_000;

export interface ExoCoreOptions {
  workspace: Workspace;
  store: KernelStore;
  loader: LoaderBinding;
  /** Called after any mutation so the owner can refresh synced UI state. */
  onMutation: () => void;
}

export class ExoCore {
  readonly workspace: Workspace;
  readonly store: KernelStore;
  #loader: LoaderBinding;
  #onMutation: () => void;
  #git: ReturnType<typeof createGit> | undefined;
  #genesis: Promise<void> | undefined;

  constructor(options: ExoCoreOptions) {
    this.workspace = options.workspace;
    this.store = options.store;
    this.#loader = options.loader;
    this.#onMutation = options.onMutation;
  }

  git() {
    this.#git ??= createGit(new WorkspaceFileSystem(this.workspace));
    return this.#git;
  }

  /** Idempotent: seed the workspace and commit version 1 on first contact. */
  ensureGenesis(): Promise<void> {
    this.#genesis ??= this.#runGenesis();
    return this.#genesis;
  }

  async #runGenesis(): Promise<void> {
    if (this.store.activeVersion() > 0) return;
    for (const [path, content] of Object.entries(SEED_FILES)) {
      await this.workspace.writeFile(path, content);
    }
    const git = this.git();
    await git.init({ defaultBranch: "main" });
    await git.add({ filepath: "." });
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
    this.#onMutation();
  }

  async readHarnessFiles(): Promise<Record<string, string>> {
    const entries = await this.workspace.glob("/harness/**");
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

    const toolPaths = Object.keys(files).filter(
      (path) => path.startsWith("/harness/tools/") && path.endsWith(".js")
    );
    const tools = await this.#loadToolManifests(files, toolPaths);

    return { identity, policy, tools, files };
  }

  /** Module map for the dynamic Worker: "/harness/tools/x.js" → "tools/x.js". */
  #toolModules(files: Record<string, string>): Record<string, string> {
    const modules: Record<string, string> = {};
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith("/harness/tools/") || !path.endsWith(".js")) {
        continue;
      }
      modules[path.slice(HARNESS_PREFIX.length)] = content;
    }
    return modules;
  }

  /**
   * Import every tool module inside an isolated dynamic Worker and return
   * validated manifests. A single broken module fails the whole load — that
   * is deliberate: it is the signal for the auto-rollback path.
   */
  async #loadToolManifests(
    files: Record<string, string>,
    toolPaths: string[]
  ): Promise<HarnessToolManifest[]> {
    if (toolPaths.length === 0) return [];
    const executor = new DynamicWorkerExecutor({
      loader: this.#loader,
      timeout: TOOL_TIMEOUT_MS,
      modules: this.#toolModules(files)
    });
    const imports = toolPaths
      .map((path) => {
        const rel = path.slice(HARNESS_PREFIX.length);
        return `
  {
    const mod = await import(${JSON.stringify(`./${rel}`)});
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
    const snippet = `async () => {
  const manifests = [];
${imports}
  return manifests;
}`;
    const result = await executor.execute(snippet, []);
    if (result.error) {
      throw new Error(`harness tools failed to load: ${result.error}`);
    }
    const manifests = result.result as HarnessToolManifest[];
    const seen = new Set<string>();
    for (const manifest of manifests) {
      if (seen.has(manifest.name)) {
        throw new Error(`duplicate tool name "${manifest.name}"`);
      }
      seen.add(manifest.name);
    }
    return manifests;
  }

  /** Overwrite /harness with the given snapshot (deleting extra files). */
  async restoreFiles(snapshot: Record<string, string>): Promise<void> {
    const current = await this.workspace.glob("/harness/**");
    for (const entry of current) {
      if (entry.type !== "file") continue;
      if (!(entry.path in snapshot)) {
        await this.workspace.deleteFile(entry.path);
      }
    }
    for (const [path, content] of Object.entries(snapshot)) {
      await this.workspace.writeFile(path, content);
    }
  }

  /**
   * Validate the live harness, commit it to git, and record a new version.
   * Throws (with a useful message) if the live harness fails validation —
   * activation is the safety gate, so a broken self never becomes a version.
   */
  async activate(note: string): Promise<{ version: number; sha: string }> {
    const loaded = await this.#loadOnce();
    const git = this.git();
    await git.add({ filepath: "." });
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
    this.#onMutation();
    return { version: version.version, sha: oid };
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

  /** Execute one harness tool inside an isolated dynamic Worker. */
  async runHarnessTool(
    loaded: LoadedHarness,
    manifest: HarnessToolManifest,
    input: unknown
  ): Promise<unknown> {
    const executor = new DynamicWorkerExecutor({
      loader: this.#loader,
      timeout: TOOL_TIMEOUT_MS,
      modules: this.#toolModules(loaded.files)
    });
    const snippet = `async () => {
  const mod = await import(${JSON.stringify(`./${manifest.file}`)});
  const input = JSON.parse(${JSON.stringify(JSON.stringify(input ?? {}))});
  return await mod.default.run(input, { state, journal });
}`;
    const journalProvider: ResolvedProvider = {
      name: "journal",
      fns: {
        note: async (text: unknown) => {
          this.store.appendJournal("note", {
            text: String(text),
            source: `tool:${manifest.name}`
          });
          this.#onMutation();
          return { ok: true };
        }
      }
    };
    const result = await executor.execute(snippet, [
      resolveProvider(stateTools(this.workspace)),
      journalProvider
    ]);
    if (result.error) {
      return { error: result.error, logs: result.logs };
    }
    return result.logs && result.logs.length > 0
      ? { result: result.result, logs: result.logs }
      : { result: result.result };
  }

  /**
   * Build the full ToolSet for a turn: the fixed kernel bootstrap surface
   * plus one entry per live harness tool. Every execute is wrapped with
   * journaling.
   */
  buildTools(loaded: LoadedHarness): ToolSet {
    const tools: ToolSet = {
      read_file: tool({
        description:
          "Read a file from the workspace (including your own /harness source)",
        inputSchema: z.object({
          path: z.string().describe("Absolute path, e.g. /harness/identity.md")
        }),
        execute: this.#journaled("read_file", async ({ path }) => {
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
        execute: this.#journaled("write_file", async ({ path, content }) => {
          await this.workspace.writeFile(path, content);
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
        execute: this.#journaled("list_files", async ({ path }) => {
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
        execute: this.#journaled("delete_file", async ({ path }) => {
          const deleted = await this.workspace.deleteFile(path);
          this.store.appendJournal("file_delete", { path });
          this.#onMutation();
          return { path, deleted };
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
        execute: this.#journaled("activate_harness", async ({ note }) => {
          try {
            return await this.activate(note);
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
        execute: this.#journaled("rollback_harness", async ({ version }) => {
          try {
            return await this.rollbackTo(version);
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : String(error)
            };
          }
        })
      }),
      journal_note: tool({
        description:
          "Append a durable note to your journal for your future self",
        inputSchema: z.object({
          text: z.string().describe("The note to record")
        }),
        execute: this.#journaled("journal_note", async ({ text }) => {
          const id = this.store.appendJournal("note", {
            text,
            source: "agent"
          });
          this.#onMutation();
          return { ok: true, id };
        })
      }),
      read_journal: tool({
        description:
          "Read the most recent entries from your append-only journal",
        inputSchema: z.object({
          limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe("How many entries (default 20)")
        }),
        execute: this.#journaled("read_journal", async ({ limit }) => {
          return this.store.journalTail(limit ?? 20);
        })
      })
    };

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
        execute: this.#journaled(manifest.name, (input) =>
          this.runHarnessTool(loaded, manifest, input)
        )
      });
    }

    return tools;
  }

  /** Wrap a tool execute with tool_call / tool_result journaling. */
  #journaled<TInput, TOutput>(
    name: string,
    fn: (input: TInput) => Promise<TOutput>
  ): (input: TInput) => Promise<TOutput | { error: string }> {
    return async (input: TInput) => {
      this.store.appendJournal("tool_call", {
        tool: name,
        input: preview(input)
      });
      try {
        const result = await fn(input);
        const failed =
          typeof result === "object" &&
          result !== null &&
          "error" in result &&
          (result as { error?: unknown }).error !== undefined;
        this.store.appendJournal("tool_result", {
          tool: name,
          ok: !failed,
          output: preview(result)
        });
        this.#onMutation();
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.appendJournal("tool_result", {
          tool: name,
          ok: false,
          error: message
        });
        this.#onMutation();
        return { error: message };
      }
    };
  }
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
