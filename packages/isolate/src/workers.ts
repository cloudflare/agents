import { RpcTarget } from "cloudflare:workers";
import {
  STATE_METHOD_NAMES,
  type StateBackend,
  type StateExecuteResult,
  type StateMethodName
} from "./backend";
import {
  createStateModuleSource,
  STATE_RUNTIME_MODULE_ID
} from "./runtime/state-module";

export interface DynamicStateExecutorOptions {
  loader: WorkerLoader;
  timeout?: number;
  globalOutbound?: Fetcher | null;
  modules?: Record<string, string>;
}

const STATE_METHOD_SET = new Set<string>(STATE_METHOD_NAMES);

export class StateDispatcher extends RpcTarget {
  constructor(private readonly backend: StateBackend) {
    super();
  }

  async call(method: string, argsJson: string): Promise<string> {
    if (!STATE_METHOD_SET.has(method)) {
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

export class DynamicStateExecutor {
  readonly #loader: WorkerLoader;
  readonly #timeout: number;
  readonly #globalOutbound: Fetcher | null;
  readonly #modules: Record<string, string>;

  constructor(options: DynamicStateExecutorOptions) {
    this.#loader = options.loader;
    this.#timeout = options.timeout ?? 30_000;
    this.#globalOutbound = options.globalOutbound ?? null;
    const {
      "executor.js": _ignoredExecutor,
      [STATE_RUNTIME_MODULE_ID]: _ignoredStateModule,
      ...safeModules
    } = options.modules ?? {};
    this.#modules = safeModules;
  }

  async execute(
    code: string,
    backend: StateBackend
  ): Promise<StateExecuteResult> {
    const executorModule = [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      `import { createState } from ${JSON.stringify(STATE_RUNTIME_MODULE_ID)};`,
      "",
      "export default class StateExecutor extends WorkerEntrypoint {",
      "  async evaluate(dispatcher) {",
      "    const __logs = [];",
      '    console.log = (...a) => { __logs.push(a.map(String).join(" ")); };',
      '    console.warn = (...a) => { __logs.push("[warn] " + a.map(String).join(" ")); };',
      '    console.error = (...a) => { __logs.push("[error] " + a.map(String).join(" ")); };',
      "    const state = createState(dispatcher);",
      "",
      "    try {",
      "      const result = await Promise.race([",
      `        (${code})(),`,
      '        new Promise((_, reject) => setTimeout(() => reject(new Error("Execution timed out")), ' +
        this.#timeout +
        "))",
      "      ]);",
      "      return { result, logs: __logs };",
      "    } catch (err) {",
      "      return {",
      "        result: undefined,",
      "        error: err instanceof Error ? err.message : String(err),",
      "        logs: __logs",
      "      };",
      "    }",
      "  }",
      "}"
    ].join("\n");

    const dispatcher = new StateDispatcher(backend);
    const worker = this.#loader.get(`isolate-${crypto.randomUUID()}`, () => ({
      compatibilityDate: "2026-01-28",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "executor.js",
      modules: {
        ...this.#modules,
        [STATE_RUNTIME_MODULE_ID]: createStateModuleSource(),
        "executor.js": executorModule
      },
      globalOutbound: this.#globalOutbound
    }));

    const entrypoint = worker.getEntrypoint() as unknown as {
      evaluate(dispatcher: StateDispatcher): Promise<StateExecuteResult>;
    };
    return entrypoint.evaluate(dispatcher);
  }
}

export type { StateBackend, StateExecuteResult } from "./backend";
