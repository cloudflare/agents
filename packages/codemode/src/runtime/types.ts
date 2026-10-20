// Types for the JavaScript backend and the host that connects it.
//
// These started in @cloudflare/computer, which now builds on this
// package. Names keep their `Workspace` prefix so Computer can re-export
// them unchanged. Nothing here depends on Computer: the backend asks its
// host for a SQLite database, a filesystem, and whatever services its
// host module factories need.

export type WorkspaceRuntimeAccess = "read" | "read-write";

/** Per-call context the backend passes to every host module function. */
export interface WorkspaceModuleCallContext {
  /** Aborts when the call passes its deadline or the execution is cancelled. */
  readonly signal: AbortSignal;
  /** Epoch milliseconds after which the caller stops waiting for this call. */
  readonly deadline: number;
  /** Access level of the backend running the call. */
  readonly access: WorkspaceRuntimeAccess;
  /**
   * Resolve a path the isolate passed against the backend's root.
   * Rejects paths that escape the root or pass through a symlink.
   *
   * @param path - An absolute path, or one relative to the backend root.
   * @param options - Set `allowMissing` when the path may not exist yet.
   * @returns The confined absolute path.
   */
  resolvePath(
    path: string,
    options?: { readonly allowMissing?: boolean }
  ): Promise<string>;
}

/**
 * One host function exported by a host module.
 *
 * `args` holds the arguments the isolate passed, decoded from the wire.
 * They come from untrusted code, so parse them before use. The function
 * may return a value or a promise of one. Arguments and results cross
 * the isolate boundary as real values through Workers RPC, not as
 * encoded text. The result must be JSON-compatible plain data: the
 * bridge checks it at runtime and treats `undefined` as `null`.
 */
export type WorkspaceModuleFunction = (
  args: readonly WorkspaceRuntimeValue[],
  context: WorkspaceModuleCallContext
) => unknown;

/** Named functions a host module exports into the isolate. */
export type WorkspaceModuleFunctions = Readonly<
  Record<string, WorkspaceModuleFunction>
>;

/**
 * Builds a host module's functions from services the host provides. The
 * backend calls it once when it connects, with every field of the host
 * except `db` and `fs`. In `@cloudflare/computer` the services are the
 * Workspace's Git client, Artifacts client and runtime.
 */
export interface WorkspaceModuleFactory<Services extends object = object> {
  (services: Services): WorkspaceModuleFunctions;
  /**
   * What the module does and how to call it, for a model. The
   * JavaScript backend adds it to its own description. Objects of
   * functions are listed by their export names.
   */
  readonly description?: string;
}

/**
 * A module caller source can import.
 *
 * - A string is JavaScript source bundled into the isolate, with no host access.
 * - An object of functions is a host module. Its functions run in the
 *   Durable Object and each becomes a named export:
 *   `{ "ws:weather": { forecast } }` lets code write
 *   `import { forecast } from "ws:weather"`.
 * - A factory is a host module built from services the host passes when
 *   the backend connects.
 *
 * Host modules must use a `ws:*` specifier.
 */
export type WorkspaceModule<Services extends object = object> =
  | string
  | WorkspaceModuleFunctions
  | WorkspaceModuleFactory<Services>;

export type WorkspaceRuntimeValue =
  | null
  | boolean
  | number
  | string
  | WorkspaceRuntimeValue[]
  | { [key: string]: WorkspaceRuntimeValue };

export interface WorkspaceRuntimeStat {
  name: string;
  inode: number;
  mode: number;
  mtime: number;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/** The files code reads and writes through `node:fs`. */
export interface WorkspaceRuntimeFilesystem {
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  stat(path: string): Promise<WorkspaceRuntimeStat>;
  lstat(path: string): Promise<WorkspaceRuntimeStat>;
  readlink(path: string): Promise<string>;
  readdir(
    path: string,
    options?: { limit?: number }
  ): Promise<
    Array<{
      name: string;
      isFile: boolean;
      isDirectory: boolean;
      isSymbolicLink: boolean;
    }>
  >;
  find(
    directory: string,
    pattern?: string
  ): Promise<Array<{ path: string; type: "file" | "dir" }>>;
  ls(prefix: string): Promise<string[]>;
  grep(
    pattern: string,
    path: string,
    options?: { ignoreCase?: boolean }
  ): Promise<Array<{ path: string; line: number; text: string }>>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeFile(
    path: string,
    content: string | Uint8Array,
    options?: { exclusive?: boolean }
  ): Promise<void>;
  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
}

/**
 * SQLite the backend keeps execution records and their output in, in
 * tables named `workspace_runtime_*`. In a Durable Object it wraps
 * `ctx.storage.sql`.
 */
export interface WorkspaceRuntimeDatabase {
  run(query: string, ...bindings: unknown[]): void;
  /** Rows as plain objects, with BLOB columns as `Uint8Array`. */
  all<Row extends object>(query: string, ...bindings: unknown[]): Row[];
  one<Row extends object>(
    query: string,
    ...bindings: unknown[]
  ): Row | undefined;
  /** Runs `closure` in one transaction. Nested calls must work. */
  transactionSync<T>(closure: () => T): T;
}

/** A Worker Loader binding, or anything with the same `load` method. */
export interface WorkspaceRuntimeLoader {
  load(code: {
    compatibilityDate: string;
    compatibilityFlags?: string[];
    limits?: { cpuMs?: number };
    mainModule: string;
    modules: Record<string, string | { js?: string }>;
    globalOutbound?: Fetcher | null;
  }): {
    getEntrypoint(
      name?: string,
      options?: { limits?: { cpuMs?: number } }
    ): unknown;
  };
}

export type WorkspaceRuntimeEvent =
  | { id: string; seq: number; name: "stdout"; value: Uint8Array }
  | { id: string; seq: number; name: "stderr"; value: Uint8Array }
  | {
      id: string;
      seq: number;
      name: "exit";
      code: number;
      result?: WorkspaceRuntimeValue;
    };

export interface ModuleExecutionInput {
  id?: string;
  source: string;
  cwd?: string;
  input?: WorkspaceRuntimeValue;
  env?: Record<string, string>;
  stdin?: Uint8Array | string;
  timeoutMs?: number;
}

export interface ModuleExecutionEnvelope {
  id: string;
  // Identity of the process-local backend runtime that owns this
  // execution. Omitted by backends whose execution state is durable or
  // shared with the host.
  runtimeId?: string;
  events: ReadableStream<WorkspaceRuntimeEvent>;
}

export interface WorkspaceModuleBackendHandle {
  exec(input: ModuleExecutionInput): Promise<ModuleExecutionEnvelope>;
  getExec(input: {
    id: string;
    after?: number | "tail";
    runtimeId?: string;
  }): Promise<ModuleExecutionEnvelope>;
  killExec(input: {
    id: string;
    signal?: string;
    runtimeId?: string;
  }): Promise<void>;
  disposeExec(input: { id: string; runtimeId?: string }): Promise<void>;
  close?(): Promise<void>;
}

/**
 * What a module backend receives when it connects: storage for its
 * execution records, the files code sees, and the services its host
 * module factories are built from.
 */
export type WorkspaceModuleBackendHost<Services extends object = object> = {
  readonly db: WorkspaceRuntimeDatabase;
  readonly fs: WorkspaceRuntimeFilesystem;
} & Services;

export interface WorkspaceModuleBackend<Services extends object = object> {
  readonly protocol: "module";
  readonly id: string;
  readonly type: string;
  readonly callable?: boolean;
  /** What the backend tells a model about itself. */
  readonly description?: string;
  connect(
    host: WorkspaceModuleBackendHost<Services>
  ): Promise<WorkspaceModuleBackendHandle>;
}
