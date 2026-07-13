import { ValidationError } from "../../kernel/errors.js";
import type { Clock } from "../../ports/clock.js";
import { scoped, type KeyValueStore } from "../../ports/storage.js";

export interface WorkspaceEntry {
  path: string;
  size: number;
  updatedAt: number;
  mediaType?: string;
}

export interface Workspace {
  read(path: string): { content: string; encoding: "utf8" | "base64"; mediaType?: string } | null;
  write(path: string, content: string, opts?: { mediaType?: string; encoding?: "utf8" | "base64" }): void;
  /** Deletes the file (or, when `path` is a directory, everything under it). */
  delete(path: string): boolean;
  exists(path: string): boolean;
  /** Entries sorted by path. Non-recursive by default (direct children of `dir` only). */
  list(dir?: string, opts?: { recursive?: boolean }): WorkspaceEntry[];
  find(glob: string): string[];
  grep(pattern: string, opts?: { glob?: string; maxMatches?: number }): Array<{ path: string; line: number; text: string }>;
  edit(
    path: string,
    oldString: string,
    newString: string,
    opts?: { replaceAll?: boolean }
  ): { ok: true } | { ok: false; reason: "not_found" | "no_match" | "not_unique" };
  totalBytes(): number;
}

interface FileRecord {
  path: string;
  content: string;
  mediaType?: string;
  encoding: "utf8" | "base64";
  size: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Normalizes a workspace path: strips a leading "/", rejects empty segments
 * and ".." traversal, and drops "." segments. Throws ValidationError on any
 * invalid input.
 */
function normalizePath(path: string): string {
  const stripped = path.startsWith("/") ? path.slice(1) : path;
  const segments = stripped.split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "") {
      throw new ValidationError(`invalid workspace path "${path}": empty path segment`);
    }
    if (segment === "..") {
      throw new ValidationError(`invalid workspace path "${path}": ".." traversal is not allowed`);
    }
    if (segment === ".") continue;
    normalized.push(segment);
  }
  if (normalized.length === 0) {
    throw new ValidationError(`invalid workspace path "${path}": empty path`);
  }
  return normalized.join("/");
}

/** Like normalizePath, but treats "", "/", and "." as the workspace root (returns ""). */
function normalizeDirPath(dir: string): string {
  const stripped = dir.startsWith("/") ? dir.slice(1) : dir;
  if (stripped === "" || stripped === ".") return "";
  return normalizePath(dir);
}

/**
 * Compiles a glob pattern to a RegExp anchored to a full path match.
 * `**` matches any characters including `/`; `*` matches any characters
 * except `/`; every other character is matched literally (regex specials
 * escaped). Shared with the fetch tool's allowlist matching.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i++;
      } else {
        pattern += "[^/]*";
      }
    } else if (ch !== undefined && "\\^$.|?+()[]{}".includes(ch)) {
      pattern += `\\${ch}`;
    } else {
      pattern += ch;
    }
  }
  return new RegExp(`^${pattern}$`);
}

function byteLength(content: string, encoding: "utf8" | "base64"): number {
  if (encoding === "base64") {
    if (content.length === 0) return 0;
    const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
    return Math.floor((content.length * 3) / 4) - padding;
  }
  return new TextEncoder().encode(content).length;
}

export function createWorkspace(deps: { store: KeyValueStore; clock: Clock }): Workspace {
  const store = scoped(deps.store, "ws:");
  const { clock } = deps;

  function getRecord(path: string): FileRecord | undefined {
    return store.get<FileRecord>(normalizePath(path));
  }

  function allRecords(): Array<[string, FileRecord]> {
    return [...store.list<FileRecord>()];
  }

  return {
    read(path) {
      const record = getRecord(path);
      if (!record) return null;
      return { content: record.content, encoding: record.encoding, mediaType: record.mediaType };
    },

    write(path, content, opts) {
      const key = normalizePath(path);
      const encoding = opts?.encoding ?? "utf8";
      const existing = store.get<FileRecord>(key);
      const now = clock.now();
      const record: FileRecord = {
        path: key,
        content,
        mediaType: opts?.mediaType,
        encoding,
        size: byteLength(content, encoding),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      store.put(key, record);
    },

    delete(path) {
      const key = normalizePath(path);
      const existed = store.delete(key);
      const nested = [...store.list<FileRecord>({ prefix: `${key}/` }).keys()];
      for (const nestedKey of nested) store.delete(nestedKey);
      return existed || nested.length > 0;
    },

    exists(path) {
      const key = normalizePath(path);
      if (store.get(key) !== undefined) return true;
      return store.list({ prefix: `${key}/`, limit: 1 }).size > 0;
    },

    list(dir, opts) {
      const dirPath = dir === undefined ? undefined : normalizeDirPath(dir);
      const recursive = opts?.recursive ?? false;
      const effectiveDir = dirPath === "" ? undefined : dirPath;
      const result: WorkspaceEntry[] = [];
      for (const [path, record] of allRecords()) {
        let rel = path;
        if (effectiveDir !== undefined) {
          if (path === effectiveDir || !path.startsWith(`${effectiveDir}/`)) continue;
          rel = path.slice(effectiveDir.length + 1);
        }
        if (!recursive && rel.includes("/")) continue;
        result.push({ path, size: record.size, updatedAt: record.updatedAt, mediaType: record.mediaType });
      }
      return result;
    },

    find(glob) {
      const regex = globToRegExp(glob);
      return allRecords()
        .map(([path]) => path)
        .filter((path) => regex.test(path));
    },

    grep(pattern, opts) {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch {
        throw new ValidationError(`invalid grep pattern: ${pattern}`);
      }
      const globRegex = opts?.glob !== undefined ? globToRegExp(opts.glob) : undefined;
      const maxMatches = opts?.maxMatches;
      const results: Array<{ path: string; line: number; text: string }> = [];
      for (const [path, record] of allRecords()) {
        if (record.encoding !== "utf8") continue;
        if (globRegex && !globRegex.test(path)) continue;
        const lines = record.content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          if (regex.test(line)) {
            results.push({ path, line: i + 1, text: line });
            if (maxMatches !== undefined && results.length >= maxMatches) return results;
          }
        }
      }
      return results;
    },

    edit(path, oldString, newString, opts) {
      const key = normalizePath(path);
      const record = store.get<FileRecord>(key);
      if (!record) return { ok: false, reason: "not_found" };

      const occurrences = countOccurrences(record.content, oldString);
      if (occurrences === 0) return { ok: false, reason: "no_match" };
      if (occurrences > 1 && !opts?.replaceAll) return { ok: false, reason: "not_unique" };

      const content = opts?.replaceAll
        ? record.content.split(oldString).join(newString)
        : replaceFirst(record.content, oldString, newString);

      store.put(key, {
        ...record,
        content,
        size: byteLength(content, record.encoding),
        updatedAt: clock.now(),
      });
      return { ok: true };
    },

    totalBytes() {
      let total = 0;
      for (const [, record] of allRecords()) total += record.size;
      return total;
    },
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count++;
    index = found + needle.length;
  }
  return count;
}

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const index = haystack.indexOf(needle);
  if (index === -1) return haystack;
  return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length);
}
