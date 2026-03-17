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
  StateExecuteResult,
  StateExecutor,
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
  MemoryStateBackend,
  createMemoryStateBackend,
  type MemoryStateBackendOptions
} from "./memory";
export {
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
export { STATE_TYPES, STATE_SYSTEM_PROMPT } from "./prompt";
