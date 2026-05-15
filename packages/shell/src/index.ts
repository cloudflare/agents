// ── Workspace (durable SQLite + R2 filesystem) ───────────────────────
export {
  Workspace,
  type SqlBackend,
  type SqlSource,
  type SqlParam,
  type WorkspaceOptions,
  type EntryType,
  type FileInfo,
  type FileStat,
  type WorkspaceChangeEvent,
  type WorkspaceChangeType,
  type WorkspaceFsLike
} from "./filesystem";

// ── FileSystem interface + InMemoryFs ─────────────────────────────────
export { InMemoryFs } from "./fs/in-memory-fs";
export type { FileSystem, FsStat, InitialFiles } from "./fs/interface";

// ── StateBackend adapter ──────────────────────────────────────────────
export type { StateBackend } from "./backend";
export { StateBatchOperationError } from "./backend";
export {
  FileSystemStateBackend,
  createMemoryStateBackend,
  type FileSystemStateBackendOptions
} from "./memory";
export {
  createWorkspaceSourceProvider,
  createWorkspaceStateBackend,
  WorkspaceFileSystem,
  type WorkspaceSourceEntry,
  type WorkspaceSourceEntryKind,
  type WorkspaceSourceLike,
  type WorkspaceSourceProvider,
  type WorkspaceSourceProviderOptions
} from "./workspace";

// ── LLM prompt helpers ────────────────────────────────────────────────
export { STATE_TYPES, STATE_SYSTEM_PROMPT } from "./prompt";
