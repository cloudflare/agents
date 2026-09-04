import type { SkillResource } from "./types";

/**
 * Computer-style Workspace shape used for Agent Skills projection.
 * `@cloudflare/computer.Workspace` satisfies this through `workspace.fs`.
 */
export interface ComputerSkillWorkspace {
  readonly fs: {
    stat(path: string): Promise<unknown>;
    readFile(
      path: string,
      options?: { byteOffset?: number; byteLength?: number }
    ): Promise<ReadableStream<Uint8Array>>;
    readFile(path: string, encoding: "utf8"): Promise<string>;
    writeFile(path: string, content: string | Uint8Array): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  };
}

/**
 * Legacy direct filesystem shape used for Agent Skills projection.
 * `@cloudflare/shell.Workspace` and Think `WorkspaceLike` satisfy this shape.
 */
export interface LegacySkillWorkspace {
  stat(path: string): Promise<unknown | null>;
  readFile(path: string): Promise<string | null>;
  readFileBytes(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, content: string): Promise<void>;
  writeFileBytes(
    path: string,
    content: Uint8Array | ArrayBuffer,
    mediaType?: string
  ): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

/** Workspace accepted by `SkillRegistry.seedWorkspace()`. */
export type SkillProjectionWorkspace =
  | ComputerSkillWorkspace
  | LegacySkillWorkspace;

/** Options for projecting Agent Skills into a Workspace. */
export interface SkillWorkspaceSeedOptions {
  /**
   * Destination directory. Defaults to `/workspace/.agents/skills` for a
   * Computer Workspace and `/.agents/skills` for a legacy Shell Workspace.
   */
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

/** @internal Parse and adapt a Computer or legacy Shell Workspace. */
export function createSkillWorkspaceFiles(
  workspace: SkillProjectionWorkspace,
  rootOverride?: string
): SkillWorkspaceFiles {
  const computer = isComputerWorkspace(workspace);
  const root = parseRoot(
    rootOverride ?? (computer ? "/workspace/.agents/skills" : "/.agents/skills")
  );

  const exists = async (path: string): Promise<boolean> => {
    try {
      const stat = computer
        ? await workspace.fs.stat(path)
        : await workspace.stat(path);
      return stat !== null && stat !== undefined;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  };

  const readText = async (path: string): Promise<string | null> => {
    try {
      return computer
        ? await workspace.fs.readFile(path, "utf8")
        : await workspace.readFile(path);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };

  const readBytes = async (path: string): Promise<Uint8Array | null> => {
    if (!computer) return workspace.readFileBytes(path);
    try {
      return await drain(await workspace.fs.readFile(path));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };

  const mkdirParent = async (path: string): Promise<void> => {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (!parent) return;
    if (computer) await workspace.fs.mkdir(parent, { recursive: true });
    else await workspace.mkdir(parent, { recursive: true });
  };

  return {
    root,
    path(name, relativePath) {
      const safeName = parseSkillDirectoryName(name);
      const safeRelative = parseRelativePath(relativePath);
      return `${root}/${safeName}/${safeRelative}`;
    },
    exists,
    readText,
    async readResource(path, descriptor) {
      const encoding = descriptor.encoding ?? "text";
      if (encoding === "text") {
        const content = await readText(path);
        return content === null ? null : { ...descriptor, content };
      }
      const bytes = await readBytes(path);
      return bytes === null
        ? null
        : { ...descriptor, content: encodeBase64(bytes) };
    },
    async writeText(path, content) {
      await mkdirParent(path);
      if (computer) await workspace.fs.writeFile(path, content);
      else await workspace.writeFile(path, content);
    },
    async writeResource(path, resource) {
      await mkdirParent(path);
      if ((resource.encoding ?? "text") === "text") {
        if (computer) await workspace.fs.writeFile(path, resource.content);
        else await workspace.writeFile(path, resource.content);
        return;
      }
      const bytes = decodeBase64(resource.content);
      if (computer) await workspace.fs.writeFile(path, bytes);
      else await workspace.writeFileBytes(path, bytes, resource.mimeType);
    }
  };
}

function isComputerWorkspace(
  workspace: SkillProjectionWorkspace
): workspace is ComputerSkillWorkspace {
  return "fs" in workspace;
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
