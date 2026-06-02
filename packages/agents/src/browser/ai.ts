import type { ToolSet } from "ai";
import { truncateResult } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
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
 * Create AI SDK tools for browser automation via CDP code mode.
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
 * import { createBrowserTools } from "agents/browser/ai";
 * import { generateText } from "ai";
 *
 * const browserTools = createBrowserTools({
 *   browser: env.BROWSER,
 *   loader: env.LOADER,
 * });
 *
 * const result = await generateText({
 *   model,
 *   tools: { ...browserTools, ...otherTools },
 *   messages,
 * });
 * ```
 */
export function createBrowserTools(options: BrowserToolsOptions): ToolSet {
  return {
    browser_execute: createCodeTool({
      tools: [createBrowserProvider(options)],
      executor: createBrowserExecutor(options),
      transformResult: truncateResult
    })
  };
}
