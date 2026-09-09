import { WorkspaceFileSystem, type WorkspaceFsLike } from "@cloudflare/shell";
import {
  BACKGROUND_CONTEXT,
  err,
  ExecutionError,
  FileError,
  ok,
  toError,
  withAbortSignal,
  type Context,
  type ExecutionEnv,
  type FileInfo,
  type FileKind,
  type Result,
  type Shell,
  type ShellExecOptions
} from "@earendil-works/pi-agent-core";
import { Bash, type InitialFiles } from "just-bash";

/**
 * pi's {@link ExecutionEnv} — the filesystem and shell its built-in
 * `read`/`write`/`edit`/`bash` tools run against — implemented over a
 * `@cloudflare/shell` `Workspace` and an in-isolate `just-bash` interpreter.
 *
 * The module deliberately knows nothing about `PiHarness`: it is a port that
 * lifts into `packages/agents` unchanged.
 */

// ── Options ───────────────────────────────────────────────────────────────

export interface WorkspaceExecutionEnvOptions {
  /** Durable workspace backing every path in this environment. */
  readonly workspace: WorkspaceFsLike;
  /** Working directory for relative paths. @default "/" */
  readonly cwd?: string;
  /** Default environment variables offered to shell commands. */
  readonly env?: Record<string, string>;
  /** Maximum workspace files copied into one shell invocation. @default 2000 */
  readonly maxSnapshotFiles?: number;
  /** Maximum size of a single file copied into a shell invocation. @default 1_000_000 */
  readonly maxSnapshotFileBytes?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const DEFAULT_MAX_SNAPSHOT_FILES = 2_000;
const DEFAULT_MAX_SNAPSHOT_FILE_BYTES = 1_000_000;
const READDIR_PAGE_SIZE = 1_000;
const TEMP_ROOT = "/tmp";

/**
 * Synthetic paths the bash sandbox materializes for itself. New entries here
 * are never persisted; pre-existing workspace files under them still sync.
 */
const EXCLUDED_SYNC_ROOTS = ["/bin", "/usr", "/dev", "/proc", "/sys"];

// ── Path helpers ──────────────────────────────────────────────────────────

/** Normalize an absolute posix path, collapsing `.`, `..` and empty segments. */
function normalizeAbsolute(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** Join posix segments without forcing the result to be absolute. */
function joinPosix(parts: string[]): string {
  const joined = parts.filter((part) => part.length > 0).join("/");
  if (joined.length === 0) return ".";
  const absolute = joined.startsWith("/");
  const resolved: string[] = [];
  for (const part of joined.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && resolved.length > 0 && resolved.at(-1) !== "..") {
      resolved.pop();
      continue;
    }
    if (part === ".." && absolute) continue;
    resolved.push(part);
  }
  if (absolute) return `/${resolved.join("/")}`;
  return resolved.length === 0 ? "." : resolved.join("/");
}

function basename(path: string): string {
  const normalized = normalizeAbsolute(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? normalized.slice(1) : normalized.slice(index + 1);
}

function parentDir(path: string): string {
  const normalized = normalizeAbsolute(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

/**
 * Resolve one caller-supplied path against `cwd`.
 *
 * Deviation from pi's Node environment: a workspace has no home directory and
 * no host filesystem, so `~` addresses the workspace root and `file://` URLs
 * keep only their path component.
 */
function resolvePath(cwd: string, path: string): string {
  let normalized = path;
  if (normalized === "~") normalized = "/";
  else if (normalized.startsWith("~/")) normalized = normalized.slice(1);
  else if (normalized.startsWith("file://")) {
    try {
      normalized = decodeURIComponent(new URL(normalized).pathname);
    } catch {
      // Keep malformed URLs as ordinary paths: file methods never throw.
    }
  }
  return normalized.startsWith("/")
    ? normalizeAbsolute(normalized)
    : normalizeAbsolute(`${cwd}/${normalized}`);
}

// ── Error mapping ─────────────────────────────────────────────────────────

/**
 * `Workspace` reports failures as plain `Error`s whose message starts with the
 * conventional errno token, so the token is the mapping key.
 */
function toFileError(error: unknown, path?: string): FileError {
  if (error instanceof FileError) return error;
  const cause = toError(error);
  const code = /^(E[A-Z]+):/.exec(cause.message)?.[1];
  switch (code) {
    case "ENOENT":
      return new FileError("not_found", cause.message, path, cause);
    case "EACCES":
    case "EPERM":
      return new FileError("permission_denied", cause.message, path, cause);
    case "ENOTDIR":
      return new FileError("not_directory", cause.message, path, cause);
    case "EISDIR":
    case "ENOTEMPTY":
      return new FileError("is_directory", cause.message, path, cause);
    case "EINVAL":
    case "EEXIST":
    case "ELOOP":
    case "ENAMETOOLONG":
      return new FileError("invalid", cause.message, path, cause);
    default:
      return new FileError("unknown", cause.message, path, cause);
  }
}

function abortResult<TValue>(
  signal: AbortSignal | undefined,
  path?: string
): Result<TValue, FileError> | undefined {
  return signal?.aborted
    ? err(new FileError("aborted", "aborted", path))
    : undefined;
}

function resolveTimeoutMs(
  timeout: number | undefined
): Result<number | undefined, ExecutionError> {
  if (timeout === undefined) return ok(undefined);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return err(
      new ExecutionError(
        "timeout",
        "Invalid timeout: must be a finite number of seconds"
      )
    );
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    return err(
      new ExecutionError(
        "timeout",
        `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`
      )
    );
  }
  return ok(timeoutMs);
}

// ── Environment ───────────────────────────────────────────────────────────

/**
 * Build pi's {@link ExecutionEnv} over a durable `Workspace`.
 *
 * Every method resolves to a `Result` and never throws, as pi's contract
 * requires. Shell timeouts are expressed in **seconds**, matching
 * {@link ShellExecOptions}.
 */
export function createWorkspaceExecutionEnv(
  options: WorkspaceExecutionEnvOptions
): ExecutionEnv {
  return new WorkspaceExecutionEnv(options);
}

class WorkspaceExecutionEnv implements ExecutionEnv {
  cwd: string;
  readonly #workspace: WorkspaceFsLike;
  readonly #fs: WorkspaceFileSystem;
  readonly #env: Record<string, string>;
  readonly #maxSnapshotFiles: number;
  readonly #maxSnapshotFileBytes: number;

  constructor(options: WorkspaceExecutionEnvOptions) {
    this.cwd = normalizeAbsolute(options.cwd ?? "/");
    this.#workspace = options.workspace;
    this.#fs = new WorkspaceFileSystem(options.workspace);
    this.#env = { ...options.env };
    this.#maxSnapshotFiles =
      options.maxSnapshotFiles ?? DEFAULT_MAX_SNAPSHOT_FILES;
    this.#maxSnapshotFileBytes =
      options.maxSnapshotFileBytes ?? DEFAULT_MAX_SNAPSHOT_FILE_BYTES;
  }

  // ── Paths ───────────────────────────────────────────────────────────────

  async absolutePath(
    path: string,
    _context: Context
  ): Promise<Result<string, FileError>> {
    return ok(resolvePath(this.cwd, path));
  }

  async joinPath(
    parts: string[],
    _context: Context
  ): Promise<Result<string, FileError>> {
    return ok(joinPosix(parts));
  }

  async canonicalPath(
    path: string,
    context: Context
  ): Promise<Result<string, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult<string>(context.abortSignal, resolved);
    if (aborted) return aborted;
    try {
      return ok(await this.#fs.realpath(resolved));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  // ── Reads ───────────────────────────────────────────────────────────────

  async readTextFile(
    path: string,
    context: Context
  ): Promise<Result<string, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult<string>(context.abortSignal, resolved);
    if (aborted) return aborted;
    try {
      return ok(await this.#fs.readFile(resolved));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context
  ): Promise<Result<string[], FileError>> {
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
    const content = await this.readTextFile(path, context);
    if (!content.ok) return err(content.error);
    const lines = content.value.split("\n");
    // Node's readline yields no trailing empty line for a final newline and
    // strips the CR of CRLF pairs.
    if (lines.at(-1) === "") lines.pop();
    const stripped = lines.map((line) =>
      line.endsWith("\r") ? line.slice(0, -1) : line
    );
    return ok(
      options?.maxLines === undefined
        ? stripped
        : stripped.slice(0, options.maxLines)
    );
  }

  async readBinaryFile(
    path: string,
    context: Context
  ): Promise<Result<Uint8Array, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult<Uint8Array>(context.abortSignal, resolved);
    if (aborted) return aborted;
    try {
      return ok(await this.#fs.readFileBytes(resolved));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async fileInfo(
    path: string,
    context: Context
  ): Promise<Result<FileInfo, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult<FileInfo>(context.abortSignal, resolved);
    if (aborted) return aborted;
    try {
      const stat = await this.#workspace.lstat(resolved);
      if (!stat) {
        return err(
          new FileError(
            "not_found",
            `ENOENT: no such file or directory: ${resolved}`,
            resolved
          )
        );
      }
      return ok({
        name: basename(resolved),
        path: resolved,
        kind: stat.type as FileKind,
        size: stat.size,
        mtimeMs: stat.updatedAt
      });
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async listDir(
    path: string,
    context: Context
  ): Promise<Result<FileInfo[], FileError>> {
    const resolved = resolvePath(this.cwd, path);
    const signal = context.abortSignal;
    const aborted = abortResult<FileInfo[]>(signal, resolved);
    if (aborted) return aborted;
    try {
      if (resolved !== "/") {
        const stat = await this.#workspace.lstat(resolved);
        if (!stat) {
          return err(
            new FileError(
              "not_found",
              `ENOENT: no such file or directory: ${resolved}`,
              resolved
            )
          );
        }
        if (stat.type !== "directory") {
          return err(
            new FileError(
              "not_directory",
              `ENOTDIR: not a directory: ${resolved}`,
              resolved
            )
          );
        }
      }
      const infos: FileInfo[] = [];
      for (const entry of await this.#readAllDirEntries(resolved)) {
        const loopAbort = abortResult<FileInfo[]>(signal, resolved);
        if (loopAbort) return loopAbort;
        infos.push({
          name: entry.name,
          path: entry.path,
          kind: entry.type as FileKind,
          size: entry.size,
          mtimeMs: entry.updatedAt
        });
      }
      return ok(infos);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async exists(
    path: string,
    context: Context
  ): Promise<Result<boolean, FileError>> {
    const result = await this.fileInfo(path, context);
    if (result.ok) return ok(true);
    if (result.error.code === "not_found") return ok(false);
    return err(result.error);
  }

  // ── Writes ──────────────────────────────────────────────────────────────

  async writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context
  ): Promise<Result<void, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult<void>(context.abortSignal, resolved);
    if (aborted) return aborted;
    try {
      await this.#ensureParent(resolved);
      const afterMkdir = abortResult<void>(context.abortSignal, resolved);
      if (afterMkdir) return afterMkdir;
      if (typeof content === "string") {
        await this.#workspace.writeFile(resolved, content);
      } else {
        await this.#workspace.writeFileBytes(resolved, content);
      }
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context
  ): Promise<Result<void, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult<void>(context.abortSignal, resolved);
    if (aborted) return aborted;
    try {
      await this.#ensureParent(resolved);
      const afterMkdir = abortResult<void>(context.abortSignal, resolved);
      if (afterMkdir) return afterMkdir;
      await this.#fs.appendFile(resolved, content);
      return abortResult<void>(context.abortSignal, resolved) ?? ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context
  ): Promise<Result<void, FileError>> {
    const source = resolvePath(this.cwd, sourcePath);
    const destination = resolvePath(this.cwd, destinationPath);
    const aborted = abortResult<void>(context.abortSignal, destination);
    if (aborted) return aborted;
    try {
      await this.#ensureParent(destination);
      await this.#workspace.mv(source, destination);
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, source));
    }
  }

  async createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context
  ): Promise<Result<void, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult<void>(context.abortSignal, resolved);
    if (aborted) return aborted;
    try {
      await this.#workspace.mkdir(resolved, {
        recursive: options?.recursive ?? true
      });
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context
  ): Promise<Result<void, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult<void>(context.abortSignal, resolved);
    if (aborted) return aborted;
    try {
      await this.#workspace.rm(resolved, {
        recursive: options?.recursive ?? false,
        force: options?.force ?? false
      });
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async createTempDir(
    prefix: string | undefined,
    context: Context
  ): Promise<Result<string, FileError>> {
    const aborted = abortResult<string>(context.abortSignal);
    if (aborted) return aborted;
    const path = `${TEMP_ROOT}/${prefix ?? "tmp-"}${crypto.randomUUID()}`;
    try {
      await this.#workspace.mkdir(path, { recursive: true });
      return ok(path);
    } catch (error) {
      return err(toFileError(error, path));
    }
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context
  ): Promise<Result<string, FileError>> {
    const dir = await this.createTempDir("tmp-", context);
    if (!dir.ok) return err(dir.error);
    const filePath = `${dir.value}/${options?.prefix ?? ""}${crypto.randomUUID()}${options?.suffix ?? ""}`;
    try {
      await this.#workspace.writeFile(filePath, "");
      return ok(filePath);
    } catch (error) {
      return err(toFileError(error, filePath));
    }
  }

  // ── Shell ───────────────────────────────────────────────────────────────

  async exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context
  ): Promise<
    Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
  > {
    const signal = context.abortSignal;
    if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));

    const timeoutMsResult = resolveTimeoutMs(options?.timeout);
    if (!timeoutMsResult.ok) return err(timeoutMsResult.error);
    const timeoutMs = timeoutMsResult.value;
    const cwd = options?.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs);

    try {
      const snapshot = await this.#snapshot();
      let bash: Bash;
      try {
        bash = new Bash({
          files: snapshot.files,
          cwd,
          env: this.#shellEnv(options),
          defenseInDepth: true,
          // just-bash only registers `sleep` when a sleep function is supplied.
          // Racing the abort keeps a sleeping script cancellable.
          sleep: (ms) => abortableDelay(ms, controller.signal)
        });
      } catch (error) {
        const cause = toError(error);
        return err(new ExecutionError("spawn_error", cause.message, cause));
      }

      for (const directory of snapshot.directories) {
        await bash.fs.mkdir(directory, { recursive: true }).catch(() => {});
      }

      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      let failure: ExecutionError | undefined;
      try {
        const result = await bash.exec(command, {
          cwd,
          signal: controller.signal,
          rawScript: true
        });
        stdout = result.stdout;
        stderr = result.stderr;
        exitCode = result.exitCode;
      } catch (error) {
        const cause = toError(error);
        failure = timedOut
          ? new ExecutionError("timeout", `timeout:${options?.timeout}`, cause)
          : controller.signal.aborted
            ? new ExecutionError("aborted", "aborted", cause)
            : new ExecutionError("unknown", cause.message, cause);
      }

      // Side effects survive a failed or cancelled script, exactly as they
      // would on a real filesystem.
      await this.#sync(bash, snapshot);

      if (timedOut) {
        return err(
          failure?.code === "timeout"
            ? failure
            : new ExecutionError("timeout", `timeout:${options?.timeout}`)
        );
      }
      if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
      if (failure) return err(failure);

      const callbackError = notify(options, stdout, stderr, context);
      if (callbackError) return err(callbackError);
      return ok({ stdout, stderr, exitCode });
    } catch (error) {
      const cause = toError(error);
      return err(new ExecutionError("unknown", cause.message, cause));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  async cleanup(_context: Context): Promise<void> {
    // Nothing to release: the workspace outlives the environment and every
    // shell invocation is torn down with its interpreter.
  }

  // ── Internals ───────────────────────────────────────────────────────────

  #shellEnv(options: ShellExecOptions | undefined): Record<string, string> {
    if (options?.inheritEnv === false) return { ...options.env };
    return { ...this.#env, ...options?.env };
  }

  async #ensureParent(path: string): Promise<void> {
    const parent = parentDir(path);
    if (parent === "/") return;
    await this.#workspace.mkdir(parent, { recursive: true });
  }

  async #readAllDirEntries(dir: string) {
    const entries = [];
    let offset = 0;
    while (true) {
      const page = await this.#workspace.readDir(dir, {
        limit: READDIR_PAGE_SIZE,
        offset
      });
      entries.push(...page);
      if (page.length !== READDIR_PAGE_SIZE) break;
      offset += page.length;
    }
    return entries;
  }

  /** Copy the whole workspace into the shell's virtual filesystem. */
  async #snapshot(): Promise<Snapshot> {
    const files: InitialFiles = {};
    const initialFiles = new Map<string, Uint8Array>();
    const initialDirectories = new Set<string>(["/"]);
    const protectedPaths = new Set<string>();
    const pending = ["/"];

    while (pending.length > 0) {
      const dir = pending.shift() as string;
      for (const entry of await this.#readAllDirEntries(dir)) {
        const path = normalizeAbsolute(entry.path);
        if (entry.type === "directory") {
          initialDirectories.add(path);
          pending.push(path);
          continue;
        }
        if (entry.type !== "file") continue;
        if (
          initialFiles.size >= this.#maxSnapshotFiles ||
          entry.size > this.#maxSnapshotFileBytes
        ) {
          protectedPaths.add(path);
          continue;
        }
        const bytes = await this.#workspace.readFileBytes(path);
        if (bytes === null) {
          protectedPaths.add(path);
          continue;
        }
        files[path] = bytes;
        initialFiles.set(path, bytes);
      }
    }

    return {
      files,
      initialFiles,
      initialDirectories,
      protectedPaths,
      directories: [...initialDirectories].sort((a, b) => a.localeCompare(b))
    };
  }

  /** Write back everything the script created, changed, or deleted. */
  async #sync(bash: Bash, snapshot: Snapshot): Promise<void> {
    const finalFiles = new Map<string, Uint8Array>();
    const finalDirectories = new Set<string>(["/"]);

    for (const rawPath of bash.fs.getAllPaths()) {
      const path = normalizeAbsolute(rawPath);
      if (!shouldSync(path, snapshot)) continue;
      const stat = await bash.fs.stat(path).catch(() => null);
      if (stat?.isDirectory) {
        finalDirectories.add(path);
        continue;
      }
      if (stat?.isFile) {
        finalFiles.set(path, await bash.fs.readFileBuffer(path));
      }
    }

    for (const path of [...finalDirectories].sort((a, b) =>
      a.localeCompare(b)
    )) {
      if (path === "/" || snapshot.initialDirectories.has(path)) continue;
      if (hasProtectedDescendant(path, snapshot.protectedPaths)) continue;
      await this.#workspace.mkdir(path, { recursive: true }).catch(() => {});
    }

    for (const [path, bytes] of finalFiles) {
      if (snapshot.protectedPaths.has(path)) continue;
      const existing = snapshot.initialFiles.get(path);
      if (existing && bytesEqual(existing, bytes)) continue;
      await this.#ensureParent(path).catch(() => {});
      await this.#workspace.writeFileBytes(path, bytes).catch(() => {});
    }

    for (const path of [...snapshot.initialFiles.keys()].sort((a, b) =>
      b.localeCompare(a)
    )) {
      if (finalFiles.has(path) || snapshot.protectedPaths.has(path)) continue;
      await this.#workspace.rm(path, { force: true }).catch(() => {});
    }

    for (const path of [...snapshot.initialDirectories].sort((a, b) =>
      b.localeCompare(a)
    )) {
      if (path === "/" || finalDirectories.has(path)) continue;
      if (hasProtectedDescendant(path, snapshot.protectedPaths)) continue;
      await this.#workspace
        .rm(path, { recursive: true, force: true })
        .catch(() => {});
    }
  }
}

// ── Shell adapter ─────────────────────────────────────────────────────────

/** Result shape pi's coding agent expects from `core/exec.ts`. */
export interface ShellExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

/** Options accepted by {@link ShellExecAdapter.exec}. Timeouts are milliseconds. */
export interface ShellExecAdapterOptions {
  cwd?: string;
  /** Timeout in milliseconds, matching pi's `ExecOptions`. */
  timeout?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ShellExecAdapter {
  exec(
    command: string,
    args: string[],
    options?: ShellExecAdapterOptions
  ): Promise<ShellExecResult>;
}

/** Quote one argv entry for a bash command line. */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Adapt a pi {@link Shell} to the `(command, args, options)` exec function pi's
 * extension loader injects. Argv entries are quoted, never re-parsed, and a
 * failed `Result` becomes a non-zero `code` instead of a rejection.
 */
export function shellExecAdapter(
  shell: Shell,
  baseContext: Context = BACKGROUND_CONTEXT
): ShellExecAdapter {
  return {
    async exec(command, args, options) {
      const context =
        options?.signal === undefined
          ? baseContext
          : withAbortSignal(options.signal, baseContext);
      const line = [command, ...args].map(shellQuote).join(" ");
      const result = await shell.exec(
        line,
        {
          ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options?.env === undefined ? {} : { env: options.env }),
          ...(options?.timeout === undefined
            ? {}
            : { timeout: options.timeout / 1000 })
        },
        context
      );
      if (result.ok) {
        return {
          stdout: result.value.stdout,
          stderr: result.value.stderr,
          code: result.value.exitCode,
          killed: false
        };
      }
      return {
        stdout: "",
        stderr: result.error.message,
        code: result.error.code === "timeout" ? 124 : 1,
        killed:
          result.error.code === "timeout" || result.error.code === "aborted"
      };
    }
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

interface Snapshot {
  files: InitialFiles;
  initialFiles: Map<string, Uint8Array>;
  initialDirectories: Set<string>;
  protectedPaths: Set<string>;
  directories: string[];
}

function shouldSync(path: string, snapshot: Snapshot): boolean {
  if (path === "/") return false;
  if (snapshot.initialFiles.has(path)) return true;
  if (snapshot.protectedPaths.has(path)) return true;
  if (path === TEMP_ROOT || path.startsWith(`${TEMP_ROOT}/`)) return false;
  return !EXCLUDED_SYNC_ROOTS.some(
    (root) => path === root || path.startsWith(`${root}/`)
  );
}

function hasProtectedDescendant(
  path: string,
  protectedPaths: Set<string>
): boolean {
  const prefix = path.endsWith("/") ? path : `${path}/`;
  for (const protectedPath of protectedPaths) {
    if (protectedPath.startsWith(prefix)) return true;
  }
  return false;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Deliver one full stdout/stderr callback, converting throws to callback errors. */
function notify(
  options: ShellExecOptions | undefined,
  stdout: string,
  stderr: string,
  context: Context
): ExecutionError | undefined {
  try {
    if (stdout.length > 0) options?.onStdout?.(stdout, context);
    if (stderr.length > 0) options?.onStderr?.(stderr, context);
    return undefined;
  } catch (error) {
    const cause = toError(error);
    return new ExecutionError("callback_error", cause.message, cause);
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
