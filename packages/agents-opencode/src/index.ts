export {
  createOpenCodeTool,
  opencodeTask,
  type OpenCodeToolOptions,
  type OpenCodeTaskOptions
} from "./tool";
export { OpenCodeSession } from "./session";
export { FileWatcher } from "./file-watcher";
export { OpenCodeStreamAccumulator } from "./stream";
export {
  resolveProviders,
  detectProviders,
  describeRequiredEnvVars,
  getProviderDisplayName,
  inferProviderFromModel
} from "./providers";
export { backupSession, restoreSession, updateSessionState } from "./backup";

export type {
  OpenCodeRunOutput,
  OpenCodeRunOptions,
  OpenCodeSessionState,
  ProviderID,
  ProviderCredentials,
  AllProviderCredentials,
  ResolvedProvider,
  ServerMessage,
  FileChange,
  FileDiff,
  Diagnostic,
  ProcessInfo,
  Todo
} from "./types";
export type { FileChangeCallback } from "./file-watcher";
export type { OpenCodeSSEEvent } from "./stream";
export type { RestoreResult } from "./backup";
