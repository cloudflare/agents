import {
  Workspace as ShellWorkspace,
  type WorkspaceFsLike,
  type WorkspaceOptions as ShellWorkspaceOptions
} from "@cloudflare/shell";
import type { InitialFiles } from "just-bash";
import { Bash } from "just-bash";
import type { Tool, ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import type { FileInfo } from "./tools/workspace";
import {
  LegacyWorkspaceFilesystem,
  workspaceLegacyBashProvider,
  workspaceToolProvider,
  type ThinkWorkspace,
  type ThinkWorkspaceRuntime,
  type ThinkWorkspaceRuntimeValue,
  type WorkspaceLegacyBashProvider,
  type WorkspaceToolProvider,
  type WorkspaceToolProviderOptions
} from "./workspace-contract";

export type WorkspaceOptions = ShellWorkspaceOptions;

/**
 * Compatibility workspace for existing Think agents.
 *
 * This keeps the original @cloudflare/shell SQLite/R2 storage and snapshot
 * Bash behavior while exposing the Computer-shaped `fs` and `runtime` fields.
 */
export class LegacyWorkspace
  extends ShellWorkspace
  implements ThinkWorkspace, WorkspaceToolProvider, WorkspaceLegacyBashProvider
{
  readonly [workspaceLegacyBashProvider] = true;
  readonly fs = new LegacyWorkspaceFilesystem(this);
  readonly runtime: ThinkWorkspaceRuntime = new LegacyShellRuntime(this);

  [workspaceToolProvider](options?: WorkspaceToolProviderOptions): ToolSet {
    if (options?.legacyBash === false) return {};
    const bashOptions = isLegacyBashOptions(options?.legacyBash)
      ? options.legacyBash
      : {};
    return {
      bash: createBashTool({
        ...bashOptions,
        ops: legacyBashOperations(this)
      })
    };
  }
}

export { LegacyWorkspace as Workspace };

export class LegacyShellRuntime implements ThinkWorkspaceRuntime {
  constructor(private readonly workspace: WorkspaceFsLike) {}

  async exec(
    source: string,
    options?: {
      cwd?: string;
      encoding?: "utf8";
      backend?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      input?: ThinkWorkspaceRuntimeValue;
      stdin?: Uint8Array | string;
    }
  ) {
    if (options?.backend !== undefined) {
      throw new Error("LegacyShellWorkspace does not support named backends");
    }
    if (options?.input !== undefined || options?.stdin !== undefined) {
      throw new Error(
        "LegacyShellWorkspace does not support structured input or stdin"
      );
    }
    const result = executeLegacyBash(
      {
        ops: legacyBashOperations(this.workspace),
        timeout: options?.timeoutMs
      },
      { script: source, cwd: options?.cwd }
    );
    return {
      async result() {
        return result;
      }
    };
  }
}

function legacyBashOperations(workspace: WorkspaceFsLike): BashOperations {
  return {
    readDir: (dir, opts) => workspace.readDir(dir, opts),
    readFileBytes: (path) => workspace.readFileBytes(path),
    writeFile: (path, content) => workspace.writeFile(path, content),
    writeFileBytes: (path, content) => workspace.writeFileBytes(path, content),
    mkdir: (path, opts) => workspace.mkdir(path, opts),
    rm: (path, opts) => workspace.rm(path, opts)
  };
}

export interface BashOperations {
  readDir(
    dir: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<FileInfo[]> | FileInfo[];
  readFileBytes(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, content: string): Promise<void>;
  writeFileBytes?: (path: string, content: Uint8Array) => Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> | void;
  rm(
    path: string,
    opts?: { recursive?: boolean; force?: boolean }
  ): Promise<void>;
}

function isLegacyBashOptions(
  value: unknown
): value is Omit<BashToolOptions, "ops"> {
  return value !== null && typeof value === "object";
}

// ── Bash ─────────────────────────────────────────────────────────────

const DEFAULT_BASH_TIMEOUT_MS = 30_000;
const DEFAULT_BASH_MAX_WORKSPACE_FILES = 1_000;
const DEFAULT_BASH_MAX_WORKSPACE_FILE_BYTES = 1_000_000;
const DEFAULT_BASH_MAX_OUTPUT_BYTES = 64_000;
const BASH_READDIR_PAGE_SIZE = 1_000;
// Synthetic paths the bash sandbox creates for itself (shell builtins under
// /bin and /usr/bin, pseudo-filesystems, scratch space). New files here must
// never be persisted to the workspace — only pre-existing workspace files
// under these roots keep syncing.
const BASH_EXCLUDED_SYNC_ROOTS = ["/bin", "/usr", "/dev", "/proc", "/sys"];

type BashToolInput = {
  script: string;
  cwd?: string;
};

type BashChangedFiles = {
  created: string[];
  updated: string[];
  deleted: string[];
  directoriesCreated: string[];
  directoriesDeleted: string[];
};

export interface BashToolOptions {
  ops: BashOperations;
  timeout?: number;
  network?: boolean;
  maxWorkspaceFiles?: number;
  maxWorkspaceFileBytes?: number;
  maxOutputBytes?: number;
}

export function createBashTool(options: BashToolOptions): Tool {
  return tool({
    description:
      "Run a Bash script against the workspace. Use for shell-style workflows " +
      "that combine multiple file operations. The script runs in a sandboxed " +
      "virtual filesystem with the workspace mounted at `/` (also the default " +
      "working directory) — there is no `/workspace` or `/home`; use absolute " +
      "paths like `/notes.txt`. Changed files are written back to the workspace.",
    inputSchema: z.object({
      script: z.string().describe("Bash script to run"),
      cwd: z
        .string()
        .optional()
        .describe(
          "Working directory for the script. Defaults to / (the workspace root)"
        )
    }),
    execute: (input: BashToolInput) => executeLegacyBash(options, input)
  });
}

export async function executeLegacyBash(
  options: BashToolOptions,
  { script, cwd }: BashToolInput
) {
  const timeout = options.timeout ?? DEFAULT_BASH_TIMEOUT_MS;
  const maxOutputBytes =
    options.maxOutputBytes ?? DEFAULT_BASH_MAX_OUTPUT_BYTES;
  const snapshot = await snapshotWorkspaceForBash(options);
  const bash = new Bash({
    files: snapshot.files,
    cwd: normalizeWorkspacePath(cwd ?? "/"),
    defenseInDepth: true,
    network: options.network ? {} : undefined
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let result:
    | {
        stdout: string;
        stderr: string;
        exitCode: number;
      }
    | undefined;
  try {
    for (const directory of snapshot.directories) {
      await bash.fs.mkdir(directory, { recursive: true }).catch(() => {});
    }

    try {
      result = await bash.exec(script, {
        cwd: normalizeWorkspacePath(cwd ?? "/"),
        signal: controller.signal,
        rawScript: true
      });
    } catch (error) {
      result = {
        stdout: "",
        stderr: errorMessage(error),
        exitCode: controller.signal.aborted ? 124 : 1
      };
    }

    const sync = await syncBashFilesToWorkspace({
      ops: options.ops,
      bash,
      initialFiles: snapshot.initialFiles,
      initialDirectories: snapshot.initialDirectories,
      protectedPaths: snapshot.protectedPaths
    });

    return {
      stdout: truncateToolOutput(result.stdout, maxOutputBytes),
      stderr: truncateToolOutput(result.stderr, maxOutputBytes),
      exitCode: result.exitCode,
      changedFiles: sync.changedFiles,
      ...(snapshot.skippedFiles.length > 0
        ? { skippedFiles: snapshot.skippedFiles }
        : {}),
      ...(sync.errors.length > 0 ? { errors: sync.errors } : {})
    };
  } finally {
    clearTimeout(timer);
  }
}

async function snapshotWorkspaceForBash(options: BashToolOptions): Promise<{
  files: InitialFiles;
  initialFiles: Map<string, Uint8Array>;
  initialDirectories: Set<string>;
  protectedPaths: Set<string>;
  directories: string[];
  skippedFiles: string[];
}> {
  const maxFiles =
    options.maxWorkspaceFiles ?? DEFAULT_BASH_MAX_WORKSPACE_FILES;
  const maxFileBytes =
    options.maxWorkspaceFileBytes ?? DEFAULT_BASH_MAX_WORKSPACE_FILE_BYTES;
  const files: InitialFiles = {};
  const initialFiles = new Map<string, Uint8Array>();
  const initialDirectories = new Set<string>(["/"]);
  const protectedPaths = new Set<string>();
  const skippedFiles: string[] = [];
  const pending = ["/"];

  while (pending.length > 0) {
    const dir = pending.shift()!;
    const entries = await readAllBashDirEntries(options.ops, dir);
    for (const entry of entries) {
      const path = normalizeWorkspacePath(entry.path);
      if (entry.type === "directory") {
        initialDirectories.add(path);
        pending.push(path);
        continue;
      }
      if (entry.type !== "file") continue;
      if (initialFiles.size >= maxFiles || entry.size > maxFileBytes) {
        protectedPaths.add(path);
        skippedFiles.push(path);
        continue;
      }
      const bytes = await options.ops.readFileBytes(path);
      if (bytes === null) {
        protectedPaths.add(path);
        skippedFiles.push(path);
        continue;
      }
      files[path] = bytes;
      initialFiles.set(path, bytes);
    }
  }

  return {
    files,
    initialFiles,
    initialDirectories,
    protectedPaths,
    directories: [...initialDirectories].sort((a, b) => a.localeCompare(b)),
    skippedFiles
  };
}

async function readAllBashDirEntries(
  ops: BashOperations,
  dir: string
): Promise<FileInfo[]> {
  const entries: FileInfo[] = [];
  let offset = 0;

  while (true) {
    const page = await ops.readDir(dir, {
      limit: BASH_READDIR_PAGE_SIZE,
      offset
    });
    entries.push(...page);
    if (page.length !== BASH_READDIR_PAGE_SIZE) break;
    offset += page.length;
  }

  return entries;
}

async function syncBashFilesToWorkspace({
  ops,
  bash,
  initialFiles,
  initialDirectories,
  protectedPaths
}: {
  ops: BashOperations;
  bash: {
    fs: {
      getAllPaths(): string[];
      stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }>;
      readFileBuffer(path: string): Promise<Uint8Array>;
    };
  };
  initialFiles: Map<string, Uint8Array>;
  initialDirectories: Set<string>;
  protectedPaths: Set<string>;
}): Promise<{ changedFiles: BashChangedFiles; errors: string[] }> {
  const changedFiles: BashChangedFiles = {
    created: [],
    updated: [],
    deleted: [],
    directoriesCreated: [],
    directoriesDeleted: []
  };
  const errors: string[] = [];
  const finalFiles = new Map<string, Uint8Array>();
  const finalDirectories = new Set<string>(["/"]);

  for (const rawPath of bash.fs.getAllPaths()) {
    const path = normalizeWorkspacePath(rawPath);
    if (!shouldSyncBashPath(path, initialFiles, protectedPaths)) continue;
    const stat = await bash.fs.stat(path).catch(() => null);
    if (stat?.isDirectory) {
      finalDirectories.add(path);
      continue;
    }
    if (stat?.isFile) {
      finalFiles.set(path, await bash.fs.readFileBuffer(path));
    }
  }

  for (const path of [...finalDirectories].sort((a, b) => a.localeCompare(b))) {
    if (path === "/" || initialDirectories.has(path)) continue;
    if (hasProtectedDescendant(path, protectedPaths)) {
      errors.push(
        `Skipped creating directory ${path}: contains protected paths.`
      );
      continue;
    }
    const created = await Promise.resolve(ops.mkdir(path, { recursive: true }))
      .then(() => true)
      .catch((error: unknown) => {
        errors.push(
          `Failed to create directory ${path}: ${errorMessage(error)}`
        );
        return false;
      });
    if (!created) continue;
    changedFiles.directoriesCreated.push(path);
  }

  for (const [path, bytes] of finalFiles) {
    if (protectedPaths.has(path)) {
      errors.push(`Skipped writing protected workspace file: ${path}`);
      continue;
    }
    const existing = initialFiles.get(path);
    if (existing && bytesEqual(existing, bytes)) continue;
    const written = await writeWorkspaceBytes(ops, path, bytes, errors);
    if (!written) continue;
    if (existing) changedFiles.updated.push(path);
    else changedFiles.created.push(path);
  }

  for (const path of [...initialFiles.keys()].sort((a, b) =>
    b.localeCompare(a)
  )) {
    if (finalFiles.has(path) || protectedPaths.has(path)) continue;
    const deleted = await ops
      .rm(path, { force: true })
      .then(() => true)
      .catch((error: unknown) => {
        errors.push(`Failed to delete ${path}: ${errorMessage(error)}`);
        return false;
      });
    if (!deleted) continue;
    changedFiles.deleted.push(path);
  }

  for (const path of [...initialDirectories].sort((a, b) =>
    b.localeCompare(a)
  )) {
    if (path === "/" || finalDirectories.has(path)) continue;
    if (hasProtectedDescendant(path, protectedPaths)) {
      errors.push(`Skipped deleting protected workspace directory: ${path}`);
      continue;
    }
    const deleted = await ops
      .rm(path, { recursive: true, force: true })
      .then(() => true)
      .catch((error: unknown) => {
        errors.push(
          `Failed to delete directory ${path}: ${errorMessage(error)}`
        );
        return false;
      });
    if (!deleted) continue;
    changedFiles.directoriesDeleted.push(path);
  }

  changedFiles.created.sort();
  changedFiles.updated.sort();
  changedFiles.deleted.sort();
  changedFiles.directoriesCreated.sort();
  changedFiles.directoriesDeleted.sort();

  return { changedFiles, errors };
}

async function writeWorkspaceBytes(
  ops: BashOperations,
  path: string,
  bytes: Uint8Array,
  errors: string[]
): Promise<boolean> {
  const parent = parentDir(path);
  if (parent !== "/") {
    const parentCreated = await Promise.resolve(
      ops.mkdir(parent, { recursive: true })
    )
      .then(() => true)
      .catch((error: unknown) => {
        errors.push(
          `Failed to create parent directory ${parent}: ${errorMessage(error)}`
        );
        return false;
      });
    if (!parentCreated) return false;
  }

  if (ops.writeFileBytes) {
    return ops
      .writeFileBytes(path, bytes)
      .then(() => true)
      .catch((error: unknown) => {
        errors.push(`Failed to write ${path}: ${errorMessage(error)}`);
        return false;
      });
  }

  if (!looksLikeText(bytes)) {
    errors.push(
      `Could not persist binary file ${path}: workspace does not support writeFileBytes.`
    );
    return false;
  }

  const content = new TextDecoder().decode(bytes);
  return ops
    .writeFile(path, content)
    .then(() => true)
    .catch((error: unknown) => {
      errors.push(`Failed to write ${path}: ${errorMessage(error)}`);
      return false;
    });
}

function shouldSyncBashPath(
  path: string,
  initialFiles: Map<string, Uint8Array>,
  protectedPaths: Set<string>
): boolean {
  if (path === "/") return false;
  if (initialFiles.has(path)) return true;
  if (protectedPaths.has(path)) return true;
  if (path === "/tmp" || path.startsWith("/tmp/")) return false;
  return !BASH_EXCLUDED_SYNC_ROOTS.some(
    (root) => path === root || path.startsWith(`${root}/`)
  );
}

function hasProtectedDescendant(
  path: string,
  protectedPaths: Set<string>
): boolean {
  const prefix = path.endsWith("/") ? path : `${path}/`;
  for (const protectedPath of protectedPaths) {
    if (protectedPath.startsWith(prefix)) return true;
  }
  return false;
}

function normalizeWorkspacePath(path: string): string {
  const parts: string[] = [];
  const raw = path.startsWith("/") ? path : `/${path}`;
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function parentDir(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function truncateToolOutput(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  const truncated = new TextDecoder().decode(bytes.slice(0, maxBytes));
  return `${truncated}\n... (${formatSize(bytes.byteLength - maxBytes)} truncated)`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  if (bytes.includes(0)) return false;

  const text = new TextDecoder().decode(bytes.subarray(0, 4096));
  if (text.length === 0) return true;

  let replacementChars = 0;
  for (const char of text) {
    if (char === "\uFFFD") replacementChars++;
  }
  return replacementChars / text.length < 0.01;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
