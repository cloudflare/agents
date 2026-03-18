/**
 * TypeScript declaration for the `state` object injected into every isolate
 * execution. Export this string in prompts so the LLM knows the exact API it
 * can call.
 *
 * Usage:
 *   import { STATE_TYPES, STATE_SYSTEM_PROMPT } from "@cloudflare/shell";
 *
 *   system: STATE_SYSTEM_PROMPT.replace("{{types}}", STATE_TYPES)
 */
export const STATE_TYPES = `
// ── Primitive types ───────────────────────────────────────────────────────
type StateEntryType = "file" | "directory" | "symlink";

type StateStat = {
  type: StateEntryType;
  size: number;
  mtime: Date;
  mode?: number;
};

type StateDirent = {
  name: string;
  type: StateEntryType;
};

// ── Options ───────────────────────────────────────────────────────────────
type StateMkdirOptions   = { recursive?: boolean };
type StateRmOptions      = { recursive?: boolean; force?: boolean };
type StateCopyOptions    = { recursive?: boolean };
type StateMoveOptions    = { recursive?: boolean };
type StateTreeOptions    = { maxDepth?: number };
type StateJsonWriteOptions = { spaces?: number };
type StateHashOptions    = { algorithm?: "md5" | "sha1" | "sha256" };

type StateSearchOptions = {
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  contextBefore?: number;
  contextAfter?: number;
  maxMatches?: number;
};

type StateReplaceInFilesOptions = StateSearchOptions & {
  dryRun?: boolean;
  rollbackOnError?: boolean;
};

type StateApplyEditsOptions = {
  dryRun?: boolean;
  rollbackOnError?: boolean;
};

type StateFindOptions = {
  name?: string;
  pathPattern?: string;
  type?: StateEntryType | StateEntryType[];
  minDepth?: number;
  maxDepth?: number;
  empty?: boolean;
  sizeMin?: number;
  sizeMax?: number;
  mtimeAfter?: string | Date;
  mtimeBefore?: string | Date;
};

// ── Result types ──────────────────────────────────────────────────────────
type StateTextMatch = {
  line: number;
  column: number;
  match: string;
  lineText: string;
  beforeLines?: string[];
  afterLines?: string[];
};

type StateFindEntry = {
  path: string;
  name: string;
  type: StateEntryType;
  depth: number;
  size: number;
  mtime: Date;
};

type StateTreeNode = {
  path: string;
  name: string;
  type: StateEntryType;
  size: number;
  children?: StateTreeNode[];
};

type StateTreeSummary = {
  files: number;
  directories: number;
  symlinks: number;
  totalBytes: number;
  maxDepth: number;
};

type StateFileDetection = {
  mime: string;
  description: string;
  extension?: string;
  binary: boolean;
};

type StateFileSearchResult = {
  path: string;
  matches: StateTextMatch[];
};

type StateReplaceResult = { replaced: number; content: string };

type StateFileReplaceResult = {
  path: string;
  replaced: number;
  content: string;
  diff: string;
};

type StateReplaceInFilesResult = {
  dryRun: boolean;
  files: StateFileReplaceResult[];
  totalFiles: number;
  totalReplacements: number;
};

type StateJsonUpdateOperation =
  | { op: "set"; path: string; value: unknown }
  | { op: "delete"; path: string };

type StateJsonUpdateResult = {
  value: unknown;
  content: string;
  diff: string;
  operationsApplied: number;
};

type StateArchiveEntry = { path: string; type: "file" | "directory"; size: number };

type StateArchiveCreateResult = {
  path: string;
  entries: StateArchiveEntry[];
  bytesWritten: number;
};

type StateArchiveExtractResult = {
  destination: string;
  entries: StateArchiveEntry[];
};

type StateCompressionResult = {
  path: string;
  destination: string;
  bytesWritten: number;
};

// ── Edit planning ─────────────────────────────────────────────────────────
type StateEdit = { path: string; content: string };

type StateEditInstruction =
  | { kind: "write";     path: string; content: string }
  | { kind: "replace";   path: string; search: string; replacement: string; options?: StateSearchOptions }
  | { kind: "writeJson"; path: string; value: unknown; options?: StateJsonWriteOptions };

type StatePlannedEdit = {
  instruction: StateEditInstruction;
  path: string;
  changed: boolean;
  content: string;
  diff: string;
};

type StateEditPlan = {
  edits: StatePlannedEdit[];
  totalChanged: number;
  totalInstructions: number;
};

type StateAppliedEditResult = {
  path: string;
  changed: boolean;
  content: string;
  diff: string;
};

type StateApplyEditsResult = {
  dryRun: boolean;
  edits: StateAppliedEditResult[];
  totalChanged: number;
};

// ── state object ──────────────────────────────────────────────────────────
declare const state: {
  // File I/O
  /** Read a file as text. */
  readFile(path: string): Promise<string>;
  /** Read a file as bytes. */
  readFileBytes(path: string): Promise<Uint8Array>;
  /** Write text to a file, creating parent directories as needed. */
  writeFile(path: string, content: string): Promise<void>;
  /** Write bytes to a file. */
  writeFileBytes(path: string, content: Uint8Array): Promise<void>;
  /** Append text or bytes to a file. */
  appendFile(path: string, content: string | Uint8Array): Promise<void>;

  // JSON
  /** Parse a JSON file and return the value. */
  readJson(path: string): Promise<unknown>;
  /** Write a value as JSON to a file. */
  writeJson(path: string, value: unknown, options?: StateJsonWriteOptions): Promise<void>;
  /** Query a JSON file using dot-path syntax like ".key[0].nested". */
  queryJson(path: string, query: string): Promise<unknown>;
  /** Apply set/delete operations to a JSON file in place. */
  updateJson(path: string, operations: StateJsonUpdateOperation[]): Promise<StateJsonUpdateResult>;

  // Metadata & directories
  /** Return true if the path exists. */
  exists(path: string): Promise<boolean>;
  /** Stat a path, following symlinks. Returns null if not found. */
  stat(path: string): Promise<StateStat | null>;
  /** Stat a path without following symlinks. Returns null if not found. */
  lstat(path: string): Promise<StateStat | null>;
  /** Create a directory. */
  mkdir(path: string, options?: StateMkdirOptions): Promise<void>;
  /** List names in a directory. */
  readdir(path: string): Promise<string[]>;
  /** List directory entries with type information. */
  readdirWithFileTypes(path: string): Promise<StateDirent[]>;

  // Tree traversal
  /** Find files/directories matching structured predicates. */
  find(path: string, options?: StateFindOptions): Promise<StateFindEntry[]>;
  /** Recursively build the directory tree. */
  walkTree(path: string, options?: StateTreeOptions): Promise<StateTreeNode>;
  /** Summarize file counts and sizes in a subtree. */
  summarizeTree(path: string, options?: StateTreeOptions): Promise<StateTreeSummary>;

  // Search & replace
  /** Search for matches in a single file. */
  searchText(path: string, query: string, options?: StateSearchOptions): Promise<StateTextMatch[]>;
  /** Search for matches across files matching a glob pattern. */
  searchFiles(pattern: string, query: string, options?: StateSearchOptions): Promise<StateFileSearchResult[]>;
  /** Replace matches in a single file. */
  replaceInFile(path: string, search: string, replacement: string, options?: StateSearchOptions): Promise<StateReplaceResult>;
  /** Replace matches across all files matching a glob. Transactional by default. */
  replaceInFiles(pattern: string, search: string, replacement: string, options?: StateReplaceInFilesOptions): Promise<StateReplaceInFilesResult>;

  // File operations
  /** Remove a file or directory. */
  rm(path: string, options?: StateRmOptions): Promise<void>;
  /** Copy a file or directory. */
  cp(src: string, dest: string, options?: StateCopyOptions): Promise<void>;
  /** Move a file or directory. */
  mv(src: string, dest: string, options?: StateMoveOptions): Promise<void>;
  /** Create a symlink. */
  symlink(target: string, linkPath: string): Promise<void>;
  /** Read a symlink target. */
  readlink(path: string): Promise<string>;
  /** Resolve all symlinks to a canonical path. */
  realpath(path: string): Promise<string>;
  /** Resolve a relative path against a base directory. */
  resolvePath(base: string, path: string): Promise<string>;
  /** Find paths matching a glob pattern. */
  glob(pattern: string): Promise<string[]>;
  /** Unified diff between two files. */
  diff(pathA: string, pathB: string): Promise<string>;
  /** Unified diff between a file and new content. */
  diffContent(path: string, newContent: string): Promise<string>;
  /** Recursively remove a directory tree. */
  removeTree(path: string): Promise<void>;
  /** Recursively copy a directory tree. */
  copyTree(src: string, dest: string): Promise<void>;
  /** Recursively move a directory tree. */
  moveTree(src: string, dest: string): Promise<void>;

  // Archives & compression
  /** Pack sources into a tar archive. */
  createArchive(path: string, sources: string[]): Promise<StateArchiveCreateResult>;
  /** List entries in a tar archive. */
  listArchive(path: string): Promise<StateArchiveEntry[]>;
  /** Extract a tar archive to a destination directory. */
  extractArchive(path: string, destination: string): Promise<StateArchiveExtractResult>;
  /** Gzip-compress a file. Default destination is \`path + ".gz"\`. */
  compressFile(path: string, destination?: string): Promise<StateCompressionResult>;
  /** Gunzip a compressed file. */
  decompressFile(path: string, destination?: string): Promise<StateCompressionResult>;
  /** Hash a file and return the hex digest. */
  hashFile(path: string, options?: StateHashOptions): Promise<string>;
  /** Detect the MIME type and binary/text nature of a file. */
  detectFile(path: string): Promise<StateFileDetection>;

  // Structured edit planning
  /**
   * Plan a batch of edits — compute content + diffs without writing.
   * Instructions: { kind: "write" | "replace" | "writeJson", path, ... }
   */
  planEdits(instructions: StateEditInstruction[]): Promise<StateEditPlan>;
  /**
   * Apply a previously computed edit plan to disk.
   * Use dryRun: true to preview without writing.
   */
  applyEditPlan(plan: StateEditPlan, options?: StateApplyEditsOptions): Promise<StateApplyEditsResult>;
  /**
   * Apply a list of raw { path, content } edits.
   * Transactional by default: rolls back earlier writes if any write fails.
   */
  applyEdits(edits: StateEdit[], options?: StateApplyEditsOptions): Promise<StateApplyEditsResult>;
};
`.trim();

/**
 * System-prompt template for using the `state` runtime.
 * Replace `{{types}}` with `STATE_TYPES` before passing to the model.
 *
 * Example:
 *   import { STATE_TYPES, STATE_SYSTEM_PROMPT } from "@cloudflare/shell";
 *   const system = STATE_SYSTEM_PROMPT.replace("{{types}}", STATE_TYPES);
 */
export const STATE_SYSTEM_PROMPT = `
You can write JavaScript code that runs inside an isolated sandbox with access to a persistent
virtual filesystem through the \`state\` object.

Rules:
- Write an async function: \`async () => { ... return result; }\`
- Do NOT use TypeScript syntax — no type annotations, interfaces, or generics in your code.
- Do NOT use \`import\` statements — all helpers are available through \`state\`.
- Always \`return\` the final value you want back.
- For multi-file refactors, prefer \`planEdits()\` + \`applyEditPlan()\` over many individual writes.
- For search-and-replace across a tree, use \`replaceInFiles()\` — it is transactional by default.

Available API (TypeScript reference):

\`\`\`typescript
{{types}}
\`\`\`
`.trim();
