import type { ToolProvider } from "@cloudflare/codemode";
import {
  STATE_METHOD_NAMES,
  type StateBackend,
  type StateMethodName
} from "./backend";
import type { Workspace } from "./filesystem";
import { createWorkspaceStateBackend } from "./workspace";
import { STATE_TYPES } from "./prompt";
import { STATE_METHODS, callStateMethod, paramNames } from "./state-methods";

// The advertised sandbox API (STATE_TYPES) is object-args:
// `state.readFile({ path })`. Detect that shape — a single plain object whose
// keys are a subset of the method's parameter names — and route it through
// the shared object→positional mapping. Anything else is treated as the
// original positional call, so pre-object-args sandbox code keeps working.
function isObjectArgsCall(
  method: StateMethodName,
  args: unknown[]
): args is [Record<string, unknown>] {
  if (args.length !== 1) return false;
  const [first] = args;
  if (
    typeof first !== "object" ||
    first === null ||
    Array.isArray(first) ||
    first instanceof Uint8Array
  ) {
    return false;
  }
  const names = paramNames(STATE_METHODS[method]);
  const keys = Object.keys(first);
  return keys.length > 0 && keys.every((key) => names.includes(key));
}

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
      description: STATE_METHODS[method].description,
      execute: (...args: unknown[]) =>
        isObjectArgsCall(method, args)
          ? callStateMethod(backend, method, args[0])
          : (fn as (...args: unknown[]) => Promise<unknown>).apply(
              backend,
              args
            )
    };
  }

  return {
    name: "state",
    tools,
    types: STATE_TYPES
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

// ── Connector model (createCodemodeRuntime) ───────────────────────────
export { StateConnector, stateConnector } from "./connector";
export {
  STATE_METHODS,
  callStateMethod,
  objectArgsToPositional,
  type StateMethodSpec
} from "./state-methods";

export type { StateBackend, ToolProvider };
