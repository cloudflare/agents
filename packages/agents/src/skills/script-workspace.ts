/**
 * The Workspace a skill script reaches through `ctx.workspace`: a
 * `Workspace` from `@cloudflare/computer`, or anything with the same `fs`
 * methods.
 */
export interface SkillScriptWorkspace {
  readonly fs: {
    stat(path: string): Promise<{ size: number; isDirectory: boolean }>;
    readFile(path: string): Promise<ReadableStream<Uint8Array>>;
    writeFile(path: string, content: Uint8Array): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    readdir(
      path: string
    ): Promise<Array<{ name: string; size: number; isDirectory: boolean }>>;
    find(
      directory: string,
      pattern?: string
    ): Promise<Array<{ path: string; type: "file" | "dir" }>>;
  };
}

/** Directory skill scripts and relative paths resolve against. */
const WORKSPACE_ROOT = "/workspace";
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** @internal File operations a skill script reaches through its host. */
export interface SkillWorkspaceAccess {
  /** Read UTF-8 text, or `null` when the file does not exist. */
  readFile(path: string): Promise<string | null>;
  /** List a directory. */
  listFiles(
    path: string
  ): Promise<Array<{ path: string; name: string; type: string; size: number }>>;
  /** Find paths matching a glob. */
  glob(
    pattern: string
  ): Promise<Array<{ path: string; type: string; size: number }>>;
  /** Describe a path, or `null` when it does not exist. */
  stat(path: string): Promise<{ type: string; size: number } | null>;
  /** Write a file, creating missing parent directories. */
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
}

/**
 * @internal Adapt a Workspace for skill scripts. Relative paths resolve
 * against `/workspace`, and paths outside `/workspace` are rejected.
 */
export function createSkillWorkspaceAccess(
  workspace: SkillScriptWorkspace
): SkillWorkspaceAccess {
  const { fs } = workspace;
  const access: SkillWorkspaceAccess = {
    async readFile(path) {
      try {
        return TEXT_DECODER.decode(
          await drain(await fs.readFile(resolvePath(path)))
        );
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async listFiles(path) {
      const directory = resolvePath(path);
      const entries = await fs.readdir(directory);
      return entries.map((entry) => ({
        path: `${directory.replace(/\/$/, "")}/${entry.name}`,
        name: entry.name,
        type: entry.isDirectory ? "directory" : "file",
        size: entry.size
      }));
    },
    async glob(pattern) {
      const segments = resolvePath(pattern).split("/").filter(Boolean);
      const firstGlob = segments.findIndex((part) => /[*?[\]{}]/.test(part));
      if (firstGlob === -1) {
        const path = `/${segments.join("/")}`;
        const found = await access.stat(path);
        return found === null ? [] : [{ path, ...found }];
      }
      let matches: Array<{ path: string; type: "file" | "dir" }>;
      try {
        matches = await fs.find(
          `/${segments.slice(0, firstGlob).join("/")}`,
          segments.slice(firstGlob).join("/")
        );
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
      // `find` walks real entries under the resolved base; keep the result
      // inside the root even if the Workspace follows a symlink out of it.
      return Promise.all(
        matches
          .filter((match) => isInsideRoot(match.path))
          .map(async (match) =>
            match.type === "dir"
              ? { path: match.path, type: "directory", size: 0 }
              : {
                  path: match.path,
                  type: "file",
                  size: (await fs.stat(match.path)).size
                }
          )
      );
    },
    async stat(path) {
      try {
        const info = await fs.stat(resolvePath(path));
        return {
          type: info.isDirectory ? "directory" : "file",
          size: info.size
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async writeFile(path, content) {
      const absolute = resolvePath(path);
      const parent = absolute.slice(0, absolute.lastIndexOf("/"));
      if (parent) await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(
        absolute,
        typeof content === "string" ? TEXT_ENCODER.encode(content) : content
      );
    }
  };
  return access;
}

function isInsideRoot(path: string): boolean {
  return path === WORKSPACE_ROOT || path.startsWith(`${WORKSPACE_ROOT}/`);
}

/** A script asked for a path outside `/workspace`. */
class SkillWorkspacePathError extends Error {
  readonly _tag = "SkillWorkspacePathError" as const;

  constructor(readonly path: string) {
    super(
      `Skill scripts can only access paths under ${WORKSPACE_ROOT}: ${path}`
    );
    this.name = "SkillWorkspacePathError";
  }
}

/**
 * Resolve a script-supplied path to a normalized absolute path under
 * `/workspace`. Relative paths resolve against `/workspace`; `.` and `..`
 * are applied before the check, so `../x` or `/workspace/../x` cannot reach
 * the rest of the Workspace filesystem.
 *
 * @throws SkillWorkspacePathError when the path resolves outside
 * `/workspace`. The host bridge reports it to the script as a failed call.
 */
function resolvePath(path: string): string {
  if (path.includes("\0")) throw new SkillWorkspacePathError(path);
  const absolute = path.startsWith("/") ? path : `${WORKSPACE_ROOT}/${path}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const resolved = `/${parts.join("/")}`;
  if (!isInsideRoot(resolved)) throw new SkillWorkspacePathError(path);
  return resolved;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; message?: unknown };
  return (
    record.code === "ENOENT" ||
    (typeof record.message === "string" &&
      /ENOENT|no such file|not found/i.test(record.message))
  );
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      parts.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (parts.length === 1) return parts[0];
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
