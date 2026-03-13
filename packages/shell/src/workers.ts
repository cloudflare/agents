/**
 * Cloudflare Workers Adapters
 *
 * Ready-made implementations of the pluggable interfaces for
 * use on Cloudflare Workers. Import from "@cloudflare/shell/workers".
 *
 * @example
 * ```ts
 * import { Shell } from "@cloudflare/shell";
 * import { DOSqlExecutor } from "@cloudflare/shell/workers";
 *
 * const shell = new Shell({
 *   sql: new DOSqlExecutor(this.ctx.storage.sql),
 * });
 * ```
 */

import type {
  SqlExecutor,
  CodeExecutor,
  MarkdownConverter
} from "./interfaces";

// ── DOSqlExecutor ──────────────────────────────────────────────
//
// Wraps Cloudflare Durable Object SqlStorage (this.ctx.storage.sql)
// to implement the SqlExecutor interface.

/**
 * The subset of Cloudflare's SqlStorage API we need.
 * This avoids importing @cloudflare/workers-types at package level.
 */
export interface DOSqlStorageLike {
  exec<T = Record<string, unknown>>(query: string): DOSqlCursorLike<T>;
}

export interface DOSqlCursorLike<T = Record<string, unknown>> {
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
  toArray(): T[];
  [Symbol.iterator](): IterableIterator<T>;
}

/**
 * Implements SqlExecutor using Cloudflare Durable Object SqlStorage.
 *
 * @example
 * ```ts
 * // Inside a Durable Object or Agent:
 * const sql = new DOSqlExecutor(this.ctx.storage.sql);
 * const shell = new Shell({ sql });
 * await shell.exec("sqlite3 'SELECT * FROM users'");
 * ```
 */
export class DOSqlExecutor implements SqlExecutor {
  constructor(private readonly storage: DOSqlStorageLike) {}

  async query(
    sql: string
  ): Promise<{ columns: string[]; values: unknown[][] }> {
    const cursor = this.storage.exec(sql);
    const columns = [...cursor.columnNames];
    const rows = cursor.toArray();
    const values = rows.map((row) =>
      columns.map((col) => (row as Record<string, unknown>)[col])
    );
    return { columns, values };
  }

  async run(sql: string): Promise<{ changes: number }> {
    const cursor = this.storage.exec(sql);
    return { changes: cursor.rowsWritten };
  }
}

// ── D1SqlExecutor ──────────────────────────────────────────────────
//
// Wraps Cloudflare D1 database binding to implement the SqlExecutor interface.

/**
 * The subset of Cloudflare's D1 API we need.
 * This avoids importing @cloudflare/workers-types at package level.
 */
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<{
    results?: T[];
    success: boolean;
  }>;
  run(): Promise<{
    success: boolean;
    meta?: { changes?: number };
  }>;
}

/**
 * Implements SqlExecutor using Cloudflare D1.
 *
 * @example
 * ```ts
 * // Inside a Worker with D1 binding configured in wrangler.jsonc:
 * const sql = new D1SqlExecutor(env.DB);
 * const shell = new Shell({ sql });
 * await shell.exec("sqlite3 'SELECT * FROM users'");
 * ```
 */
export class D1SqlExecutor implements SqlExecutor {
  constructor(private readonly db: D1DatabaseLike) {}

  async query(
    sql: string
  ): Promise<{ columns: string[]; values: unknown[][] }> {
    const stmt = this.db.prepare(sql);
    const response = await stmt.all();

    if (
      !response.success ||
      !response.results ||
      response.results.length === 0
    ) {
      return { columns: [], values: [] };
    }

    const columns = Object.keys(response.results[0]);
    const values = response.results.map((row) =>
      columns.map((col) => (row as Record<string, unknown>)[col])
    );
    return { columns, values };
  }

  async run(sql: string): Promise<{ changes: number }> {
    const stmt = this.db.prepare(sql);
    const response = await stmt.run();
    return { changes: response.meta?.changes ?? 0 };
  }
}

// ── DynamicIsolateExecutor ──────────────────────────────────────────
//
// Uses Cloudflare's Dynamic Worker Loader to run code in an isolated
// Worker. User code is embedded directly into a dynamically-loaded
// module — no eval() or new Function() needed.
//
// See: https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/

/**
 * Minimal interface for the Worker Loader binding.
 * Matches the shape of `env.LOADER` when configured with `worker_loaders`
 * in wrangler.jsonc.
 */
export interface WorkerLoaderLike {
  get(
    id: string,
    getCode: () => WorkerLoaderCode | Promise<WorkerLoaderCode>
  ): WorkerLoaderStub;
}

export interface WorkerLoaderCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string>;
  globalOutbound?: unknown;
  env?: Record<string, unknown>;
}

interface WorkerLoaderStub {
  getEntrypoint(
    name?: string,
    options?: { props?: Record<string, unknown> }
  ): WorkerLoaderEntrypoint;
}

interface WorkerLoaderEntrypoint {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
  [key: string]: unknown;
}

export interface DynamicIsolateExecutorOptions {
  loader: WorkerLoaderLike;
  /**
   * Timeout in milliseconds for code execution. Defaults to 30000 (30s).
   */
  timeout?: number;
  /**
   * Controls outbound network access from sandboxed code.
   * - `null` (default): fetch() and connect() throw — sandbox is fully isolated.
   * - `undefined`: inherits parent Worker's network access (full internet).
   * - A service binding: all outbound requests route through this handler.
   */
  globalOutbound?: unknown | null;
}

/**
 * Implements CodeExecutor by loading user code into an isolated Worker
 * via the Dynamic Worker Loader API. Each execution spawns a fresh
 * isolate with the user's code embedded as the module source.
 *
 * @example
 * ```ts
 * const executor = new DynamicIsolateExecutor({ loader: env.LOADER });
 * const shell = new Shell({ executor });
 * await shell.exec('js-exec "console.log(1+1)"');
 * ```
 */
export class DynamicIsolateExecutor implements CodeExecutor {
  private readonly loader: WorkerLoaderLike;
  private readonly timeout: number;
  private readonly globalOutbound: unknown;

  constructor(options: DynamicIsolateExecutorOptions) {
    this.loader = options.loader;
    this.timeout = options.timeout ?? 30000;
    this.globalOutbound = options.globalOutbound ?? null;
  }

  async execute(
    code: string,
    language: "javascript" | "python",
    options?: { stdin?: string; env?: Record<string, string> }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const timeoutMs = this.timeout;

    if (language === "javascript") {
      return this.executeJavaScript(code, timeoutMs, options);
    }
    if (language === "python") {
      return this.executePython(code, timeoutMs, options);
    }

    return {
      stdout: "",
      stderr: `Unsupported language: ${language}\n`,
      exitCode: 127
    };
  }

  private async executeJavaScript(
    code: string,
    _timeoutMs: number,
    options?: { stdin?: string; env?: Record<string, string> }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const envJson = JSON.stringify(options?.env ?? {});
    const stdinJson = JSON.stringify(options?.stdin ?? "");

    const moduleCode = [
      "export default {",
      "  async fetch() {",
      "    const __stdout = [];",
      "    const __stderr = [];",
      '    console.log = (...a) => { __stdout.push(a.map(String).join(" ")); };',
      '    console.error = (...a) => { __stderr.push(a.map(String).join(" ")); };',
      '    console.warn = (...a) => { __stderr.push(a.map(String).join(" ")); };',
      `    const process = { env: ${envJson}, stdin: { read: () => ${stdinJson} } };`,
      "",
      "    try {",
      "      await (async () => {",
      code,
      "      })();",
      "      return Response.json({",
      '        stdout: __stdout.length ? __stdout.join("\\n") + "\\n" : "",',
      '        stderr: __stderr.length ? __stderr.join("\\n") + "\\n" : "",',
      "        exitCode: 0,",
      "      });",
      "    } catch (err) {",
      "      return Response.json({",
      '        stdout: __stdout.length ? __stdout.join("\\n") + "\\n" : "",',
      '        stderr: (__stderr.length ? __stderr.join("\\n") + "\\n" : "") + err.message + "\\n",',
      "        exitCode: 1,",
      "      });",
      "    }",
      "  }",
      "}"
    ].join("\n");

    try {
      const worker = this.loader.get(`shell-js-${crypto.randomUUID()}`, () => ({
        compatibilityDate: "2025-06-01",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "code.js",
        modules: { "code.js": moduleCode },
        globalOutbound: this.globalOutbound
      }));

      const entrypoint = worker.getEntrypoint();
      const response = await entrypoint.fetch("http://localhost/run");
      return (response as Response).json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { stdout: "", stderr: message + "\n", exitCode: 1 };
    }
  }

  private async executePython(
    code: string,
    _timeoutMs: number,
    options?: { stdin?: string; env?: Record<string, string> }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const envJson = JSON.stringify(options?.env ?? {});
    const stdinValue = JSON.stringify(options?.stdin ?? "");

    const wrapperJs = [
      'import pyCode from "./user_code.py";',
      "",
      "export default {",
      "  async fetch() {",
      "    const __stdout = [];",
      "    const __stderr = [];",
      '    console.log = (...a) => { __stdout.push(a.map(String).join(" ")); };',
      '    console.error = (...a) => { __stderr.push(a.map(String).join(" ")); };',
      "",
      "    try {",
      "      const { default: loadPyodide } = await import('pyodide');",
      "      const pyodide = await loadPyodide();",
      `      pyodide.globals.set('__env__', ${envJson});`,
      `      pyodide.globals.set('__stdin__', ${stdinValue});`,
      "      await pyodide.runPythonAsync(",
      '        "import sys, io\\n" +',
      '        "sys.stdout = io.StringIO()\\n" +',
      '        "sys.stderr = io.StringIO()\\n" +',
      "        pyCode",
      "      );",
      '      const pyOut = pyodide.runPython("sys.stdout.getvalue()");',
      '      const pyErr = pyodide.runPython("sys.stderr.getvalue()");',
      "      if (pyOut) __stdout.push(pyOut);",
      "      if (pyErr) __stderr.push(pyErr);",
      "      return Response.json({",
      '        stdout: __stdout.join(""),',
      '        stderr: __stderr.join(""),',
      "        exitCode: 0,",
      "      });",
      "    } catch (err) {",
      "      return Response.json({",
      '        stdout: __stdout.join(""),',
      '        stderr: (__stderr.length ? __stderr.join("") : "") + err.message + "\\n",',
      "        exitCode: 1,",
      "      });",
      "    }",
      "  }",
      "}"
    ].join("\n");

    try {
      const worker = this.loader.get(`shell-py-${crypto.randomUUID()}`, () => ({
        compatibilityDate: "2025-06-01",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "runner.js",
        modules: {
          "runner.js": wrapperJs,
          "user_code.py": code
        },
        globalOutbound: this.globalOutbound
      }));

      const entrypoint = worker.getEntrypoint();
      const response = await entrypoint.fetch("http://localhost/run");
      return (response as Response).json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { stdout: "", stderr: message + "\n", exitCode: 1 };
    }
  }
}

// ── WorkersAIMarkdownConverter ──────────────────────────────────────
//
// Uses Cloudflare Workers AI to convert documents to markdown.

/**
 * Minimal interface for the Workers AI binding.
 * Matches the shape of `env.AI` in Workers.
 */
export interface AiBindingLike {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

/**
 * Implements MarkdownConverter using Cloudflare Workers AI.
 *
 * Uses the toMarkdown model (e.g., @cf/toMarkdown) to convert
 * HTML or other document formats to Markdown.
 *
 * @example
 * ```ts
 * const markdown = new WorkersAIMarkdownConverter(env.AI);
 * const shell = new Shell({ markdown });
 * await shell.exec('echo "<h1>Hi</h1>" | html-to-markdown');
 * ```
 */
export class WorkersAIMarkdownConverter implements MarkdownConverter {
  private readonly model: string;

  constructor(
    private readonly ai: AiBindingLike,
    options?: { model?: string }
  ) {
    this.model = options?.model ?? "@cf/extractous/document-to-markdown";
  }

  async convert(
    input: string | Uint8Array,
    options?: { url?: string; type?: string }
  ): Promise<string> {
    const inputs: Record<string, unknown> = {};

    if (typeof input === "string") {
      // For string input, pass as content
      inputs.content = input;
    } else {
      // For binary input, pass as file with base64 encoding
      inputs.file = Array.from(input);
    }

    if (options?.url) {
      inputs.url = options.url;
    }
    if (options?.type) {
      inputs.type = options.type;
    }

    const result = await this.ai.run(this.model, inputs);
    if (typeof result === "string") {
      return result;
    }
    if (result && typeof result === "object" && "response" in result) {
      return String((result as Record<string, unknown>).response);
    }
    if (result && typeof result === "object" && "text" in result) {
      return String((result as Record<string, unknown>).text);
    }
    return String(result);
  }
}

// Re-export interfaces for convenience
export type { SqlExecutor, CodeExecutor, MarkdownConverter };
