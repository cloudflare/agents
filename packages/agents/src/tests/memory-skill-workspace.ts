import type { SkillWorkspace } from "../skills";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function notFound(path: string): Error {
  return Object.assign(new Error(`no such file: ${path}`), { code: "ENOENT" });
}

function absolute(path: string): string {
  return path.startsWith("/") ? path : `/workspace/${path}`;
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index++;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * In-memory Workspace with the `fs` shape Computer's `Workspace` has.
 * Relative paths in the test helpers resolve against `/workspace`, like
 * skill scripts.
 */
export class MemorySkillWorkspace implements SkillWorkspace {
  readonly files = new Map<string, Uint8Array>();

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) {
      this.files.set(absolute(path), encoder.encode(content));
    }
  }

  readonly fs: SkillWorkspace["fs"] = {
    stat: async (path) => {
      const bytes = this.files.get(path);
      if (bytes) return { size: bytes.byteLength, isDirectory: false };
      const prefix = path.endsWith("/") ? path : `${path}/`;
      for (const key of this.files.keys()) {
        if (key.startsWith(prefix)) return { size: 0, isDirectory: true };
      }
      throw notFound(path);
    },
    readFile: async (path) => {
      const bytes = this.files.get(path);
      if (!bytes) throw notFound(path);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        }
      });
    },
    writeFile: async (path, content) => {
      this.files.set(path, new Uint8Array(content));
    },
    mkdir: async () => {},
    readdir: async (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const children = new Map<
        string,
        { name: string; size: number; isDirectory: boolean }
      >();
      for (const [key, bytes] of this.files) {
        if (!key.startsWith(prefix)) continue;
        const [name, ...rest] = key.slice(prefix.length).split("/");
        if (!name) continue;
        children.set(name, {
          name,
          size: rest.length === 0 ? bytes.byteLength : 0,
          isDirectory: rest.length > 0
        });
      }
      return [...children.values()];
    },
    find: async (directory, pattern = "**") => {
      const prefix = directory.endsWith("/") ? directory : `${directory}/`;
      const matcher = globToRegExp(pattern);
      return [...this.files.keys()]
        .filter(
          (key) =>
            key.startsWith(prefix) && matcher.test(key.slice(prefix.length))
        )
        .map((path) => ({ path, type: "file" as const }));
    }
  };

  /** Read a file as text, or `null` when missing. */
  async readText(path: string): Promise<string | null> {
    const bytes = this.files.get(absolute(path));
    return bytes ? decoder.decode(bytes) : null;
  }

  /** Write a file as text. */
  async writeText(path: string, content: string): Promise<void> {
    this.files.set(absolute(path), encoder.encode(content));
  }
}
