export { createWorkspaceTools } from "./tools/index";

export {
  createReadTool,
  createWriteTool,
  createEditTool,
  createListTool,
  createFindTool,
  createGrepTool,
  createDeleteTool,
  createExecuteTool,
  createExtensionTools
} from "./tools/index";

export type { CreateExecuteToolOptions } from "./tools/index";
export type { ExtensionToolsOptions } from "./tools/index";

export type {
  ReadOperations,
  WriteOperations,
  EditOperations,
  ListOperations,
  FindOperations,
  DeleteOperations,
  GrepOperations
} from "./tools/types";

// AssistantAgent base class
export { AssistantAgent } from "./agent";
export type { ChatMessageOptions } from "./agent";

// Session management
export { SessionManager } from "./session/index";
export type {
  Session,
  Compaction,
  SessionManagerOptions
} from "./session/index";

// Extension system
export { ExtensionManager, HostBridge } from "./extensions/index";
export type {
  ExtensionManagerOptions,
  ExtensionManifest,
  ExtensionPermissions,
  ExtensionToolDescriptor,
  ExtensionInfo
} from "./extensions/index";

// Truncation utilities
export {
  truncateHead,
  truncateTail,
  truncateLines,
  truncateMiddle,
  truncateToolOutput
} from "./session/truncation";
