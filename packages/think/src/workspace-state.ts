import {
  createWorkspaceStateBackend as createLegacyStateBackend,
  type FileInfo,
  type StateBackend,
  type WorkspaceFsLike
} from "@cloudflare/shell";
import { StateConnector } from "@cloudflare/shell/workers";
import {
  isWorkspaceNotFoundError,
  normalizeWorkspacePath,
  workspaceFilesystem,
  type ThinkWorkspaceFilesystem,
  type WorkspaceLike
} from "./workspace-contract";

/** Build the existing codemode `state.*` backend over a Computer-style fs. */
export function createWorkspaceStateBackend(
  workspace: WorkspaceLike
): StateBackend {
  return createLegacyStateBackend(
    new WorkspaceStateFilesystem(workspaceFilesystem(workspace))
  );
}

/** Expose the existing codemode `state.*` interface for any Think workspace. */
export function createWorkspaceStateConnectors(
  workspace: WorkspaceLike,
  ctx: DurableObjectState | ExecutionContext
): StateConnector[] {
  return [new StateConnector(ctx, createWorkspaceStateBackend(workspace))];
}

/**
 * Adapt the Computer filesystem surface to the direct-method interface used by
 * the existing state backend. This adapter is private to the codemode boundary;
 * the rest of Think continues to use `workspace.fs`.
 */
class WorkspaceStateFilesystem implements WorkspaceFsLike {
  constructor(private readonly fs: ThinkWorkspaceFilesystem) {}

  async readFile(path: string): Promise<string | null> {
    try {
      return await this.fs.readFile(normalizeWorkspacePath(path), "utf8");
    } catch (error) {
      if (isWorkspaceNotFoundError(error)) return null;
      throw error;
    }
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    try {
      const stream = await this.fs.readFile(normalizeWorkspacePath(path));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) {
      if (isWorkspaceNotFoundError(error)) return null;
      throw error;
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.writeFileBytes(path, new TextEncoder().encode(content));
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    await this.ensureParent(normalized);
    await this.fs.writeFile(normalized, content);
  }

  async appendFile(path: string, content: string): Promise<void> {
    const previous = (await this.readFile(path)) ?? "";
    await this.writeFile(path, previous + content);
  }

  async exists(path: string): Promise<boolean> {
    return this.fs.exists(normalizeWorkspacePath(path));
  }

  async stat(path: string): Promise<FileInfo | null> {
    return this.fileInfo(path, false);
  }

  async lstat(path: string): Promise<FileInfo | null> {
    return this.fileInfo(path, true);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.fs.mkdir(normalizeWorkspacePath(path), options);
  }

  async readDir(
    path: string,
    options?: { limit?: number; offset?: number }
  ): Promise<FileInfo[]> {
    const normalized = normalizeWorkspacePath(path);
    const offset = options?.offset ?? 0;
    const entries = await this.fs.readdir(normalized, {
      limit: options?.limit === undefined ? undefined : offset + options.limit
    });
    const selected = entries.slice(
      offset,
      options?.limit === undefined ? undefined : offset + options.limit
    );
    return Promise.all(
      selected.map((entry) =>
        this.fileInfoOrThrow(joinPath(normalized, entry.name), entry.name)
      )
    );
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    await this.fs.rm(normalizeWorkspacePath(path), options);
  }

  async cp(
    source: string,
    destination: string,
    options?: { recursive?: boolean }
  ): Promise<void> {
    const src = normalizeWorkspacePath(source);
    const dest = normalizeWorkspacePath(destination);
    const stat = await this.fs.lstat(src);
    if (stat.isDirectory) {
      if (!options?.recursive) {
        throw new Error(`Cannot copy directory without recursive: ${source}`);
      }
      await this.fs.mkdir(dest, { recursive: true });
      for (const entry of await this.fs.readdir(src)) {
        await this.cp(joinPath(src, entry.name), joinPath(dest, entry.name), {
          recursive: true
        });
      }
      return;
    }
    if (stat.isSymbolicLink) {
      await this.ensureParent(dest);
      await this.fs.symlink(await this.fs.readlink(src), dest);
      return;
    }
    await this.ensureParent(dest);
    await this.fs.writeFile(dest, await this.fs.readFile(src));
  }

  async mv(source: string, destination: string): Promise<void> {
    const src = normalizeWorkspacePath(source);
    await this.cp(src, destination, { recursive: true });
    await this.fs.rm(src, { recursive: true });
  }

  async symlink(target: string, path: string): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    await this.ensureParent(normalized);
    await this.fs.symlink(target, normalized);
  }

  async readlink(path: string): Promise<string> {
    return this.fs.readlink(normalizeWorkspacePath(path));
  }

  async glob(pattern: string): Promise<FileInfo[]> {
    const { directory, relativePattern } = splitGlobPattern(pattern);
    const entries = await this.fs.find(directory, relativePattern);
    return Promise.all(
      entries.map((entry) => this.fileInfoOrThrow(entry.path))
    );
  }

  private async fileInfo(
    path: string,
    useLstat: boolean
  ): Promise<FileInfo | null> {
    try {
      return await this.fileInfoOrThrow(path, undefined, useLstat);
    } catch (error) {
      if (isWorkspaceNotFoundError(error)) return null;
      throw error;
    }
  }

  private async fileInfoOrThrow(
    path: string,
    name?: string,
    useLstat = false
  ): Promise<FileInfo> {
    const normalized = normalizeWorkspacePath(path);
    const stat = useLstat
      ? await this.fs.lstat(normalized)
      : await this.fs.stat(normalized);
    const type = stat.isDirectory
      ? "directory"
      : stat.isSymbolicLink
        ? "symlink"
        : "file";
    return {
      path: normalized,
      name: name ?? basename(normalized),
      type,
      mimeType: "application/octet-stream",
      size: stat.size,
      createdAt: stat.mtime,
      updatedAt: stat.mtime,
      ...(type === "symlink"
        ? { target: await this.fs.readlink(normalized) }
        : {})
    };
  }

  private async ensureParent(path: string): Promise<void> {
    const parent = dirname(path);
    if (parent !== "/") {
      await this.fs.mkdir(parent, { recursive: true });
    }
  }
}

function splitGlobPattern(pattern: string): {
  directory: string;
  relativePattern: string;
} {
  const normalized = normalizeWorkspacePath(pattern);
  const wildcard = normalized.search(/[!*?[\]{}]/);
  if (wildcard === -1) {
    return {
      directory: dirname(normalized),
      relativePattern: basename(normalized)
    };
  }
  const slash = normalized.lastIndexOf("/", wildcard);
  return {
    directory: slash <= 0 ? "/" : normalized.slice(0, slash),
    relativePattern: normalized.slice(slash + 1)
  };
}

function joinPath(parent: string, child: string): string {
  return parent === "/" ? `/${child}` : `${parent.replace(/\/$/, "")}/${child}`;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
