import type { Workspace } from "@cloudflare/computer";
import type { CreateAIToolsOptions } from "@cloudflare/computer/tools/ai-sdk";

/**
 * The filesystem methods Think uses, from `@cloudflare/computer`'s
 * `workspace.fs`.
 */
export type ThinkWorkspaceFilesystem = Pick<
  Workspace["fs"],
  | "readFile"
  | "writeFile"
  | "mkdir"
  | "rm"
  | "stat"
  | "readdir"
  | "find"
  | "grep"
>;

/** The parts of a Workspace the `@cloudflare/computer` tools use besides `fs`. */
type ToolsWorkspace = CreateAIToolsOptions["workspace"];

/**
 * The Workspace a Think agent works in.
 *
 * A `Workspace` from `@cloudflare/computer` satisfies this, and so does the
 * client `getWorkspace(stub)` returns for a Workspace owned by another
 * Durable Object. Think reads and writes through `workspace.fs`. The
 * `@cloudflare/computer` tools also use `runtime` for `exec` and `assets`
 * for `publish` when the Workspace has them.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type ThinkWorkspace = {
  /** The Workspace filesystem. */
  readonly fs: ThinkWorkspaceFilesystem;
} & Partial<Pick<ToolsWorkspace, "runtime" | "sessionId" | "assets">>;

/** One file, directory, or symlink in a Workspace. */
export type WorkspaceEntry = {
  /** Absolute path. */
  readonly path: string;
  /** Last path segment. */
  readonly name: string;
  /** Entry kind. */
  readonly type: "file" | "directory" | "symlink";
  /** Size in bytes. `0` for directories. */
  readonly size: number;
  /** Last modification time in milliseconds since the epoch. */
  readonly updatedAt: number;
};

/** Directory Computer's backends and tools treat as the working root. */
export const WORKSPACE_ROOT = "/workspace";

/**
 * Resolve a path against {@link WORKSPACE_ROOT}. Absolute paths pass
 * through; relative ones, such as an extension's `notes/today.md`, land
 * under `/workspace`.
 *
 * @param path - Absolute or root-relative path.
 * @returns An absolute path.
 */
export function resolveWorkspacePath(path: string): string {
  if (path.startsWith("/")) return path;
  const relative = path.replace(/^\.\//, "");
  return relative === "" || relative === "."
    ? WORKSPACE_ROOT
    : `${WORKSPACE_ROOT}/${relative}`;
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * Think's file operations over a {@link ThinkWorkspace}.
 *
 * Translates the Workspace's node-style filesystem into the shape Think's
 * internals use: missing files read as `null` instead of rejecting with
 * `ENOENT`, writes create their parent directories, and listings return
 * {@link WorkspaceEntry} values.
 *
 * @internal
 */
export class WorkspaceFiles {
  readonly #fs: ThinkWorkspaceFilesystem;

  /**
   * @param workspace - The Workspace to operate on.
   */
  constructor(workspace: ThinkWorkspace) {
    this.#fs = workspace.fs;
  }

  /**
   * Read a file as UTF-8 text.
   *
   * @param path - Absolute file path.
   * @returns The text, or `null` when the file does not exist.
   */
  async readText(path: string): Promise<string | null> {
    const bytes = await this.readBytes(path);
    return bytes === null ? null : TEXT_DECODER.decode(bytes);
  }

  /**
   * Read a file's bytes.
   *
   * @param path - Absolute file path.
   * @returns The bytes, or `null` when the file does not exist.
   */
  async readBytes(path: string): Promise<Uint8Array | null> {
    try {
      return await drain(await this.#fs.readFile(path));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * Write a file, creating missing parent directories.
   *
   * @param path - Absolute file path.
   * @param content - Text, written as UTF-8, or bytes.
   */
  async write(path: string, content: string | Uint8Array): Promise<void> {
    const parent = parentDirectory(path);
    if (parent !== "/") await this.#fs.mkdir(parent, { recursive: true });
    await this.#fs.writeFile(
      path,
      typeof content === "string" ? TEXT_ENCODER.encode(content) : content
    );
  }

  /**
   * Remove a file or directory.
   *
   * @param path - Absolute path.
   * @param options - `recursive` removes a non-empty directory; `force`
   *   accepts a missing path.
   */
  async remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    await this.#fs.rm(path, options);
  }

  /**
   * List a directory's entries in name order.
   *
   * @param path - Absolute directory path.
   * @param options - Page size and start.
   * @returns The entries on the requested page.
   */
  async list(
    path: string,
    options?: { limit?: number; offset?: number }
  ): Promise<WorkspaceEntry[]> {
    const entries = await this.#fs.readdir(path, options);
    return entries.map((entry) => ({
      path: joinPath(path, entry.name),
      name: entry.name,
      type: entry.isDirectory
        ? "directory"
        : entry.isSymbolicLink
          ? "symlink"
          : "file",
      size: entry.size,
      updatedAt: entry.mtime
    }));
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const part of stream) {
    parts.push(part);
    total += part.byteLength;
  }
  if (parts.length === 1 && parts[0]) return parts[0];
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function parentDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function joinPath(directory: string, name: string): string {
  return directory.endsWith("/")
    ? `${directory}${name}`
    : `${directory}/${name}`;
}
