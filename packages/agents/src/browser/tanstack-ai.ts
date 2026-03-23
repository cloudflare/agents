import { toolDefinition } from "@tanstack/ai";
import type { ServerTool } from "@tanstack/ai";
import { z } from "zod";
import {
  createBrowserToolHandlers,
  SEARCH_DESCRIPTION,
  EXECUTE_DESCRIPTION,
  type BrowserToolsOptions
} from "./shared";

export type { BrowserToolsOptions } from "./shared";

/**
 * Create TanStack AI tools for browser automation via CDP code mode.
 *
 * Returns an array of `ServerTool`s: `browser_search` (query the CDP spec)
 * and `browser_execute` (run CDP commands against a live browser).
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
  const handlers = createBrowserToolHandlers(options);

  const search = toolDefinition({
    name: "browser_search" as const,
    description: SEARCH_DESCRIPTION,
    inputSchema: z.object({
      code: z.string().meta({
        description: "JavaScript async arrow function that queries the CDP spec"
      })
    })
  }).server(async ({ code }) => {
    const result = await handlers.search(code);
    if (result.isError) {
      throw new Error(result.text);
    }
    return { text: result.text };
  });

  const execute = toolDefinition({
    name: "browser_execute" as const,
    description: EXECUTE_DESCRIPTION,
    inputSchema: z.object({
      code: z.string().meta({
        description: "JavaScript async arrow function that uses the cdp helper"
      })
    })
  }).server(async ({ code }) => {
    const result = await handlers.execute(code);
    if (result.isError) {
      throw new Error(result.text);
    }
    return { text: result.text };
  });

  return [search, execute];
}
