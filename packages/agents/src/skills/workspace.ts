import type { SkillResource } from "./types";

/**
 * The Workspace Agent Skills read and write: a `Workspace` from
 * `@cloudflare/computer`, or anything with the same `fs` methods.
 */
export interface SkillWorkspace {
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

/** Options for projecting Agent Skills into a Workspace. */
export interface SkillWorkspaceSeedOptions {
  /** Destination directory. Defaults to `/workspace/.agents/skills`. */
  readonly root?: string;
  /** Existing-file policy. Default `"preserve"` keeps Workspace edits. */
  readonly onConflict?: "preserve" | "replace";
}

/** Summary returned after projecting Agent Skills into a Workspace. */
export interface SkillWorkspaceSeedResult {
  /** Files written from source content. */
  readonly written: number;
  /** Existing files preserved without a write. */
  readonly preserved: number;
  /** Files skipped because their source content could not be read or written. */
  readonly skipped: number;
  /** Non-fatal per-file diagnostics. */
  readonly warnings: readonly string[];
  /** Absolute Workspace directory containing the projected skills. */
  readonly root: string;
}

/** @internal File operations used by SkillRegistry after projection. */
export interface SkillWorkspaceFiles {
  readonly root: string;
  path(name: string, relativePath: string): string;
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string | null>;
  readResource(
    path: string,
    descriptor: Omit<SkillResource, "content">
  ): Promise<SkillResource | null>;
  writeText(path: string, content: string): Promise<void>;
  writeResource(path: string, resource: SkillResource): Promise<void>;
}

/** Directory skill scripts and relative paths resolve against. */
const WORKSPACE_ROOT = "/workspace";
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** @internal Adapt a Workspace for projecting skills into it. */
export function createSkillWorkspaceFiles(
  workspace: SkillWorkspace,
  rootOverride?: string
): SkillWorkspaceFiles {
  const root = parseRoot(rootOverride ?? `${WORKSPACE_ROOT}/.agents/skills`);
  const access = createSkillWorkspaceAccess(workspace);

  const readBytes = async (path: string): Promise<Uint8Array | null> => {
    try {
      return await drain(await workspace.fs.readFile(path));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };

  return {
    root,
    path(name, relativePath) {
      const safeName = parseSkillDirectoryName(name);
      const safeRelative = parseRelativePath(relativePath);
      return `${root}/${safeName}/${safeRelative}`;
    },
    async exists(path) {
      return (await access.stat(path)) !== null;
    },
    readText: (path) => access.readFile(path),
    async readResource(path, descriptor) {
      const encoding = descriptor.encoding ?? "text";
      if (encoding === "text") {
        const content = await access.readFile(path);
        return content === null ? null : { ...descriptor, content };
      }
      const bytes = await readBytes(path);
      return bytes === null
        ? null
        : { ...descriptor, content: encodeBase64(bytes) };
    },
    writeText: (path, content) => access.writeFile(path, content),
    async writeResource(path, resource) {
      await access.writeFile(
        path,
        (resource.encoding ?? "text") === "text"
          ? resource.content
          : decodeBase64(resource.content)
      );
    }
  };
}

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
 * against `/workspace`.
 */
export function createSkillWorkspaceAccess(
  workspace: SkillWorkspace
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
      return Promise.all(
        matches.map(async (match) =>
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

function resolvePath(path: string): string {
  if (path.startsWith("/")) return path;
  const relative = path.replace(/^\.(\/|$)/, "");
  return relative === "" ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}/${relative}`;
}

function parseRoot(root: string): string {
  if (
    !root.startsWith("/") ||
    root.includes("\0") ||
    root.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error(
      `Skill Workspace root must be a normalized absolute path: ${root}`
    );
  }
  const normalized = root.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  if (!normalized) throw new Error("Skill Workspace root cannot be /");
  return normalized;
}

function parseSkillDirectoryName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(
      `Skill name must be a safe Workspace directory name: ${name}`
    );
  }
  return name;
}

function parseRelativePath(path: string): string {
  if (
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Skill file path must be normalized and relative: ${path}`);
  }
  return path;
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

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(parts.join(""));
}
