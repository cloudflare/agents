import { Bash } from "just-bash";
import type {
  IFileSystem,
  FsStat,
  MkdirOptions,
  RmOptions,
  CpOptions,
  FileContent,
  ReadFileOptions,
  BufferEncoding,
  WriteFileOptions,
  DirentEntry
} from "just-bash";
import { AgentFacet } from "./agent-facet";

// ── Constants ──────────────────────────────────────────────────────

/**
 * Files larger than this are stored in R2 instead of inline SQLite.
 * 1.5MB leaves comfortable headroom below SQLite's ~2MB row limit.
 */
const INLINE_THRESHOLD = 1_500_000; // 1.5 MB in bytes

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// ── Types ──────────────────────────────────────────────────────────

export type EntryType = "file" | "directory";
type StorageBackend = "inline" | "r2";

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

/** Typed facet stub for RPC calls from ThinkAgent. */
export interface WorkspaceFacet {
  // File I/O (async — may hit R2)
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string, mimeType?: string): Promise<void>;
  deleteFile(path: string): Promise<boolean>;
  fileExists(path: string): Promise<boolean>;

  // Metadata (sync — SQLite only)
  stat(path: string): Promise<FileStat | null>;

  // Directory operations
  listFiles(
    dir?: string,
    options?: { limit?: number; offset?: number }
  ): Promise<FileInfo[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void>;

  // Execution
  bash(command: string): Promise<BashResult>;

  // Info
  getInfo(): Promise<{
    fileCount: number;
    directoryCount: number;
    totalBytes: number;
    r2FileCount: number;
  }>;
}

/**
 * Workspace facet — a durable, addressable workspace that can be
 * attached to any thread (or detached and reattached later).
 *
 * Hybrid storage:
 *   - Files < 1.5 MB: stored inline in SQLite (fast, no external calls)
 *   - Files ≥ 1.5 MB: metadata in SQLite, content in R2 (avoids row limit)
 *
 * The `storage_backend` column in `entries` tracks where each file's
 * content lives. R2 keys are `{workspaceId}/{path}`.
 */
export class Workspace extends AgentFacet {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.sql`
      CREATE TABLE IF NOT EXISTS entries (
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
      CREATE INDEX IF NOT EXISTS entries_parent ON entries(parent_path)
    `;

    // Root directory always exists
    const hasRoot =
      this.sql<{ cnt: number }>`
        SELECT COUNT(*) AS cnt FROM entries WHERE path = '/'
      `[0]?.cnt ?? 0;

    if (hasRoot === 0) {
      const now = Math.floor(Date.now() / 1000);
      this.sql`
        INSERT INTO entries
          (path, parent_path, name, type, size, created_at, modified_at)
        VALUES ('/', '', '', 'directory', 0, ${now}, ${now})
      `;
    }
  }

  // ── R2 access ──────────────────────────────────────────────────────

  private get _r2(): R2Bucket {
    return (this.env as unknown as { WORKSPACE_FILES: R2Bucket })
      .WORKSPACE_FILES;
  }

  /** Build a stable R2 key for a workspace file path. */
  private _r2Key(filePath: string): string {
    // Use the DO's unique ID as namespace prefix so multiple workspaces
    // share one bucket without collisions.
    const id = this.ctx.id.toString();
    return `${id}${filePath}`;
  }

  // ── Metadata ───────────────────────────────────────────────────────

  stat(path: string): FileStat | null {
    const normalized = _normalize(path);
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
      FROM entries WHERE path = ${normalized}
    `;
    const r = rows[0];
    if (!r) return null;
    return _toFileInfo(r);
  }

  // ── File I/O ───────────────────────────────────────────────────────

  async readFile(path: string): Promise<string | null> {
    const normalized = _normalize(path);
    const rows = this.sql<{
      type: string;
      storage_backend: string;
      r2_key: string | null;
      content: string | null;
    }>`
      SELECT type, storage_backend, r2_key, content
      FROM entries WHERE path = ${normalized}
    `;
    const r = rows[0];
    if (!r) return null;
    if (r.type !== "file") throw new Error(`EISDIR: ${path} is a directory`);

    if (r.storage_backend === "r2" && r.r2_key) {
      const obj = await this._r2.get(r.r2_key);
      if (!obj) return "";
      return await obj.text();
    }

    return r.content ?? "";
  }

  /**
   * Write content to a file. Auto-creates missing parent directories.
   * Routes to R2 if content ≥ 1.5 MB, otherwise stores inline in SQLite.
   *
   * Consistency guarantee: R2 write happens first. If the subsequent SQL
   * update fails (rare), we attempt to clean up the R2 object so we don't
   * leave an orphan. If the R2 write itself fails, SQL is never touched.
   */
  async writeFile(
    path: string,
    content: string,
    mimeType = "text/plain"
  ): Promise<void> {
    const normalized = _normalize(path);
    if (normalized === "/")
      throw new Error("EISDIR: cannot write to root directory");

    const parentPath = _parent(normalized);
    const name = _basename(normalized);
    const bytes = TEXT_ENCODER.encode(content);
    const size = bytes.byteLength;
    const now = Math.floor(Date.now() / 1000);

    this._ensureDir(parentPath);

    // Check if there's an existing R2 file that may need cleanup
    const existing = this.sql<{
      storage_backend: string;
      r2_key: string | null;
    }>`
      SELECT storage_backend, r2_key FROM entries WHERE path = ${normalized}
    `[0];

    if (size >= INLINE_THRESHOLD) {
      const r2Key = this._r2Key(normalized);

      if (existing?.storage_backend === "r2" && existing.r2_key !== r2Key) {
        // Different key (shouldn't happen with our key scheme, but clean up)
        await this._r2.delete(existing.r2_key!);
      }

      // Write to R2 first. If this fails, SQL is untouched — consistent.
      await this._r2.put(r2Key, bytes, {
        httpMetadata: { contentType: mimeType }
      });

      // Update SQL. If this fails, clean up R2 to avoid orphan.
      try {
        this.sql`
          INSERT INTO entries
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
        // Best-effort R2 cleanup to avoid orphan
        try {
          await this._r2.delete(r2Key);
        } catch {
          console.error(
            `[Workspace] Failed to clean up orphaned R2 object ${r2Key} after SQL error`
          );
        }
        throw sqlErr;
      }
    } else {
      // Going inline: delete any existing R2 object first to avoid orphan.
      if (existing?.storage_backend === "r2" && existing.r2_key) {
        await this._r2.delete(existing.r2_key);
      }

      this.sql`
        INSERT INTO entries
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
    const normalized = _normalize(path);
    const rows = this.sql<{
      type: string;
      storage_backend: string;
      r2_key: string | null;
    }>`
      SELECT type, storage_backend, r2_key FROM entries WHERE path = ${normalized}
    `;
    if (!rows[0]) return false;
    if (rows[0].type !== "file")
      throw new Error(`EISDIR: ${path} is a directory — use rm() instead`);

    if (rows[0].storage_backend === "r2" && rows[0].r2_key) {
      await this._r2.delete(rows[0].r2_key);
    }

    this.sql`DELETE FROM entries WHERE path = ${normalized}`;
    return true;
  }

  fileExists(path: string): boolean {
    const normalized = _normalize(path);
    const rows = this.sql<{ type: string }>`
      SELECT type FROM entries WHERE path = ${normalized}
    `;
    return rows.length > 0 && rows[0].type === "file";
  }

  // ── Directory operations ───────────────────────────────────────────

  listFiles(
    dir = "/",
    options?: { limit?: number; offset?: number }
  ): FileInfo[] {
    const normalized = _normalize(dir);
    const limit = options?.limit ?? 1000;
    const offset = options?.offset ?? 0;
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
      FROM entries
      WHERE parent_path = ${normalized}
      ORDER BY type ASC, name ASC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map(_toFileInfo);
  }

  mkdir(path: string, options?: { recursive?: boolean }): void {
    const normalized = _normalize(path);
    if (normalized === "/") return;

    const existing = this.sql<{ type: string }>`
      SELECT type FROM entries WHERE path = ${normalized}
    `;

    if (existing.length > 0) {
      if (existing[0].type === "directory" && options?.recursive) return;
      throw new Error(
        existing[0].type === "directory"
          ? `EEXIST: directory already exists: ${path}`
          : `EEXIST: path exists as a file: ${path}`
      );
    }

    const parentPath = _parent(normalized);
    const parentRows = this.sql<{ type: string }>`
      SELECT type FROM entries WHERE path = ${parentPath}
    `;

    if (!parentRows[0]) {
      if (options?.recursive) {
        this.mkdir(parentPath, { recursive: true });
      } else {
        throw new Error(`ENOENT: parent directory not found: ${parentPath}`);
      }
    } else if (parentRows[0].type !== "directory") {
      throw new Error(`ENOTDIR: parent is not a directory: ${parentPath}`);
    }

    const name = _basename(normalized);
    const now = Math.floor(Date.now() / 1000);
    this.sql`
      INSERT INTO entries
        (path, parent_path, name, type, size, created_at, modified_at)
      VALUES (${normalized}, ${parentPath}, ${name}, 'directory', 0, ${now}, ${now})
    `;
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    const normalized = _normalize(path);
    if (normalized === "/")
      throw new Error("EPERM: cannot remove root directory");

    const rows = this.sql<{ type: string }>`
      SELECT type FROM entries WHERE path = ${normalized}
    `;

    if (!rows[0]) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory: ${path}`);
    }

    if (rows[0].type === "directory") {
      const children = this.sql<{ cnt: number }>`
        SELECT COUNT(*) AS cnt FROM entries WHERE parent_path = ${normalized}
      `;
      if ((children[0]?.cnt ?? 0) > 0) {
        if (!options?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty: ${path}`);
        }
        // Delete all descendants, cleaning up R2 objects first
        await this._deleteDescendants(normalized);
      }
    } else {
      // Single file — clean up R2 if needed
      const fileRow = this.sql<{
        storage_backend: string;
        r2_key: string | null;
      }>`
        SELECT storage_backend, r2_key FROM entries WHERE path = ${normalized}
      `[0];
      if (fileRow?.storage_backend === "r2" && fileRow.r2_key) {
        await this._r2.delete(fileRow.r2_key);
      }
    }

    this.sql`DELETE FROM entries WHERE path = ${normalized}`;
  }

  // ── Bash execution ─────────────────────────────────────────────────

  async bash(command: string): Promise<BashResult> {
    const fs = new WorkspaceFileSystem(this);
    const bash = new Bash({
      fs,
      cwd: "/",
      executionLimits: {
        maxCommandCount: 5000,
        maxLoopIterations: 2000,
        maxCallDepth: 50
      }
    });
    const result = await bash.exec(command);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    };
  }

  // ── Info ───────────────────────────────────────────────────────────

  getInfo(): {
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
      FROM entries
    `;
    return {
      fileCount: rows[0]?.files ?? 0,
      directoryCount: rows[0]?.dirs ?? 0,
      totalBytes: rows[0]?.total ?? 0,
      r2FileCount: rows[0]?.r2files ?? 0
    };
  }

  // ── Private helpers ────────────────────────────────────────────────

  private _ensureDir(dirPath: string): void {
    if (!dirPath) return;
    const rows = this.sql<{ type: string }>`
      SELECT type FROM entries WHERE path = ${dirPath}
    `;
    if (!rows[0]) {
      this.mkdir(dirPath, { recursive: true });
    } else if (rows[0].type !== "directory") {
      throw new Error(`ENOTDIR: ${dirPath} is not a directory`);
    }
  }

  /**
   * Delete all entries under a directory prefix, cleaning up R2 objects.
   * Called before deleting the directory itself.
   */
  private async _deleteDescendants(dirPath: string): Promise<void> {
    const prefix = `${dirPath}/`;

    // Collect all R2 keys under this directory
    const r2Rows = this.sql<{ r2_key: string }>`
      SELECT r2_key FROM entries
      WHERE path LIKE ${prefix + "%"}
        AND storage_backend = 'r2'
        AND r2_key IS NOT NULL
    `;

    // Delete R2 objects (in parallel, batched)
    if (r2Rows.length > 0) {
      await Promise.all(r2Rows.map((r) => this._r2.delete(r.r2_key)));
    }

    // Delete all SQLite rows
    this.sql`DELETE FROM entries WHERE path LIKE ${prefix + "%"}`;
  }
}

// ── WorkspaceFileSystem (IFileSystem bridge for just-bash) ─────────────
//
// All reads/writes go through the Workspace's async methods so bash
// commands and readFile/writeFile calls share the same durable storage.

function _fileContentToString(content: FileContent): string {
  return typeof content === "string" ? content : TEXT_DECODER.decode(content);
}

class WorkspaceFileSystem implements IFileSystem {
  constructor(private ws: Workspace) {}

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
    await this.ws.writeFile(path, _fileContentToString(content));
  }

  async appendFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    const existing = (await this.ws.readFile(path)) ?? "";
    await this.ws.writeFile(path, existing + _fileContentToString(content));
  }

  async exists(path: string): Promise<boolean> {
    return this.ws.stat(path) !== null;
  }

  async stat(path: string): Promise<FsStat> {
    const s = this.ws.stat(path);
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
    const srcStat = this.ws.stat(src);
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
    // Guard: resolved path must stay inside the virtual root "/"
    // (pop() on an empty array is a no-op, so leading ".." is already safe,
    // but we double-check to be explicit)
    return "/" + resolved.join("/");
  }

  getAllPaths(): string[] {
    return this.ws["sql"]<{ path: string }>`
      SELECT path FROM entries ORDER BY path
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
    const normalized = _normalize(path);
    if (!this.ws.stat(normalized))
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return normalized;
  }

  async utimes(_path: string, _atime: Date, mtime: Date): Promise<void> {
    const normalized = _normalize(_path);
    const ts = Math.floor(mtime.getTime() / 1000);
    this.ws["sql"]`
      UPDATE entries SET modified_at = ${ts} WHERE path = ${normalized}
    `;
  }
}

// ── Path helpers ─────────────────────────────────────────────────────

function _normalize(path: string): string {
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\/+/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

function _parent(path: string): string {
  const normalized = _normalize(path);
  if (normalized === "/") return "";
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === 0 ? "/" : normalized.slice(0, lastSlash);
}

function _basename(path: string): string {
  const normalized = _normalize(path);
  if (normalized === "/") return "";
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function _toFileInfo(r: {
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
