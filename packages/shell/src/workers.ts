import { RpcTarget } from "cloudflare:workers";
import type { SandboxPlugin } from "@cloudflare/codemode";
import {
  STATE_METHOD_NAMES,
  type StateBackend,
  type StateMethodName
} from "./backend";
import {
  createStateModuleSource,
  STATE_RUNTIME_MODULE_ID
} from "./runtime/state-module";
import { STATE_TYPES } from "./prompt";

// ── StateDispatcher ───────────────────────────────────────────────────

/**
 * RpcTarget that dispatches `state.*` calls from the sandbox back to a
 * `StateBackend` on the host. Used internally by `statePlugin()`.
 */
export class StateDispatcher extends RpcTarget {
  private readonly backend: StateBackend;
  private static readonly methods = new Set<string>(STATE_METHOD_NAMES);

  constructor(backend: StateBackend) {
    super();
    this.backend = backend;
  }

  async call(method: string, argsJson: string): Promise<string> {
    if (!StateDispatcher.methods.has(method)) {
      return JSON.stringify({ error: `State method "${method}" not found` });
    }

    const fn = this.backend[method as StateMethodName];
    if (typeof fn !== "function") {
      return JSON.stringify({
        error: `State method "${method}" is not callable`
      });
    }

    try {
      const args = argsJson ? JSON.parse(argsJson) : [];
      const callable = fn as (...args: unknown[]) => Promise<unknown>;
      const result = await callable.apply(
        this.backend,
        Array.isArray(args) ? args : []
      );
      return JSON.stringify({ result });
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

// ── statePlugin ───────────────────────────────────────────────────────

/**
 * Creates a `SandboxPlugin` that exposes `state.*` inside any
 * `DynamicWorkerExecutor` execution.
 *
 * ```ts
 * import { DynamicWorkerExecutor } from "@cloudflare/codemode";
 * import { statePlugin, createWorkspaceStateBackend } from "@cloudflare/shell";
 * import { statePlugin as sp } from "@cloudflare/shell/workers";
 *
 * const result = await executor.execute(code, tools, [
 *   sp(createWorkspaceStateBackend(workspace)),
 * ]);
 * // sandbox: codemode.webSearch({ q }) AND state.readFile(path)
 * ```
 */
export function statePlugin(backend: StateBackend): SandboxPlugin {
  return {
    name: "state",
    dispatcher: new StateDispatcher(backend),
    module: {
      name: STATE_RUNTIME_MODULE_ID,
      source: createStateModuleSource()
    },
    createGlobal: (dispatcherRef) => ({
      imports: `import { createState } from ${JSON.stringify(STATE_RUNTIME_MODULE_ID)};`,
      init: `const state = createState(${dispatcherRef});`
    }),
    types: STATE_TYPES
  };
}

export type { StateBackend, SandboxPlugin };
