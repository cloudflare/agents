import type {
  WorkspaceRuntimeFilesystem,
  WorkspaceRuntimeStat
} from "../runtime/types";

type Entry =
  | {
      type: "file";
      data: Uint8Array;
      mode: number;
      mtime: number;
      inode: number;
    }
  | { type: "dir"; mode: number; mtime: number; inode: number };

function fsError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

/**
 * A small in-memory filesystem for tests: files and directories only, no
 * symbolic links or search.
 */
export class MemoryFilesystem implements WorkspaceRuntimeFilesystem {
  readonly #entries = new Map<string, Entry>([
    ["/", { type: "dir", mode: 0o755, mtime: Date.now(), inode: 1 }]
  ]);
  #nextInode = 2;

  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  async readFile(
    path: string,
    encoding?: "utf8"
  ): Promise<ReadableStream<Uint8Array> | string> {
    const entry = this.#entries.get(path);
    if (!entry) throw fsError("ENOENT", path);
    if (entry.type !== "file") throw fsError("EISDIR", path);
    if (encoding === "utf8") return new TextDecoder().decode(entry.data);
    const data = entry.data;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      }
    });
  }

  async stat(path: string): Promise<WorkspaceRuntimeStat> {
    const entry = this.#entries.get(path);
    if (!entry) throw fsError("ENOENT", path);
    return {
      name: path.slice(path.lastIndexOf("/") + 1),
      inode: entry.inode,
      mode: entry.mode,
      mtime: entry.mtime,
      size: entry.type === "file" ? entry.data.byteLength : 0,
      isFile: entry.type === "file",
      isDirectory: entry.type === "dir",
      isSymbolicLink: false
    };
  }

  lstat(path: string): Promise<WorkspaceRuntimeStat> {
    return this.stat(path);
  }

  async readlink(path: string): Promise<string> {
    throw fsError("EINVAL", path);
  }

  async readdir(path: string, options?: { limit?: number }) {
    const entry = this.#entries.get(path);
    if (!entry) throw fsError("ENOENT", path);
    if (entry.type !== "dir") throw fsError("ENOTDIR", path);
    const prefix = path === "/" ? "/" : `${path}/`;
    const children = [...this.#entries]
      .filter(
        ([child]) =>
          child !== path &&
          child.startsWith(prefix) &&
          !child.slice(prefix.length).includes("/")
      )
      .map(([child, value]) => ({
        name: child.slice(prefix.length),
        isFile: value.type === "file",
        isDirectory: value.type === "dir",
        isSymbolicLink: false
      }));
    return children.slice(0, options?.limit ?? children.length);
  }

  async find(): Promise<Array<{ path: string; type: "file" | "dir" }>> {
    throw fsError("ENOSYS", "find");
  }

  async ls(): Promise<string[]> {
    throw fsError("ENOSYS", "ls");
  }

  async grep(): Promise<Array<{ path: string; line: number; text: string }>> {
    throw fsError("ENOSYS", "grep");
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const existing = this.#entries.get(path);
    if (existing) {
      if (options?.recursive && existing.type === "dir") return;
      throw fsError("EEXIST", path);
    }
    const parent = parentOf(path);
    if (!this.#entries.has(parent)) {
      if (!options?.recursive) throw fsError("ENOENT", parent);
      await this.mkdir(parent, options);
    }
    this.#entries.set(path, {
      type: "dir",
      mode: 0o755,
      mtime: Date.now(),
      inode: this.#nextInode++
    });
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    options?: { exclusive?: boolean }
  ): Promise<void> {
    const existing = this.#entries.get(path);
    if (existing?.type === "dir") throw fsError("EISDIR", path);
    if (existing && options?.exclusive) throw fsError("EEXIST", path);
    const parent = this.#entries.get(parentOf(path));
    if (!parent) throw fsError("ENOENT", parentOf(path));
    if (parent.type !== "dir") throw fsError("ENOTDIR", parentOf(path));
    this.#entries.set(path, {
      type: "file",
      data:
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content,
      mode: 0o644,
      mtime: Date.now(),
      inode: existing?.inode ?? this.#nextInode++
    });
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    const entry = this.#entries.get(path);
    if (!entry) {
      if (options?.force) return;
      throw fsError("ENOENT", path);
    }
    const prefix = `${path}/`;
    const children = [...this.#entries.keys()].filter((key) =>
      key.startsWith(prefix)
    );
    if (children.length > 0 && !options?.recursive) {
      throw fsError("ENOTEMPTY", path);
    }
    for (const child of children) this.#entries.delete(child);
    this.#entries.delete(path);
  }

  async chmod(path: string, mode: number): Promise<void> {
    const entry = this.#entries.get(path);
    if (!entry) throw fsError("ENOENT", path);
    entry.mode = mode;
  }

  async symlink(): Promise<void> {
    throw fsError("ENOSYS", "symlink");
  }
}
