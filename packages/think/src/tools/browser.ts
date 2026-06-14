import type { ToolSet } from "ai";
import {
  createBrowserRuntime,
  createBrowserTools as createBrowserToolsForAi,
  createQuickActionTools,
  type BrowserRuntime,
  type CreateBrowserToolsOptions,
  type CreateQuickActionToolsOptions,
  type QuickActionToolName
} from "agents/browser/ai";

export {
  createBrowserRuntime,
  type BrowserRuntime,
  type CreateBrowserToolsOptions
};

// Stateless Quick Action tools — re-exported so a Think agent can expose them
// from `getTools()` with a single import, including the loader-free path
// (`createQuickActionTools`) that needs only the `browser` binding.
export {
  createQuickActionTools,
  type CreateQuickActionToolsOptions,
  type QuickActionToolName
};
export {
  browserContent,
  browserExtract,
  browserLinks,
  browserMarkdown,
  browserPdf,
  browserScrape,
  browserScreenshot,
  browserSnapshot,
  runQuickAction,
  type QuickAction,
  type QuickActionBinary,
  type QuickActionBinding,
  type QuickActionCommonOptions,
  type QuickActionExtractInput,
  type QuickActionInput,
  type QuickActionPage,
  type QuickActionScrapeInput,
  type QuickActionScrapeResult,
  type QuickActionScreenshotInput,
  type QuickActionSnapshot
} from "agents/browser";

/**
 * Create browser automation tools for Think agents.
 *
 * Returns the durable `browser_execute` tool backed by a codemode runtime —
 * the model writes TypeScript against the `cdp` connector (`cdp.send`,
 * `cdp.attachToTarget`, `cdp.spec`, …); executions are recorded for
 * abort-and-replay, and browser sessions are keyed by execution (they survive
 * pauses and, in `reuse`/`dynamic` modes, span executions) — plus the stateless
 * {@link createQuickActionTools | Quick Action} tools (`browser_markdown`,
 * `browser_extract`, …) by default whenever a `browser` binding is present.
 * Pass `quickActions: false` to omit them, or use `createQuickActionTools`
 * directly for the stateless tools alone (no Worker Loader required).
 *
 * Setup checklist:
 *
 * - `"browser": { "binding": "BROWSER" }` in wrangler.jsonc
 * - `"worker_loaders": [{ "binding": "LOADER" }]` in wrangler.jsonc
 * - export the runtime class from your worker entry:
 *   `export { CodemodeRuntime } from "@cloudflare/codemode"`
 *   (the `@cloudflare/codemode/vite` plugin does this automatically)
 *
 * Use {@link createBrowserRuntime} instead when you also need the runtime
 * handle (approvals, audit, `expirePaused`) or the connector's host-side
 * session helpers (`sessionInfo`, `closeSession`, `sweep`).
 *
 * @example
 * ```ts
 * import { Think } from "@cloudflare/think";
 * import { createBrowserTools } from "@cloudflare/think/tools/browser";
 *
 * export class MyAgent extends Think<Env> {
 *   getModel() {
 *     return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.7-code");
 *   }
 *
 *   getTools() {
 *     return {
 *       ...createBrowserTools({
 *         ctx: this.ctx,
 *         browser: this.env.BROWSER,
 *         loader: this.env.LOADER,
 *         session: { mode: "dynamic" }
 *       }),
 *     };
 *   }
 * }
 * ```
 */
export function createBrowserTools(
  options: CreateBrowserToolsOptions
): ToolSet {
  return createBrowserToolsForAi(options);
}
