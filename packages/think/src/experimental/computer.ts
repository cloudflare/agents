import {
  Workspace as Computer,
  type WorkspaceClient,
  type WorkspaceOptions as ComputerOptions
} from "@cloudflare/computer";
import type { WorkspaceLike } from "../tools/workspace";

export {
  getWorkspace,
  WorkspaceServiceProxy,
  withWorkspace
} from "@cloudflare/computer";
export { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
export type {
  WorkerShellBackendOptions,
  WorkerShellFetcher
} from "@cloudflare/computer/backends/worker-shell";
export type { ComputerOptions, WorkspaceClient };
export { Computer };

/**
 * A locally owned Computer with Think compatibility methods enabled.
 *
 * This is the actual Computer instance, not an adapter. Its native `fs`,
 * `shell`, `git`, `assets`, and other surfaces remain directly available.
 */
export type LocalComputerWorkspace = Computer & WorkspaceLike;
export type ComputerWorkspace = WorkspaceClient & WorkspaceLike;

/**
 * Create a Think-compatible workspace backed by a locally owned Computer.
 *
 * @experimental There is currently no data migration path from Think's
 * legacy workspace.
 */
export function createComputerWorkspace(
  options: ComputerOptions
): LocalComputerWorkspace {
  return new Computer({
    ...options,
    useThink: true
  }) as LocalComputerWorkspace;
}

/**
 * Mark a Computer client whose owner enabled `useThink` as a Think workspace.
 *
 * The client already contains the compatibility methods; this function only
 * narrows their optional types.
 */
export function adaptComputer(computer: WorkspaceClient): ComputerWorkspace {
  // WorkspaceClient exposes these methods as optional because useThink is an
  // owner-side runtime option that TypeScript cannot infer across RPC.
  const methods: Array<keyof WorkspaceLike> = [
    "readFile",
    "readFileBytes",
    "writeFile",
    "readDir",
    "rm",
    "glob",
    "mkdir",
    "stat"
  ];
  for (const method of methods) {
    if (typeof computer[method] !== "function") {
      throw new Error(
        "Computer client is not Think-compatible. Construct its Workspace with useThink: true."
      );
    }
  }
  return computer as ComputerWorkspace;
}
