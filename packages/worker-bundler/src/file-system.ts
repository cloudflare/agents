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

  flush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A filesystem backed by Durable Object KV storage. Writes are buffered in an
 * in-memory overlay and only persisted to KV when `flush()` is called, avoiding
 * the cost of a KV write on every individual file operation. Reads are served
 * from the overlay when possible, falling back to KV, so callers always observe
 * their own writes immediately regardless of whether `flush()` has been called.
 */
export class DurableObjectKVFileSystem implements FileSystem {
  /**
   * An in-memory buffer of pending writes. Null until the first write occurs.
   *
   * Writes are held here rather than being sent directly to Durable Object KV
   * because KV I/O is comparatively expensive due to I/O gates blocking
   * side-effects until writes are confirmed durable. Reads consult the overlay
   * first so callers always observe their own writes immediately. The buffered
   * entries are only persisted to KV when `flush()` is called explicitly.
   *
   * Keys are stored in their fully-formatted form (i.e. with the path prefix
   * already applied) so they can be passed to `kv.put` directly during flush
   * without any transformation.
   */
  private writeOverlay: Map<string, string> | null = null;

  /**
   * @param storage The Durable Object storage instance to persist files to.
   * @param prefix  An optional path prefix prepended to every key stored in KV.
   *                Defaults to `"bundle/"`, which namespaces bundle files away
   *                from any other keys the Durable Object may store.
   */
  constructor(
    private storage: DurableObjectStorage,
    private prefix: string = "bundle/"
  ) {}

  read(path: string): string | null {
    const realPath = this.formatPath(path);
    return (
      this.writeOverlay?.get(realPath) ??
      this.storage.kv.get<string>(realPath) ??
      null
    );
  }

  write(path: string, content: string): void {
    if (this.writeOverlay === null) {
      this.writeOverlay = new Map();
    }
    const realPath = this.formatPath(path);
    this.writeOverlay.set(realPath, content);
  }

  async flush(): Promise<void> {
    if (this.writeOverlay === null) {
      return;
    }
    for (const [key, value] of this.writeOverlay) {
      this.storage.kv.put(key, value);
    }
    this.writeOverlay = null;
  }

  private formatPath(path: string): string {
    return `${this.prefix}${path}`;
  }
}

export function isFileSystem(
  obj: FileSystem | Record<string, string>
): obj is FileSystem {
  return "read" in obj && typeof obj.read === "function";
}
