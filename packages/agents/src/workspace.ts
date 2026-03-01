import type { Agent } from "./index";

/**
 * Workspace mixin — adds durable file storage to any Agent.
 *
 * Hybrid storage:
 *   - Files < threshold: stored inline in SQLite (fast, no external calls)
 *   - Files ≥ threshold: metadata in SQLite, content in R2 (avoids row limit)
 *
 * Usage:
 *   class MyAgent extends withWorkspace(Agent) { ... }
 *   // now has this.readFile, this.writeFile, this.bash, etc.
 *
 * R2 is optional — if the configured binding isn't present, all files are
 * stored inline regardless of size (with a warning for large files).
 *
 * just-bash is an optional peer dependency. The bash() method dynamically
 * imports it at runtime and throws a helpful error if it isn't installed.
 *
 * @module agents/workspace
 */

// ── Options ──────────────────────────────────────────────────────────

export interface WorkspaceOptions {
  /** Name of the R2 binding in your env (default: "WORKSPACE_FILES"). */
  r2Binding?: string;
  /** Byte threshold for spilling files to R2 (default: 1_500_000 = 1.5 MB). */
  inlineThreshold?: number;
  /** Bash execution limits (requires just-bash). */
  bashLimits?: {
    maxCommandCount?: number;
    maxLoopIterations?: number;
    maxCallDepth?: number;
  };
}

// ── Public types ─────────────────────────────────────────────────────

export type EntryType = "file" | "directory";

export type FileInfo = {
  path: string;
  name: string;
  type: EntryType;
  mimeType: string;
  size: number;
  createdAt: number;
  updatedAt: number;
};

export type FileStat = FileInfo;

export type BashResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_INLINE_THRESHOLD = 1_500_000; // 1.5 MB
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const DEFAULT_BASH_LIMITS = {
  maxCommandCount: 5000,
  maxLoopIterations: 2000,
  maxCallDepth: 50
};

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor pattern
type AgentConstructor = new (...args: any[]) => Agent;

// ── withWorkspace mixin ──────────────────────────────────────────────

/**
 * Adds durable file-system capabilities to an Agent.
 *
 * ```ts
 * import { Agent } from "agents";
 * import { withWorkspace } from "agents/workspace";
 *
 * class MyAgent extends withWorkspace(Agent) {
 *   async onMessage(conn, msg) {
 *     await this.writeFile("/hello.txt", "world");
 *     const content = await this.readFile("/hello.txt");
 *   }
 * }
 * ```
 */
export function withWorkspace<TBase extends typeof Agent>(
  Base: TBase,
  options?: WorkspaceOptions
) {
  const r2BindingName = options?.r2Binding ?? "WORKSPACE_FILES";
  const threshold = options?.inlineThreshold ?? DEFAULT_INLINE_THRESHOLD;
  const bashLimits = {
    ...DEFAULT_BASH_LIMITS,
    ...options?.bashLimits
  };

  class WorkspaceAgent extends (Base as AgentConstructor) {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor
    constructor(...args: any[]) {
      super(...args);
      this._initWorkspaceTables();
    }

    // ── Table init ─────────────────────────────────────────────────

    private _initWorkspaceTables(): void {
      this.sql`
        CREATE TABLE IF NOT EXISTS cf_workspace_entries (
          path            TEXT PRIMARY KEY,
          parent_path     TEXT NOT NULL,
          name            TEXT NOT NULL,
          type            TEXT NOT NULL CHECK(type IN ('file','directory')),
          mime_type       TEXT NOT NULL DEFAULT 'text/plain',
          size            INTEGER NOT NULL DEFAULT 0,
          storage_backend TEXT NOT NULL DEFAULT 'inline' CHECK(storage_backend IN ('inline','r2')),
          r2_key          TEXT,
          content         TEXT,
          created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
          modified_at     INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `;

      this.sql`
        CREATE INDEX IF NOT EXISTS cf_workspace_entries_parent
          ON cf_workspace_entries(parent_path)
      `;

      // Root directory always exists
      const hasRoot =
        this.sql<{ cnt: number }>`
          SELECT COUNT(*) AS cnt FROM cf_workspace_entries WHERE path = '/'
        `[0]?.cnt ?? 0;

      if (hasRoot === 0) {
        const now = Math.floor(Date.now() / 1000);
        this.sql`
          INSERT INTO cf_workspace_entries
            (path, parent_path, name, type, size, created_at, modified_at)
          VALUES ('/', '', '', 'directory', 0, ${now}, ${now})
        `;
      }
    }

    // ── R2 helpers ─────────────────────────────────────────────────

    private _getR2(): R2Bucket | null {
      const binding = (this.env as Record<string, unknown>)[r2BindingName];
      if (!binding) return null;
      return binding as R2Bucket;
    }

    private _r2Key(filePath: string): string {
      return `${this.ctx.id.toString()}${filePath}`;
    }

    // ── Metadata ───────────────────────────────────────────────────

    fileStat(path: string): FileStat | null {
      const normalized = normalizePath(path);
      const rows = this.sql<{
        path: string;
        name: string;
        type: string;
        mime_type: string;
        size: number;
        created_at: number;
        modified_at: number;
      }>`
        SELECT path, name, type, mime_type, size, created_at, modified_at
        FROM cf_workspace_entries WHERE path = ${normalized}
      `;
      const r = rows[0];
      if (!r) return null;
      return toFileInfo(r);
    }

    // ── File I/O ───────────────────────────────────────────────────

    async readFile(path: string): Promise<string | null> {
      const normalized = normalizePath(path);
      const rows = this.sql<{
        type: string;
        storage_backend: string;
        r2_key: string | null;
        content: string | null;
      }>`
        SELECT type, storage_backend, r2_key, content
        FROM cf_workspace_entries WHERE path = ${normalized}
      `;
      const r = rows[0];
      if (!r) return null;
      if (r.type !== "file") throw new Error(`EISDIR: ${path} is a directory`);

      if (r.storage_backend === "r2" && r.r2_key) {
        const r2 = this._getR2();
        if (!r2) {
          throw new Error(
            `File ${path} is stored in R2 but no R2 binding "${r2BindingName}" is configured`
          );
        }
        const obj = await r2.get(r.r2_key);
        if (!obj) return "";
        return await obj.text();
      }

      return r.content ?? "";
    }

    async writeFile(
      path: string,
      content: string,
      mimeType = "text/plain"
    ): Promise<void> {
      const normalized = normalizePath(path);
      if (normalized === "/")
        throw new Error("EISDIR: cannot write to root directory");

      const parentPath = getParent(normalized);
      const name = getBasename(normalized);
      const bytes = TEXT_ENCODER.encode(content);
      const size = bytes.byteLength;
      const now = Math.floor(Date.now() / 1000);

      this._ensureParentDir(parentPath);

      // Check if there's an existing R2 file that may need cleanup
      const existing = this.sql<{
        storage_backend: string;
        r2_key: string | null;
      }>`
        SELECT storage_backend, r2_key FROM cf_workspace_entries WHERE path = ${normalized}
      `[0];

      const r2 = this._getR2();

      if (size >= threshold && r2) {
        const r2Key = this._r2Key(normalized);

        if (existing?.storage_backend === "r2" && existing.r2_key !== r2Key) {
          await r2.delete(existing.r2_key!);
        }

        // Write to R2 first. If this fails, SQL is untouched.
        await r2.put(r2Key, bytes, {
          httpMetadata: { contentType: mimeType }
        });

        // Update SQL. If this fails, clean up R2.
        try {
          this.sql`
            INSERT INTO cf_workspace_entries
              (path, parent_path, name, type, mime_type, size,
               storage_backend, r2_key, content, created_at, modified_at)
            VALUES
              (${normalized}, ${parentPath}, ${name}, 'file', ${mimeType}, ${size},
               'r2', ${r2Key}, NULL, ${now}, ${now})
            ON CONFLICT(path) DO UPDATE SET
              mime_type       = excluded.mime_type,
              size            = excluded.size,
              storage_backend = 'r2',
              r2_key          = excluded.r2_key,
              content         = NULL,
              modified_at     = excluded.modified_at
          `;
        } catch (sqlErr) {
          try {
            await r2.delete(r2Key);
          } catch {
            console.error(
              `[Workspace] Failed to clean up orphaned R2 object ${r2Key} after SQL error`
            );
          }
          throw sqlErr;
        }
      } else {
        if (size >= threshold && !r2) {
          console.warn(
            `[Workspace] File ${path} is ${size} bytes but no R2 binding "${r2BindingName}" is configured. Storing inline — this may hit SQLite row limits for very large files.`
          );
        }

        // Going inline: delete any existing R2 object first.
        if (existing?.storage_backend === "r2" && existing.r2_key && r2) {
          await r2.delete(existing.r2_key);
        }

        this.sql`
          INSERT INTO cf_workspace_entries
            (path, parent_path, name, type, mime_type, size,
             storage_backend, r2_key, content, created_at, modified_at)
          VALUES
            (${normalized}, ${parentPath}, ${name}, 'file', ${mimeType}, ${size},
             'inline', NULL, ${content}, ${now}, ${now})
          ON CONFLICT(path) DO UPDATE SET
            mime_type       = excluded.mime_type,
            size            = excluded.size,
            storage_backend = 'inline',
            r2_key          = NULL,
            content         = excluded.content,
            modified_at     = excluded.modified_at
        `;
      }
    }

    async deleteFile(path: string): Promise<boolean> {
      const normalized = normalizePath(path);
      const rows = this.sql<{
        type: string;
        storage_backend: string;
        r2_key: string | null;
      }>`
        SELECT type, storage_backend, r2_key FROM cf_workspace_entries WHERE path = ${normalized}
      `;
      if (!rows[0]) return false;
      if (rows[0].type !== "file")
        throw new Error(`EISDIR: ${path} is a directory — use rm() instead`);

      if (rows[0].storage_backend === "r2" && rows[0].r2_key) {
        const r2 = this._getR2();
        if (r2) await r2.delete(rows[0].r2_key);
      }

      this.sql`DELETE FROM cf_workspace_entries WHERE path = ${normalized}`;
      return true;
    }

    fileExists(path: string): boolean {
      const normalized = normalizePath(path);
      const rows = this.sql<{ type: string }>`
        SELECT type FROM cf_workspace_entries WHERE path = ${normalized}
      `;
      return rows.length > 0 && rows[0].type === "file";
    }

    // ── Directory operations ───────────────────────────────────────

    listFiles(
      dir = "/",
      opts?: { limit?: number; offset?: number }
    ): FileInfo[] {
      const normalized = normalizePath(dir);
      const limit = opts?.limit ?? 1000;
      const offset = opts?.offset ?? 0;
      const rows = this.sql<{
        path: string;
        name: string;
        type: string;
        mime_type: string;
        size: number;
        created_at: number;
        modified_at: number;
      }>`
        SELECT path, name, type, mime_type, size, created_at, modified_at
        FROM cf_workspace_entries
        WHERE parent_path = ${normalized}
        ORDER BY type ASC, name ASC
        LIMIT ${limit} OFFSET ${offset}
      `;
      return rows.map(toFileInfo);
    }

    mkdir(path: string, opts?: { recursive?: boolean }): void {
      const normalized = normalizePath(path);
      if (normalized === "/") return;

      const existing = this.sql<{ type: string }>`
        SELECT type FROM cf_workspace_entries WHERE path = ${normalized}
      `;

      if (existing.length > 0) {
        if (existing[0].type === "directory" && opts?.recursive) return;
        throw new Error(
          existing[0].type === "directory"
            ? `EEXIST: directory already exists: ${path}`
            : `EEXIST: path exists as a file: ${path}`
        );
      }

      const parentPath = getParent(normalized);
      const parentRows = this.sql<{ type: string }>`
        SELECT type FROM cf_workspace_entries WHERE path = ${parentPath}
      `;

      if (!parentRows[0]) {
        if (opts?.recursive) {
          this.mkdir(parentPath, { recursive: true });
        } else {
          throw new Error(`ENOENT: parent directory not found: ${parentPath}`);
        }
      } else if (parentRows[0].type !== "directory") {
        throw new Error(`ENOTDIR: parent is not a directory: ${parentPath}`);
      }

      const name = getBasename(normalized);
      const now = Math.floor(Date.now() / 1000);
      this.sql`
        INSERT INTO cf_workspace_entries
          (path, parent_path, name, type, size, created_at, modified_at)
        VALUES (${normalized}, ${parentPath}, ${name}, 'directory', 0, ${now}, ${now})
      `;
    }

    async rm(
      path: string,
      opts?: { recursive?: boolean; force?: boolean }
    ): Promise<void> {
      const normalized = normalizePath(path);
      if (normalized === "/")
        throw new Error("EPERM: cannot remove root directory");

      const rows = this.sql<{ type: string }>`
        SELECT type FROM cf_workspace_entries WHERE path = ${normalized}
      `;

      if (!rows[0]) {
        if (opts?.force) return;
        throw new Error(`ENOENT: no such file or directory: ${path}`);
      }

      if (rows[0].type === "directory") {
        const children = this.sql<{ cnt: number }>`
          SELECT COUNT(*) AS cnt FROM cf_workspace_entries WHERE parent_path = ${normalized}
        `;
        if ((children[0]?.cnt ?? 0) > 0) {
          if (!opts?.recursive) {
            throw new Error(`ENOTEMPTY: directory not empty: ${path}`);
          }
          await this._deleteDescendants(normalized);
        }
      } else {
        const fileRow = this.sql<{
          storage_backend: string;
          r2_key: string | null;
        }>`
          SELECT storage_backend, r2_key FROM cf_workspace_entries WHERE path = ${normalized}
        `[0];
        if (fileRow?.storage_backend === "r2" && fileRow.r2_key) {
          const r2 = this._getR2();
          if (r2) await r2.delete(fileRow.r2_key);
        }
      }

      this.sql`DELETE FROM cf_workspace_entries WHERE path = ${normalized}`;
    }

    // ── Bash execution ─────────────────────────────────────────────

    async bash(command: string): Promise<BashResult> {
      let justBash: typeof import("just-bash");
      try {
        justBash = await import("just-bash");
      } catch {
        throw new Error(
          'The bash() method requires the "just-bash" package. Install it with: npm install just-bash'
        );
      }

      const fs = new WorkspaceFileSystem(this as WorkspaceInstance);
      const bashInstance = new justBash.Bash({
        fs,
        cwd: "/",
        executionLimits: bashLimits
      });
      const result = await bashInstance.exec(command);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      };
    }

    // ── Info ────────────────────────────────────────────────────────

    getWorkspaceInfo(): {
      fileCount: number;
      directoryCount: number;
      totalBytes: number;
      r2FileCount: number;
    } {
      const rows = this.sql<{
        files: number;
        dirs: number;
        total: number;
        r2files: number;
      }>`
        SELECT
          SUM(CASE WHEN type = 'file'                               THEN 1 ELSE 0 END) AS files,
          SUM(CASE WHEN type = 'directory'                          THEN 1 ELSE 0 END) AS dirs,
          COALESCE(SUM(CASE WHEN type = 'file' THEN size ELSE 0 END), 0)               AS total,
          SUM(CASE WHEN type = 'file' AND storage_backend = 'r2'   THEN 1 ELSE 0 END) AS r2files
        FROM cf_workspace_entries
      `;
      return {
        fileCount: rows[0]?.files ?? 0,
        directoryCount: rows[0]?.dirs ?? 0,
        totalBytes: rows[0]?.total ?? 0,
        r2FileCount: rows[0]?.r2files ?? 0
      };
    }

    // ── Private helpers ────────────────────────────────────────────

    private _ensureParentDir(dirPath: string): void {
      if (!dirPath) return;
      const rows = this.sql<{ type: string }>`
        SELECT type FROM cf_workspace_entries WHERE path = ${dirPath}
      `;
      if (!rows[0]) {
        this.mkdir(dirPath, { recursive: true });
      } else if (rows[0].type !== "directory") {
        throw new Error(`ENOTDIR: ${dirPath} is not a directory`);
      }
    }

    private async _deleteDescendants(dirPath: string): Promise<void> {
      const prefix = `${dirPath}/`;

      const r2Rows = this.sql<{ r2_key: string }>`
        SELECT r2_key FROM cf_workspace_entries
        WHERE path LIKE ${prefix + "%"}
          AND storage_backend = 'r2'
          AND r2_key IS NOT NULL
      `;

      if (r2Rows.length > 0) {
        const r2 = this._getR2();
        if (r2) {
          await Promise.all(r2Rows.map((r) => r2.delete(r.r2_key)));
        }
      }

      this
        .sql`DELETE FROM cf_workspace_entries WHERE path LIKE ${prefix + "%"}`;
    }
  }

  return WorkspaceAgent as unknown as TBase & {
    new (
      ...args: ConstructorParameters<TBase>
    ): InstanceType<TBase> & WorkspaceMethods;
  };
}

// ── WorkspaceMethods interface ───────────────────────────────────────
//
// Describes the methods added by the mixin. Exported so users can
// reference the shape in their own type annotations if needed.

export interface WorkspaceMethods {
  fileStat(path: string): FileStat | null;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string, mimeType?: string): Promise<void>;
  deleteFile(path: string): Promise<boolean>;
  fileExists(path: string): boolean;
  listFiles(
    dir?: string,
    opts?: { limit?: number; offset?: number }
  ): FileInfo[];
  mkdir(path: string, opts?: { recursive?: boolean }): void;
  rm(
    path: string,
    opts?: { recursive?: boolean; force?: boolean }
  ): Promise<void>;
  bash(command: string): Promise<BashResult>;
  getWorkspaceInfo(): {
    fileCount: number;
    directoryCount: number;
    totalBytes: number;
    r2FileCount: number;
  };
}

// ── WorkspaceInstance (internal) ─────────────────────────────────────
//
// Minimal interface for the WorkspaceFileSystem bridge to call back
// into the workspace methods without circular type dependencies.

interface WorkspaceInstance {
  fileStat(path: string): FileStat | null;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string, mimeType?: string): Promise<void>;
  listFiles(
    dir?: string,
    opts?: { limit?: number; offset?: number }
  ): FileInfo[];
  mkdir(path: string, opts?: { recursive?: boolean }): void;
  rm(
    path: string,
    opts?: { recursive?: boolean; force?: boolean }
  ): Promise<void>;
  sql: <T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) => T[];
}

// ── WorkspaceFileSystem (IFileSystem bridge for just-bash) ───────────
//
// Bridges the workspace's async file methods into the IFileSystem
// interface that just-bash expects. All reads/writes go through the
// workspace so bash commands share the same durable storage.
//
// We define the IFileSystem shape locally to avoid a hard dependency
// on just-bash types at compile time.

interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: Date;
}

interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

type FileContent = string | Uint8Array;
type BufferEncoding = "utf-8" | "utf8" | "ascii" | "base64" | "hex" | "latin1";
type ReadFileOptions = { encoding?: BufferEncoding | null };
type WriteFileOptions = { encoding?: BufferEncoding };
type MkdirOptions = { recursive?: boolean };
type RmOptions = { recursive?: boolean; force?: boolean };
type CpOptions = { recursive?: boolean };

function fileContentToString(content: FileContent): string {
  return typeof content === "string" ? content : TEXT_DECODER.decode(content);
}

class WorkspaceFileSystem {
  constructor(private ws: WorkspaceInstance) {}

  async readFile(
    path: string,
    _options?: ReadFileOptions | BufferEncoding
  ): Promise<string> {
    const content = await this.ws.readFile(path);
    if (content === null)
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return content;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const content = await this.ws.readFile(path);
    if (content === null)
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return TEXT_ENCODER.encode(content);
  }

  async writeFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    await this.ws.writeFile(path, fileContentToString(content));
  }

  async appendFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    const existing = (await this.ws.readFile(path)) ?? "";
    await this.ws.writeFile(path, existing + fileContentToString(content));
  }

  async exists(path: string): Promise<boolean> {
    return this.ws.fileStat(path) !== null;
  }

  async stat(path: string): Promise<FsStat> {
    const s = this.ws.fileStat(path);
    if (!s)
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return {
      isFile: s.type === "file",
      isDirectory: s.type === "directory",
      isSymbolicLink: false,
      mode: s.type === "directory" ? 0o755 : 0o644,
      size: s.size,
      mtime: new Date(s.updatedAt)
    };
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.ws.mkdir(path, options);
  }

  async readdir(path: string): Promise<string[]> {
    return this.ws.listFiles(path).map((e) => e.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    return this.ws.listFiles(path).map((e) => ({
      name: e.name,
      isFile: e.type === "file",
      isDirectory: e.type === "directory",
      isSymbolicLink: false
    }));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    await this.ws.rm(path, options);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcStat = this.ws.fileStat(src);
    if (!srcStat)
      throw Object.assign(new Error(`ENOENT: ${src}`), { code: "ENOENT" });

    if (srcStat.type === "directory") {
      if (!options?.recursive)
        throw Object.assign(
          new Error(`EISDIR: cannot copy directory without recursive: ${src}`),
          { code: "EISDIR" }
        );
      this.ws.mkdir(dest, { recursive: true });
      for (const child of this.ws.listFiles(src)) {
        await this.cp(child.path, `${dest}/${child.name}`, options);
      }
    } else {
      const content = (await this.ws.readFile(src)) ?? "";
      await this.ws.writeFile(dest, content, srcStat.mimeType);
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest, { recursive: true });
    await this.ws.rm(src, { recursive: true, force: true });
  }

  resolvePath(base: string, path: string): string {
    const raw = path.startsWith("/") ? path : `${base}/${path}`;
    const parts = raw.split("/").filter(Boolean);
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === "..") resolved.pop();
      else if (part !== ".") resolved.push(part);
    }
    return "/" + resolved.join("/");
  }

  getAllPaths(): string[] {
    return this.ws.sql<{ path: string }>`
      SELECT path FROM cf_workspace_entries ORDER BY path
    `.map((r) => r.path);
  }

  async chmod(_path: string, _mode: number): Promise<void> {
    // no-op
  }

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new Error("ENOSYS: symlinks not supported in workspace filesystem");
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new Error("ENOSYS: hard links not supported in workspace filesystem");
  }

  async readlink(path: string): Promise<string> {
    throw Object.assign(new Error(`EINVAL: not a symlink: ${path}`), {
      code: "EINVAL"
    });
  }

  async realpath(path: string): Promise<string> {
    const normalized = normalizePath(path);
    if (!this.ws.fileStat(normalized))
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return normalized;
  }

  async utimes(_path: string, _atime: Date, mtime: Date): Promise<void> {
    const normalized = normalizePath(_path);
    const ts = Math.floor(mtime.getTime() / 1000);
    this.ws.sql`
      UPDATE cf_workspace_entries SET modified_at = ${ts} WHERE path = ${normalized}
    `;
  }
}

// ── Path helpers ─────────────────────────────────────────────────────

function normalizePath(path: string): string {
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\/+/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

function getParent(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "";
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === 0 ? "/" : normalized.slice(0, lastSlash);
}

function getBasename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "";
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function toFileInfo(r: {
  path: string;
  name: string;
  type: string;
  mime_type: string;
  size: number;
  created_at: number;
  modified_at: number;
}): FileInfo {
  return {
    path: r.path,
    name: r.name,
    type: r.type as EntryType,
    mimeType: r.mime_type,
    size: r.size,
    createdAt: r.created_at * 1000,
    updatedAt: r.modified_at * 1000
  };
}
