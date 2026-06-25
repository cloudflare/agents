/**
 * Executor interface and DynamicWorkerExecutor implementation.
 *
 * The Executor interface is the core abstraction — implement it to run
 * LLM-generated code in any sandbox (Workers, QuickJS, Node VM, etc.).
 */

import { RpcTarget } from "cloudflare:workers";
import type {
  ExecuteResult,
  ExecuteOptions,
  Executor,
  ResolvedProvider
} from "./executor-types";
import { normalizeCode } from "./normalize";
import { sanitizeToolName } from "./utils";
import type { ToolDescriptors } from "./tool-types";
import type { ToolSet } from "ai";
export type {
  ExecuteResult,
  ExecuteOptions,
  Executor,
  ConnectorBinding,
  ResolvedProvider
} from "./executor-types";
// ConnectorBinding re-exported for public API — used by proxy-tool and runtime.

import { stringifyForCodemode, parseForCodemode } from "./codec";

// Control protocol between a connector binding (host) and the sandbox proxy.
// A binding returns `{ [CONNECTOR_CONTROL_KEY]: "pause" }` (awaiting approval /
// diverged) or `{ [CONNECTOR_CONTROL_KEY]: "error", message }` (the call threw
// on the host) instead of throwing across RPC; the generated proxy re-throws
// locally. Keep in sync with proxy-tool.ts (CONTROL_KEY / PAUSE_SENTINEL).
const CONNECTOR_CONTROL_KEY = "__codemode_control__";
const PAUSE_SENTINEL_LITERAL = "__CODEMODE_PAUSE__";

/**
 * Best-effort synchronous disposal of a disposable resource.
 *
 * Dynamically-loaded Workers and the RPC `Fetcher` stubs returned by
 * `getEntrypoint()` own native handles. Left to GC, they can be finalized
 * after the isolate's destruction queue has closed — under the
 * `@cloudflare/vitest-pool-workers` teardown matrix this trips a fatal
 * workerd assertion ("tried to defer destruction during isolate shutdown")
 * that kills the worker. Disposing them eagerly releases the handle while the
 * isolate is still alive. Disposal must never mask the execution result, so
 * failures are swallowed.
 */
function disposeQuietly(resource: unknown): void {
  if (
    typeof resource !== "object" ||
    resource === null ||
    !(Symbol.dispose in resource)
  ) {
    return;
  }
  const dispose = (resource as { [Symbol.dispose]?: unknown })[Symbol.dispose];
  if (typeof dispose !== "function") return;
  try {
    (dispose as () => void).call(resource);
  } catch {
    // Best-effort cleanup.
  }
}

const SANDBOX_CODEC = String.raw`
    const __CODEMODE_BINARY_TAG = "__codemode_binary_v1__";
    function __bytesToBase64(bytes) {
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.byteLength; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength)));
      }
      return btoa(binary);
    }
    function __base64ToBytes(b64) {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    function __encodeCodemodeValue(value) {
      if (value instanceof Uint8Array) {
        return { [__CODEMODE_BINARY_TAG]: "Uint8Array", data: __bytesToBase64(value) };
      }
      if (value instanceof ArrayBuffer) {
        return { [__CODEMODE_BINARY_TAG]: "ArrayBuffer", data: __bytesToBase64(new Uint8Array(value)) };
      }
      if (ArrayBuffer.isView(value)) {
        return { [__CODEMODE_BINARY_TAG]: "ArrayBufferView", data: __bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
      }
      return value;
    }
    function __decodeCodemodeValue(value) {
      if (!value || typeof value !== "object" || !(__CODEMODE_BINARY_TAG in value) || typeof value.data !== "string") return value;
      const bytes = __base64ToBytes(value.data);
      if (value[__CODEMODE_BINARY_TAG] === "ArrayBuffer") {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      return bytes;
    }
    function __stringifyForCodemode(value) {
      return JSON.stringify(value, (_key, nested) => __encodeCodemodeValue(nested));
    }
    function __parseForCodemode(json) {
      return JSON.parse(json, (_key, nested) => __decodeCodemodeValue(nested));
    }
`;

// ── ToolProvider ──────────────────────────────────────────────────────

/**
 * A minimal tool record — just a description and an execute function.
 * Use this for providers that supply their own `types` and don't need
 * schema-based type generation (e.g. stateTools).
 */
export type SimpleToolRecord = Record<
  string,
  { description?: string; execute: (args: unknown) => Promise<unknown> }
>;

/**
 * All tool record types accepted by a ToolProvider.
 */
export type ToolProviderTools = ToolDescriptors | ToolSet | SimpleToolRecord;

/**
 * A ToolProvider contributes tools to the codemode sandbox under a namespace.
 *
 * Each provider's tools are accessible as `name.toolName()` in sandbox code.
 * If `name` is omitted, tools are exposed under the default `codemode.*` namespace.
 *
 * @example Multiple providers with different namespaces
 * ```ts
 * createCodeTool({
 *   tools: [
 *     { name: "github", tools: githubTools },
 *     { name: "shell", tools: shellTools },
 *     { tools: aiTools }, // default "codemode" namespace
 *   ],
 *   executor,
 * });
 * // sandbox: github.listIssues(), shell.exec(), codemode.search()
 * ```
 */
export interface ToolProvider {
  /** Namespace prefix in the sandbox (e.g. "state", "mcp"). Defaults to "codemode". */
  name?: string;

  /** Tools exposed as `namespace.toolName()` in the sandbox. */
  tools: ToolProviderTools;

  /** Type declarations for the LLM. Auto-generated from `tools` if omitted. */
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

  async call(name: string, argsJson?: string): Promise<string> {
    const fn = this.#fns[name];
    if (!fn) {
      return stringifyForCodemode({ error: `Tool "${name}" not found` });
    }
    try {
      const args = argsJson ? parseForCodemode(argsJson) : [];
      const result = await fn(...(Array.isArray(args) ? args : [args]));
      return stringifyForCodemode({ result });
    } catch (err) {
      return stringifyForCodemode({
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}

// ── DynamicWorkerExecutor ─────────────────────────────────────────────

const DEFAULT_DYNAMIC_WORKER_EXECUTION_TIMEOUT_MS = 60_000;

export interface DynamicWorkerExecutorOptions {
  loader: WorkerLoader;
  /**
   * Timeout in milliseconds for code execution. Defaults to 60000 (60s).
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
  /**
   * Additional env bindings injected into the sandbox worker.
   * Use this to pass ServiceStubs (e.g. CodemodeConnector instances)
   * so sandbox code can call their RPC methods directly.
   *
   * These are available as `env.KEY` inside the sandbox worker.
   */
  bindings?: Record<string, unknown>;
}

/**
 * Executes code in an isolated Cloudflare Worker via WorkerLoader.
 * Tool calls are dispatched via Workers RPC — the host passes
 * ToolDispatchers (one per namespace) to the Worker's evaluate() method.
 *
 * External fetch() and connect() are blocked by default via
 * `globalOutbound: null` (runtime-enforced). Pass a Fetcher to
 * `globalOutbound` to allow controlled outbound access.
 *
 * @example
 * ```ts
 * const result = await executor.execute(code, [
 *   { name: "codemode", fns: { search: searchFn } },
 *   { name: "state", fns: { readFile: readFileFn } },
 * ]);
 * // sandbox has both codemode.search() and state.readFile()
 * ```
 */
export class DynamicWorkerExecutor implements Executor {
  #loader: WorkerLoader;
  #timeout: number;
  #globalOutbound: Fetcher | null;
  #modules: Record<string, string>;
  #bindings: Record<string, unknown>;

  constructor(options: DynamicWorkerExecutorOptions) {
    this.#loader = options.loader;
    this.#timeout =
      options.timeout ?? DEFAULT_DYNAMIC_WORKER_EXECUTION_TIMEOUT_MS;
    this.#globalOutbound = options.globalOutbound ?? null;
    const { "executor.js": _, ...safeModules } = options.modules ?? {};
    this.#modules = safeModules;
    this.#bindings = options.bindings ?? {};
  }

  async execute(
    code: string,
    providersOrFns:
      | ResolvedProvider[]
      | Record<string, (...args: unknown[]) => Promise<unknown>>,
    options?: ExecuteOptions
  ): Promise<ExecuteResult> {
    // Backwards compat: detect old `execute(code, fns)` signature.
    let providers: ResolvedProvider[];
    if (!Array.isArray(providersOrFns)) {
      console.warn(
        "[@cloudflare/codemode] Passing raw fns to executor.execute() is deprecated. " +
          "Use ResolvedProvider[] instead. This will be removed in the next major version."
      );
      providers = [{ name: "codemode", fns: providersOrFns }];
    } else {
      providers = providersOrFns;
    }

    const normalized = normalizeCode(code);
    const timeoutMs = this.#timeout;

    // Validate provider names. Each provider is declared as a top-level
    // `const <name>` inside the generated `evaluate()` body, so a provider
    // name must not collide with the harness's own locals/imports or with the
    // JS globals the harness relies on (e.g. `Promise.race`, `setTimeout`,
    // `new Error`, `console`) — shadowing those would break execution in
    // confusing ways.
    const RESERVED_NAMES = new Set([
      // Harness internals (locals/imports/classes in the generated module).
      "__dispatchers",
      "__connectors",
      "__logs",
      "__CODEMODE_BINARY_TAG",
      "__bytesToBase64",
      "__base64ToBytes",
      "__encodeCodemodeValue",
      "__decodeCodemodeValue",
      "__stringifyForCodemode",
      "__parseForCodemode",
      "WorkerEntrypoint",
      "CodeExecutor",
      // Globals the generated harness code depends on.
      "Promise",
      "setTimeout",
      "Error",
      "console"
    ]);
    const VALID_IDENT = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
    const seenNames = new Set<string>();
    for (const provider of providers) {
      if (RESERVED_NAMES.has(provider.name)) {
        return {
          result: undefined,
          error: `Provider name "${provider.name}" is reserved`
        };
      }
      if (!VALID_IDENT.test(provider.name)) {
        return {
          result: undefined,
          error: `Provider name "${provider.name}" is not a valid JavaScript identifier`
        };
      }
      if (seenNames.has(provider.name)) {
        return {
          result: undefined,
          error: `Duplicate provider name "${provider.name}"`
        };
      }
      seenNames.add(provider.name);
    }

    // Connector bindings — passed as env to the sandbox worker.
    // These use direct RPC (callTool) instead of ToolDispatcher serialization.
    const connectors = options?.connectors ?? [];
    const connectorNames = new Set(connectors.map((c) => c.name));

    // Validate connector names don't clash with provider names or reserved
    // names. RESERVED_NAMES includes the `evaluate(__dispatchers, __connectors)`
    // parameters, so a connector/provider can't shadow the RPC bindings its own
    // generated proxy reads from (`__connectors.<name>.callTool(...)`).
    for (const connector of connectors) {
      if (RESERVED_NAMES.has(connector.name)) {
        return {
          result: undefined,
          error: `Connector name "${connector.name}" is reserved`
        };
      }
      if (!VALID_IDENT.test(connector.name)) {
        return {
          result: undefined,
          error: `Connector name "${connector.name}" is not a valid JavaScript identifier`
        };
      }
      if (seenNames.has(connector.name)) {
        return {
          result: undefined,
          error: `Duplicate name "${connector.name}" (connector clashes with provider)`
        };
      }
      seenNames.add(connector.name);
    }

    // Generate Proxy globals for dispatcher-backed providers.
    // Backed by a real object so a provider's `prelude` can assign real
    // in-sandbox functions (own properties) that take precedence over dispatch.
    const proxyInits = providers
      .filter((p) => !connectorNames.has(p.name))
      .map(
        (p) =>
          `    const ${p.name} = new Proxy({}, {\n` +
          `      get: (target, toolName) => {\n` +
          `        if (Object.prototype.hasOwnProperty.call(target, toolName)) return target[toolName];\n` +
          `        if (typeof toolName !== "string") return undefined;\n` +
          `        return async (...args) => {\n` +
          `          const resJson = await __dispatchers.${p.name}.call(String(toolName), __stringifyForCodemode(args));\n` +
          `          const data = __parseForCodemode(resJson);\n` +
          `          if (data.error) throw new Error(data.error);\n` +
          `          return data.result;\n` +
          `        };\n` +
          `      }\n` +
          `    });`
      );

    // Sandbox-side preludes (e.g. codemode.step) injected after proxy setup.
    const preludeInits = providers
      .filter((p) => !connectorNames.has(p.name) && p.prelude)
      .map((p) => p.prelude as string);

    // Generate Proxy globals for connector-backed namespaces.
    // These call connector.callTool(method, args) via Workers RPC — no
    // serialization layer. Connector bindings are passed as an argument to
    // evaluate() (not via env): live RPC references can be serialized as RPC
    // call arguments but NOT as Worker `env` config values.
    //
    // A binding never throws across RPC (that would leave an unhandled remote
    // rejection); instead it returns a control marker — "pause" (awaiting
    // approval) or "error" (the host call threw) — which we turn into a local
    // throw here, where the sandbox's own try/catch handles it.
    const connectorProxyInits = connectors.map(
      (c) =>
        `    const ${c.name} = new Proxy({}, {\n` +
        `      get: (_, toolName) => {\n` +
        `        if (typeof toolName !== "string") return undefined;\n` +
        `        return async (...args) => {\n` +
        `          const __r = await __connectors.${c.name}.callTool(toolName, args[0]);\n` +
        `          if (__r && typeof __r === "object") {\n` +
        `            if (__r.${CONNECTOR_CONTROL_KEY} === "pause") throw new Error("${PAUSE_SENTINEL_LITERAL}");\n` +
        `            if (__r.${CONNECTOR_CONTROL_KEY} === "error") throw new Error(String(__r.message));\n` +
        `          }\n` +
        `          return __r;\n` +
        `        };\n` +
        `      }\n` +
        `    });`
    );

    const executorModule = [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      "",
      "export default class CodeExecutor extends WorkerEntrypoint {",
      "  async evaluate(__dispatchers = {}, __connectors = {}) {",
      "    const __logs = [];",
      '    console.log = (...a) => { __logs.push(a.map(String).join(" ")); };',
      '    console.warn = (...a) => { __logs.push("[warn] " + a.map(String).join(" ")); };',
      '    console.error = (...a) => { __logs.push("[error] " + a.map(String).join(" ")); };',
      SANDBOX_CODEC,
      ...proxyInits,
      ...connectorProxyInits,
      ...preludeInits,
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

    // Build dispatcher map: { codemode: ToolDispatcher, state: ToolDispatcher, ... }
    // Sanitize fn keys so raw tool names (e.g. "github.list-issues") become
    // valid JS identifiers (e.g. "github_list_issues") on the proxy.
    const dispatchers: Record<string, ToolDispatcher> = {};
    for (const provider of providers) {
      const sanitizedFns: Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      > = {};
      const sanitizedNames = new Map<string, string>();
      for (const [name, fn] of Object.entries(provider.fns)) {
        const sanitizedName = sanitizeToolName(name);
        const existingName = sanitizedNames.get(sanitizedName);
        if (existingName && existingName !== name) {
          return {
            result: undefined,
            error:
              `Tool names "${existingName}" and "${name}" both sanitize to ` +
              `"${sanitizedName}" in provider "${provider.name}"`
          };
        }
        sanitizedNames.set(sanitizedName, name);
        sanitizedFns[sanitizedName] = fn;
      }
      dispatchers[provider.name] = new ToolDispatcher(sanitizedFns);
    }

    // Connector bindings are passed as an evaluate() argument (RPC), not via
    // env — live RPC references can only be serialized for RPC calls.
    const connectorBindings: Record<string, unknown> = {};
    for (const connector of connectors) {
      connectorBindings[connector.name] = connector.binding;
    }
    const env = { ...this.#bindings };
    const hasEnv = Object.keys(env).length > 0;

    // `load()` (not `get(id, cb)`): every run produces a unique generated
    // module, so there is nothing to cache by id — `get` with a random id would
    // only churn the loader's isolate cache. `load()` is the one-shot path the
    // Worker Loader API provides for exactly this (codemode-style) use.
    const worker = this.#loader.load({
      compatibilityDate: "2025-06-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "executor.js",
      modules: {
        ...this.#modules,
        "executor.js": executorModule
      },
      globalOutbound: this.#globalOutbound,
      env: hasEnv ? env : undefined
    });

    // `worker` (the loaded child Worker) and `entrypoint` (its RPC stub) own
    // native handles. Dispose both once `evaluate` settles so they are not left
    // for GC — a finalize during isolate shutdown trips a fatal workerd
    // assertion under vitest-pool-workers (see `disposeQuietly`).
    try {
      const entrypoint = worker.getEntrypoint() as unknown as {
        evaluate(
          dispatchers: Record<string, ToolDispatcher>,
          connectors: Record<string, unknown>
        ): Promise<{
          result: unknown;
          error?: string;
          logs?: string[];
        }>;
      };
      try {
        const response = await entrypoint.evaluate(
          dispatchers,
          connectorBindings
        );

        if (response.error) {
          return {
            result: undefined,
            error: response.error,
            logs: response.logs
          };
        }

        return { result: response.result, logs: response.logs };
      } finally {
        disposeQuietly(entrypoint);
      }
    } finally {
      disposeQuietly(worker);
    }
  }
}
