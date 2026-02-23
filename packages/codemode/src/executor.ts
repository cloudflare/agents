/**
 * Executor interface and DynamicWorkerExecutor implementation.
 *
 * The Executor interface is the core abstraction — implement it to run
 * LLM-generated code in any sandbox (Workers, QuickJS, Node VM, etc.).
 */

import { RpcTarget } from "cloudflare:workers";

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
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult>;
}

// -- ToolDispatcher (RPC target for tool calls from sandboxed Workers) --

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

// -- DynamicWorkerExecutor (Cloudflare Workers) --

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
}

/**
 * Executes code in an isolated Cloudflare Worker via WorkerLoader.
 * Tool calls are dispatched via Workers RPC — the host passes a
 * ToolDispatcher (RpcTarget) to the Worker's evaluate() method.
 *
 * External fetch() and connect() are blocked by default via
 * `globalOutbound: null` (runtime-enforced). Pass a Fetcher to
 * `globalOutbound` to allow controlled outbound access.
 */
export class DynamicWorkerExecutor implements Executor {
  #loader: WorkerLoader;
  #timeout: number;
  #globalOutbound: Fetcher | null;

  constructor(options: DynamicWorkerExecutorOptions) {
    this.#loader = options.loader;
    this.#timeout = options.timeout ?? 30000;
    this.#globalOutbound = options.globalOutbound ?? null;
  }

  async execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    const timeoutMs = this.#timeout;

    const modulePrefix = [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      "",
      "export default class CodeExecutor extends WorkerEntrypoint {",
      "  async evaluate(dispatcher) {",
      "    const __logs = [];",
      '    console.log = (...a) => { __logs.push(a.map(String).join(" ")); };',
      '    console.warn = (...a) => { __logs.push("[warn] " + a.map(String).join(" ")); };',
      '    console.error = (...a) => { __logs.push("[error] " + a.map(String).join(" ")); };',
      "    const codemode = new Proxy({}, {",
      "      get: (_, toolName) => async (args) => {",
      "        const resJson = await dispatcher.call(String(toolName), JSON.stringify(args ?? {}));",
      "        const data = JSON.parse(resJson);",
      "        if (data.error) throw new Error(data.error);",
      "        return data.result;",
      "      }",
      "    });",
      "",
      "    try {",
      "      const result = await Promise.race([",
      "        ("
    ].join("\n");

    const moduleSuffix = [
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
    ].join("\n");

    const executorModule = modulePrefix + code + moduleSuffix;

    const dispatcher = new ToolDispatcher(fns);

    const worker = this.#loader.get(`codemode-${crypto.randomUUID()}`, () => ({
      compatibilityDate: "2025-06-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "executor.js",
      modules: {
        "executor.js": executorModule
      },
      globalOutbound: this.#globalOutbound
    }));

    const entrypoint = worker.getEntrypoint() as unknown as {
      evaluate(dispatcher: ToolDispatcher): Promise<{
        result: unknown;
        error?: string;
        logs?: string[];
      }>;
    };
    const response = await entrypoint.evaluate(dispatcher);

    if (response.error) {
      return { result: undefined, error: response.error, logs: response.logs };
    }

    return { result: response.result, logs: response.logs };
  }
}
