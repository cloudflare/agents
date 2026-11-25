import { err, ok } from "./result";
import {
  describeSkillResource,
  encodeSkillResourceContent,
  type SkillResource
} from "./resource";
import {
  SkillResourceNotFoundError,
  SkillSourceError,
  type SkillSource
} from "./source";
import type { SkillName } from "./skill";
import { indexSkillTree } from "./tree";

/**
 * The parts of a `@cloudflare/computer` Workspace a skill source reads. A
 * local `Workspace`, a client from `getWorkspace()`, and Think's
 * `this.workspace` all fit.
 */
export interface SkillWorkspace {
  /** The Workspace filesystem. */
  readonly fs: {
    /** Walk a directory tree. */
    find(
      directory: string,
      pattern?: string,
      options?: { exclude?: string[] }
    ): Promise<ReadonlyArray<{ path: string; type: string }>>;
    /** Read a file's bytes. */
    readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  };
}

/** Options for {@link workspace}. */
export interface WorkspaceSkillSourceOptions {
  /**
   * Absolute directory that holds the skill directories. Defaults to
   * `/workspace/.agents/skills`, the cross-client Agent Skills location.
   */
  readonly root?: string;
  /** Source id for diagnostics. Defaults to `workspace:<root>`. */
  readonly id?: string;
}

/** Default skills directory inside a Workspace. */
export const DEFAULT_WORKSPACE_SKILLS_ROOT = "/workspace/.agents/skills";

/**
 * Create a source that reads skills from a Computer Workspace.
 *
 * Skills are plain files: every `<root>/<skill-name>/SKILL.md` is a skill,
 * and the files beside it are its resources. The Workspace is read on every
 * listing, so skills the agent or a user adds, edits, or deletes take effect
 * the next time the catalog loads. A missing root lists no skills.
 *
 * @param target - The Workspace to read.
 * @param options - Skills root and source id.
 * @returns A source backed by the Workspace.
 * @throws TypeError when `root` is not a normalized absolute path.
 */
export function workspace(
  target: SkillWorkspace,
  options: WorkspaceSkillSourceOptions = {}
): SkillSource {
  const root = parseRoot(options.root ?? DEFAULT_WORKSPACE_SKILLS_ROOT);
  const id = options.id ?? `workspace:${root}`;
  const { fs } = target;
  // Skill name -> directory from the last listing. Lenient names can differ
  // from their directory, and resources live in the directory.
  let directories: ReadonlyMap<SkillName, string> = new Map();

  async function readBytes(path: string): Promise<Uint8Array | null> {
    try {
      return await drain(await fs.readFile(path));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  return {
    id,
    async list() {
      try {
        let entries: ReadonlyArray<{ path: string; type: string }>;
        try {
          entries = await fs.find(root, undefined, {
            exclude: ["*/node_modules/**", "*/.git/**"]
          });
        } catch (error) {
          if (isNotFound(error)) return ok({ skills: [], invalid: [] });
          throw error;
        }
        const files = entries
          .filter((entry) => entry.type === "file")
          .map((entry) => ({ path: entry.path.slice(root.length + 1) }));
        const tree = await indexSkillTree(
          files,
          async (path) => {
            const bytes = await readBytes(`${root}/${path}`);
            return bytes === null ? null : new TextDecoder().decode(bytes);
          },
          (directory) => `${root}/${directory}`
        );
        directories = tree.directories;
        return ok(tree.listing);
      } catch (cause) {
        return err(new SkillSourceError(id, "list", cause));
      }
    },
    async readResource(skill, path) {
      const info = describeSkillResource(path);
      try {
        const directory = directories.get(skill) ?? skill;
        const bytes = await readBytes(`${root}/${directory}/${path}`);
        if (bytes === null) {
          return err(new SkillResourceNotFoundError(skill, path));
        }
        const resource: SkillResource = {
          ...info,
          size: bytes.byteLength,
          content: encodeSkillResourceContent(bytes, info.encoding)
        };
        return ok(resource);
      } catch (cause) {
        return err(new SkillSourceError(id, "read-resource", cause));
      }
    }
  };
}

function parseRoot(root: string): string {
  const normalized = root.replace(/\/+$/, "");
  if (
    !normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized
      .slice(1)
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new TypeError(
      `Skills root must be a normalized absolute path: ${root}`
    );
  }
  return normalized;
}

/**
 * Computer raises `ENOENT` errors with a `code`. Over RPC only the message
 * may survive, so match that too.
 */
function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    ("code" in error && error.code === "ENOENT") ||
    /ENOENT|no such (file|path)/i.test(error.message)
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
      parts.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
