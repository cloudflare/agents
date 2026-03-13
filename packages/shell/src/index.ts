// Shell class + compat aliases
export {
  Shell,
  Bash,
  type ShellOptions,
  type BashOptions,
  type ShellLogger,
  type BashLogger,
  type ExecOptions,
  type ShellExecResult
} from "./Shell";

// Pluggable interfaces
export type {
  SqlExecutor,
  CodeExecutor,
  MarkdownConverter
} from "./interfaces";

// Command registry
export type { CommandName, NetworkCommandName } from "./commands/registry";
export { getCommandNames, getNetworkCommandNames } from "./commands/registry";

// Custom commands API
export type { CustomCommand, LazyCommand } from "./custom-commands";
export { defineCommand } from "./custom-commands";

// Filesystem
export { InMemoryFs } from "./fs/in-memory-fs/index";
export type {
  BufferEncoding,
  CpOptions,
  DirectoryEntry,
  FileContent,
  FileEntry,
  FileInit,
  FileSystemFactory,
  FsEntry,
  FsStat,
  InitialFiles,
  LazyFileEntry,
  LazyFileProvider,
  MkdirOptions,
  RmOptions,
  SymlinkEntry
} from "./fs/interface";

// Network
export type { NetworkConfig, SecureFetch } from "./network/index";
export {
  NetworkAccessDeniedError,
  RedirectNotAllowedError,
  TooManyRedirectsError
} from "./network/index";

// Parser
export { parse } from "./parser/parser";

// Core types
export type {
  BashExecResult,
  Command,
  CommandContext,
  ExecResult,
  IFileSystem,
  TraceCallback
} from "./types";

// Execution limits
export type { ExecutionLimits } from "./limits";

// AST types
export type {
  CommandNode,
  PipelineNode,
  ScriptNode,
  SimpleCommandNode,
  StatementNode,
  WordNode
} from "./ast/types";
