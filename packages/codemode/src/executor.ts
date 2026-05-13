/**
 * Executor interface and DynamicWorkerExecutor implementation.
 *
 * The Executor interface is the core abstraction — implement it to run
 * LLM-generated code in any sandbox (Workers, QuickJS, Node VM, etc.).
 */

import { RpcTarget } from "cloudflare:workers";
import type {
  ExecuteResult,
  Executor,
  ResolvedProvider
} from "./executor-types";
import { normalizeCode } from "./normalize";
import { sanitizeToolName } from "./utils";
import type { ToolDescriptors } from "./tool-types";
import type { ToolSet } from "ai";
export type {
  ExecuteResult,
  Executor,
  ResolvedProvider
} from "./executor-types";

const BINARY_TAG = "__codemode_binary_v1__";

type EncodedBinary = {
  [BINARY_TAG]: "Uint8Array" | "ArrayBuffer" | "ArrayBufferView";
  data: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength))
    );
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeCodemodeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { [BINARY_TAG]: "Uint8Array", data: bytesToBase64(value) };
  }
  if (value instanceof ArrayBuffer) {
    return {
      [BINARY_TAG]: "ArrayBuffer",
      data: bytesToBase64(new Uint8Array(value))
    };
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return {
      [BINARY_TAG]: "ArrayBufferView",
      data: bytesToBase64(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
      )
    };
  }
  return value;
}

function decodeCodemodeValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || !(BINARY_TAG in value)) {
    return value;
  }
  const encoded = value as EncodedBinary;
  if (typeof encoded.data !== "string") return value;
  const bytes = base64ToBytes(encoded.data);
  if (encoded[BINARY_TAG] === "ArrayBuffer") {
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    );
  }
  return bytes;
}

function stringifyForCodemode(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => encodeCodemodeValue(nested));
}

function parseForCodemode(json: string): unknown {
  return JSON.parse(json, (_key, nested) => decodeCodemodeValue(nested));
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

  /**
   * When true, tools accept positional args instead of a single object arg.
   * The sandbox proxy uses `(...args)` and the dispatcher spreads the args array.
   *
   * Default tools use single-object args: `codemode.search({ query: "test" })`
   * Positional tools use normal args: `state.readFile("/path")`
   */
  positionalArgs?: boolean;
}

// ── ToolDispatcher ────────────────────────────────────────────────────

/**
 * An RpcTarget that dispatches tool calls from the sandboxed Worker
 * back to the host. Passed via Workers RPC to the dynamic Worker's
 * evaluate() method — no globalOutbound or Fetcher bindings needed.
 */
export class ToolDispatcher extends RpcTarget {
  #fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  #positionalArgs: boolean;

  constructor(
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>,
    positionalArgs = false
  ) {
    super();
    this.#fns = fns;
    this.#positionalArgs = positionalArgs;
  }

  async call(name: string, argsJson: string): Promise<string> {
    const fn = this.#fns[name];
    if (!fn) {
      return stringifyForCodemode({ error: `Tool "${name}" not found` });
    }
    try {
      if (this.#positionalArgs) {
        const args = argsJson ? parseForCodemode(argsJson) : [];
        const result = await fn(...(Array.isArray(args) ? args : [args]));
        return stringifyForCodemode({ result });
      }
      const args = argsJson ? parseForCodemode(argsJson) : {};
      const result = await fn(args);
      return stringifyForCodemode({ result });
    } catch (err) {
      return stringifyForCodemode({
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

  constructor(options: DynamicWorkerExecutorOptions) {
    this.#loader = options.loader;
    this.#timeout = options.timeout ?? 30000;
    this.#globalOutbound = options.globalOutbound ?? null;
    const { "executor.js": _, ...safeModules } = options.modules ?? {};
    this.#modules = safeModules;
  }

  async execute(
    code: string,
    providersOrFns:
      | ResolvedProvider[]
      | Record<string, (...args: unknown[]) => Promise<unknown>>
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

    // Validate provider names.
    const RESERVED_NAMES = new Set([
      "__dispatchers",
      "__logs",
      "__CODEMODE_BINARY_TAG",
      "__bytesToBase64",
      "__base64ToBytes",
      "__encodeCodemodeValue",
      "__decodeCodemodeValue",
      "__stringifyForCodemode",
      "__parseForCodemode"
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

    // Generate a Proxy global for each provider namespace.
    const proxyInits = providers.map((p) => {
      if (p.positionalArgs) {
        return (
          `    const ${p.name} = new Proxy({}, {\n` +
          `      get: (_, toolName) => async (...args) => {\n` +
          `        const resJson = await __dispatchers.${p.name}.call(String(toolName), __stringifyForCodemode(args));\n` +
          `        const data = __parseForCodemode(resJson);\n` +
          `        if (data.error) throw new Error(data.error);\n` +
          `        return data.result;\n` +
          `      }\n` +
          `    });`
        );
      }
      return (
        `    const ${p.name} = new Proxy({}, {\n` +
        `      get: (_, toolName) => async (args) => {\n` +
        `        const resJson = await __dispatchers.${p.name}.call(String(toolName), __stringifyForCodemode(args ?? {}));\n` +
        `        const data = __parseForCodemode(resJson);\n` +
        `        if (data.error) throw new Error(data.error);\n` +
        `        return data.result;\n` +
        `      }\n` +
        `    });`
      );
    });

    const executorModule = [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      "",
      "export default class CodeExecutor extends WorkerEntrypoint {",
      "  async evaluate(__dispatchers = {}) {",
      "    const __logs = [];",
      '    console.log = (...a) => { __logs.push(a.map(String).join(" ")); };',
      '    console.warn = (...a) => { __logs.push("[warn] " + a.map(String).join(" ")); };',
      '    console.error = (...a) => { __logs.push("[error] " + a.map(String).join(" ")); };',
      SANDBOX_CODEC,
      ...proxyInits,
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
      dispatchers[provider.name] = new ToolDispatcher(
        sanitizedFns,
        provider.positionalArgs
      );
    }

    const worker = this.#loader.get(`codemode-${crypto.randomUUID()}`, () => ({
      compatibilityDate: "2025-06-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "executor.js",
      modules: {
        ...this.#modules,
        "executor.js": executorModule
      },
      globalOutbound: this.#globalOutbound
    }));

    const entrypoint = worker.getEntrypoint() as unknown as {
      evaluate(dispatchers: Record<string, ToolDispatcher>): Promise<{
        result: unknown;
        error?: string;
        logs?: string[];
      }>;
    };
    const response = await entrypoint.evaluate(dispatchers);

    if (response.error) {
      return { result: undefined, error: response.error, logs: response.logs };
    }

    return { result: response.result, logs: response.logs };
  }
}
