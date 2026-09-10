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
  /**
   * Maximum workspace files copied into one shell invocation.
   *
   * A workspace holding more fails the run, as with
   * {@link maxSnapshotTotalBytes}: every limit here is a refusal, never a
   * truncation.
   *
   * @default 2000
   */
  readonly maxSnapshotFiles?: number;
  /**
   * Maximum size of a single file copied into a shell invocation. A workspace
   * holding a larger one fails the run.
   *
   * @default 1_000_000
   */
  readonly maxSnapshotFileBytes?: number;
  /**
   * Maximum total size of the snapshot copied into one shell invocation.
   *
   * The per-file and per-count caps bound each dimension on its own, and a
   * workspace can exceed neither while still holding more bytes than an
   * isolate can hold at once — the snapshot lives in memory twice, as the
   * workspace's copy and the interpreter's. A run that would cross this
   * limit fails rather than truncating: a shell whose input silently lost
   * files reports success for a script that read the wrong tree.
   *
   * @default 8_388_608
   */
  readonly maxSnapshotTotalBytes?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const DEFAULT_MAX_SNAPSHOT_FILES = 2_000;
const DEFAULT_MAX_SNAPSHOT_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_SNAPSHOT_TOTAL_BYTES = 8 * 1024 * 1024;
const READDIR_PAGE_SIZE = 1_000;
const TEMP_ROOT = "/tmp";

/**
 * Roots the bash sandbox materializes for itself, plus {@link TEMP_ROOT}.
 *
 * One rule governs them, in both directions:
 *
 * - entries the *script* creates under them are never persisted — a sandbox
 *   `/bin/ls` is not workspace content;
 * - entries the *workspace* already holds under them are ordinary content:
 *   they are snapshotted into the shell, written back when the script changes
 *   them, and removed when the script removes them.
 *
 * The second half is why the sync passes must never delete a sandbox root or
 * anything under it wholesale. `/tmp` in particular holds the files
 * `createTempDir`/`createTempFile` just wrote, and the shell always
 * materializes these roots whether or not the workspace has content there.
 */
const SANDBOX_ROOTS = [TEMP_ROOT, "/bin", "/usr", "/dev", "/proc", "/sys"];

/** True when `path` is a sandbox root or lives under one. */
function inSandboxRoot(path: string): boolean {
  return SANDBOX_ROOTS.some(
    (root) => path === root || path.startsWith(`${root}/`)
  );
}

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
  readonly #maxSnapshotTotalBytes: number;

  constructor(options: WorkspaceExecutionEnvOptions) {
    this.cwd = normalizeAbsolute(options.cwd ?? "/");
    this.#workspace = options.workspace;
    this.#fs = new WorkspaceFileSystem(options.workspace);
    this.#env = { ...options.env };
    this.#maxSnapshotFiles =
      options.maxSnapshotFiles ?? DEFAULT_MAX_SNAPSHOT_FILES;
    this.#maxSnapshotFileBytes =
      options.maxSnapshotFileBytes ?? DEFAULT_MAX_SNAPSHOT_FILE_BYTES;
    this.#maxSnapshotTotalBytes =
      options.maxSnapshotTotalBytes ?? DEFAULT_MAX_SNAPSHOT_TOTAL_BYTES;
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
      let snapshot: Snapshot;
      try {
        snapshot = await this.#snapshot();
      } catch (error) {
        // The workspace is too big to hand to the interpreter. Say so instead
        // of running the script against a silently truncated tree.
        if (error instanceof SnapshotLimitError) {
          return err(new ExecutionError("spawn_error", error.message, error));
        }
        throw error;
      }
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
      // Links are made after the directories they live in, and a link that
      // cannot be made refuses the run: a script that saw a dangling name
      // where the workspace has a link would read and write the wrong path.
      for (const [path, target] of snapshot.symlinks) {
        try {
          await bash.fs.symlink(target, path);
        } catch (error) {
          const cause = toError(error);
          return err(
            new ExecutionError(
              "spawn_error",
              `Workspace symlink ${path} -> ${target} could not be recreated for the shell: ${cause.message}`,
              cause
            )
          );
        }
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
      const syncFailures = await this.#sync(bash, snapshot);

      // Output a killed script produced before it was killed is still output:
      // pi builds a tool's visible result from these callbacks alone, so it
      // has to be streamed on the failure paths too, before they return.
      const callbackError = notify(options, stdout, stderr, context);

      if (timedOut) {
        return err(
          failure?.code === "timeout"
            ? failure
            : new ExecutionError("timeout", `timeout:${options?.timeout}`)
        );
      }
      if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
      if (failure) return err(failure);
      if (callbackError) return err(callbackError);
      // The script ran; its writes did not all land. Reporting success here
      // would tell the model the files it wrote exist.
      if (syncFailures.length > 0) return err(syncError(syncFailures));
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

  /**
   * Copy the whole workspace into the shell's virtual filesystem.
   *
   * This snapshot/sync pair is a fork of Think's bash tool
   * (`packages/think/src/tools/workspace.ts`, the `#snapshot`/`#sync` engine
   * around its `BASH_EXCLUDED_SYNC_ROOTS`): same problem, same shape, one
   * layer apart. Fix a bug in either engine in both — the divergences here
   * are the sandbox-root rule documented at {@link SANDBOX_ROOTS} and the
   * symlink pass below, which Think's engine has no counterpart for yet.
   */
  async #snapshot(): Promise<Snapshot> {
    const files: InitialFiles = {};
    const initialFiles = new Map<string, Uint8Array>();
    const initialDirectories = new Set<string>(["/"]);
    const symlinks = new Map<string, string>();
    const protectedPaths = new Set<string>();
    const pending = ["/"];
    let totalBytes = 0;

    while (pending.length > 0) {
      const dir = pending.shift() as string;
      for (const entry of await this.#readAllDirEntries(dir)) {
        const path = normalizeAbsolute(entry.path);
        if (entry.type === "directory") {
          initialDirectories.add(path);
          pending.push(path);
          continue;
        }
        if (entry.type === "symlink") {
          if (initialFiles.size + symlinks.size >= this.#maxSnapshotFiles) {
            throw new SnapshotLimitError(
              `Workspace snapshot exceeds maxSnapshotFiles (${this.#maxSnapshotFiles} files) at ${path}; the shell cannot run against this workspace`
            );
          }
          // A link is carried across as a link. Snapshotting the file it
          // points at instead would hand the script a copy: `readlink` would
          // answer for a path that is not a link, and a write through the
          // link would land on the link rather than on its target. The
          // listing usually names the target already; a listing that does
          // not is asked.
          symlinks.set(
            path,
            entry.target ?? (await this.#workspace.readlink(path))
          );
          continue;
        }
        if (entry.type !== "file") continue;
        // Every limit refuses the run rather than hiding a file from the
        // shell. A snapshot that silently dropped one still syncs back over
        // the workspace, so a script that read a tree missing files would be
        // reported as a success — and `grep`, `find` and `cp -r` would all
        // answer for a workspace that does not exist.
        if (entry.size > this.#maxSnapshotFileBytes) {
          throw new SnapshotLimitError(
            `Workspace file ${path} is ${entry.size} bytes, over maxSnapshotFileBytes (${this.#maxSnapshotFileBytes}); the shell cannot run against this workspace`
          );
        }
        if (initialFiles.size + symlinks.size >= this.#maxSnapshotFiles) {
          throw new SnapshotLimitError(
            `Workspace snapshot exceeds maxSnapshotFiles (${this.#maxSnapshotFiles} files) at ${path}; the shell cannot run against this workspace`
          );
        }
        const bytes = await this.#workspace.readFileBytes(path);
        if (bytes === null) {
          protectedPaths.add(path);
          continue;
        }
        totalBytes += bytes.byteLength;
        if (totalBytes > this.#maxSnapshotTotalBytes) {
          throw new SnapshotLimitError(
            `Workspace snapshot exceeds maxSnapshotTotalBytes (${this.#maxSnapshotTotalBytes} bytes); the shell cannot run against this workspace`
          );
        }
        files[path] = bytes;
        initialFiles.set(path, bytes);
      }
    }

    return {
      files,
      initialFiles,
      initialDirectories,
      symlinks,
      protectedPaths,
      directories: [...initialDirectories].sort((a, b) => a.localeCompare(b))
    };
  }

  /**
   * Write back everything the script created, changed, or deleted, and report
   * every change that would not persist.
   *
   * A failed write-back is not a cosmetic problem: the script ran, the caller
   * is told it succeeded, and the file it wrote is not there. Every path is
   * still attempted — one unwritable file must not strand the rest — and the
   * failures come back for {@link WorkspaceExecutionEnv.exec} to turn into an
   * error the model can read.
   */
  async #sync(bash: Bash, snapshot: Snapshot): Promise<SyncFailure[]> {
    const failures: SyncFailure[] = [];
    const attempt = async (path: string, write: Promise<unknown>) => {
      try {
        await write;
      } catch (error) {
        failures.push({ path, message: toError(error).message });
      }
    };
    const finalFiles = new Map<string, Uint8Array>();
    const finalDirectories = new Set<string>(["/"]);
    const finalSymlinks = new Map<string, string>();
    /**
     * Drop a workspace entry whose kind no longer matches what the script
     * left under that name, without following it.
     *
     * `writeFileBytes` resolves symlinks, so writing a file back over a name
     * the script turned from a link into a regular file would overwrite the
     * link's *target* and leave the link in place — the workspace would then
     * disagree with the tree the script produced, and the target's old
     * content would be gone. The same holds for a name that changed between
     * file and directory. The snapshot already recorded every synced path's
     * kind, so the comparison costs nothing; a path the snapshot never saw
     * is checked with `lstat`, which reports the link itself.
     */
    const clearTypeChange = async (path: string, final: EntryKind) => {
      const before = snapshotKind(snapshot, path);
      if (before === final) return;
      const current =
        before ?? (await this.#workspace.lstat(path).catch(() => null))?.type;
      if (current === undefined || current === final) return;
      await this.#workspace.rm(path, { recursive: true, force: true });
    };

    for (const rawPath of bash.fs.getAllPaths()) {
      const path = normalizeAbsolute(rawPath);
      if (!shouldSync(path, snapshot)) continue;
      // `lstat`, not `stat`: a link to a file is a file to `stat`, and
      // writing its target's bytes back would replace the workspace's link
      // with a copy of what it pointed at.
      const stat = await bash.fs.lstat(path).catch(() => null);
      if (stat?.isSymbolicLink) {
        const target = await bash.fs.readlink(path).catch(() => null);
        if (target !== null) finalSymlinks.set(path, target);
        continue;
      }
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
      await attempt(
        path,
        (async () => {
          await clearTypeChange(path, "directory");
          await this.#workspace.mkdir(path, { recursive: true });
        })()
      );
    }

    for (const [path, bytes] of finalFiles) {
      if (snapshot.protectedPaths.has(path)) continue;
      const existing = snapshot.initialFiles.get(path);
      if (existing && bytesEqual(existing, bytes)) continue;
      await this.#ensureParent(path).catch(() => {});
      await attempt(
        path,
        (async () => {
          await clearTypeChange(path, "file");
          await this.#workspace.writeFileBytes(path, bytes);
        })()
      );
    }

    for (const [path, target] of finalSymlinks) {
      if (snapshot.symlinks.get(path) === target) continue;
      await this.#ensureParent(path).catch(() => {});
      await attempt(
        path,
        (async () => {
          // The workspace refuses to link over an existing name, so a
          // changed link replaces the old one — as does a name the script
          // turned from a file or a directory into a link.
          await this.#workspace
            .rm(path, { recursive: true, force: true })
            .catch(() => {});
          await this.#workspace.symlink(target, path);
        })()
      );
    }

    for (const path of snapshot.symlinks.keys()) {
      // A link the script replaced with a file or a directory of the same
      // name was already written back above; only a name that is gone
      // altogether is removed here.
      if (
        finalSymlinks.has(path) ||
        finalFiles.has(path) ||
        finalDirectories.has(path)
      ) {
        continue;
      }
      await attempt(path, this.#workspace.rm(path, { force: true }));
    }

    for (const path of [...snapshot.initialFiles.keys()].sort((a, b) =>
      b.localeCompare(a)
    )) {
      // A file the script replaced with a directory of the same name was
      // written back above; only a name that is gone altogether is removed.
      if (
        finalFiles.has(path) ||
        finalSymlinks.has(path) ||
        finalDirectories.has(path) ||
        snapshot.protectedPaths.has(path)
      ) {
        continue;
      }
      await attempt(path, this.#workspace.rm(path, { force: true }));
    }

    for (const path of [...snapshot.initialDirectories].sort((a, b) =>
      b.localeCompare(a)
    )) {
      if (path === "/" || finalDirectories.has(path)) continue;
      if (finalSymlinks.has(path) || finalFiles.has(path)) continue;
      // A sandbox root is never absent from the shell's view because the
      // shell owns it, so its absence from `finalDirectories` says nothing
      // about the script's intent — and a recursive delete here would take
      // the workspace's own `/tmp` content with it.
      if (inSandboxRoot(path)) continue;
      if (hasProtectedDescendant(path, snapshot.protectedPaths)) continue;
      await attempt(
        path,
        this.#workspace.rm(path, { recursive: true, force: true })
      );
    }

    return failures;
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

/** One workspace change a completed script left unpersisted. */
type SyncFailure = {
  readonly path: string;
  readonly message: string;
};

/** Raised when a workspace is too large to copy into one shell invocation. */
class SnapshotLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotLimitError";
  }
}

/** Name every path whose write-back failed, in the order they were tried. */
function syncError(failures: readonly SyncFailure[]): ExecutionError {
  const listed = failures
    .map((failure) => `${failure.path} (${failure.message})`)
    .join(", ");
  return new ExecutionError(
    "unknown",
    `The shell ran but the workspace could not be updated: ${listed}`
  );
}

interface Snapshot {
  files: InitialFiles;
  initialFiles: Map<string, Uint8Array>;
  initialDirectories: Set<string>;
  /**
   * Workspace symlinks, by link path, as the snapshot found them.
   *
   * just-bash's `files` option takes content only, so these are created on
   * the interpreter's filesystem after it is built, and the sync pass has to
   * know which paths were links rather than the files they resolve to.
   */
  symlinks: Map<string, string>;
  /**
   * Workspace files the shell never saw, because the workspace would not
   * hand their bytes over. Every size limit refuses the run instead, so this
   * only ever holds unreadable paths — and the sync passes must leave them
   * alone in both directions: the script could neither change nor delete a
   * file it was never shown.
   */
  protectedPaths: Set<string>;
  directories: string[];
}

/** Workspace entry kinds, as `lstat` reports them. */
type EntryKind = "file" | "directory" | "symlink";

/**
 * The kind the snapshot found at `path`, or `undefined` for a name it never
 * walked. The snapshot is authoritative for every path it carried in, so the
 * sync pass can tell a changed kind from an unchanged one without a read.
 */
function snapshotKind(snapshot: Snapshot, path: string): EntryKind | undefined {
  if (snapshot.symlinks.has(path)) return "symlink";
  if (snapshot.initialDirectories.has(path)) return "directory";
  if (snapshot.initialFiles.has(path)) return "file";
  return undefined;
}

function shouldSync(path: string, snapshot: Snapshot): boolean {
  if (path === "/") return false;
  // Anything the snapshot carried in is workspace content, wherever it lives.
  if (snapshot.initialFiles.has(path)) return true;
  if (snapshot.initialDirectories.has(path)) return true;
  if (snapshot.symlinks.has(path)) return true;
  if (snapshot.protectedPaths.has(path)) return true;
  return !inSandboxRoot(path);
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
