import type { ToolSet } from "ai";
import {
  createBrowserRuntime,
  createBrowserTools as createBrowserToolsForAi,
  type BrowserRuntime,
  type CreateBrowserToolsOptions
} from "agents/browser/ai";

export {
  createBrowserRuntime,
  type BrowserRuntime,
  type CreateBrowserToolsOptions
};

/**
 * Create browser automation tools for Think agents.
 *
 * Returns a `ToolSet` with a single durable `browser_execute` tool backed by
 * a codemode runtime: the model writes TypeScript against the `cdp`
 * connector (`cdp.send`, `cdp.attachToTarget`, `cdp.spec`, …). Executions
 * are recorded for abort-and-replay, and browser sessions are keyed by
 * execution — they survive pauses and, in `reuse`/`dynamic` session modes,
 * span executions.
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
 *     return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.6");
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
