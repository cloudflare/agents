import type { ToolSet } from "ai";
import {
  createCodemodeRuntime,
  DynamicWorkerExecutor,
  truncateResult,
  type CodemodeRuntimeHandle
} from "@cloudflare/codemode";
import type { BrowserBinding } from "./browser-run";
import {
  BrowserConnector,
  type BrowserConnectorOptions,
  type BrowserConnectorSessionOptions
} from "./connector";
import {
  DurableBrowserSessionStore,
  type BrowserSessionStore
} from "./session-manager";

export interface CreateBrowserToolsOptions {
  /**
   * Durable Object state. The codemode runtime that backs the browser tool
   * lives in a facet of this DO, and browser session ids are stored in its
   * storage — so the tool must be created from inside a Durable Object
   * (e.g. an Agent).
   *
   * The worker must export the `CodemodeRuntime` class (the
   * `@cloudflare/codemode/vite` plugin does this automatically, or add
   * `export { CodemodeRuntime } from "@cloudflare/codemode"` to your entry).
   */
  ctx: DurableObjectState;

  /**
   * WorkerLoader binding for sandboxed code execution.
   *
   * Requires `"worker_loaders": [{ "binding": "LOADER" }]` in wrangler.jsonc.
   */
  loader: WorkerLoader;

  /**
   * Browser Rendering binding (Fetcher).
   *
   * This is the primary way to connect — works both locally in
   * `wrangler dev` and when deployed to Cloudflare Workers.
   *
   * Requires `"browser": { "binding": "BROWSER" }` in wrangler.jsonc.
   */
  browser?: BrowserBinding;

  /**
   * Optional CDP base URL override (e.g. `http://localhost:9222`).
   *
   * Use when connecting to a manually managed Chrome instance or
   * a remote CDP endpoint behind a tunnel.
   */
  cdpUrl?: string;

  /**
   * Headers to send with CDP URL discovery requests.
   * Useful when the CDP endpoint requires authentication
   * (e.g. Cloudflare Access headers).
   */
  cdpHeaders?: Record<string, string>;

  /**
   * Browser session lifecycle (binding-backed only). Defaults to one fresh
   * session per codemode execution (`one-shot`).
   */
  session?: BrowserConnectorSessionOptions;

  /**
   * Durable store for Browser Run session ids. Defaults to a
   * {@link DurableBrowserSessionStore} over `ctx.storage`.
   */
  store?: BrowserSessionStore;

  /**
   * Sandbox execution timeout in milliseconds. Defaults to 30000 (30s).
   * Also used as the per-CDP-command timeout.
   */
  timeout?: number;

  /**
   * Codemode runtime name — the durable identity of the tool's executions
   * and snippets. Defaults to `"browser"`.
   */
  name?: string;
}

/**
 * The browser tool's moving parts, for hosts that need more than the tools:
 *
 * - `runtime` — the codemode runtime handle (approve/reject paused runs,
 *   `expirePaused`, audit via `executions()`, snippets).
 * - `connector` — host-side session helpers: `sessionInfo()`,
 *   `closeSession()`, and `sweep()` for a recurring cleanup task.
 * - `tools` — what `createBrowserTools` returns.
 */
export interface BrowserRuntime {
  runtime: CodemodeRuntimeHandle;
  connector: BrowserConnector;
  tools: ToolSet;
}

let didWarnExperimental = false;

function connectorOptions(
  options: CreateBrowserToolsOptions
): BrowserConnectorOptions {
  if (options.cdpUrl) {
    return {
      cdpUrl: options.cdpUrl,
      cdpHeaders: options.cdpHeaders,
      timeout: options.timeout
    };
  }
  if (!options.browser) {
    throw new Error(
      "Either 'browser' (Fetcher binding) or 'cdpUrl' must be provided"
    );
  }
  return {
    browser: options.browser,
    store: options.store ?? new DurableBrowserSessionStore(options.ctx.storage),
    session: options.session,
    timeout: options.timeout
  };
}

/**
 * Create the browser codemode runtime: the `browser_execute` tool plus the
 * runtime handle and connector for host-side wiring (approvals, session info,
 * sweeps).
 *
 * @example
 * ```ts
 * export class MyAgent extends Agent<Env> {
 *   get browser() {
 *     return createBrowserRuntime({
 *       ctx: this.ctx,
 *       browser: this.env.BROWSER,
 *       loader: this.env.LOADER,
 *       session: { mode: "dynamic" }
 *     });
 *   }
 *
 *   @callable()
 *   async closeBrowserSession() {
 *     await this.browser.connector.closeSession();
 *   }
 * }
 * ```
 */
export function createBrowserRuntime(
  options: CreateBrowserToolsOptions
): BrowserRuntime {
  if (!didWarnExperimental) {
    didWarnExperimental = true;
    console.warn(
      "[agents/browser] Browser tools are experimental and may change in a future release."
    );
  }

  const connector = new BrowserConnector(
    options.ctx,
    connectorOptions(options)
  );
  const runtime = createCodemodeRuntime({
    ctx: options.ctx,
    executor: new DynamicWorkerExecutor({
      loader: options.loader,
      timeout: options.timeout
    }),
    connectors: [connector],
    name: options.name ?? "browser",
    transformResult: truncateResult
  });

  return {
    runtime,
    connector,
    tools: { browser_execute: runtime.tool() }
  };
}

/**
 * Create AI SDK tools for browser automation via CDP code mode.
 *
 * Returns a `ToolSet` with a single durable `browser_execute` tool backed by
 * a codemode runtime: the model writes TypeScript against the `cdp` connector
 * (`cdp.send`, `cdp.attachToTarget`, `cdp.spec`, …), executions are recorded
 * for abort-and-replay, and browser sessions survive pauses.
 *
 * @example
 * ```ts
 * import { createBrowserTools } from "agents/browser/ai";
 * import { generateText } from "ai";
 *
 * // inside a Durable Object / Agent:
 * const browserTools = createBrowserTools({
 *   ctx: this.ctx,
 *   browser: this.env.BROWSER,
 *   loader: this.env.LOADER,
 * });
 *
 * const result = await generateText({
 *   model,
 *   tools: { ...browserTools, ...otherTools },
 *   messages,
 * });
 * ```
 */
export function createBrowserTools(
  options: CreateBrowserToolsOptions
): ToolSet {
  return createBrowserRuntime(options).tools;
}
