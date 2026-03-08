import type { ToolSet } from "ai";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { Executor } from "@cloudflare/codemode";

export interface CreateExecuteToolOptions {
  /**
   * The tools available inside the sandboxed code.
   * These are exposed as `codemode.toolName(args)` in the sandbox.
   *
   * Typically this is the workspace tools from `createWorkspaceTools()`,
   * but can include any AI SDK tools with `execute` functions.
   */
  tools: ToolSet;

  /**
   * The executor that runs the generated code.
   *
   * Use `DynamicWorkerExecutor` for Cloudflare Workers (requires a
   * `worker_loaders` binding in wrangler.jsonc), or implement the
   * `Executor` interface for other runtimes.
   *
   * If not provided, you must provide a `loader` instead.
   */
  executor?: Executor;

  /**
   * WorkerLoader binding for creating a `DynamicWorkerExecutor`.
   * This is a convenience alternative to passing a full `executor`.
   *
   * Requires `"worker_loaders": [{ "binding": "LOADER" }]` in wrangler.jsonc.
   */
  loader?: WorkerLoader;

  /**
   * Timeout in milliseconds for code execution. Defaults to 30000 (30s).
   * Only used when `loader` is provided (ignored if `executor` is given).
   */
  timeout?: number;

  /**
   * Controls outbound network access from sandboxed code.
   * - `null` (default): fetch() and connect() throw — sandbox is fully isolated.
   * - `undefined`: inherits parent Worker's network access.
   * - A `Fetcher`: all outbound requests route through this handler.
   *
   * Only used when `loader` is provided (ignored if `executor` is given).
   */
  globalOutbound?: Fetcher | null;

  /**
   * Custom tool description. Use `{{types}}` as a placeholder for the
   * auto-generated TypeScript type definitions of the available tools.
   */
  description?: string;
}

/**
 * Create a code execution tool that lets the LLM write and run JavaScript
 * with access to your tools in a sandboxed environment.
 *
 * The LLM sees typed `codemode.*` functions and writes code that calls them.
 * Code runs in an isolated Worker via `DynamicWorkerExecutor` — external
 * network access is blocked by default.
 *
 * @example
 * ```ts
 * import { createWorkspaceTools, createExecuteTool } from "@cloudflare/think";
 *
 * getTools() {
 *   const workspaceTools = createWorkspaceTools(this.workspace);
 *   return {
 *     ...workspaceTools,
 *     execute: createExecuteTool({
 *       tools: workspaceTools,
 *       loader: this.env.LOADER,
 *     }),
 *   };
 * }
 * ```
 *
 * @example Using a custom executor
 * ```ts
 * import { DynamicWorkerExecutor } from "@cloudflare/codemode";
 *
 * const executor = new DynamicWorkerExecutor({
 *   loader: this.env.LOADER,
 *   timeout: 60000,
 *   globalOutbound: this.env.OUTBOUND,
 * });
 *
 * getTools() {
 *   return {
 *     execute: createExecuteTool({ tools: myTools, executor }),
 *   };
 * }
 * ```
 */
export function createExecuteTool(options: CreateExecuteToolOptions) {
  const { tools, description } = options;

  let executor: Executor;
  if (options.executor) {
    executor = options.executor;
  } else if (options.loader) {
    executor = new DynamicWorkerExecutor({
      loader: options.loader,
      timeout: options.timeout,
      globalOutbound: options.globalOutbound
    });
  } else {
    throw new Error(
      "createExecuteTool requires either an `executor` or a `loader` (WorkerLoader binding)."
    );
  }

  return createCodeTool({ tools, executor, description });
}
