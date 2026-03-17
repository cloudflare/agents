import { channel } from "node:diagnostics_channel";

/**
 * Workspace — durable file storage backed by SQLite + optional R2.
 *
 * The `WorkspaceHost` interface accepts any object that provides async
 * `sqlQuery` / `sqlRun` tagged-template helpers.  For Agents whose built-in
 * `sql` is synchronous, pass `legacyWorkspaceHost(this)` or use the
 * `LegacyWorkspaceHost` union — the constructor detects and wraps it
 * automatically so `new Workspace(this)` keeps working unchanged.
 *
 * ```ts
 * import { Agent } from "agents";
 * import { Workspace } from "@cloudflare/isolate";
 *
 * class MyAgent extends Agent<Env> {
 *   workspace = new Workspace(this, {
 *     r2: this.env.WORKSPACE_FILES,
 *   });
 *
 *   async onMessage(conn, msg) {
 *     await this.workspace.writeFile("/hello.txt", "world");
 *     const content = await this.workspace.readFile("/hello.txt");
 *   }
 * }
 * ```
 *
 * @module workspace
 */

// ── Host interface ───────────────────────────────────────────────────

/** Async SQL host — supports D1 or any Promise-returning SQL backend. */
export interface WorkspaceHost {
  sqlQuery<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): Promise<T[]>;
  sqlRun(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): Promise<void>;
  /** Durable Object ID / name — used as the default R2 key prefix. */
  name?: string;
}

/**
 * Backward-compat host for Agents whose built-in `sql` is synchronous.
 * Pass `this` directly; the `Workspace` constructor wraps it automatically.
 */
export interface LegacyWorkspaceHost {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
  name?: string;
}

function adaptHost(host: WorkspaceHost | LegacyWorkspaceHost): WorkspaceHost {
  if ("sqlQuery" in host) return host as WorkspaceHost;
  const legacy = host as LegacyWorkspaceHost;
  return {
    sqlQuery<T = Record<string, string | number | boolean | null>>(
      strings: TemplateStringsArray,
      ...values: (string | number | boolean | null)[]
    ): Promise<T[]> {
      return Promise.resolve(legacy.sql<T>(strings, ...values));
    },
    sqlRun(
      strings: TemplateStringsArray,
      ...values: (string | number | boolean | null)[]
    ): Promise<void> {
      legacy.sql(strings, ...values);
      return Promise.resolve();
    },
    get name() {
      return legacy.name;
    }
  };
}

// ── Options ──────────────────────────────────────────────────────────

export interface WorkspaceOptions {
  /** Namespace to isolate this workspace's tables (default: "default"). */
  namespace?: string;
  /** R2 bucket for large-file storage (optional). */
  r2?: R2Bucket;
  /** Prefix for R2 object keys. Defaults to `host.name`. */
  r2Prefix?: string;
  /** Byte threshold for spilling files to R2 (default: 1_500_000). */
  inlineThreshold?: number;
  /** Called when files/directories change. */
  onChange?: (event: WorkspaceChangeEvent) => void;
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

const workspaceRegistry = new WeakMap<
  WorkspaceHost | LegacyWorkspaceHost,
  Set<string>
>();

const wsChannel = channel("agents:workspace");

// ── Workspace class ──────────────────────────────────────────────────

export class Workspace {
  private readonly host: WorkspaceHost;
  private readonly originalHost: WorkspaceHost | LegacyWorkspaceHost;
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
  private readonly sqlCache = new Map<
    TemplateStringsArray,
    TemplateStringsArray
  >();

  constructor(
    host: WorkspaceHost | LegacyWorkspaceHost,
    options?: WorkspaceOptions
  ) {
    const ns = options?.namespace ?? "default";
    if (!VALID_NAMESPACE.test(ns)) {
      throw new Error(
        `Invalid workspace namespace "${ns}": must start with a letter and contain only alphanumeric characters or underscores`
      );
    }

    const registered = workspaceRegistry.get(host) ?? new Set<string>();
    if (registered.has(ns)) {
      throw new Error(
        `Workspace namespace "${ns}" is already registered on this agent`
      );
    }
    registered.add(ns);
    workspaceRegistry.set(host, registered);

    this.originalHost = host;
    this.host = adaptHost(host);
    this.namespace = ns;
    this.tableName = `cf_workspace_${ns}`;
    this.indexName = `cf_workspace_${ns}_parent`;
    this.r2 = options?.r2 ?? null;
    this.r2Prefix = options?.r2Prefix;
    this.threshold = options?.inlineThreshold ?? DEFAULT_INLINE_THRESHOLD;
    this.onChange = options?.onChange;
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
      name: this.host.name,
      payload: { ...payload, namespace: this.namespace },
      timestamp: Date.now()
    });
  }

  // ── SQL helpers ─────────────────────────────────────────────────

  private async sqlQuery<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): Promise<T[]> {
    const tsa = this.resolveTsa(strings);
    return this.host.sqlQuery<T>(tsa, ...values);
  }

  private async sqlRun(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): Promise<void> {
    const tsa = this.resolveTsa(strings);
    return this.host.sqlRun(tsa, ...values);
  }

  private resolveTsa(strings: TemplateStringsArray): TemplateStringsArray {
    let tsa = this.sqlCache.get(strings);
    if (!tsa) {
      const replaced = strings.map((s) =>
        s
          .replace(/__TABLE__/g, this.tableName)
          .replace(/__INDEX__/g, this.indexName)
      );
      tsa = Object.assign(replaced, {
        raw: replaced
      }) as unknown as TemplateStringsArray;
      this.sqlCache.set(strings, tsa);
    }
    return tsa;
  }

  // ── Lazy table init ─────────────────────────────────────────────

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    await this.sqlRun`
      CREATE TABLE IF NOT EXISTS __TABLE__ (
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
    `;

    await this.sqlRun`
      CREATE INDEX IF NOT EXISTS __INDEX__
        ON __TABLE__(parent_path)
    `;

    const hasRoot =
      (
        await this.sqlQuery<{ cnt: number }>`
          SELECT COUNT(*) AS cnt FROM __TABLE__ WHERE path = '/'
        `
      )[0]?.cnt ?? 0;

    if (hasRoot === 0) {
      const now = Math.floor(Date.now() / 1000);
      await this.sqlRun`
        INSERT INTO __TABLE__
          (path, parent_path, name, type, size, created_at, modified_at)
        VALUES ('/', '', '', 'directory', 0, ${now}, ${now})
      `;
    }
  }

  // ── R2 helpers ─────────────────────────────────────────────────

  private getR2(): R2Bucket | null {
    return this.r2;
  }

  private resolveR2Prefix(): string {
    if (this.r2Prefix !== undefined) return this.r2Prefix;
    const name = this.host.name;
    if (!name) {
      throw new Error(
        "[Workspace] R2 is configured but no r2Prefix was provided and host.name is not available. " +
          "Either pass r2Prefix in WorkspaceOptions or ensure the host exposes a name property."
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
    const rows = await this.sqlQuery<{ type: string; target: string | null }>`
      SELECT type, target FROM __TABLE__ WHERE path = ${path}
    `;
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

    await this.ensureParentDir(parentPath);

    const existing = (
      await this.sqlQuery<{ type: string }>`
        SELECT type FROM __TABLE__ WHERE path = ${normalized}
      `
    )[0];
    if (existing) {
      throw new Error(`EEXIST: path already exists: ${linkPath}`);
    }

    await this.sqlRun`
      INSERT INTO __TABLE__
        (path, parent_path, name, type, target, size, created_at, modified_at)
      VALUES
        (${normalized}, ${parentPath}, ${name}, 'symlink', ${target}, 0, ${now}, ${now})
    `;
    this.emit("create", normalized, "symlink");
  }

  async readlink(path: string): Promise<string> {
    await this.ensureInit();
    const normalized = normalizePath(path);
    const rows = await this.sqlQuery<{ type: string; target: string | null }>`
      SELECT type, target FROM __TABLE__ WHERE path = ${normalized}
    `;
    const r = rows[0];
    if (!r) throw new Error(`ENOENT: no such file or directory: ${path}`);
    if (r.type !== "symlink" || !r.target)
      throw new Error(`EINVAL: not a symlink: ${path}`);
    return r.target;
  }

  async lstat(path: string): Promise<FileStat | null> {
    await this.ensureInit();
    const normalized = normalizePath(path);
    const rows = await this.sqlQuery<{
      path: string;
      name: string;
      type: string;
      mime_type: string;
      size: number;
      created_at: number;
      modified_at: number;
      target: string | null;
    }>`
      SELECT path, name, type, mime_type, size, created_at, modified_at, target
      FROM __TABLE__ WHERE path = ${normalized}
    `;
    const r = rows[0];
    if (!r) return null;
    return toFileInfo(r);
  }

  // ── Metadata ───────────────────────────────────────────────────

  async stat(path: string): Promise<FileStat | null> {
    await this.ensureInit();
    const normalized = normalizePath(path);
    const resolved = await this.resolveSymlink(normalized);
    const rows = await this.sqlQuery<{
      path: string;
      name: string;
      type: string;
      mime_type: string;
      size: number;
      created_at: number;
      modified_at: number;
      target: string | null;
    }>`
      SELECT path, name, type, mime_type, size, created_at, modified_at, target
      FROM __TABLE__ WHERE path = ${resolved}
    `;
    const r = rows[0];
    if (!r) return null;
    return toFileInfo(r);
  }

  // ── File I/O ───────────────────────────────────────────────────

  async readFile(path: string): Promise<string | null> {
    await this.ensureInit();
    const normalized = normalizePath(path);
    const resolved = await this.resolveSymlink(normalized);
    const rows = await this.sqlQuery<{
      type: string;
      storage_backend: string;
      r2_key: string | null;
      content: string | null;
      content_encoding: string;
    }>`
      SELECT type, storage_backend, r2_key, content, content_encoding
      FROM __TABLE__ WHERE path = ${resolved}
    `;
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
    const rows = await this.sqlQuery<{
      type: string;
      storage_backend: string;
      r2_key: string | null;
      content: string | null;
      content_encoding: string;
    }>`
      SELECT type, storage_backend, r2_key, content, content_encoding
      FROM __TABLE__ WHERE path = ${resolved}
    `;
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

    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const size = bytes.byteLength;
    const parentPath = getParent(normalized);
    const name = getBasename(normalized);
    const now = Math.floor(Date.now() / 1000);

    await this.ensureParentDir(parentPath);

    const existing = (
      await this.sqlQuery<{
        storage_backend: string;
        r2_key: string | null;
      }>`
        SELECT storage_backend, r2_key FROM __TABLE__ WHERE path = ${normalized}
      `
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
        await this.sqlRun`
          INSERT INTO __TABLE__
            (path, parent_path, name, type, mime_type, size,
             storage_backend, r2_key, content_encoding, content, created_at, modified_at)
          VALUES
            (${normalized}, ${parentPath}, ${name}, 'file', ${mimeType}, ${size},
             'r2', ${key}, 'base64', NULL, ${now}, ${now})
          ON CONFLICT(path) DO UPDATE SET
            mime_type         = excluded.mime_type,
            size              = excluded.size,
            storage_backend   = 'r2',
            r2_key            = excluded.r2_key,
            content_encoding  = 'base64',
            content           = NULL,
            modified_at       = excluded.modified_at
        `;
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
      await this.sqlRun`
        INSERT INTO __TABLE__
          (path, parent_path, name, type, mime_type, size,
           storage_backend, r2_key, content_encoding, content, created_at, modified_at)
        VALUES
          (${normalized}, ${parentPath}, ${name}, 'file', ${mimeType}, ${size},
           'inline', NULL, 'base64', ${b64}, ${now}, ${now})
        ON CONFLICT(path) DO UPDATE SET
          mime_type         = excluded.mime_type,
          size              = excluded.size,
          storage_backend   = 'inline',
          r2_key            = NULL,
          content_encoding  = 'base64',
          content           = excluded.content,
          modified_at       = excluded.modified_at
      `;
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

    await this.ensureParentDir(parentPath);

    const existing = (
      await this.sqlQuery<{
        storage_backend: string;
        r2_key: string | null;
      }>`
        SELECT storage_backend, r2_key FROM __TABLE__ WHERE path = ${normalized}
      `
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
        await this.sqlRun`
          INSERT INTO __TABLE__
            (path, parent_path, name, type, mime_type, size,
             storage_backend, r2_key, content_encoding, content, created_at, modified_at)
          VALUES
            (${normalized}, ${parentPath}, ${name}, 'file', ${mimeType}, ${size},
             'r2', ${key}, 'utf8', NULL, ${now}, ${now})
          ON CONFLICT(path) DO UPDATE SET
            mime_type         = excluded.mime_type,
            size              = excluded.size,
            storage_backend   = 'r2',
            r2_key            = excluded.r2_key,
            content_encoding  = 'utf8',
            content           = NULL,
            modified_at       = excluded.modified_at
        `;
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

      await this.sqlRun`
        INSERT INTO __TABLE__
          (path, parent_path, name, type, mime_type, size,
           storage_backend, r2_key, content_encoding, content, created_at, modified_at)
        VALUES
          (${normalized}, ${parentPath}, ${name}, 'file', ${mimeType}, ${size},
           'inline', NULL, 'utf8', ${content}, ${now}, ${now})
        ON CONFLICT(path) DO UPDATE SET
          mime_type         = excluded.mime_type,
          size              = excluded.size,
          storage_backend   = 'inline',
          r2_key            = NULL,
          content_encoding  = 'utf8',
          content           = excluded.content,
          modified_at       = excluded.modified_at
      `;
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
    const rows = await this.sqlQuery<{
      type: string;
      storage_backend: string;
      r2_key: string | null;
      content: string | null;
      content_encoding: string;
    }>`
      SELECT type, storage_backend, r2_key, content, content_encoding
      FROM __TABLE__ WHERE path = ${resolved}
    `;
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

    const row = (
      await this.sqlQuery<{
        type: string;
        storage_backend: string;
        content_encoding: string;
      }>`
        SELECT type, storage_backend, content_encoding
        FROM __TABLE__ WHERE path = ${normalized}
      `
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
      await this.sqlRun`
        UPDATE __TABLE__ SET
          content = content || ${content},
          size = size + ${appendSize},
          modified_at = ${now}
        WHERE path = ${normalized}
      `;
      this.emit("update", normalized, "file");
      return;
    }

    const existing = await this.readFile(path);
    await this.writeFile(path, (existing ?? "") + content, mimeType);
  }

  async deleteFile(path: string): Promise<boolean> {
    await this.ensureInit();
    const normalized = normalizePath(path);
    const rows = await this.sqlQuery<{
      type: string;
      storage_backend: string;
      r2_key: string | null;
    }>`
      SELECT type, storage_backend, r2_key FROM __TABLE__ WHERE path = ${normalized}
    `;
    if (!rows[0]) return false;
    if (rows[0].type === "directory")
      throw new Error(`EISDIR: ${path} is a directory — use rm() instead`);

    if (rows[0].storage_backend === "r2" && rows[0].r2_key) {
      const r2 = this.getR2();
      if (r2) await r2.delete(rows[0].r2_key);
    }

    await this.sqlRun`DELETE FROM __TABLE__ WHERE path = ${normalized}`;
    this.emit("delete", normalized, rows[0].type as EntryType);
    this._observe("workspace:delete", { path: normalized });
    return true;
  }

  async fileExists(path: string): Promise<boolean> {
    await this.ensureInit();
    const resolved = await this.resolveSymlink(normalizePath(path));
    const rows = await this.sqlQuery<{ type: string }>`
      SELECT type FROM __TABLE__ WHERE path = ${resolved}
    `;
    return rows.length > 0 && rows[0].type === "file";
  }

  async exists(path: string): Promise<boolean> {
    await this.ensureInit();
    const normalized = normalizePath(path);
    const rows = await this.sqlQuery<{ cnt: number }>`
      SELECT COUNT(*) AS cnt FROM __TABLE__ WHERE path = ${normalized}
    `;
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
    const rows = await this.sqlQuery<{
      path: string;
      name: string;
      type: string;
      mime_type: string;
      size: number;
      created_at: number;
      modified_at: number;
    }>`
      SELECT path, name, type, mime_type, size, created_at, modified_at
      FROM __TABLE__
      WHERE parent_path = ${normalized}
      ORDER BY type ASC, name ASC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map(toFileInfo);
  }

  async glob(pattern: string): Promise<FileInfo[]> {
    await this.ensureInit();
    const normalized = normalizePath(pattern);
    const prefix = getGlobPrefix(normalized);
    const likePattern = escapeLike(prefix) + "%";
    const regex = globToRegex(normalized);

    const rows = await this.sqlQuery<{
      path: string;
      name: string;
      type: string;
      mime_type: string;
      size: number;
      created_at: number;
      modified_at: number;
      target: string | null;
    }>`
      SELECT path, name, type, mime_type, size, created_at, modified_at, target
      FROM __TABLE__
      WHERE path LIKE ${likePattern} ESCAPE ${LIKE_ESCAPE}
      ORDER BY path
    `;

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

    const existing = await this.sqlQuery<{ type: string }>`
      SELECT type FROM __TABLE__ WHERE path = ${normalized}
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
    const parentRows = await this.sqlQuery<{ type: string }>`
      SELECT type FROM __TABLE__ WHERE path = ${parentPath}
    `;

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
    await this.sqlRun`
      INSERT INTO __TABLE__
        (path, parent_path, name, type, size, created_at, modified_at)
      VALUES (${normalized}, ${parentPath}, ${name}, 'directory', 0, ${now}, ${now})
    `;
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

    const rows = await this.sqlQuery<{ type: string }>`
      SELECT type FROM __TABLE__ WHERE path = ${normalized}
    `;

    if (!rows[0]) {
      if (opts?.force) return;
      throw new Error(`ENOENT: no such file or directory: ${path}`);
    }

    if (rows[0].type === "directory") {
      const children = await this.sqlQuery<{ cnt: number }>`
        SELECT COUNT(*) AS cnt FROM __TABLE__ WHERE parent_path = ${normalized}
      `;
      if ((children[0]?.cnt ?? 0) > 0) {
        if (!opts?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty: ${path}`);
        }
        await this.deleteDescendants(normalized);
      }
    } else {
      const fileRow = (
        await this.sqlQuery<{
          storage_backend: string;
          r2_key: string | null;
        }>`
          SELECT storage_backend, r2_key FROM __TABLE__ WHERE path = ${normalized}
        `
      )[0];
      if (fileRow?.storage_backend === "r2" && fileRow.r2_key) {
        const r2 = this.getR2();
        if (r2) await r2.delete(fileRow.r2_key);
      }
    }

    await this.sqlRun`DELETE FROM __TABLE__ WHERE path = ${normalized}`;
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
    await this.ensureParentDir(destParent);

    const existingDest = (
      await this.sqlQuery<{ type: string }>`
        SELECT type FROM __TABLE__ WHERE path = ${destNorm}
      `
    )[0];
    if (existingDest) {
      if (existingDest.type === "directory") {
        throw new Error(`EISDIR: cannot overwrite directory: ${dest}`);
      }
      await this.deleteFile(destNorm);
    }

    if (srcStat.type === "file") {
      const row = (
        await this.sqlQuery<{
          storage_backend: string;
          r2_key: string | null;
        }>`
          SELECT storage_backend, r2_key FROM __TABLE__ WHERE path = ${srcNorm}
        `
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
          await this.sqlRun`
            UPDATE __TABLE__ SET
              path = ${destNorm},
              parent_path = ${destParent},
              name = ${destName},
              r2_key = ${newKey},
              modified_at = ${now}
            WHERE path = ${srcNorm}
          `;
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
    await this.sqlRun`
      UPDATE __TABLE__ SET
        path = ${destNorm},
        parent_path = ${destParent},
        name = ${destName},
        modified_at = ${now}
      WHERE path = ${srcNorm}
    `;
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
    const rows = await this.sqlQuery<{
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
      FROM __TABLE__
    `;
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
    return (
      await this.sqlQuery<{ path: string }>`
        SELECT path FROM __TABLE__ ORDER BY path
      `
    ).map((r) => r.path);
  }

  /** @internal */
  async _updateModifiedAt(path: string, mtime: Date): Promise<void> {
    await this.ensureInit();
    const normalized = normalizePath(path);
    const ts = Math.floor(mtime.getTime() / 1000);
    await this.sqlRun`
      UPDATE __TABLE__ SET modified_at = ${ts} WHERE path = ${normalized}
    `;
  }

  // ── Private helpers ────────────────────────────────────────────

  private async ensureParentDir(dirPath: string): Promise<void> {
    if (!dirPath || dirPath === "/") return;

    const rows = await this.sqlQuery<{ type: string }>`
      SELECT type FROM __TABLE__ WHERE path = ${dirPath}
    `;
    if (rows[0]) {
      if (rows[0].type !== "directory") {
        throw new Error(`ENOTDIR: ${dirPath} is not a directory`);
      }
      return;
    }

    const missing: string[] = [dirPath];
    let current = getParent(dirPath);
    while (current && current !== "/") {
      const r = await this.sqlQuery<{ type: string }>`
        SELECT type FROM __TABLE__ WHERE path = ${current}
      `;
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
      await this.sqlRun`
        INSERT INTO __TABLE__
          (path, parent_path, name, type, size, created_at, modified_at)
        VALUES (${p}, ${parentPath}, ${name}, 'directory', 0, ${now}, ${now})
      `;
      this.emit("create", p, "directory");
    }
  }

  private async deleteDescendants(dirPath: string): Promise<void> {
    const pattern = escapeLike(dirPath) + "/%";

    const r2Rows = await this.sqlQuery<{ r2_key: string }>`
      SELECT r2_key FROM __TABLE__
      WHERE path LIKE ${pattern} ESCAPE ${LIKE_ESCAPE}
        AND storage_backend = 'r2'
        AND r2_key IS NOT NULL
    `;

    if (r2Rows.length > 0) {
      const r2 = this.getR2();
      if (r2) {
        const keys = r2Rows.map((r) => r.r2_key);
        await r2.delete(keys);
      }
    }

    await this
      .sqlRun`DELETE FROM __TABLE__ WHERE path LIKE ${pattern} ESCAPE ${LIKE_ESCAPE}`;
  }
}

// ── Base64 helpers ───────────────────────────────────────────────────

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
