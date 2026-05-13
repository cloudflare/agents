import { channel } from "node:diagnostics_channel";

/**
 * Workspace — durable file storage backed by SQLite + optional R2.
 *
 * Accepts any `SqlBackend` (two methods: `query` and `run`), or
 * auto-detects `SqlStorage` (DO built-in) and `D1Database` directly.
 *
 * ```ts
 * // Durable Object (any DO with SQLite storage)
 * const workspace = new Workspace({ sql: ctx.storage.sql });
 *
 * // D1
 * const workspace = new Workspace({ sql: env.MY_DB });
 *
 * // Agent (with R2 and lazy name for observability)
 * class MyAgent extends Agent<Env> {
 *   workspace = new Workspace({
 *     sql: this.ctx.storage.sql,
 *     r2: this.env.WORKSPACE_FILES,
 *     name: () => this.name,
 *   });
 * }
 * ```
 *
 * @module workspace
 */

// ── SQL backend interface ────────────────────────────────────────────

export type SqlParam = string | number | boolean | null;

/**
 * Minimal SQL interface: query rows and run statements.
 * Return values may be sync or async — Workspace awaits either.
 */
export interface SqlBackend {
  query<T = Record<string, SqlParam>>(
    sql: string,
    ...params: SqlParam[]
  ): T[] | Promise<T[]>;
  run(sql: string, ...params: SqlParam[]): void | Promise<void>;
}

/** Auto-detect: accepts SqlStorage, D1Database, or a raw SqlBackend. */
export type SqlSource = SqlStorage | D1Database | SqlBackend;

function isSqlStorage(src: SqlSource): src is SqlStorage {
  return typeof src === "object" && src !== null && "databaseSize" in src;
}

function isD1Database(src: SqlSource): src is D1Database {
  return (
    typeof src === "object" &&
    src !== null &&
    "prepare" in src &&
    "batch" in src
  );
}

function toBackend(src: SqlSource): SqlBackend {
  if (isSqlStorage(src)) {
    const storage = src;
    return {
      query(sql: string, ...params: SqlParam[]) {
        return [...storage.exec(sql, ...params)] as never;
      },
      run(sql: string, ...params: SqlParam[]) {
        storage.exec(sql, ...params);
      }
    };
  }
  if (isD1Database(src)) {
    const db = src;
    return {
      async query(sql: string, ...params: SqlParam[]) {
        const r = await db
          .prepare(sql)
          .bind(...params)
          .all();
        return r.results as never;
      },
      async run(sql: string, ...params: SqlParam[]) {
        await db
          .prepare(sql)
          .bind(...params)
          .run();
      }
    };
  }
  return src;
}

// ── Options ──────────────────────────────────────────────────────────

export interface WorkspaceOptions {
  /** SQL backend — SqlStorage, D1Database, or a custom SqlBackend. */
  sql: SqlSource;
  /** Namespace to isolate this workspace's tables (default: "default"). */
  namespace?: string;
  /** R2 bucket for large-file storage (optional). */
  r2?: R2Bucket;
  /** Prefix for R2 object keys. Defaults to `name`. */
  r2Prefix?: string;
  /** Byte threshold for spilling files to R2 (default: 1_500_000). */
  inlineThreshold?: number;
  /** Called when files/directories change. */
  onChange?: (event: WorkspaceChangeEvent) => void;
  /**
   * Name used as default R2 prefix and in observability events.
   * Accepts a string or a function for lazy evaluation (useful when
   * the name isn't available at class field initialization time, e.g.
   * in Durable Objects where `this.name` is set after construction).
   */
  name?: string | (() => string | undefined);
}

// ── Public types ─────────────────────────────────────────────────────

export type EntryType = "file" | "directory" | "symlink";

export type FileInfo = {
  path: string;
  name: string;
  type: EntryType;
  mimeType: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  target?: string;
};

export type FileStat = FileInfo;

export type WorkspaceChangeType = "create" | "update" | "delete";

export type WorkspaceChangeEvent = {
  type: WorkspaceChangeType;
  path: string;
  entryType: EntryType;
};

/**
 * Minimum set of `Workspace` methods required to satisfy the
 * `FileSystem` adapter (and therefore `createWorkspaceStateBackend`).
 *
 * A concrete `Workspace` trivially satisfies this. Callers who wrap a
 * `Workspace` behind their own layer — most commonly a cross-DO proxy
 * that forwards each call to a parent agent's real `Workspace` over
 * RPC — can satisfy `WorkspaceFsLike` without subclassing or casting,
 * and still pass the object to `WorkspaceFileSystem` or
 * `createWorkspaceStateBackend`.
 *
 * This is a strict superset of the `WorkspaceLike` shape that
 * `@cloudflare/think` uses for builtin tool wiring. Tooling that only
 * reaches for the narrow surface can stick with `WorkspaceLike`;
 * anything touching codemode's `state.*` via
 * `createWorkspaceStateBackend` needs this.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type WorkspaceFsLike = Pick<
  Workspace,
  | "readFile"
  | "readFileBytes"
  | "writeFile"
  | "writeFileBytes"
  | "appendFile"
  | "exists"
  | "stat"
  | "lstat"
  | "mkdir"
  | "readDir"
  | "rm"
  | "cp"
  | "mv"
  | "symlink"
  | "readlink"
  | "glob"
>;

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_INLINE_THRESHOLD = 1_500_000;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const MAX_SYMLINK_DEPTH = 40;
const VALID_NAMESPACE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const LIKE_ESCAPE = "\\";
const MAX_STREAM_SIZE = 100 * 1024 * 1024;
const MAX_DIFF_LINES = 10_000;
const MAX_PATH_LENGTH = 4096;
const MAX_SYMLINK_TARGET_LENGTH = 4096;
const MAX_MKDIR_DEPTH = 100;

/**
 * Options that affect where durable data lives. Two `Workspace` instances for
 * the same `{sql, namespace}` are allowed to coexist (for HMR, helpers, etc.)
 * but MUST agree on these — otherwise large files spill to different R2 keys
 * or sizes, and reads through one instance will fail to find data written
 * through the other.
 */
interface RegisteredConfig {
  r2: R2Bucket | null;
  r2Prefix: string | undefined;
  inlineThreshold: number;
}

const workspaceRegistry = new WeakMap<
  SqlSource,
  Map<string, RegisteredConfig>
>();

function describeR2(r2: R2Bucket | null): string {
  return r2 === null ? "none" : "R2 bucket";
}

const wsChannel = channel("agents:workspace");

// ── Workspace class ──────────────────────────────────────────────────

export class Workspace {
  private readonly sql: SqlBackend;
  private readonly _nameOrFn: string | (() => string | undefined) | undefined;
  private readonly namespace: string;
  private readonly tableName: string;
  private readonly indexName: string;
  private readonly r2: R2Bucket | null;
  private readonly r2Prefix: string | undefined;
  private readonly threshold: number;
  private readonly onChange:
    | ((event: WorkspaceChangeEvent) => void)
    | undefined;
  private initialized = false;

  constructor(options: WorkspaceOptions) {
    const { sql: source } = options;
    const ns = options.namespace ?? "default";
    if (!VALID_NAMESPACE.test(ns)) {
      throw new Error(
        `Invalid workspace namespace "${ns}": must start with a letter and contain only alphanumeric characters or underscores`
      );
    }

    const nextConfig: RegisteredConfig = {
      r2: options.r2 ?? null,
      r2Prefix: options.r2Prefix,
      inlineThreshold: options.inlineThreshold ?? DEFAULT_INLINE_THRESHOLD
    };

    // Idempotent by default: a second construction for the same {sql, namespace}
    // is allowed (Vite HMR, helper re-use, etc.) as long as the options that
    // control where durable data lives are identical. We only throw when the
    // configs diverge — that is a real correctness bug because large files
    // would be routed to different R2 keys or classified at different sizes,
    // and reads through one instance would fail to find data written via the
    // other. `onChange` is intentionally NOT checked: it's a per-instance
    // listener by design.
    const registered = workspaceRegistry.get(source) ?? new Map();
    const prevConfig = registered.get(ns);
    if (prevConfig) {
      const diffs: string[] = [];
      if (prevConfig.r2 !== nextConfig.r2) {
        diffs.push(
          `r2 (previous=${describeR2(prevConfig.r2)}, new=${describeR2(nextConfig.r2)})`
        );
      }
      if (prevConfig.r2Prefix !== nextConfig.r2Prefix) {
        diffs.push(
          `r2Prefix (previous=${JSON.stringify(prevConfig.r2Prefix)}, new=${JSON.stringify(nextConfig.r2Prefix)})`
        );
      }
      if (prevConfig.inlineThreshold !== nextConfig.inlineThreshold) {
        diffs.push(
          `inlineThreshold (previous=${prevConfig.inlineThreshold}, new=${nextConfig.inlineThreshold})`
        );
      }
      if (diffs.length > 0) {
        throw new Error(
          `Workspace "${ns}" on this sql was previously constructed with different options: ${diffs.join(", ")}. ` +
            "Two Workspaces sharing the same storage and namespace must use identical " +
            "r2, r2Prefix, and inlineThreshold or reads of large files will fail."
        );
      }
    } else {
      registered.set(ns, nextConfig);
      workspaceRegistry.set(source, registered);
    }

    this.sql = toBackend(source);
    this._nameOrFn = options.name;
    this.namespace = ns;
    this.tableName = `cf_workspace_${ns}`;
    this.indexName = `cf_workspace_${ns}_parent`;
    this.r2 = nextConfig.r2;
    this.r2Prefix = nextConfig.r2Prefix;
    this.threshold = nextConfig.inlineThreshold;
    this.onChange = options.onChange;
  }

  private get _name(): string | undefined {
    const v = this._nameOrFn;
    return typeof v === "function" ? v() : v;
  }

  private emit(
    type: WorkspaceChangeType,
    path: string,
    entryType: EntryType
  ): void {
    if (this.onChange) this.onChange({ type, path, entryType });
  }

  private _observe(type: string, payload: Record<string, unknown>): void {
    wsChannel.publish({
      type,
      name: this._name,
      payload: { ...payload, namespace: this.namespace },
      timestamp: Date.now()
    });
  }

  // ── Lazy table init ─────────────────────────────────────────────

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const T = this.tableName;
    const I = this.indexName;

    await this.sql.run(`
      CREATE TABLE IF NOT EXISTS ${T} (
        path            TEXT PRIMARY KEY,
        parent_path     TEXT NOT NULL,
        name            TEXT NOT NULL,
        type            TEXT NOT NULL CHECK(type IN ('file','directory','symlink')),
        mime_type       TEXT NOT NULL DEFAULT 'text/plain',
        size            INTEGER NOT NULL DEFAULT 0,
        storage_backend TEXT NOT NULL DEFAULT 'inline' CHECK(storage_backend IN ('inline','r2')),
        r2_key          TEXT,
        target          TEXT,
        content_encoding TEXT NOT NULL DEFAULT 'utf8',
        content         TEXT,
        created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        modified_at     INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);

    await this.sql.run(`CREATE INDEX IF NOT EXISTS ${I} ON ${T}(parent_path)`);

    const hasRoot =
      (
        await this.sql.query<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM ${T} WHERE path = '/'`
        )
      )[0]?.cnt ?? 0;

    if (hasRoot === 0) {
      const now = Math.floor(Date.now() / 1000);
      await this.sql.run(
        `INSERT INTO ${T}
          (path, parent_path, name, type, size, created_at, modified_at)
        VALUES ('/', '', '', 'directory', 0, ?, ?)`,
        now,
        now
      );
    }
  }

  // ── R2 helpers ─────────────────────────────────────────────────

  private getR2(): R2Bucket | null {
    return this.r2;
  }

  private resolveR2Prefix(): string {
    if (this.r2Prefix !== undefined) return this.r2Prefix;
    const name = this._name;
    if (!name) {
      throw new Error(
        "[Workspace] R2 is configured but no r2Prefix was provided and no name is available. " +
          "Either pass r2Prefix in WorkspaceOptions or provide a name."
      );
    }
    return name;
  }

  private r2Key(filePath: string): string {
    return `${this.resolveR2Prefix()}/${this.namespace}${filePath}`;
  }

  // ── Symlink resolution ────────────────────────────────────────

  private async resolveSymlink(path: string, depth = 0): Promise<string> {
    if (depth > MAX_SYMLINK_DEPTH) {
      throw new Error(`ELOOP: too many levels of symbolic links: ${path}`);
    }
    const T = this.tableName;
    const rows = await this.sql.query<{
      type: string;
      target: string | null;
    }>(`SELECT type, target FROM ${T} WHERE path = ?`, path);
    const r = rows[0];
    if (!r || r.type !== "symlink" || !r.target) return path;
    const resolved = r.target.startsWith("/")
      ? normalizePath(r.target)
      : normalizePath(getParent(path) + "/" + r.target);
    return this.resolveSymlink(resolved, depth + 1);
  }

  // ── Symlink API ───────────────────────────────────────────────

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.ensureInit();
    if (!target || target.trim().length === 0) {
      throw new Error("EINVAL: symlink target must not be empty");
    }
    if (target.length > MAX_SYMLINK_TARGET_LENGTH) {
      throw new Error(
        `ENAMETOOLONG: symlink target exceeds ${MAX_SYMLINK_TARGET_LENGTH} characters`
      );
    }
    const normalized = normalizePath(linkPath);
    if (normalized === "/")
      throw new Error("EPERM: cannot create symlink at root");

    const parentPath = getParent(normalized);
    const name = getBasename(normalized);
    const now = Math.floor(Date.now() / 1000);
    const T = this.tableName;

    await this.ensureParentDir(parentPath);

    const existing = (
      await this.sql.query<{ type: string }>(
        `SELECT type FROM ${T} WHERE path = ?`,
        normalized
      )
    )[0];
    if (existing) {
      throw new Error(`EEXIST: path already exists: ${linkPath}`);
    }

    await this.sql.run(
      `INSERT INTO ${T}
        (path, parent_path, name, type, target, size, created_at, modified_at)
      VALUES (?, ?, ?, 'symlink', ?, 0, ?, ?)`,
      normalized,
      parentPath,
      name,
      target,
      now,
      now
    );
    this.emit("create", normalized, "symlink");
  }

  async readlink(path: string): Promise<string> {
    await this.ensureInit();
    const normalized = normalizePath(path);
    const T = this.tableName;
    const rows = await this.sql.query<{
      type: string;
      target: string | null;
    }>(`SELECT type, target FROM ${T} WHERE path = ?`, normalized);
    const r = rows[0];
    if (!r) throw new Error(`ENOENT: no such file or directory: ${path}`);
    if (r.type !== "symlink" || !r.target)
      throw new Error(`EINVAL: not a symlink: ${path}`);
    return r.target;
  }

  async lstat(path: string): Promise<FileStat | null> {
    await this.ensureInit();
    const normalized = normalizePath(path);
    const T = this.tableName;
    const rows = await this.sql.query<{
      path: string;
      name: string;
      type: string;
      mime_type: string;
      size: number;
      created_at: number;
      modified_at: number;
      target: string | null;
    }>(
      `SELECT path, name, type, mime_type, size, created_at, modified_at, target
      FROM ${T} WHERE path = ?`,
      normalized
    );
    const r = rows[0];
    if (!r) return null;
    return toFileInfo(r);
  }

  // ── Metadata ───────────────────────────────────────────────────

  async stat(path: string): Promise<FileStat | null> {
    await this.ensureInit();
    const normalized = normalizePath(path);
    const resolved = await this.resolveSymlink(normalized);
    const T = this.tableName;
    const rows = await this.sql.query<{
      path: string;
      name: string;
      type: string;
      mime_type: string;
      size: number;
      created_at: number;
      modified_at: number;
      target: string | null;
    }>(
      `SELECT path, name, type, mime_type, size, created_at, modified_at, target
      FROM ${T} WHERE path = ?`,
      resolved
    );
    const r = rows[0];
    if (!r) return null;
    return toFileInfo(r);
  }

  // ── File I/O ───────────────────────────────────────────────────

  async readFile(path: string): Promise<string | null> {
    await this.ensureInit();
    const normalized = normalizePath(path);
    const resolved = await this.resolveSymlink(normalized);
    const T = this.tableName;
    const rows = await this.sql.query<{
      type: string;
      storage_backend: string;
      r2_key: string | null;
      content: string | null;
      content_encoding: string;
    }>(
      `SELECT type, storage_backend, r2_key, content, content_encoding
      FROM ${T} WHERE path = ?`,
      resolved
    );
    const r = rows[0];
    if (!r) return null;
    if (r.type !== "file") throw new Error(`EISDIR: ${path} is a directory`);
    this._observe("workspace:read", {
      path: resolved,
      storage: r.storage_backend as "inline" | "r2"
    });

    if (r.storage_backend === "r2" && r.r2_key) {
      const r2 = this.getR2();
      if (!r2) {
        throw new Error(
          `File ${path} is stored in R2 but no R2 bucket was provided`
        );
      }
      const obj = await r2.get(r.r2_key);
      if (!obj) return "";
      return await obj.text();
    }

    if (r.content_encoding === "base64" && r.content) {
      const bytes = base64ToBytes(r.content);
      return TEXT_DECODER.decode(bytes);
    }
    return r.content ?? "";
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    await this.ensureInit();
    const normalized = normalizePath(path);
    const resolved = await this.resolveSymlink(normalized);
    const T = this.tableName;
    const rows = await this.sql.query<{
      type: string;
      storage_backend: string;
      r2_key: string | null;
      content: string | null;
      content_encoding: string;
    }>(
      `SELECT type, storage_backend, r2_key, content, content_encoding
      FROM ${T} WHERE path = ?`,
      resolved
    );
    const r = rows[0];
    if (!r) return null;
    if (r.type !== "file") throw new Error(`EISDIR: ${path} is a directory`);
    this._observe("workspace:read", {
      path: resolved,
      storage: r.storage_backend as "inline" | "r2"
    });

    if (r.storage_backend === "r2" && r.r2_key) {
      const r2 = this.getR2();
      if (!r2) {
        throw new Error(
          `File ${path} is stored in R2 but no R2 bucket was provided`
        );
      }
      const obj = await r2.get(r.r2_key);
      if (!obj) return new Uint8Array(0);
      return new Uint8Array(await obj.arrayBuffer());
    }

    if (r.content_encoding === "base64" && r.content) {
      return base64ToBytes(r.content);
    }
    return TEXT_ENCODER.encode(r.content ?? "");
  }

  async writeFileBytes(
    path: string,
    data: Uint8Array | ArrayBuffer,
    mimeType = "application/octet-stream"
  ): Promise<void> {
    await this.ensureInit();
    const normalized = await this.resolveSymlink(normalizePath(path));
    if (normalized === "/")
      throw new Error("EISDIR: cannot write to root directory");

    const bytes = normalizeBytes(data);
    const size = bytes.byteLength;
    const parentPath = getParent(normalized);
    const name = getBasename(normalized);
    const now = Math.floor(Date.now() / 1000);
    const T = this.tableName;

    await this.ensureParentDir(parentPath);

    const existing = (
      await this.sql.query<{
        storage_backend: string;
        r2_key: string | null;
      }>(`SELECT storage_backend, r2_key FROM ${T} WHERE path = ?`, normalized)
    )[0];

    const r2 = this.getR2();

    if (size >= this.threshold && r2) {
      const key = this.r2Key(normalized);
      if (existing?.storage_backend === "r2" && existing.r2_key !== key) {
        await r2.delete(existing.r2_key!);
      }
      await r2.put(key, bytes, {
        httpMetadata: { contentType: mimeType }
      });
      try {
        await this.sql.run(
          `INSERT INTO ${T}
            (path, parent_path, name, type, mime_type, size,
             storage_backend, r2_key, content_encoding, content, created_at, modified_at)
          VALUES (?, ?, ?, 'file', ?, ?, 'r2', ?, 'base64', NULL, ?, ?)
          ON CONFLICT(path) DO UPDATE SET
            mime_type         = excluded.mime_type,
            size              = excluded.size,
            storage_backend   = 'r2',
            r2_key            = excluded.r2_key,
            content_encoding  = 'base64',
            content           = NULL,
            modified_at       = excluded.modified_at`,
          normalized,
          parentPath,
          name,
          mimeType,
          size,
          key,
          now,
          now
        );
      } catch (sqlErr) {
        try {
          await r2.delete(key);
        } catch {
          console.error(
            `[Workspace] Failed to clean up orphaned R2 object ${key} after SQL error`
          );
        }
        throw sqlErr;
      }
      this.emit(existing ? "update" : "create", normalized, "file");
      this._observe("workspace:write", {
        path: normalized,
        size,
        storage: "r2" as const,
        update: !!existing
      });
    } else {
      if (size >= this.threshold && !r2) {
        console.warn(
          `[Workspace] File ${path} is ${size} bytes but no R2 bucket was provided. Storing inline.`
        );
      }
      if (existing?.storage_backend === "r2" && existing.r2_key && r2) {
        await r2.delete(existing.r2_key);
      }
      const b64 = bytesToBase64(bytes);
      await this.sql.run(
        `INSERT INTO ${T}
          (path, parent_path, name, type, mime_type, size,
           storage_backend, r2_key, content_encoding, content, created_at, modified_at)
        VALUES (?, ?, ?, 'file', ?, ?, 'inline', NULL, 'base64', ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          mime_type         = excluded.mime_type,
          size              = excluded.size,
          storage_backend   = 'inline',
          r2_key            = NULL,
          content_encoding  = 'base64',
          content           = excluded.content,
          modified_at       = excluded.modified_at`,
        normalized,
        parentPath,
        name,
        mimeType,
        size,
        b64,
        now,
        now
      );
      this.emit(existing ? "update" : "create", normalized, "file");
      this._observe("workspace:write", {
        path: normalized,
        size,
        storage: "inline" as const,
        update: !!existing
      });
    }
  }

  async writeFile(
    path: string,
    content: string,
    mimeType = "text/plain"
  ): Promise<void> {
    await this.ensureInit();
    const normalized = await this.resolveSymlink(normalizePath(path));
    if (normalized === "/")
      throw new Error("EISDIR: cannot write to root directory");

    const parentPath = getParent(normalized);
    const name = getBasename(normalized);
    const bytes = TEXT_ENCODER.encode(content);
    const size = bytes.byteLength;
    const now = Math.floor(Date.now() / 1000);
    const T = this.tableName;

    await this.ensureParentDir(parentPath);

    const existing = (
      await this.sql.query<{
        storage_backend: string;
        r2_key: string | null;
      }>(`SELECT storage_backend, r2_key FROM ${T} WHERE path = ?`, normalized)
    )[0];

    const r2 = this.getR2();

    if (size >= this.threshold && r2) {
      const key = this.r2Key(normalized);

      if (existing?.storage_backend === "r2" && existing.r2_key !== key) {
        await r2.delete(existing.r2_key!);
      }

      await r2.put(key, bytes, {
        httpMetadata: { contentType: mimeType }
      });

      try {
        await this.sql.run(
          `INSERT INTO ${T}
            (path, parent_path, name, type, mime_type, size,
             storage_backend, r2_key, content_encoding, content, created_at, modified_at)
          VALUES (?, ?, ?, 'file', ?, ?, 'r2', ?, 'utf8', NULL, ?, ?)
          ON CONFLICT(path) DO UPDATE SET
            mime_type         = excluded.mime_type,
            size              = excluded.size,
            storage_backend   = 'r2',
            r2_key            = excluded.r2_key,
            content_encoding  = 'utf8',
            content           = NULL,
            modified_at       = excluded.modified_at`,
          normalized,
          parentPath,
          name,
          mimeType,
          size,
          key,
          now,
          now
        );
      } catch (sqlErr) {
        try {
          await r2.delete(key);
        } catch {
          console.error(
            `[Workspace] Failed to clean up orphaned R2 object ${key} after SQL error`
          );
        }
        throw sqlErr;
      }
      this.emit(existing ? "update" : "create", normalized, "file");
      this._observe("workspace:write", {
        path: normalized,
        size,
        storage: "r2" as const,
        update: !!existing
      });
    } else {
      if (size >= this.threshold && !r2) {
        console.warn(
          `[Workspace] File ${path} is ${size} bytes but no R2 bucket was provided. Storing inline — this may hit SQLite row limits for very large files.`
        );
      }

      if (existing?.storage_backend === "r2" && existing.r2_key && r2) {
        await r2.delete(existing.r2_key);
      }

      await this.sql.run(
        `INSERT INTO ${T}
          (path, parent_path, name, type, mime_type, size,
           storage_backend, r2_key, content_encoding, content, created_at, modified_at)
        VALUES (?, ?, ?, 'file', ?, ?, 'inline', NULL, 'utf8', ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          mime_type         = excluded.mime_type,
          size              = excluded.size,
          storage_backend   = 'inline',
          r2_key            = NULL,
          content_encoding  = 'utf8',
          content           = excluded.content,
          modified_at       = excluded.modified_at`,
        normalized,
        parentPath,
        name,
        mimeType,
        size,
        content,
        now,
        now
      );
      this.emit(existing ? "update" : "create", normalized, "file");
      this._observe("workspace:write", {
        path: normalized,
        size,
        storage: "inline" as const,
        update: !!existing
      });
    }
  }

  async readFileStream(
    path: string
  ): Promise<ReadableStream<Uint8Array> | null> {
    await this.ensureInit();
    const normalized = normalizePath(path);
    const resolved = await this.resolveSymlink(normalized);
    const T = this.tableName;
    const rows = await this.sql.query<{
      type: string;
      storage_backend: string;
      r2_key: string | null;
      content: string | null;
      content_encoding: string;
    }>(
      `SELECT type, storage_backend, r2_key, content, content_encoding
      FROM ${T} WHERE path = ?`,
      resolved
    );
    const r = rows[0];
    if (!r) return null;
    if (r.type !== "file") throw new Error(`EISDIR: ${path} is a directory`);
    this._observe("workspace:read", {
      path: resolved,
      storage: r.storage_backend as "inline" | "r2"
    });

    if (r.storage_backend === "r2" && r.r2_key) {
      const r2 = this.getR2();
      if (!r2) {
        throw new Error(
          `File ${path} is stored in R2 but no R2 bucket was provided`
        );
      }
      const obj = await r2.get(r.r2_key);
      if (!obj) {
        return new ReadableStream({
          start(c) {
            c.close();
          }
        });
      }
      return obj.body;
    }

    const bytes =
      r.content_encoding === "base64" && r.content
        ? base64ToBytes(r.content)
        : TEXT_ENCODER.encode(r.content ?? "");
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    });
  }

  async writeFileStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    mimeType = "application/octet-stream"
  ): Promise<void> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > MAX_STREAM_SIZE) {
        reader.cancel();
        throw new Error(
          `EFBIG: stream exceeds maximum size of ${MAX_STREAM_SIZE} bytes`
        );
      }
      chunks.push(value);
    }

    const buffer = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }

    await this.writeFileBytes(path, buffer, mimeType);
  }

  async appendFile(
    path: string,
    content: string,
    mimeType = "text/plain"
  ): Promise<void> {
    await this.ensureInit();
    const normalized = await this.resolveSymlink(normalizePath(path));
    const T = this.tableName;

    const row = (
      await this.sql.query<{
        type: string;
        storage_backend: string;
        content_encoding: string;
      }>(
        `SELECT type, storage_backend, content_encoding
        FROM ${T} WHERE path = ?`,
        normalized
      )
    )[0];

    if (!row) {
      await this.writeFile(path, content, mimeType);
      return;
    }

    if (row.type !== "file") {
      throw new Error(`EISDIR: ${path} is a directory`);
    }

    if (row.storage_backend === "inline" && row.content_encoding === "utf8") {
      const appendSize = TEXT_ENCODER.encode(content).byteLength;
      const now = Math.floor(Date.now() / 1000);
      await this.sql.run(
        `UPDATE ${T} SET
          content = content || ?,
          size = size + ?,
          modified_at = ?
        WHERE path = ?`,
        content,
        appendSize,
        now,
        normalized
      );
      this.emit("update", normalized, "file");
      return;
    }

    const existing = await this.readFile(path);
    await this.writeFile(path, (existing ?? "") + content, mimeType);
  }

  async deleteFile(path: string): Promise<boolean> {
    await this.ensureInit();
    const normalized = normalizePath(path);
    const T = this.tableName;
    const rows = await this.sql.query<{
      type: string;
      storage_backend: string;
      r2_key: string | null;
    }>(
      `SELECT type, storage_backend, r2_key FROM ${T} WHERE path = ?`,
      normalized
    );
    if (!rows[0]) return false;
    if (rows[0].type === "directory")
      throw new Error(`EISDIR: ${path} is a directory — use rm() instead`);

    if (rows[0].storage_backend === "r2" && rows[0].r2_key) {
      const r2 = this.getR2();
      if (r2) await r2.delete(rows[0].r2_key);
    }

    await this.sql.run(`DELETE FROM ${T} WHERE path = ?`, normalized);
    this.emit("delete", normalized, rows[0].type as EntryType);
    this._observe("workspace:delete", { path: normalized });
    return true;
  }

  async fileExists(path: string): Promise<boolean> {
    await this.ensureInit();
    const resolved = await this.resolveSymlink(normalizePath(path));
    const T = this.tableName;
    const rows = await this.sql.query<{ type: string }>(
      `SELECT type FROM ${T} WHERE path = ?`,
      resolved
    );
    return rows.length > 0 && rows[0].type === "file";
  }

  async exists(path: string): Promise<boolean> {
    await this.ensureInit();
    const normalized = normalizePath(path);
    const T = this.tableName;
    const rows = await this.sql.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM ${T} WHERE path = ?`,
      normalized
    );
    return (rows[0]?.cnt ?? 0) > 0;
  }

  // ── Directory operations ───────────────────────────────────────

  async readDir(
    dir = "/",
    opts?: { limit?: number; offset?: number }
  ): Promise<FileInfo[]> {
    await this.ensureInit();
    const normalized = normalizePath(dir);
    const limit = opts?.limit ?? 1000;
    const offset = opts?.offset ?? 0;
    const T = this.tableName;
    const rows = await this.sql.query<{
      path: string;
      name: string;
      type: string;
      mime_type: string;
      size: number;
      created_at: number;
      modified_at: number;
    }>(
      `SELECT path, name, type, mime_type, size, created_at, modified_at
      FROM ${T}
      WHERE parent_path = ?
      ORDER BY type ASC, name ASC
      LIMIT ? OFFSET ?`,
      normalized,
      limit,
      offset
    );
    return rows.map(toFileInfo);
  }

  async glob(pattern: string): Promise<FileInfo[]> {
    await this.ensureInit();
    const normalized = normalizePath(pattern);
    const prefix = getGlobPrefix(normalized);
    const likePattern = escapeLike(prefix) + "%";
    const regex = globToRegex(normalized);
    const T = this.tableName;

    const rows = await this.sql.query<{
      path: string;
      name: string;
      type: string;
      mime_type: string;
      size: number;
      created_at: number;
      modified_at: number;
      target: string | null;
    }>(
      `SELECT path, name, type, mime_type, size, created_at, modified_at, target
      FROM ${T}
      WHERE path LIKE ? ESCAPE ?
      ORDER BY path`,
      likePattern,
      LIKE_ESCAPE
    );

    return rows.filter((r) => regex.test(r.path)).map(toFileInfo);
  }

  async mkdir(
    path: string,
    opts?: { recursive?: boolean },
    _depth = 0
  ): Promise<void> {
    await this.ensureInit();
    if (_depth > MAX_MKDIR_DEPTH) {
      throw new Error(
        `ELOOP: mkdir recursion too deep (max ${MAX_MKDIR_DEPTH} levels)`
      );
    }
    const normalized = normalizePath(path);
    if (normalized === "/") return;
    const T = this.tableName;

    const existing = await this.sql.query<{ type: string }>(
      `SELECT type FROM ${T} WHERE path = ?`,
      normalized
    );

    if (existing.length > 0) {
      if (existing[0].type === "directory" && opts?.recursive) return;
      throw new Error(
        existing[0].type === "directory"
          ? `EEXIST: directory already exists: ${path}`
          : `EEXIST: path exists as a file: ${path}`
      );
    }

    const parentPath = getParent(normalized);
    const parentRows = await this.sql.query<{ type: string }>(
      `SELECT type FROM ${T} WHERE path = ?`,
      parentPath
    );

    if (!parentRows[0]) {
      if (opts?.recursive) {
        await this.mkdir(parentPath, { recursive: true }, _depth + 1);
      } else {
        throw new Error(`ENOENT: parent directory not found: ${parentPath}`);
      }
    } else if (parentRows[0].type !== "directory") {
      throw new Error(`ENOTDIR: parent is not a directory: ${parentPath}`);
    }

    const name = getBasename(normalized);
    const now = Math.floor(Date.now() / 1000);
    await this.sql.run(
      `INSERT INTO ${T}
        (path, parent_path, name, type, size, created_at, modified_at)
      VALUES (?, ?, ?, 'directory', 0, ?, ?)`,
      normalized,
      parentPath,
      name,
      now,
      now
    );
    this.emit("create", normalized, "directory");
    this._observe("workspace:mkdir", {
      path: normalized,
      recursive: !!opts?.recursive
    });
  }

  async rm(
    path: string,
    opts?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    await this.ensureInit();
    const normalized = normalizePath(path);
    if (normalized === "/")
      throw new Error("EPERM: cannot remove root directory");
    const T = this.tableName;

    const rows = await this.sql.query<{ type: string }>(
      `SELECT type FROM ${T} WHERE path = ?`,
      normalized
    );

    if (!rows[0]) {
      if (opts?.force) return;
      throw new Error(`ENOENT: no such file or directory: ${path}`);
    }

    if (rows[0].type === "directory") {
      const children = await this.sql.query<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM ${T} WHERE parent_path = ?`,
        normalized
      );
      if ((children[0]?.cnt ?? 0) > 0) {
        if (!opts?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty: ${path}`);
        }
        await this.deleteDescendants(normalized);
      }
    } else {
      const fileRow = (
        await this.sql.query<{
          storage_backend: string;
          r2_key: string | null;
        }>(
          `SELECT storage_backend, r2_key FROM ${T} WHERE path = ?`,
          normalized
        )
      )[0];
      if (fileRow?.storage_backend === "r2" && fileRow.r2_key) {
        const r2 = this.getR2();
        if (r2) await r2.delete(fileRow.r2_key);
      }
    }

    await this.sql.run(`DELETE FROM ${T} WHERE path = ?`, normalized);
    this.emit("delete", normalized, rows[0].type as EntryType);
    this._observe("workspace:rm", {
      path: normalized,
      recursive: !!opts?.recursive
    });
  }

  // ── Copy / Move ───────────────────────────────────────────────

  async cp(
    src: string,
    dest: string,
    opts?: { recursive?: boolean }
  ): Promise<void> {
    await this.ensureInit();
    const srcNorm = normalizePath(src);
    const destNorm = normalizePath(dest);
    const srcStat = await this.lstat(srcNorm);
    if (!srcStat) throw new Error(`ENOENT: no such file or directory: ${src}`);

    if (srcStat.type === "symlink") {
      const target = await this.readlink(srcNorm);
      await this.symlink(target, destNorm);
      return;
    }

    if (srcStat.type === "directory") {
      if (!opts?.recursive) {
        throw new Error(
          `EISDIR: cannot copy directory without recursive: ${src}`
        );
      }
      await this.mkdir(destNorm, { recursive: true });
      for (const child of await this.readDir(srcNorm)) {
        await this.cp(child.path, `${destNorm}/${child.name}`, opts);
      }
      return;
    }

    const bytes = await this.readFileBytes(srcNorm);
    if (bytes) {
      await this.writeFileBytes(destNorm, bytes, srcStat.mimeType);
    } else {
      await this.writeFile(destNorm, "", srcStat.mimeType);
    }
    this._observe("workspace:cp", {
      src: srcNorm,
      dest: destNorm,
      recursive: !!opts?.recursive
    });
  }

  async mv(
    src: string,
    dest: string,
    opts?: { recursive?: boolean }
  ): Promise<void> {
    await this.ensureInit();
    const srcNorm = normalizePath(src);
    const destNorm = normalizePath(dest);
    const srcStat = await this.lstat(srcNorm);
    if (!srcStat) throw new Error(`ENOENT: no such file or directory: ${src}`);

    if (srcStat.type === "directory") {
      if (!(opts?.recursive ?? true)) {
        throw new Error(
          `EISDIR: cannot move directory without recursive: ${src}`
        );
      }
      await this.cp(src, dest, { recursive: true });
      await this.rm(src, { recursive: true, force: true });
      return;
    }

    const destParent = getParent(destNorm);
    const destName = getBasename(destNorm);
    const T = this.tableName;
    await this.ensureParentDir(destParent);

    const existingDest = (
      await this.sql.query<{ type: string }>(
        `SELECT type FROM ${T} WHERE path = ?`,
        destNorm
      )
    )[0];
    if (existingDest) {
      if (existingDest.type === "directory") {
        throw new Error(`EISDIR: cannot overwrite directory: ${dest}`);
      }
      await this.deleteFile(destNorm);
    }

    if (srcStat.type === "file") {
      const row = (
        await this.sql.query<{
          storage_backend: string;
          r2_key: string | null;
        }>(`SELECT storage_backend, r2_key FROM ${T} WHERE path = ?`, srcNorm)
      )[0];
      if (row?.storage_backend === "r2" && row.r2_key) {
        const r2 = this.getR2();
        if (r2) {
          const newKey = this.r2Key(destNorm);
          const obj = await r2.get(row.r2_key);
          if (obj) {
            await r2.put(newKey, await obj.arrayBuffer(), {
              httpMetadata: obj.httpMetadata
            });
          }
          await r2.delete(row.r2_key);
          const now = Math.floor(Date.now() / 1000);
          await this.sql.run(
            `UPDATE ${T} SET
              path = ?,
              parent_path = ?,
              name = ?,
              r2_key = ?,
              modified_at = ?
            WHERE path = ?`,
            destNorm,
            destParent,
            destName,
            newKey,
            now,
            srcNorm
          );
          this.emit("delete", srcNorm, "file");
          this.emit("create", destNorm, "file");
          this._observe("workspace:mv", {
            src: srcNorm,
            dest: destNorm
          });
          return;
        }
      }
    }

    const now = Math.floor(Date.now() / 1000);
    await this.sql.run(
      `UPDATE ${T} SET
        path = ?,
        parent_path = ?,
        name = ?,
        modified_at = ?
      WHERE path = ?`,
      destNorm,
      destParent,
      destName,
      now,
      srcNorm
    );
    this.emit("delete", srcNorm, srcStat.type);
    this.emit("create", destNorm, srcStat.type);
    this._observe("workspace:mv", { src: srcNorm, dest: destNorm });
  }

  // ── Diff ───────────────────────────────────────────────────────

  async diff(pathA: string, pathB: string): Promise<string> {
    const contentA = await this.readFile(pathA);
    if (contentA === null) throw new Error(`ENOENT: no such file: ${pathA}`);
    const contentB = await this.readFile(pathB);
    if (contentB === null) throw new Error(`ENOENT: no such file: ${pathB}`);
    const linesA = contentA.split("\n").length;
    const linesB = contentB.split("\n").length;
    if (linesA > MAX_DIFF_LINES || linesB > MAX_DIFF_LINES) {
      throw new Error(
        `EFBIG: files too large for diff (max ${MAX_DIFF_LINES} lines)`
      );
    }
    return unifiedDiff(
      contentA,
      contentB,
      normalizePath(pathA),
      normalizePath(pathB)
    );
  }

  async diffContent(path: string, newContent: string): Promise<string> {
    const existing = await this.readFile(path);
    if (existing === null) throw new Error(`ENOENT: no such file: ${path}`);
    const linesA = existing.split("\n").length;
    const linesB = newContent.split("\n").length;
    if (linesA > MAX_DIFF_LINES || linesB > MAX_DIFF_LINES) {
      throw new Error(
        `EFBIG: content too large for diff (max ${MAX_DIFF_LINES} lines)`
      );
    }
    const normalized = normalizePath(path);
    return unifiedDiff(existing, newContent, normalized, normalized);
  }

  // ── Info ────────────────────────────────────────────────────────

  async getWorkspaceInfo(): Promise<{
    fileCount: number;
    directoryCount: number;
    totalBytes: number;
    r2FileCount: number;
  }> {
    await this.ensureInit();
    const T = this.tableName;
    const rows = await this.sql.query<{
      files: number;
      dirs: number;
      total: number;
      r2files: number;
    }>(
      `SELECT
        SUM(CASE WHEN type = 'file'                               THEN 1 ELSE 0 END) AS files,
        SUM(CASE WHEN type = 'directory'                          THEN 1 ELSE 0 END) AS dirs,
        COALESCE(SUM(CASE WHEN type = 'file' THEN size ELSE 0 END), 0)               AS total,
        SUM(CASE WHEN type = 'file' AND storage_backend = 'r2'   THEN 1 ELSE 0 END) AS r2files
      FROM ${T}`
    );
    return {
      fileCount: rows[0]?.files ?? 0,
      directoryCount: rows[0]?.dirs ?? 0,
      totalBytes: rows[0]?.total ?? 0,
      r2FileCount: rows[0]?.r2files ?? 0
    };
  }

  // ── Internal helpers ────────────────────────────────────────────

  /** @internal */
  async _getAllPaths(): Promise<string[]> {
    await this.ensureInit();
    const T = this.tableName;
    return (
      await this.sql.query<{ path: string }>(
        `SELECT path FROM ${T} ORDER BY path`
      )
    ).map((r) => r.path);
  }

  /** @internal */
  async _updateModifiedAt(path: string, mtime: Date): Promise<void> {
    await this.ensureInit();
    const normalized = normalizePath(path);
    const ts = Math.floor(mtime.getTime() / 1000);
    const T = this.tableName;
    await this.sql.run(
      `UPDATE ${T} SET modified_at = ? WHERE path = ?`,
      ts,
      normalized
    );
  }

  // ── Private helpers ────────────────────────────────────────────

  private async ensureParentDir(dirPath: string): Promise<void> {
    if (!dirPath || dirPath === "/") return;
    const T = this.tableName;

    const rows = await this.sql.query<{ type: string }>(
      `SELECT type FROM ${T} WHERE path = ?`,
      dirPath
    );
    if (rows[0]) {
      if (rows[0].type !== "directory") {
        throw new Error(`ENOTDIR: ${dirPath} is not a directory`);
      }
      return;
    }

    const missing: string[] = [dirPath];
    let current = getParent(dirPath);
    while (current && current !== "/") {
      const r = await this.sql.query<{ type: string }>(
        `SELECT type FROM ${T} WHERE path = ?`,
        current
      );
      if (r[0]) {
        if (r[0].type !== "directory") {
          throw new Error(`ENOTDIR: ${current} is not a directory`);
        }
        break;
      }
      missing.push(current);
      current = getParent(current);
    }

    const now = Math.floor(Date.now() / 1000);
    for (let i = missing.length - 1; i >= 0; i--) {
      const p = missing[i];
      const parentPath = getParent(p);
      const name = getBasename(p);
      await this.sql.run(
        `INSERT INTO ${T}
          (path, parent_path, name, type, size, created_at, modified_at)
        VALUES (?, ?, ?, 'directory', 0, ?, ?)`,
        p,
        parentPath,
        name,
        now,
        now
      );
      this.emit("create", p, "directory");
    }
  }

  private async deleteDescendants(dirPath: string): Promise<void> {
    const pattern = escapeLike(dirPath) + "/%";
    const T = this.tableName;

    const r2Rows = await this.sql.query<{ r2_key: string }>(
      `SELECT r2_key FROM ${T}
      WHERE path LIKE ? ESCAPE ?
        AND storage_backend = 'r2'
        AND r2_key IS NOT NULL`,
      pattern,
      LIKE_ESCAPE
    );

    if (r2Rows.length > 0) {
      const r2 = this.getR2();
      if (r2) {
        const keys = r2Rows.map((r) => r.r2_key);
        await r2.delete(keys);
      }
    }

    await this.sql.run(
      `DELETE FROM ${T} WHERE path LIKE ? ESCAPE ?`,
      pattern,
      LIKE_ESCAPE
    );
  }
}

// ── Base64 helpers ───────────────────────────────────────────────────

function normalizeBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError("writeFileBytes expected Uint8Array or ArrayBuffer");
}

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength))
    );
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ── Path helpers ─────────────────────────────────────────────────────

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => "\\" + ch);
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
  const result = "/" + resolved.join("/");
  if (result.length > MAX_PATH_LENGTH) {
    throw new Error(`ENAMETOOLONG: path exceeds ${MAX_PATH_LENGTH} characters`);
  }
  return result;
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
  target?: string | null;
}): FileInfo {
  const info: FileInfo = {
    path: r.path,
    name: r.name,
    type: r.type as EntryType,
    mimeType: r.mime_type,
    size: r.size,
    createdAt: r.created_at * 1000,
    updatedAt: r.modified_at * 1000
  };
  if (r.target) info.target = r.target;
  return info;
}

// ── Glob helpers ─────────────────────────────────────────────────────

function getGlobPrefix(pattern: string): string {
  const first = pattern.search(/[*?[{]/);
  if (first === -1) return pattern;
  const before = pattern.slice(0, first);
  const lastSlash = before.lastIndexOf("/");
  return lastSlash >= 0 ? before.slice(0, lastSlash + 1) : "/";
}

function globToRegex(pattern: string): RegExp {
  let i = 0;
  let re = "^";
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i += 2;
        if (pattern[i] === "/") {
          re += "(?:.+/)?";
          i++;
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        re += "\\[";
        i++;
      } else {
        re += pattern.slice(i, close + 1);
        i = close + 1;
      }
    } else if (ch === "{") {
      const close = pattern.indexOf("}", i + 1);
      if (close === -1) {
        re += "\\{";
        i++;
      } else {
        const inner = pattern
          .slice(i + 1, close)
          .split(",")
          .join("|");
        re += `(?:${inner})`;
        i = close + 1;
      }
    } else {
      re += ch.replace(/[.+^$|\\()]/g, "\\$&");
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

// ── Diff helpers ─────────────────────────────────────────────────────

function unifiedDiff(
  a: string,
  b: string,
  labelA: string,
  labelB: string,
  contextLines = 3
): string {
  if (a === b) return "";

  const linesA = a.split("\n");
  const linesB = b.split("\n");
  const edits = myersDiff(linesA, linesB);
  return formatUnified(edits, linesA, linesB, labelA, labelB, contextLines);
}

type Edit = {
  type: "keep" | "delete" | "insert";
  lineA: number;
  lineB: number;
};

function myersDiff(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const vSize = 2 * max + 1;
  const v = new Int32Array(vSize);
  v.fill(-1);
  const offset = max;
  v[offset + 1] = 0;

  const trace: Int32Array[] = [];

  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  const edits: Edit[] = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0; d--) {
    const vPrev = trace[d];
    const k = x - y;
    let prevK: number;
    if (
      k === -d ||
      (k !== d && vPrev[offset + k - 1] < vPrev[offset + k + 1])
    ) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vPrev[offset + prevK];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x--;
      y--;
      edits.push({ type: "keep", lineA: x, lineB: y });
    }
    if (d > 0) {
      if (x === prevX) {
        edits.push({ type: "insert", lineA: x, lineB: y - 1 });
        y--;
      } else {
        edits.push({ type: "delete", lineA: x - 1, lineB: y });
        x--;
      }
    }
  }

  edits.reverse();
  return edits;
}

function formatUnified(
  edits: Edit[],
  linesA: string[],
  linesB: string[],
  labelA: string,
  labelB: string,
  ctx: number
): string {
  const out: string[] = [];
  out.push(`--- ${labelA}`);
  out.push(`+++ ${labelB}`);

  const changes: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i].type !== "keep") changes.push(i);
  }
  if (changes.length === 0) return "";

  let i = 0;
  while (i < changes.length) {
    let start = Math.max(0, changes[i] - ctx);
    let end = Math.min(edits.length - 1, changes[i] + ctx);

    let j = i + 1;
    while (j < changes.length && changes[j] - ctx <= end + 1) {
      end = Math.min(edits.length - 1, changes[j] + ctx);
      j++;
    }

    let startA = edits[start].lineA;
    let startB = edits[start].lineB;
    let countA = 0;
    let countB = 0;
    const hunkLines: string[] = [];

    for (let idx = start; idx <= end; idx++) {
      const e = edits[idx];
      if (e.type === "keep") {
        hunkLines.push(` ${linesA[e.lineA]}`);
        countA++;
        countB++;
      } else if (e.type === "delete") {
        hunkLines.push(`-${linesA[e.lineA]}`);
        countA++;
      } else {
        hunkLines.push(`+${linesB[e.lineB]}`);
        countB++;
      }
    }

    out.push(`@@ -${startA + 1},${countA} +${startB + 1},${countB} @@`);
    out.push(...hunkLines);
    i = j;
  }

  return out.join("\n");
}
