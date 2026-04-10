export interface FileSystem {
  /**
   * Reads a file from the file system.
   * @param path The path to the file.
   * @returns The contents of the file, or `null` if the file does not exist.
   */
  read(path: string): string | null;

  /**
   * Writes a file to the file system.
   * @param path The path to the file.
   * @param content The contents of the file.
   */
  write(path: string, content: string): void;

  /**
   * Deletes a file from the file system.
   * @param path The path to the file.
   */
  delete(path: string): void;

  /**
   * Returns the logical paths of all files in the filesystem, optionally
   * filtered to those whose path starts with `prefix`.
   * @param prefix Optional path prefix to filter results.
   */
  list(prefix?: string): string[];

  /**
   * Depending on the implementation of the filesystem writes may be buffered
   * in-memory to avoid (comparatively) expensive I/O operations. This method
   * gives users of the filesystem a way to ensure that all writes are flushed
   * to disk.
   */
  flush(): Promise<void>;
}

/**
 * A simple in-memory filesystem backed by a `Map`. Intended for use in tests
 * and build pipelines where persistence is not required.
 */
export class InMemoryFileSystem implements FileSystem {
  private files: Map<string, string> = new Map();

  /**
   * @param files Optional initial file contents. Accepts either a plain object
   * (keys are paths, values are file contents) or a `Map`. Defaults to an
   * empty filesystem.
   */
  constructor(files: Record<string, string> | Map<string, string> = new Map()) {
    this.files = files instanceof Map ? files : new Map(Object.entries(files));
  }

  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  write(path: string, content: string): void {
    this.files.set(path, content);
  }

  delete(path: string): void {
    this.files.delete(path);
  }

  list(prefix?: string): string[] {
    return Array.from(this.files.keys()).filter(
      (path) => prefix === undefined || path.startsWith(prefix)
    );
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A generic write-overlay on top of any `FileSystem`. Not exported — intended
 * as an implementation detail for higher-level filesystem classes.
 *
 * Writes and deletes are buffered in memory keyed by the raw (untransformed)
 * path. Reads are served from the write buffer first; deleted paths return
 * `null`; remaining reads are delegated to the inner filesystem. `flush()`
 * drains deletes and writes into the inner filesystem, awaits `inner.flush()`,
 * and then clears the buffers.
 */
export class OverlayFileSystem implements FileSystem {
  private overlay: Map<string, string> | null = null;
  private deletions: Set<string> | null = null;

  constructor(private readonly inner: FileSystem) {}

  read(path: string): string | null {
    if (this.overlay?.has(path)) {
      return this.overlay.get(path) ?? null;
    }
    if (this.deletions?.has(path)) {
      return null;
    }
    return this.inner.read(path);
  }

  write(path: string, content: string): void {
    if (this.overlay === null) {
      this.overlay = new Map();
    }
    this.overlay.set(path, content);
    this.deletions?.delete(path);
  }

  delete(path: string): void {
    this.overlay?.delete(path);
    if (this.deletions === null) {
      this.deletions = new Set();
    }
    this.deletions.add(path);
  }

  list(prefix?: string): string[] {
    const innerPaths = this.inner
      .list(prefix)
      .filter((path) => !this.deletions?.has(path));
    // Union of inner paths and overlay paths, with overlay entries taking
    // precedence (Set deduplicates paths that appear in both).
    const result = new Set(innerPaths);
    for (const path of this.overlay?.keys() ?? []) {
      if (prefix === undefined || path.startsWith(prefix)) {
        result.add(path);
      }
    }
    return Array.from(result);
  }

  async flush(): Promise<void> {
    if (this.overlay === null && this.deletions === null) {
      return;
    }
    for (const path of this.deletions ?? []) {
      this.inner.delete(path);
    }
    for (const [path, content] of this.overlay ?? []) {
      this.inner.write(path, content);
    }
    await this.inner.flush();
    this.overlay = null;
    this.deletions = null;
  }
}

/**
 * A filesystem backed directly by Durable Object KV storage. Every write is
 * committed to KV synchronously with no in-memory buffering, and `flush()` is
 * a no-op.
 *
 * Use this when you want immediate, per-write durability and the overhead of
 * individual KV writes is acceptable — for example, when seeding a small number
 * of files. For bulk write workloads, prefer `DurableObjectKVFileSystem`, which
 * batches all writes into a single flush.
 */
export class DurableObjectRawFileSystem implements FileSystem {
  /**
   * @param storage The Durable Object storage instance to persist files to.
   * @param prefix  An optional path prefix prepended to every key stored in KV.
   *                Defaults to `"bundle/"`, which namespaces bundle files away
   *                from any other keys the Durable Object may store.
   */
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly prefix: string = "bundle/"
  ) {}

  read(path: string): string | null {
    return this.storage.kv.get<string>(this.formatPath(path)) ?? null;
  }

  write(path: string, content: string): void {
    this.storage.kv.put(this.formatPath(path), content);
  }

  delete(path: string): void {
    this.storage.kv.delete(this.formatPath(path));
  }

  list(prefix?: string): string[] {
    const formattedPrefix =
      prefix !== undefined ? this.formatPath(prefix) : this.prefix;
    // kv.list() returns Iterable<[key, value]>. Strip the storage prefix from
    // each key so callers always receive logical paths, consistent with
    // InMemoryFileSystem.list().
    const result: string[] = [];
    for (const [key] of this.storage.kv.list({ prefix: formattedPrefix })) {
      result.push(key.slice(this.prefix.length));
    }
    return result;
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  private formatPath(path: string): string {
    return `${this.prefix}${path}`;
  }
}

/**
 * A filesystem backed by Durable Object KV storage with a write-overlay.
 * Writes are buffered in memory and only persisted to KV when `flush()` is
 * called, avoiding the cost of a KV write on every individual file operation.
 * Reads are served from the overlay when possible, falling back to KV, so
 * callers always observe their own writes immediately.
 *
 * Implemented as an `OverlayFileSystem` wrapping a `DurableObjectRawFileSystem`.
 * Use `DurableObjectRawFileSystem` directly if you want immediate per-write KV
 * durability without buffering.
 */
export class DurableObjectKVFileSystem implements FileSystem {
  private readonly fs: OverlayFileSystem;

  /**
   * @param storage The Durable Object storage instance to persist files to.
   * @param prefix  An optional path prefix prepended to every key stored in KV.
   *                Defaults to `"bundle/"`, which namespaces bundle files away
   *                from any other keys the Durable Object may store.
   */
  constructor(storage: DurableObjectStorage, prefix: string = "bundle/") {
    this.fs = new OverlayFileSystem(
      new DurableObjectRawFileSystem(storage, prefix)
    );
  }

  read(path: string): string | null {
    return this.fs.read(path);
  }

  write(path: string, content: string): void {
    this.fs.write(path, content);
  }

  delete(path: string): void {
    this.fs.delete(path);
  }

  list(prefix?: string): string[] {
    return this.fs.list(prefix);
  }

  flush(): Promise<void> {
    return this.fs.flush();
  }
}

/**
 * Creates an `InMemoryFileSystem` from an async source of file entries.
 *
 * This is the bridge between async storage backends (e.g. a Durable Object
 * `Workspace` backed by SQLite/R2) and the synchronous `FileSystem` interface
 * required by the bundler and TypeScript language service.
 *
 * @example
 * ```ts
 * // Snapshot a Workspace into a bundler-compatible FileSystem
 * async function* workspaceFiles(workspace) {
 *   for (const entry of workspace.glob("**\/*.{ts,tsx,json}")) {
 *     const content = await workspace.readFile(entry.path);
 *     if (content !== null) yield [entry.path, content];
 *   }
 * }
 *
 * const fs = await createFileSystemSnapshot(workspaceFiles(workspace));
 * const { languageService } = await createTypescriptLanguageService({ fileSystem: fs });
 * ```
 */
export async function createFileSystemSnapshot(
  entries:
    | AsyncIterable<readonly [string, string]>
    | Iterable<readonly [string, string]>
): Promise<InMemoryFileSystem> {
  const fs = new InMemoryFileSystem();
  for await (const [path, content] of entries) {
    fs.write(path, content);
  }
  return fs;
}

export function isFileSystem(
  obj: FileSystem | Record<string, string>
): obj is FileSystem {
  return (
    "read" in obj &&
    typeof obj.read === "function" &&
    "delete" in obj &&
    typeof obj.delete === "function"
  );
}
