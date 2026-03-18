import type { ToolSet } from "ai";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { Executor, ToolProvider } from "@cloudflare/codemode";
import type { StateBackend } from "@cloudflare/shell";
import { stateToolsFromBackend } from "@cloudflare/shell/workers";

export interface CreateExecuteToolOptions {
  /**
   * The tools available inside the sandboxed code as `codemode.*`.
   *
   * Typically the workspace tools from `createWorkspaceTools()`,
   * but can include any AI SDK tools with `execute` functions.
   */
  tools: ToolSet;

  /**
   * Optional StateBackend to expose as `state.*` inside the sandbox.
   *
   * When provided, the sandbox has both `codemode.*` tool calls and
   * the full `state.*` filesystem API (readFile, writeFile, glob,
   * searchFiles, replaceInFiles, planEdits, etc.).
   *
   * This is the preferred way to give the LLM rich filesystem access:
   * use individual workspace tools for simple one-shot operations,
   * and `state.*` for coordinated multi-file work.
   *
   * @example
   * ```ts
   * import { createWorkspaceStateBackend } from "@cloudflare/shell";
   *
   * createExecuteTool({
   *   tools: myDomainTools,
   *   state: createWorkspaceStateBackend(this.workspace),
   *   loader: this.env.LOADER,
   * });
   * // sandbox: codemode.myTool() AND state.readFile() AND state.planEdits()
   * ```
   */
  state?: StateBackend;

  /**
   * Additional tool providers for the sandbox beyond the default tools and state.
   * Each provider adds a named namespace alongside `codemode.*` and `state.*`.
   */
  providers?: ToolProvider[];

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
 * Pass `state` to also expose the full `state.*` filesystem API alongside
 * `codemode.*`:
 *
 * @example
 * ```ts
 * import { createWorkspaceTools, createExecuteTool } from "@cloudflare/think";
 * import { createWorkspaceStateBackend } from "@cloudflare/shell";
 *
 * getTools() {
 *   const workspaceTools = createWorkspaceTools(this.workspace);
 *   const backend = createWorkspaceStateBackend(this.workspace);
 *   return {
 *     ...workspaceTools,
 *     execute: createExecuteTool({
 *       tools: myDomainTools,  // codemode.* — non-filesystem tools
 *       state: backend,        // state.* — full filesystem API
 *       loader: this.env.LOADER,
 *     }),
 *   };
 * }
 * ```
 *
 * @example Tools only (no filesystem in sandbox)
 * ```ts
 * createExecuteTool({
 *   tools: myTools,
 *   loader: this.env.LOADER,
 * });
 * ```
 *
 * @example Custom executor
 * ```ts
 * import { DynamicWorkerExecutor } from "@cloudflare/codemode";
 *
 * const executor = new DynamicWorkerExecutor({
 *   loader: this.env.LOADER,
 *   timeout: 60000,
 * });
 *
 * createExecuteTool({ tools: myTools, executor });
 * ```
 */
export function createExecuteTool(options: CreateExecuteToolOptions) {
  const { tools, description, state } = options;

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

  const providers: ToolProvider[] = [
    { tools }, // default "codemode" namespace
    ...(options.providers ?? [])
  ];
  if (state) {
    providers.push(stateToolsFromBackend(state));
  }

  return createCodeTool({ tools: providers, executor, description });
}
