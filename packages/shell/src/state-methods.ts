/**
 * Per-method metadata for the `state.*` sandbox API.
 *
 * The sandbox-facing calling convention is a single object argument
 * (`state.readFile({ path })`), while `StateBackend` methods are positional.
 * This table is the single source of truth for that mapping, and for which
 * methods are reads (replayed by re-execution — their results never enter
 * the durable log) versus writes (logged and replayed from the log).
 */
import type { StateBackend, StateMethodName } from "./backend";

export interface StateMethodSpec {
  /**
   * Positional parameter names, in backend-call order. A trailing `?` marks
   * an optional parameter (all optionals are trailing in `StateBackend`).
   */
  params: readonly string[];
  /** Reads are replayed by re-execution; writes are logged durably. */
  kind: "read" | "write";
  description: string;
}

export const STATE_METHODS: Record<StateMethodName, StateMethodSpec> = {
  getCapabilities: {
    params: [],
    kind: "read",
    description: "Report which optional filesystem features are supported."
  },
  readFile: {
    params: ["path"],
    kind: "read",
    description: "Read a file as text."
  },
  readFileBytes: {
    params: ["path"],
    kind: "read",
    description: "Read a file as bytes."
  },
  writeFile: {
    params: ["path", "content"],
    kind: "write",
    description: "Write text to a file, creating parent directories as needed."
  },
  writeFileBytes: {
    params: ["path", "content"],
    kind: "write",
    description: "Write bytes to a file."
  },
  appendFile: {
    params: ["path", "content"],
    kind: "write",
    description: "Append text or bytes to a file."
  },
  readJson: {
    params: ["path"],
    kind: "read",
    description: "Parse a JSON file and return the value."
  },
  writeJson: {
    params: ["path", "value", "options?"],
    kind: "write",
    description: "Write a value as JSON to a file."
  },
  queryJson: {
    params: ["path", "query"],
    kind: "read",
    description:
      'Query a JSON file using dot-path syntax like ".key[0].nested".'
  },
  updateJson: {
    params: ["path", "operations"],
    kind: "write",
    description: "Apply set/delete operations to a JSON file in place."
  },
  exists: {
    params: ["path"],
    kind: "read",
    description: "Return true if the path exists."
  },
  stat: {
    params: ["path"],
    kind: "read",
    description: "Stat a path, following symlinks. Returns null if not found."
  },
  lstat: {
    params: ["path"],
    kind: "read",
    description:
      "Stat a path without following symlinks. Returns null if not found."
  },
  mkdir: {
    params: ["path", "options?"],
    kind: "write",
    description: "Create a directory."
  },
  readdir: {
    params: ["path"],
    kind: "read",
    description: "List names in a directory."
  },
  readdirWithFileTypes: {
    params: ["path"],
    kind: "read",
    description: "List directory entries with type information."
  },
  find: {
    params: ["path", "options?"],
    kind: "read",
    description: "Find files/directories matching structured predicates."
  },
  walkTree: {
    params: ["path", "options?"],
    kind: "read",
    description: "Recursively build the directory tree."
  },
  summarizeTree: {
    params: ["path", "options?"],
    kind: "read",
    description: "Summarize file counts and sizes in a subtree."
  },
  searchText: {
    params: ["path", "query", "options?"],
    kind: "read",
    description: "Search for matches in a single file."
  },
  searchFiles: {
    params: ["pattern", "query", "options?"],
    kind: "read",
    description: "Search for matches across files matching a glob pattern."
  },
  replaceInFile: {
    params: ["path", "search", "replacement", "options?"],
    kind: "write",
    description: "Replace matches in a single file."
  },
  replaceInFiles: {
    params: ["pattern", "search", "replacement", "options?"],
    kind: "write",
    description:
      "Replace matches across all files matching a glob. Transactional by default."
  },
  rm: {
    params: ["path", "options?"],
    kind: "write",
    description: "Remove a file or directory."
  },
  cp: {
    params: ["src", "dest", "options?"],
    kind: "write",
    description: "Copy a file or directory."
  },
  mv: {
    params: ["src", "dest", "options?"],
    kind: "write",
    description: "Move a file or directory."
  },
  symlink: {
    params: ["target", "linkPath"],
    kind: "write",
    description: "Create a symlink."
  },
  readlink: {
    params: ["path"],
    kind: "read",
    description: "Read a symlink target."
  },
  realpath: {
    params: ["path"],
    kind: "read",
    description: "Resolve all symlinks to a canonical path."
  },
  resolvePath: {
    params: ["base", "path"],
    kind: "read",
    description: "Resolve a relative path against a base directory."
  },
  glob: {
    params: ["pattern"],
    kind: "read",
    description: "Find paths matching a glob pattern."
  },
  diff: {
    params: ["pathA", "pathB"],
    kind: "read",
    description: "Unified diff between two files."
  },
  diffContent: {
    params: ["path", "newContent"],
    kind: "read",
    description: "Unified diff between a file and new content."
  },
  createArchive: {
    params: ["path", "sources"],
    kind: "write",
    description: "Pack sources into a tar archive."
  },
  listArchive: {
    params: ["path"],
    kind: "read",
    description: "List entries in a tar archive."
  },
  extractArchive: {
    params: ["path", "destination"],
    kind: "write",
    description: "Extract a tar archive to a destination directory."
  },
  compressFile: {
    params: ["path", "destination?"],
    kind: "write",
    description: 'Gzip-compress a file. Default destination is `path + ".gz"`.'
  },
  decompressFile: {
    params: ["path", "destination?"],
    kind: "write",
    description: "Gunzip a compressed file."
  },
  hashFile: {
    params: ["path", "options?"],
    kind: "read",
    description: "Hash a file and return the hex digest."
  },
  detectFile: {
    params: ["path"],
    kind: "read",
    description: "Detect the MIME type and binary/text nature of a file."
  },
  removeTree: {
    params: ["path"],
    kind: "write",
    description: "Recursively remove a directory tree."
  },
  copyTree: {
    params: ["src", "dest"],
    kind: "write",
    description: "Recursively copy a directory tree."
  },
  moveTree: {
    params: ["src", "dest"],
    kind: "write",
    description: "Recursively move a directory tree."
  },
  planEdits: {
    params: ["instructions"],
    // Logged, not re-executed: the returned plan feeds applyEditPlan, whose
    // logged args must match what the first run actually applied.
    kind: "write",
    description:
      "Plan a batch of edits — compute content + diffs without writing."
  },
  applyEditPlan: {
    params: ["plan", "options?"],
    kind: "write",
    description:
      "Apply a previously computed edit plan. Use dryRun: true to preview."
  },
  applyEdits: {
    params: ["edits", "options?"],
    kind: "write",
    description:
      "Apply a list of raw { path, content } edits. Transactional by default."
  }
};

function paramName(param: string): string {
  return param.endsWith("?") ? param.slice(0, -1) : param;
}

export function requiredParams(spec: StateMethodSpec): string[] {
  return spec.params.filter((p) => !p.endsWith("?")).map(paramName);
}

export function paramNames(spec: StateMethodSpec): string[] {
  return spec.params.map(paramName);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Date)
  );
}

/**
 * Map a single object argument (`{ path, content }`) to the backend's
 * positional parameter order. Throws when a required parameter is missing,
 * naming the method and the parameter so the sandbox error is actionable.
 */
export function objectArgsToPositional(
  method: StateMethodName,
  args: unknown
): unknown[] {
  const spec = STATE_METHODS[method];
  if (spec.params.length === 0) return [];
  if (!isPlainObject(args)) {
    throw new Error(
      `state.${method} takes a single object argument: ` +
        `state.${method}({ ${spec.params.join(", ")} })`
    );
  }
  for (const required of requiredParams(spec)) {
    if (args[required] === undefined) {
      throw new Error(
        `state.${method}: missing required parameter "${required}" — ` +
          `expected state.${method}({ ${spec.params.join(", ")} })`
      );
    }
  }
  const positional = spec.params.map((p) => args[paramName(p)]);
  // Trim trailing undefined so backends see the same arity as a direct call.
  while (
    positional.length > 0 &&
    positional[positional.length - 1] === undefined
  ) {
    positional.pop();
  }
  return positional;
}

/**
 * Invoke a `StateBackend` method with a sandbox-style object argument.
 */
export async function callStateMethod(
  backend: StateBackend,
  method: StateMethodName,
  args: unknown
): Promise<unknown> {
  const fn = backend[method] as (...positional: unknown[]) => Promise<unknown>;
  if (typeof fn !== "function") {
    throw new Error(`state.${method} is not supported by this backend`);
  }
  return fn.apply(backend, objectArgsToPositional(method, args));
}
