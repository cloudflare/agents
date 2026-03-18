import type { ToolProvider } from "@cloudflare/codemode";
import {
  STATE_METHOD_NAMES,
  type StateBackend,
  type StateMethodName
} from "./backend";
import type { Workspace } from "./filesystem";
import { createWorkspaceStateBackend } from "./workspace";
import { STATE_TYPES } from "./prompt";

/**
 * Create state tools from a StateBackend.
 */
function createStateToolProvider(backend: StateBackend): ToolProvider {
  const tools: Record<
    string,
    { description: string; execute: (...args: unknown[]) => Promise<unknown> }
  > = {};

  for (const method of STATE_METHOD_NAMES) {
    const fn = backend[method as StateMethodName];
    if (typeof fn !== "function") continue;

    tools[method] = {
      description: `state.${method}`,
      execute: (fn as (...args: unknown[]) => Promise<unknown>).bind(backend)
    };
  }

  return {
    name: "state",
    tools,
    types: STATE_TYPES,
    positionalArgs: true
  };
}

/**
 * Creates a `ToolProvider` that exposes `state.*` inside any
 * codemode sandbox execution.
 *
 * ```ts
 * import { stateTools } from "@cloudflare/shell/workers";
 *
 * createCodeTool({
 *   tools: [
 *     { tools: myTools },
 *     stateTools(workspace),
 *   ],
 *   executor,
 * });
 * // sandbox: codemode.myTool({ query: "test" }) AND state.readFile("/path")
 * ```
 */
export function stateTools(workspace: Workspace): ToolProvider {
  return createStateToolProvider(createWorkspaceStateBackend(workspace));
}

/**
 * Creates a `ToolProvider` from a raw `StateBackend`.
 * Use `stateTools(workspace)` for the common case.
 */
export function stateToolsFromBackend(backend: StateBackend): ToolProvider {
  return createStateToolProvider(backend);
}

export type { StateBackend, ToolProvider };
