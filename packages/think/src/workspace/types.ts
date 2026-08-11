import type {
  FileInfo as LegacyFileInfo,
  WorkspaceFsLike
} from "@cloudflare/shell";
import type { ToolSet } from "ai";

export interface ThinkWorkspaceStat {
  name: string;
  inode: number;
  mode: number;
  size: number;
  mtime: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface ThinkWorkspaceDirent {
  name: string;
  parentPath: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface ThinkWorkspaceFoundEntry {
  path: string;
  type: "file" | "dir";
}

/** The Computer-shaped filesystem surface used by Think. */
export interface ThinkWorkspaceFilesystem {
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(
    path: string,
    options: { encoding?: "utf8" }
  ): Promise<string | ReadableStream<Uint8Array>>;
  stat(path: string): Promise<ThinkWorkspaceStat>;
  lstat(path: string): Promise<ThinkWorkspaceStat>;
  readlink(path: string): Promise<string>;
  readdir(
    path: string,
    options?: { limit?: number }
  ): Promise<ThinkWorkspaceDirent[]>;
  find(
    directory: string,
    pattern?: string
  ): Promise<ThinkWorkspaceFoundEntry[]>;
  writeFile(
    path: string,
    content: string | Uint8Array | ReadableStream<Uint8Array>,
    options?: { mode?: number; exclusive?: boolean }
  ): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
}

export interface ThinkWorkspaceRuntimeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  value?: unknown;
}

export type ThinkWorkspaceRuntimeEvent =
  | { name: "stdout"; value: string }
  | { name: "stderr"; value: string }
  | { name: "exit"; code: number; result?: unknown };

export interface ThinkWorkspaceRuntimeHandle extends Partial<
  AsyncIterable<ThinkWorkspaceRuntimeEvent>
> {
  result(): Promise<ThinkWorkspaceRuntimeResult>;
  kill?(): Promise<void>;
  [Symbol.dispose]?(): void;
}

export type ThinkWorkspaceRuntimeValue =
  | null
  | boolean
  | number
  | string
  | ThinkWorkspaceRuntimeValue[]
  | { [key: string]: ThinkWorkspaceRuntimeValue };

export interface ThinkWorkspaceRuntime {
  /** Whether a backend accepts structured input and returns a result value. */
  isCallable?(id: string): boolean;
  exec(
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
  ): Promise<ThinkWorkspaceRuntimeHandle>;
}

/** The native workspace surface used by Think. */
export interface ThinkWorkspace {
  readonly fs: ThinkWorkspaceFilesystem;
  readonly runtime: ThinkWorkspaceRuntime;
}

/**
 * Workspace values accepted at the public compatibility boundary.
 *
 * New implementations should provide `ThinkWorkspace`. The direct-method
 * shape keeps existing custom and shared workspaces source-compatible while
 * all Think internals operate on `workspace.fs`.
 */
export type WorkspaceLike = ThinkWorkspace | WorkspaceFsLike;

export const workspaceToolProvider: unique symbol = Symbol.for(
  "@cloudflare/think/workspace-tool-provider"
) as unknown as typeof workspaceToolProvider;

export const workspaceLegacyBashProvider: unique symbol = Symbol.for(
  "@cloudflare/think/workspace-legacy-bash-provider"
) as unknown as typeof workspaceLegacyBashProvider;

export interface LegacyWorkspaceBashOptions {
  timeout?: number;
  network?: boolean;
  maxWorkspaceFiles?: number;
  maxWorkspaceFileBytes?: number;
  maxOutputBytes?: number;
}

export interface WorkspaceToolProviderOptions {
  /** @deprecated Passed only to the legacy workspace. */
  legacyBash?: boolean | LegacyWorkspaceBashOptions;
}

/** Opt-in tools supplied by a configured workspace implementation. */
export interface WorkspaceToolProvider {
  [workspaceToolProvider](options?: WorkspaceToolProviderOptions): ToolSet;
}

export interface WorkspaceLegacyBashProvider {
  readonly [workspaceLegacyBashProvider]: true;
}

export function hasWorkspaceToolProvider(
  workspace: WorkspaceLike
): workspace is WorkspaceLike & WorkspaceToolProvider {
  const candidate = workspace as WorkspaceLike & Partial<WorkspaceToolProvider>;
  return typeof candidate[workspaceToolProvider] === "function";
}

export function hasWorkspaceLegacyBashProvider(
  workspace: WorkspaceLike
): workspace is WorkspaceLike & WorkspaceLegacyBashProvider {
  return (
    workspaceLegacyBashProvider in workspace &&
    workspace[workspaceLegacyBashProvider] === true
  );
}

export function isThinkWorkspace(
  workspace: WorkspaceLike
): workspace is ThinkWorkspace {
  return "fs" in workspace && "runtime" in workspace;
}

/** Resolve either workspace shape to the Computer-style filesystem surface. */
export function workspaceFilesystem(
  workspace: WorkspaceLike
): ThinkWorkspaceFilesystem {
  return isThinkWorkspace(workspace)
    ? workspace.fs
    : new LegacyWorkspaceFilesystem(workspace);
}

/** Adapt the previous direct-method workspace interface at the API boundary. */
export class LegacyWorkspaceFilesystem implements ThinkWorkspaceFilesystem {
  constructor(private readonly workspace: WorkspaceFsLike) {}

  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(
    path: string,
    options: { encoding?: "utf8" }
  ): Promise<string | ReadableStream<Uint8Array>>;
  async readFile(
    path: string,
    options?: "utf8" | { encoding?: "utf8" }
  ): Promise<string | ReadableStream<Uint8Array>> {
    if (options === "utf8" || options?.encoding === "utf8") {
      const content = await this.workspace.readFile(path);
      if (content === null) throw workspaceNotFound(path);
      return content;
    }
    const bytes = await this.workspace.readFileBytes(path);
    if (bytes === null) throw workspaceNotFound(path);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    });
  }

  async exists(path: string): Promise<boolean> {
    return this.workspace.exists(path);
  }

  async stat(path: string): Promise<ThinkWorkspaceStat> {
    const stat = await this.workspace.stat(path);
    if (stat === null) throw workspaceNotFound(path);
    return legacyStat(stat);
  }

  async lstat(path: string): Promise<ThinkWorkspaceStat> {
    const stat = await this.workspace.lstat(path);
    if (stat === null) throw workspaceNotFound(path);
    return legacyStat(stat);
  }

  async readlink(path: string): Promise<string> {
    const target = await this.workspace.readlink(path);
    if (target === null) throw workspaceNotFound(path);
    return target;
  }

  async readdir(
    path: string,
    options: { limit?: number } = {}
  ): Promise<ThinkWorkspaceDirent[]> {
    const entries = await this.workspace.readDir(path, {
      limit: options.limit
    });
    return entries.map((entry) => ({
      name: entry.name,
      parentPath: path,
      isFile: entry.type === "file",
      isDirectory: entry.type === "directory",
      isSymbolicLink: entry.type === "symlink"
    }));
  }

  async find(
    directory: string,
    pattern?: string
  ): Promise<ThinkWorkspaceFoundEntry[]> {
    const glob = joinPattern(directory, pattern ?? "**/*");
    return (await this.workspace.glob(glob)).map((entry) => ({
      path: entry.path,
      type: entry.type === "directory" ? "dir" : "file"
    }));
  }

  async writeFile(
    path: string,
    content: string | Uint8Array | ReadableStream<Uint8Array>
  ): Promise<void> {
    if (typeof content === "string") {
      await this.workspace.writeFile(path, content);
      return;
    }
    const bytes =
      content instanceof Uint8Array ? content : await drainStream(content);
    await this.workspace.writeFileBytes(path, bytes);
  }

  async mkdir(
    path: string,
    options: { recursive?: boolean } = {}
  ): Promise<void> {
    await this.workspace.mkdir(path, options);
  }

  async rm(
    path: string,
    options: { recursive?: boolean; force?: boolean } = {}
  ): Promise<void> {
    await this.workspace.rm(path, options);
  }

  async symlink(target: string, path: string): Promise<void> {
    await this.workspace.symlink(target, path);
  }
}

export function normalizeWorkspacePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export async function writeWorkspaceFile(
  workspace: WorkspaceLike,
  path: string,
  data: string | Uint8Array
): Promise<void> {
  const fs = workspaceFilesystem(workspace);
  const normalizedPath = normalizeWorkspacePath(path);
  const lastSlash = normalizedPath.lastIndexOf("/");
  const parent = normalizedPath.slice(0, lastSlash) || "/";
  if (parent !== "/") {
    await fs.mkdir(parent, { recursive: true });
  }
  await fs.writeFile(normalizedPath, data);
}

export async function readWorkspaceText(
  workspace: WorkspaceLike,
  path: string
): Promise<string | null> {
  try {
    return await workspaceFilesystem(workspace).readFile(
      normalizeWorkspacePath(path),
      "utf8"
    );
  } catch (error) {
    if (isWorkspaceNotFoundError(error)) return null;
    throw error;
  }
}

export function isWorkspaceNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "ENOENT" ||
    (typeof candidate.message === "string" &&
      /ENOENT|no such/i.test(candidate.message))
  );
}

function legacyStat(stat: LegacyFileInfo): ThinkWorkspaceStat {
  return {
    name: stat.name,
    inode: 0,
    mode:
      stat.type === "directory"
        ? 0o040755
        : stat.type === "symlink"
          ? 0o120777
          : 0o100644,
    mtime: stat.updatedAt,
    size: stat.size,
    isFile: stat.type === "file",
    isDirectory: stat.type === "directory",
    isSymbolicLink: stat.type === "symlink"
  };
}

function joinPattern(directory: string, pattern: string): string {
  const base = directory === "/" ? "" : directory.replace(/\/$/, "");
  return `${base}/${pattern.replace(/^\//, "")}`;
}

async function drainStream(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function workspaceNotFound(path: string): Error & { code: "ENOENT" } {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, ${path}`),
    {
      code: "ENOENT" as const
    }
  );
}
