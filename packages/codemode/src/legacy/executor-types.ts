/**
 * Shared executor contract — implemented by anything that runs LLM-generated
 * code in a sandbox (DynamicWorkerExecutor, IframeSandboxExecutor, ...).
 *
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use `WorkerJavaScriptBackend` from `@cloudflare/codemode`. See
 * https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */

export interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

/**
 * Internal resolved form of a tool provider, ready for execution.
 * The tool functions are keyed by tool name and exposed under `name.*`
 * inside the sandbox.
 *
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use `exec` from `@cloudflare/computer`, with tools imported from `ws:tools`.
 * See https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */
export interface ResolvedProvider {
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  /**
   * Optional sandbox-side JavaScript injected after the provider's namespace
   * proxy is created. Use it to define real in-sandbox functions on the
   * namespace (e.g. `codemode.step`) that wrap a local closure around host
   * calls — something a plain dispatched fn cannot do, since closures can't
   * cross the RPC boundary. Own properties assigned here take precedence over
   * the dispatch proxy.
   */
  prelude?: string;
}

/**
 * A connector binding passable directly to the sandbox as an env binding.
 * The sandbox calls callTool(method, args) via Workers RPC —
 * no ToolDispatcher serialization layer needed.
 *
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use `WorkerJavaScriptBackend` from `@cloudflare/codemode`. See
 * https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */
export interface ConnectorBinding {
  name: string;
  /** The connector instance (WorkerEntrypoint subclass) or ServiceStub. */
  binding: { callTool(method: string, args: unknown): Promise<unknown> };
}

/**
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use `WorkerJavaScriptBackend` from `@cloudflare/codemode`. See
 * https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */
export interface ExecuteOptions {
  /** Connectors passed as env bindings — sandbox calls callTool via RPC. */
  connectors?: ConnectorBinding[];
}

/**
 * An executor runs LLM-generated code in a sandbox, making the provided
 * tool functions callable under their namespace inside the sandbox.
 *
 * Implementations should never throw — errors are returned in `ExecuteResult.error`.
 *
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use `WorkerJavaScriptBackend` from `@cloudflare/codemode`. See
 * https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */
export interface Executor {
  execute(
    code: string,
    providersOrFns:
      | ResolvedProvider[]
      | Record<string, (...args: unknown[]) => Promise<unknown>>,
    options?: ExecuteOptions
  ): Promise<ExecuteResult>;
}
