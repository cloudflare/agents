/**
 * Executor interface and DynamicWorkerExecutor implementation.
 *
 * The Executor interface is the core abstraction — implement it to run
 * LLM-generated code in any sandbox (Workers, QuickJS, Node VM, etc.).
 */

import { RpcTarget } from "cloudflare:workers";
import { normalizeCode } from "./normalize";
import { sanitizeToolName } from "./utils";

export interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

/**
 * An executor runs LLM-generated code in a sandbox, making the provided
 * tool functions callable as `codemode.*` inside the sandbox.
 *
 * Implementations should never throw — errors are returned in `ExecuteResult.error`.
 */
export interface Executor {
  execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>,
    plugins?: SandboxPlugin[]
  ): Promise<ExecuteResult>;
}

// ── SandboxPlugin ─────────────────────────────────────────────────────

/**
 * A plugin adds a named global variable to the sandbox alongside `codemode.*`.
 *
 * Example: `statePlugin(backend)` from `@cloudflare/shell/workers` adds
 * `state.*` for filesystem operations.
 *
 * ```ts
 * import { statePlugin } from "@cloudflare/shell/workers";
 *
 * const result = await executor.execute(code, tools, [
 *   statePlugin(backend),
 * ]);
 * // sandbox: codemode.webSearch({ q }) AND state.readFile(path)
 * ```
 */
export interface SandboxPlugin {
  /** Name of the global variable exposed in the sandbox (e.g. "state", "db"). */
  name: string;

  /** Host-side RpcTarget that handles calls from the sandbox. */
  dispatcher: RpcTarget;

  /**
   * Optional extra module to make available for import in the sandbox.
   * The module source is typically a factory that creates the named global.
   */
  module?: { name: string; source: string };

  /**
   * Returns the code needed to initialize this plugin's global variable.
   * Called with `dispatcherRef` — the expression that evaluates to this
   * plugin's dispatcher stub inside the sandbox (e.g. "__plugins.state").
   *
   * Return value:
   *   - `imports`: optional top-level import statement(s) (joined at module top)
   *   - `init`: variable declaration that creates the named global
   */
  createGlobal(dispatcherRef: string): { imports?: string; init: string };

  /**
   * TypeScript type declaration for the global, for use in LLM system prompts.
   * Describes the API available as `globalName.*` in the sandbox.
   */
  types?: string;
}

// ── ToolDispatcher ────────────────────────────────────────────────────

/**
 * An RpcTarget that dispatches tool calls from the sandboxed Worker
 * back to the host. Passed via Workers RPC to the dynamic Worker's
 * evaluate() method — no globalOutbound or Fetcher bindings needed.
 */
export class ToolDispatcher extends RpcTarget {
  #fns: Record<string, (...args: unknown[]) => Promise<unknown>>;

  constructor(fns: Record<string, (...args: unknown[]) => Promise<unknown>>) {
    super();
    this.#fns = fns;
  }

  async call(name: string, argsJson: string): Promise<string> {
    const fn = this.#fns[name];
    if (!fn) {
      return JSON.stringify({ error: `Tool "${name}" not found` });
    }
    try {
      const args = argsJson ? JSON.parse(argsJson) : {};
      const result = await fn(args);
      return JSON.stringify({ result });
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}

// ── DynamicWorkerExecutor ─────────────────────────────────────────────

export interface DynamicWorkerExecutorOptions {
  loader: WorkerLoader;
  /**
   * Timeout in milliseconds for code execution. Defaults to 30000 (30s).
   */
  timeout?: number;
  /**
   * Controls outbound network access from sandboxed code.
   * - `null` (default): fetch() and connect() throw — sandbox is fully isolated.
   * - `undefined`: inherits parent Worker's network access (full internet).
   * - A `Fetcher`: all outbound requests route through this handler.
   */
  globalOutbound?: Fetcher | null;
  /**
   * Additional modules to make available in the sandbox.
   * Keys are module specifiers (e.g. `"mylib.js"`), values are module source code.
   *
   * Note: the key `"executor.js"` is reserved and will be ignored if provided.
   */
  modules?: Record<string, string>;
}

/**
 * Executes code in an isolated Cloudflare Worker via WorkerLoader.
 * Tool calls are dispatched via Workers RPC — the host passes a
 * ToolDispatcher (RpcTarget) to the Worker's evaluate() method.
 *
 * External fetch() and connect() are blocked by default via
 * `globalOutbound: null` (runtime-enforced). Pass a Fetcher to
 * `globalOutbound` to allow controlled outbound access.
 *
 * Plugins add named globals alongside `codemode.*`:
 * ```ts
 * import { statePlugin } from "@cloudflare/shell/workers";
 * const result = await executor.execute(code, tools, [statePlugin(backend)]);
 * // sandbox has both codemode.* and state.*
 * ```
 */
export class DynamicWorkerExecutor implements Executor {
  #loader: WorkerLoader;
  #timeout: number;
  #globalOutbound: Fetcher | null;
  #modules: Record<string, string>;

  constructor(options: DynamicWorkerExecutorOptions) {
    this.#loader = options.loader;
    this.#timeout = options.timeout ?? 30000;
    this.#globalOutbound = options.globalOutbound ?? null;
    const { "executor.js": _, ...safeModules } = options.modules ?? {};
    this.#modules = safeModules;
  }

  async execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>,
    plugins: SandboxPlugin[] = []
  ): Promise<ExecuteResult> {
    const normalized = normalizeCode(code);
    const timeoutMs = this.#timeout;

    // Sanitize fn keys so raw tool names (e.g. "github.list-issues") become
    // valid JS identifiers (e.g. "github_list_issues") on the codemode proxy.
    const sanitizedFns: Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    > = {};
    for (const [name, fn] of Object.entries(fns)) {
      sanitizedFns[sanitizeToolName(name)] = fn;
    }

    // Validate plugin names before generating code.
    const RESERVED_NAMES = new Set([
      "codemode",
      "__dispatcher",
      "__plugins",
      "__logs"
    ]);
    const VALID_IDENT = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
    const seenNames = new Set<string>();
    for (const plugin of plugins) {
      if (RESERVED_NAMES.has(plugin.name)) {
        return {
          result: undefined,
          error: `Plugin name "${plugin.name}" is reserved`
        };
      }
      if (!VALID_IDENT.test(plugin.name)) {
        return {
          result: undefined,
          error: `Plugin name "${plugin.name}" is not a valid JavaScript identifier`
        };
      }
      if (seenNames.has(plugin.name)) {
        return {
          result: undefined,
          error: `Duplicate plugin name "${plugin.name}"`
        };
      }
      seenNames.add(plugin.name);
    }

    // Collect plugin modules and generate plugin setup code.
    const pluginImports: string[] = [];
    const pluginInits: string[] = [];
    for (const plugin of plugins) {
      const { imports, init } = plugin.createGlobal(`__plugins.${plugin.name}`);
      if (imports) pluginImports.push(imports);
      pluginInits.push(init);
    }

    const executorModule = [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      ...pluginImports,
      "",
      "export default class CodeExecutor extends WorkerEntrypoint {",
      "  async evaluate(__dispatcher, __plugins = {}) {",
      "    const __logs = [];",
      '    console.log = (...a) => { __logs.push(a.map(String).join(" ")); };',
      '    console.warn = (...a) => { __logs.push("[warn] " + a.map(String).join(" ")); };',
      '    console.error = (...a) => { __logs.push("[error] " + a.map(String).join(" ")); };',
      "    const codemode = new Proxy({}, {",
      "      get: (_, toolName) => async (args) => {",
      "        const resJson = await __dispatcher.call(String(toolName), JSON.stringify(args ?? {}));",
      "        const data = JSON.parse(resJson);",
      "        if (data.error) throw new Error(data.error);",
      "        return data.result;",
      "      }",
      "    });",
      ...pluginInits.map((line) => `    ${line}`),
      "",
      "    try {",
      "      const result = await Promise.race([",
      "        ("
    ]
      .concat([normalized])
      .concat([
        ")(),",
        '        new Promise((_, reject) => setTimeout(() => reject(new Error("Execution timed out")), ' +
          timeoutMs +
          "))",
        "      ]);",
        "      return { result, logs: __logs };",
        "    } catch (err) {",
        "      return { result: undefined, error: err.message, logs: __logs };",
        "    }",
        "  }",
        "}"
      ])
      .join("\n");

    const dispatcher = new ToolDispatcher(sanitizedFns);

    // Build plugin dispatcher map: { state: StateDispatcher, db: DbDispatcher, ... }
    const pluginDispatchers: Record<string, RpcTarget> = {};
    for (const plugin of plugins) {
      pluginDispatchers[plugin.name] = plugin.dispatcher;
    }

    // Collect all modules: executor-level defaults + plugins + user-provided.
    const pluginModules: Record<string, string> = {};
    for (const plugin of plugins) {
      if (plugin.module) {
        pluginModules[plugin.module.name] = plugin.module.source;
      }
    }

    const worker = this.#loader.get(`codemode-${crypto.randomUUID()}`, () => ({
      compatibilityDate: "2025-06-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "executor.js",
      modules: {
        ...pluginModules,
        ...this.#modules,
        "executor.js": executorModule
      },
      globalOutbound: this.#globalOutbound
    }));

    const entrypoint = worker.getEntrypoint() as unknown as {
      evaluate(
        dispatcher: ToolDispatcher,
        plugins: Record<string, RpcTarget>
      ): Promise<{
        result: unknown;
        error?: string;
        logs?: string[];
      }>;
    };
    const response = await entrypoint.evaluate(dispatcher, pluginDispatchers);

    if (response.error) {
      return { result: undefined, error: response.error, logs: response.logs };
    }

    return { result: response.result, logs: response.logs };
  }
}
