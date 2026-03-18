export type {
  StateArchiveCreateResult,
  StateArchiveEntry,
  StateArchiveExtractResult,
  StateAppliedEditResult,
  StateApplyEditsOptions,
  StateApplyEditsResult,
  StateBackend,
  StateCapabilities,
  StateCompressionResult,
  StateCopyOptions,
  StateDirent,
  StateEdit,
  StateEditInstruction,
  StateEditPlan,
  StateEntryType,
  StateFileDetection,
  StateFileReplaceResult,
  StateFileSearchResult,
  StateFindEntry,
  StateFindOptions,
  StateHashOptions,
  StateJsonUpdateOperation,
  StateJsonUpdateResult,
  StateJsonWriteOptions,
  StateMkdirOptions,
  StateMethodName,
  StateMoveOptions,
  StateReplaceInFilesOptions,
  StateReplaceInFilesResult,
  StateReplaceResult,
  StateRmOptions,
  StateSearchOptions,
  StateStat,
  StateTextMatch,
  StateTreeNode,
  StateTreeOptions,
  StateTreeSummary,
  StatePlannedEdit,
  StateReplaceEditInstruction,
  StateWriteEditInstruction,
  StateWriteJsonEditInstruction
} from "./backend";
export { STATE_METHOD_NAMES, StateBatchOperationError } from "./backend";

export {
  FileSystemStateBackend,
  MemoryStateBackend,
  createMemoryStateBackend,
  type FileSystemStateBackendOptions,
  type MemoryStateBackendOptions
} from "./memory";
export {
  WorkspaceFileSystem,
  WorkspaceStateBackend,
  createWorkspaceStateBackend
} from "./workspace";
export {
  Workspace,
  type WorkspaceHost,
  type LegacyWorkspaceHost,
  type WorkspaceOptions,
  type EntryType,
  type FileInfo,
  type FileStat,
  type WorkspaceChangeEvent,
  type WorkspaceChangeType
} from "./filesystem";
export { InMemoryFs } from "./fs/in-memory-fs";
export type {
  FileSystem,
  FileSystemDirent,
  FsStat,
  InitialFiles,
  FileContent,
  MkdirOptions,
  RmOptions,
  CpOptions
} from "./fs/interface";
export { STATE_TYPES, STATE_SYSTEM_PROMPT } from "./prompt";
