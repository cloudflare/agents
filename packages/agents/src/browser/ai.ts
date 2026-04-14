import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import {
  createBrowserToolHandlers,
  SEARCH_DESCRIPTION,
  EXECUTE_DESCRIPTION,
  type BrowserToolsOptions
} from "./shared";

export type { BrowserToolsOptions } from "./shared";

/**
 * Create AI SDK tools for browser automation via CDP code mode.
 *
 * Returns a `ToolSet` with `search` (query the CDP spec) and
 * `execute` (run CDP commands against a live browser).
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
  const handlers = createBrowserToolHandlers(options);

  return {
    browser_search: tool({
      description: SEARCH_DESCRIPTION,
      inputSchema: z.object({
        code: z
          .string()
          .describe("JavaScript async arrow function that queries the CDP spec")
      }),
      execute: async ({ code }) => {
        const result = await handlers.search(code);
        if (result.isError) {
          throw new Error(result.text);
        }
        return result.text;
      }
    }),

    browser_execute: tool({
      description: EXECUTE_DESCRIPTION,
      inputSchema: z.object({
        code: z
          .string()
          .describe("JavaScript async arrow function that uses the cdp helper")
      }),
      execute: async ({ code }) => {
        const result = await handlers.execute(code);
        if (result.isError) {
          throw new Error(result.text);
        }
        return result.text;
      }
    })
  };
}
