import type { ServerTool } from "@tanstack/ai";
import { truncateResult } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/tanstack-ai";
import {
  createBrowserExecutor,
  createBrowserProvider,
  type BrowserToolsOptions
} from "./shared";

export {
  createBrowserProvider,
  type BrowserProvider,
  type BrowserProviderOptions,
  type BrowserToolsOptions
} from "./shared";

/**
 * Create TanStack AI tools for browser automation via CDP code mode.
 *
 * Returns an array with a code mode tool backed by `createBrowserProvider()`.
 * The provider exposes `cdp.spec()` for protocol discovery and `cdp.send()` for
 * live browser commands.
 *
 * Use this helper when you do not already expose a code mode tool. If your
 * agent already has code mode, prefer adding `createBrowserProvider()` to that
 * tool instead of registering a second code execution tool.
 *
 * @example
 * ```ts
 * import { createBrowserTools } from "agents/browser/tanstack-ai";
 * import { chat } from "@tanstack/ai";
 *
 * const browserTools = createBrowserTools({
 *   browser: env.BROWSER,
 *   loader: env.LOADER,
 * });
 *
 * const stream = chat({
 *   adapter: openaiText("gpt-4o"),
 *   tools: [...browserTools, ...otherTools],
 *   messages,
 * });
 * ```
 */
export function createBrowserTools(options: BrowserToolsOptions): ServerTool[] {
  return [
    createCodeTool({
      tools: [createBrowserProvider(options)],
      executor: createBrowserExecutor(options),
      transformResult: truncateResult
    })
  ];
}
