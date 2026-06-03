import type { ToolSet } from "ai";
import {
  createBrowserExecutor,
  createBrowserProvider,
  createBrowserSessionManager,
  DurableBrowserSessionStore,
  type BrowserProvider,
  type BrowserProviderOptions,
  type BrowserSessionManager,
  type BrowserSessionInfo,
  type BrowserSessionOptions,
  type BrowserSessionStore,
  type BrowserToolsOptions,
  type StoredBrowserSession
} from "agents/browser";
import { truncateResult } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";

export type CreateBrowserToolsOptions = BrowserToolsOptions;

export {
  createBrowserProvider,
  createBrowserSessionManager,
  DurableBrowserSessionStore,
  type BrowserProvider,
  type BrowserProviderOptions,
  type BrowserSessionManager,
  type BrowserSessionInfo,
  type BrowserSessionOptions,
  type BrowserSessionStore,
  type StoredBrowserSession
};

/**
 * Create browser automation tools for Think agents.
 *
 * Returns a `ToolSet` with a code mode tool backed by `createBrowserProvider()`.
 * The provider exposes `cdp.spec()` for protocol discovery and `cdp.send()` for
 * live browser commands.
 *
 * Use this helper when you do not already expose a code mode tool. If your
 * agent already has code mode, prefer adding `createBrowserProvider()` to that
 * tool instead of registering a second code execution tool.
 *
 * @example
 * ```ts
 * import { Think } from "@cloudflare/think";
 * import {
 *   createBrowserTools,
 *   DurableBrowserSessionStore
 * } from "@cloudflare/think/tools/browser";
 *
 * export class MyAgent extends Think<Env> {
 *   getModel() {
 *     return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.6");
 *   }
 *
 *   getTools() {
 *     return {
 *       ...createBrowserTools({
 *         browser: this.env.BROWSER,
 *         loader: this.env.LOADER,
 *         session: {
 *           mode: "dynamic",
 *           key: "default",
 *           store: new DurableBrowserSessionStore(this.ctx.storage),
 *           keepAliveMs: 600_000
 *         }
 *       }),
 *     };
 *   }
 * }
 * ```
 */
export function createBrowserTools(
  options: CreateBrowserToolsOptions
): ToolSet {
  return {
    browser_execute: createCodeTool({
      tools: [createBrowserProvider(options)],
      executor: createBrowserExecutor(options),
      transformResult: truncateResult
    })
  };
}
