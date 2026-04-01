import type {
  ISandbox,
  ExecResult,
  DirectoryBackup
} from "@cloudflare/sandbox";

// ── Types matching @cloudflare/shell ────────────────────────────────

export type EntryType = "file" | "directory" | "symlink";

export interface FileInfo {
  path: string;
  name: string;
  type: EntryType;
  size: number;
}

export interface WorkspaceInfo {
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
}

export type { ExecResult, DirectoryBackup as BackupHandle };

// ── SandboxWorkspace ────────────────────────────────────────────────

/**
 * Adapter that wraps `@cloudflare/sandbox`'s `ISandbox` with an
 * interface consistent with `@cloudflare/shell`'s Workspace. File
 * operations, directory listings, glob, and workspace info all return
 * the same shapes.
 */
export class SandboxWorkspace {
  private readonly sandbox: ISandbox;

  constructor(sandbox: ISandbox) {
    this.sandbox = sandbox;
  }

  /**
   * Start the container eagerly so subsequent operations don't pay
   * cold-start latency.
   */
  async start(): Promise<void> {
    await this.sandbox.exec("true");
  }

  /** Read a file. Returns null if not found (matches Workspace.readFile). */
  async readFile(path: string): Promise<string | null> {
    try {
      const file = await this.sandbox.readFile(path);
      return file.content;
    } catch {
      return null;
    }
  }

  /** Write a file. Creates parent directories (matches Workspace.writeFile). */
  async writeFile(path: string, content: string): Promise<void> {
    const parent = path.substring(0, path.lastIndexOf("/"));
    if (parent && parent !== "/") {
      await this.sandbox.mkdir(parent, { recursive: true });
    }
    await this.sandbox.writeFile(path, content);
  }

  /**
   * List directory entries (matches Workspace.readDir → FileInfo[]).
   * Uses the SDK's native `listFiles` and maps to our FileInfo shape.
   */
  async readDir(path: string): Promise<FileInfo[]> {
    try {
      const result = await this.sandbox.listFiles(path, {
        includeHidden: true
      });
      return result.files.map((f) => ({
        path: f.absolutePath,
        name: f.name,
        type: f.type === "other" ? ("file" as const) : f.type,
        size: f.size
      }));
    } catch {
      return [];
    }
  }

  /** Delete a file. Returns true if deleted (matches Workspace.deleteFile). */
  async deleteFile(path: string): Promise<boolean> {
    try {
      const result = await this.sandbox.deleteFile(path);
      return result.success;
    } catch {
      return false;
    }
  }

  /** Create directory, optionally recursive (matches Workspace.mkdir). */
  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.sandbox.mkdir(path, opts);
  }

  /** Check if a path exists (matches Workspace.exists). */
  async exists(path: string): Promise<boolean> {
    const result = await this.sandbox.exists(path);
    return result.exists;
  }

  /**
   * Glob for files matching a pattern (matches Workspace.glob → FileInfo[]).
   * Uses `find` with shell globbing since the SDK has no native glob.
   */
  async glob(pattern: string): Promise<FileInfo[]> {
    // Single exec: find with -printf returns type, size, and path per line.
    // %y = type char (f/d/l), %s = size in bytes, %p = full path.
    const result = await this.sandbox.exec(
      `find /workspace -path '${pattern}' -not -path '*/node_modules/*' -printf '%y %s %p\n' 2>/dev/null`
    );
    if (!result.success || !result.stdout.trim()) {
      return [];
    }

    const entries: FileInfo[] = [];
    for (const line of result.stdout.trim().split("\n")) {
      if (!line) continue;
      // Format: "<type-char> <size> <path>"
      const firstSpace = line.indexOf(" ");
      const secondSpace = line.indexOf(" ", firstSpace + 1);
      if (firstSpace < 0 || secondSpace < 0) continue;

      const typeChar = line.slice(0, firstSpace);
      const size = parseInt(line.slice(firstSpace + 1, secondSpace), 10) || 0;
      const p = line.slice(secondSpace + 1);
      const name = p.split("/").pop() ?? "";
      const type: EntryType =
        typeChar === "d" ? "directory" : typeChar === "l" ? "symlink" : "file";
      entries.push({ path: p, name, type, size });
    }
    return entries;
  }

  /** Get workspace stats (matches Workspace.getWorkspaceInfo). */
  async getWorkspaceInfo(): Promise<WorkspaceInfo> {
    // Single shell pipeline: find counts files and dirs, du gets total size.
    const result = await this.sandbox.exec(
      `echo "$(find /workspace -type f 2>/dev/null | wc -l) $(find /workspace -type d 2>/dev/null | wc -l) $(du -sb /workspace 2>/dev/null | cut -f1)"`
    );
    if (!result.success || !result.stdout.trim()) {
      return { fileCount: 0, directoryCount: 0, totalBytes: 0 };
    }
    const [files, dirs, bytes] = result.stdout.trim().split(/\s+/);
    return {
      fileCount: parseInt(files, 10) || 0,
      directoryCount: parseInt(dirs, 10) || 0,
      totalBytes: parseInt(bytes, 10) || 0
    };
  }

  /** Run a shell command. Returns { stdout, stderr, exitCode, success }. */
  async exec(
    command: string,
    opts?: { cwd?: string; timeout?: number }
  ): Promise<ExecResult> {
    return this.sandbox.exec(command, opts);
  }

  /** Create a backup of /workspace to R2. */
  async createBackup(): Promise<DirectoryBackup> {
    return this.sandbox.createBackup({
      dir: "/workspace",
      gitignore: true
    });
  }

  /** Restore a backup from R2. */
  async restoreBackup(backup: DirectoryBackup): Promise<void> {
    await this.sandbox.restoreBackup(backup);
  }

  /** Watch a directory for filesystem changes (SSE stream). */
  async watch(path: string): Promise<ReadableStream<Uint8Array>> {
    return this.sandbox.watch(path, { recursive: true });
  }
}
