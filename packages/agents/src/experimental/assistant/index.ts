export { createWorkspaceTools } from "./tools/index";

export {
  createReadTool,
  createWriteTool,
  createEditTool,
  createListTool,
  createFindTool,
  createGrepTool
} from "./tools/index";

export type {
  ReadOperations,
  WriteOperations,
  EditOperations,
  ListOperations,
  FindOperations,
  GrepOperations
} from "./tools/types";

// AssistantAgent base class
export { AssistantAgent } from "./agent";
export type { ChatMessageOptions, AssistantAgentOptions } from "./agent";

// Session management
export { SessionManager } from "./session/index";
export type {
  Session,
  Compaction,
  SessionManagerOptions
} from "./session/index";

// Truncation utilities
export {
  truncateHead,
  truncateTail,
  truncateLines,
  truncateMiddle,
  truncateToolOutput
} from "./session/truncation";
