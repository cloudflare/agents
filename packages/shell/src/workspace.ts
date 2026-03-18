import type { Workspace } from "./filesystem";
import type { FileSystem, FileSystemDirent, FsStat } from "./fs/interface";
import { FileSystemStateBackend } from "./memory";

const MAX_SYMLINK_DEPTH = 40;

// ── WorkspaceFileSystem ───────────────────────────────────────────────
//
// Thin adapter that makes `Workspace` satisfy the `FileSystem` interface.
// Handles the two main API differences:
//   - Workspace.readFile / readFileBytes return null on missing;
//     FileSystem requires ENOENT to be thrown.
//   - Workspace.stat / lstat return Workspace-specific FileStat;
//     FileSystem.stat / lstat return FsStat = { type, size, mtime, mode? }.

export class WorkspaceFileSystem implements FileSystem {
  constructor(private readonly ws: Workspace) {}

  async readFile(path: string): Promise<string> {
    const content = await this.ws.readFile(path);
    if (content === null) {
      throw new Error(`ENOENT: no such file or directory: ${path}`);
    }
    return content;
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const bytes = await this.ws.readFileBytes(path);
    if (bytes === null) {
      throw new Error(`ENOENT: no such file or directory: ${path}`);
    }
    return bytes;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.ws.writeFile(path, content);
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    await this.ws.writeFileBytes(path, content);
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    if (typeof content === "string") {
      await this.ws.appendFile(path, content);
      return;
    }

    const existing = await this.ws.readFileBytes(path);
    if (existing === null) {
      await this.ws.writeFileBytes(path, content);
      return;
    }

    const combined = new Uint8Array(existing.byteLength + content.byteLength);
    combined.set(existing);
    combined.set(content, existing.byteLength);
    await this.ws.writeFileBytes(path, combined);
  }

  async exists(path: string): Promise<boolean> {
    return this.ws.exists(path);
  }

  async stat(path: string): Promise<FsStat> {
    const s = await this.ws.stat(path);
    if (!s) {
      throw new Error(`ENOENT: no such file or directory: ${path}`);
    }
    return fromWorkspaceStat(s);
  }

  async lstat(path: string): Promise<FsStat> {
    const s = await this.ws.lstat(path);
    if (!s) {
      throw new Error(`ENOENT: no such file or directory: ${path}`);
    }
    return fromWorkspaceStat(s);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.ws.mkdir(path, options);
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.ws.readDir(path)).map((e) => e.name);
  }

  async readdirWithFileTypes(path: string): Promise<FileSystemDirent[]> {
    return (await this.ws.readDir(path)).map((e) => ({
      name: e.name,
      type: e.type
    }));
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    await this.ws.rm(path, options);
  }

  async cp(
    src: string,
    dest: string,
    options?: { recursive?: boolean }
  ): Promise<void> {
    await this.ws.cp(src, dest, options);
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.ws.mv(src, dest);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.ws.symlink(target, linkPath);
  }

  async readlink(path: string): Promise<string> {
    return this.ws.readlink(path);
  }

  async realpath(path: string, _depth = 0): Promise<string> {
    if (_depth > MAX_SYMLINK_DEPTH) {
      throw new Error(`ELOOP: too many levels of symbolic links: ${path}`);
    }

    const stat = await this.ws.lstat(path);
    if (!stat) {
      throw new Error(`ENOENT: no such file or directory: ${path}`);
    }

    if (stat.type !== "symlink") {
      return normalizePath(path);
    }

    const target = await this.ws.readlink(path);
    const resolved = target.startsWith("/")
      ? normalizePath(target)
      : normalizePath(`${dirname(path)}/${target}`);
    return this.realpath(resolved, _depth + 1);
  }

  resolvePath(base: string, path: string): string {
    return normalizePath(path.startsWith("/") ? path : `${base}/${path}`);
  }

  async glob(pattern: string): Promise<string[]> {
    return (await this.ws.glob(pattern)).map((e) => e.path);
  }
}

// ── Factory ───────────────────────────────────────────────────────────

export function createWorkspaceStateBackend(
  workspace: Workspace
): FileSystemStateBackend {
  return new FileSystemStateBackend(new WorkspaceFileSystem(workspace));
}

/** @deprecated Use `FileSystemStateBackend` */
export const WorkspaceStateBackend = FileSystemStateBackend;

// ── Private helpers ───────────────────────────────────────────────────

function fromWorkspaceStat(stat: {
  type: string;
  size: number;
  updatedAt: number;
}): FsStat {
  return {
    type: stat.type as FsStat["type"],
    size: stat.size,
    mtime: new Date(stat.updatedAt)
  };
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) path = "/" + path;
  const parts = path.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return "/" + resolved.join("/");
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : normalized.slice(0, lastSlash);
}
