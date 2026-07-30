import {
  Workspace as Computer,
  type WorkspaceClient,
  type WorkspaceOptions as ComputerOptions
} from "@cloudflare/computer";
import type { FileInfo } from "@cloudflare/shell";
import type { WorkspaceLike } from "../tools/workspace";
import {
  workspaceShellCapability,
  type WorkspaceShellExecutor
} from "../tools/workspace-capabilities";

export {
  getWorkspace,
  WorkspaceServiceProxy,
  withWorkspace
} from "@cloudflare/computer";
export { WorkerBackend } from "@cloudflare/computer/backends/worker";
export type {
  WorkerBackendOptions,
  WorkerShellFetcher
} from "@cloudflare/computer/backends/worker";
export type { ComputerOptions, WorkspaceClient };
export { Computer };

/**
 * A locally owned Computer with Think compatibility methods enabled.
 *
 * This is the actual Computer instance, not an adapter. Its native `fs`,
 * `shell`, `git`, `assets`, and other surfaces remain directly available.
 */
export type LocalComputerWorkspace = Computer & WorkspaceLike;

type ComputerStat = Awaited<ReturnType<Computer["fs"]["stat"]>>;

/*
 * Upstream compatibility gap
 * --------------------------
 *
 * `@cloudflare/computer` already contains the translations required by
 * Think's `WorkspaceLike`: ENOENT becomes `null`, byte streams are collected
 * into `Uint8Array`s, and Computer's stat/directory/find results become
 * Think `FileInfo`s. Those translations are inherently necessary, but should
 * have a single implementation in Computer.
 *
 * Today Computer only applies that implementation while constructing a local
 * `Workspace` with `useThink: true`. The implementation is private, and
 * `getWorkspace()` creates a separate remote `WorkspaceClient` containing
 * `fs`, `shell`, and the other native surfaces without the direct Think
 * methods. There is no public `withThinkCompatibility()` that can apply the
 * same implementation to that client. `WorkspaceClient.fs` is also currently
 * typed as `any`, so Think cannot consume its otherwise-compatible filesystem
 * surface without the assertion below.
 *
 * Consequently, `ComputerWorkspace`, `adaptComputer()`, and the conversion
 * helpers below duplicate Computer's Think translations solely for remote
 * clients. They can all be removed once Computer exposes a typed common
 * filesystem surface and applies (or lets callers apply) its Think
 * compatibility implementation to the value returned by `getWorkspace()`.
 *
 * Some Think-side integration remains necessary after that cleanup:
 * `createWorkspaceTools()` must select a workspace's native `shell` instead
 * of the legacy just-bash fallback, and `Think.__getWorkspaceStub()` must
 * expose a locally owned Computer to the Worker shell backend. In the ideal
 * user-facing interface, however, assigning a Computer constructed with
 * `useThink: true` is the only opt-in required.
 */

/**
 * Compatibility adapter for using `@cloudflare/computer` as a Think
 * workspace.
 *
 * The adapter keeps Think's existing direct filesystem interface for a remote
 * `WorkspaceClient`. The client remains available as `.computer`.
 *
 * This adapter uses the Computer's separate `vfs_*` SQLite tables. It does not
 * read or migrate files from Think's legacy `@cloudflare/shell` workspace.
 *
 * @experimental This adapter does not migrate Think's legacy workspace data.
 */
export class ComputerWorkspace implements WorkspaceLike {
  constructor(readonly computer: WorkspaceClient) {}

  get [workspaceShellCapability](): WorkspaceShellExecutor {
    return this.computer.shell;
  }

  private get fs(): Computer["fs"] {
    return this.computer.fs as Computer["fs"];
  }

  async readFile(path: string): Promise<string | null> {
    return missingAsNull(() => this.fs.readFile(path, "utf8"));
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    return missingAsNull(async () => {
      const stream = await this.fs.readFile(path);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    });
  }

  async writeFile(
    path: string,
    content: string,
    _mimeType?: string
  ): Promise<void> {
    await this.fs.writeFile(path, content);
  }

  async stat(path: string): Promise<FileInfo | null> {
    return missingAsNull(async () =>
      fileInfoFromStat(path, await this.fs.stat(path))
    );
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.fs.mkdir(path, options);
  }

  async readDir(
    path: string,
    options?: { limit?: number; offset?: number }
  ): Promise<FileInfo[]> {
    const entries = await this.fs.readdir(path);
    const offset = options?.offset ?? 0;
    const selected = entries.slice(
      offset,
      options?.limit === undefined ? undefined : offset + options.limit
    );
    return selected.map((entry) =>
      fallbackFileInfo(
        joinPath(entry.parentPath, entry.name),
        entry.name,
        entry.isDirectory ? "directory" : "file"
      )
    );
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    await this.fs.rm(path, options);
  }

  async glob(pattern: string): Promise<FileInfo[]> {
    const entries = await this.fs.find("/", pattern.replace(/^\/+/, ""));
    return entries.map((entry) =>
      fallbackFileInfo(
        normalizePath(entry.path),
        basename(entry.path),
        entry.type === "dir" ? "directory" : "file"
      )
    );
  }
}

/**
 * Create a Think-compatible workspace backed by a locally owned Computer.
 *
 * @experimental There is currently no data migration path from Think's
 * legacy workspace.
 */
export function createComputerWorkspace(
  options: ComputerOptions
): LocalComputerWorkspace {
  return new Computer({
    ...options,
    useThink: true
  }) as LocalComputerWorkspace;
}

/**
 * Adapt a remote Computer client to Think's existing workspace interface.
 */
export function adaptComputer(computer: WorkspaceClient): ComputerWorkspace {
  return new ComputerWorkspace(computer);
}

function fileInfoFromStat(path: string, stat: ComputerStat): FileInfo {
  const normalized = normalizePath(path);
  return {
    path: normalized,
    name: stat.name || basename(normalized),
    type: stat.isDirectory
      ? "directory"
      : stat.isSymbolicLink
        ? "symlink"
        : "file",
    mimeType: "application/octet-stream",
    size: stat.size,
    createdAt: stat.mtime,
    updatedAt: stat.mtime
  };
}

function isMissingEntry(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function missingAsNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (isMissingEntry(error)) return null;
    throw error;
  }
}

function fallbackFileInfo(
  path: string,
  name: string,
  type: FileInfo["type"]
): FileInfo {
  return {
    path,
    name,
    type,
    mimeType: "application/octet-stream",
    size: 0,
    createdAt: 0,
    updatedAt: 0
  };
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of (path.startsWith("/") ? path : `/${path}`).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function joinPath(parent: string, name: string): string {
  return normalizePath(`${parent === "/" ? "" : parent}/${name}`);
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  return normalized === "/"
    ? ""
    : normalized.slice(normalized.lastIndexOf("/") + 1);
}
