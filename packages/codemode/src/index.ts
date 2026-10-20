// @cloudflare/codemode
//
// WorkerJavaScriptBackend runs an ECMAScript module in a fresh Dynamic
// Worker. Code reads and writes files the host provides through
// `node:fs`, and imports host modules (`ws:*`) whose functions run in the
// host Durable Object. @cloudflare/computer runs Workspace code on it.

export {
  WorkerJavaScriptBackend,
  type WorkerJavaScriptBackendOptions
} from "./backends/worker-javascript/worker-javascript";
export type { WorkspaceEgressPolicy } from "./runtime/egress";
export type {
  ModuleExecutionEnvelope,
  ModuleExecutionInput,
  WorkspaceModule,
  WorkspaceModuleBackend,
  WorkspaceModuleBackendHandle,
  WorkspaceModuleBackendHost,
  WorkspaceModuleCallContext,
  WorkspaceModuleFactory,
  WorkspaceModuleFunction,
  WorkspaceModuleFunctions,
  WorkspaceRuntimeAccess,
  WorkspaceRuntimeDatabase,
  WorkspaceRuntimeEvent,
  WorkspaceRuntimeFilesystem,
  WorkspaceRuntimeLoader,
  WorkspaceRuntimeStat,
  WorkspaceRuntimeValue
} from "./runtime/types";

// The legacy Code Mode API, re-exported from ./legacy. It is
// feature-frozen: it keeps working and won't change, but it is no longer
// maintained, and every export is marked deprecated. The code stays in
// one folder so a project can copy it.
export * from "./legacy/index";
