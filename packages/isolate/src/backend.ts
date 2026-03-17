export type StateEntryType = "file" | "directory" | "symlink";

export interface StateCapabilities {
  chmod: boolean;
  utimes: boolean;
  hardLinks: boolean;
}

export interface StateDirent {
  name: string;
  type: StateEntryType;
}

export interface StateStat {
  type: StateEntryType;
  size: number;
  mtime: Date;
  mode?: number;
}

export interface StateMkdirOptions {
  recursive?: boolean;
}

export interface StateRmOptions {
  recursive?: boolean;
  force?: boolean;
}

export interface StateCopyOptions {
  recursive?: boolean;
}

export interface StateMoveOptions {
  recursive?: boolean;
}

export interface StateJsonWriteOptions {
  spaces?: number;
}

export interface StateSearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  contextBefore?: number;
  contextAfter?: number;
  maxMatches?: number;
}

export interface StateTextMatch {
  line: number;
  column: number;
  match: string;
  lineText: string;
  beforeLines?: string[];
  afterLines?: string[];
}

export interface StateFindOptions {
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
}

export interface StateFindEntry {
  path: string;
  name: string;
  type: StateEntryType;
  depth: number;
  size: number;
  mtime: Date;
}

export type StateJsonUpdateOperation =
  | {
      op: "set";
      path: string;
      value: unknown;
    }
  | {
      op: "delete";
      path: string;
    };

export interface StateJsonUpdateResult {
  value: unknown;
  content: string;
  diff: string;
  operationsApplied: number;
}

export interface StateArchiveEntry {
  path: string;
  type: "file" | "directory";
  size: number;
}

export interface StateArchiveCreateResult {
  path: string;
  entries: StateArchiveEntry[];
  bytesWritten: number;
}

export interface StateArchiveExtractResult {
  destination: string;
  entries: StateArchiveEntry[];
}

export interface StateCompressionResult {
  path: string;
  destination: string;
  bytesWritten: number;
}

export interface StateTreeOptions {
  maxDepth?: number;
}

export interface StateTreeNode {
  path: string;
  name: string;
  type: StateEntryType;
  size: number;
  children?: StateTreeNode[];
}

export interface StateTreeSummary {
  files: number;
  directories: number;
  symlinks: number;
  totalBytes: number;
  maxDepth: number;
}

export interface StateFileDetection {
  mime: string;
  description: string;
  extension?: string;
  binary: boolean;
}

export interface StateHashOptions {
  algorithm?: "md5" | "sha1" | "sha256";
}

export interface StateReplaceResult {
  replaced: number;
  content: string;
}

export interface StateFileSearchResult {
  path: string;
  matches: StateTextMatch[];
}

export interface StateReplaceInFilesOptions extends StateSearchOptions {
  dryRun?: boolean;
  rollbackOnError?: boolean;
}

export interface StateFileReplaceResult {
  path: string;
  replaced: number;
  content: string;
  diff: string;
}

export interface StateReplaceInFilesResult {
  dryRun: boolean;
  files: StateFileReplaceResult[];
  totalFiles: number;
  totalReplacements: number;
}

export interface StateEdit {
  path: string;
  content: string;
}

export interface StateWriteEditInstruction {
  kind: "write";
  path: string;
  content: string;
}

export interface StateReplaceEditInstruction {
  kind: "replace";
  path: string;
  search: string;
  replacement: string;
  options?: StateSearchOptions;
}

export interface StateWriteJsonEditInstruction {
  kind: "writeJson";
  path: string;
  value: unknown;
  options?: StateJsonWriteOptions;
}

export type StateEditInstruction =
  | StateWriteEditInstruction
  | StateReplaceEditInstruction
  | StateWriteJsonEditInstruction;

export interface StateApplyEditsOptions {
  dryRun?: boolean;
  rollbackOnError?: boolean;
}

export interface StateAppliedEditResult {
  path: string;
  changed: boolean;
  content: string;
  diff: string;
}

export interface StateApplyEditsResult {
  dryRun: boolean;
  edits: StateAppliedEditResult[];
  totalChanged: number;
}

export interface StatePlannedEdit {
  instruction: StateEditInstruction;
  path: string;
  changed: boolean;
  content: string;
  diff: string;
}

export interface StateEditPlan {
  edits: StatePlannedEdit[];
  totalChanged: number;
  totalInstructions: number;
}

export interface StateExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

export class StateBatchOperationError extends Error {
  readonly operation: "replaceInFiles" | "applyEdits";
  readonly rolledBack: boolean;
  readonly rollbackError?: string;

  constructor(options: {
    operation: "replaceInFiles" | "applyEdits";
    message: string;
    rolledBack: boolean;
    rollbackError?: string;
  }) {
    super(options.message);
    this.name = "StateBatchOperationError";
    this.operation = options.operation;
    this.rolledBack = options.rolledBack;
    this.rollbackError = options.rollbackError;
  }
}

export interface StateExecutor {
  execute(code: string, backend: StateBackend): Promise<StateExecuteResult>;
}

export interface StateBackend {
  getCapabilities(): Promise<StateCapabilities>;
  readFile(path: string): Promise<string>;
  readFileBytes(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  writeFileBytes(path: string, content: Uint8Array): Promise<void>;
  appendFile(path: string, content: string | Uint8Array): Promise<void>;
  readJson(path: string): Promise<unknown>;
  writeJson(
    path: string,
    value: unknown,
    options?: StateJsonWriteOptions
  ): Promise<void>;
  queryJson(path: string, query: string): Promise<unknown>;
  updateJson(
    path: string,
    operations: StateJsonUpdateOperation[]
  ): Promise<StateJsonUpdateResult>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<StateStat | null>;
  lstat(path: string): Promise<StateStat | null>;
  mkdir(path: string, options?: StateMkdirOptions): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdirWithFileTypes(path: string): Promise<StateDirent[]>;
  find(path: string, options?: StateFindOptions): Promise<StateFindEntry[]>;
  walkTree(path: string, options?: StateTreeOptions): Promise<StateTreeNode>;
  summarizeTree(
    path: string,
    options?: StateTreeOptions
  ): Promise<StateTreeSummary>;
  searchText(
    path: string,
    query: string,
    options?: StateSearchOptions
  ): Promise<StateTextMatch[]>;
  searchFiles(
    pattern: string,
    query: string,
    options?: StateSearchOptions
  ): Promise<StateFileSearchResult[]>;
  replaceInFile(
    path: string,
    search: string,
    replacement: string,
    options?: StateSearchOptions
  ): Promise<StateReplaceResult>;
  replaceInFiles(
    pattern: string,
    search: string,
    replacement: string,
    options?: StateReplaceInFilesOptions
  ): Promise<StateReplaceInFilesResult>;
  rm(path: string, options?: StateRmOptions): Promise<void>;
  cp(src: string, dest: string, options?: StateCopyOptions): Promise<void>;
  mv(src: string, dest: string, options?: StateMoveOptions): Promise<void>;
  symlink(target: string, linkPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  resolvePath(base: string, path: string): Promise<string>;
  glob(pattern: string): Promise<string[]>;
  diff(pathA: string, pathB: string): Promise<string>;
  diffContent(path: string, newContent: string): Promise<string>;
  createArchive(
    path: string,
    sources: string[]
  ): Promise<StateArchiveCreateResult>;
  listArchive(path: string): Promise<StateArchiveEntry[]>;
  extractArchive(
    path: string,
    destination: string
  ): Promise<StateArchiveExtractResult>;
  compressFile(
    path: string,
    destination?: string
  ): Promise<StateCompressionResult>;
  decompressFile(
    path: string,
    destination?: string
  ): Promise<StateCompressionResult>;
  hashFile(path: string, options?: StateHashOptions): Promise<string>;
  detectFile(path: string): Promise<StateFileDetection>;
  removeTree(path: string): Promise<void>;
  copyTree(src: string, dest: string): Promise<void>;
  moveTree(src: string, dest: string): Promise<void>;
  planEdits(instructions: StateEditInstruction[]): Promise<StateEditPlan>;
  applyEditPlan(
    plan: StateEditPlan,
    options?: StateApplyEditsOptions
  ): Promise<StateApplyEditsResult>;
  applyEdits(
    edits: StateEdit[],
    options?: StateApplyEditsOptions
  ): Promise<StateApplyEditsResult>;
}

export const STATE_METHOD_NAMES = [
  "getCapabilities",
  "readFile",
  "readFileBytes",
  "writeFile",
  "writeFileBytes",
  "appendFile",
  "readJson",
  "writeJson",
  "queryJson",
  "updateJson",
  "exists",
  "stat",
  "lstat",
  "mkdir",
  "readdir",
  "readdirWithFileTypes",
  "find",
  "walkTree",
  "summarizeTree",
  "searchText",
  "searchFiles",
  "replaceInFile",
  "replaceInFiles",
  "rm",
  "cp",
  "mv",
  "symlink",
  "readlink",
  "realpath",
  "resolvePath",
  "glob",
  "diff",
  "diffContent",
  "createArchive",
  "listArchive",
  "extractArchive",
  "compressFile",
  "decompressFile",
  "hashFile",
  "detectFile",
  "removeTree",
  "copyTree",
  "moveTree",
  "planEdits",
  "applyEditPlan",
  "applyEdits"
] as const satisfies readonly (keyof StateBackend)[];

export type StateMethodName = (typeof STATE_METHOD_NAMES)[number];
