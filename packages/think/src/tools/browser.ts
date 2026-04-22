import type { ToolSet } from "ai";
import {
  createBrowserToolHandlers,
  SEARCH_DESCRIPTION,
  EXECUTE_DESCRIPTION
} from "agents/browser";
import { tool } from "ai";
import { z } from "zod";

export interface CreateBrowserToolsOptions {
  /**
   * Browser Rendering binding (Fetcher).
   *
   * This is the primary way to connect — works both locally in
   * `wrangler dev` and when deployed to Cloudflare Workers.
   *
   * Requires `"browser": { "binding": "BROWSER" }` in wrangler.jsonc.
   */
  browser?: Fetcher;

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
   * WorkerLoader binding for sandboxed code execution.
   *
   * Requires `"worker_loaders": [{ "binding": "LOADER" }]` in wrangler.jsonc.
   */
  loader: WorkerLoader;

  /**
   * Execution timeout in milliseconds. Defaults to 30000 (30s).
   */
  timeout?: number;
}

/**
 * Create browser automation tools for Think agents.
 *
 * Returns a `ToolSet` with two tools:
 *
 * - **`browser_search`** — query the Chrome DevTools Protocol spec
 *   to discover commands, events, and types. The LLM writes JavaScript
 *   that runs against a cached, normalized copy of the protocol.
 *
 * - **`browser_execute`** — run CDP commands against a live browser
 *   session. Each call opens a fresh session, exposes a `cdp` helper,
 *   and closes the session on completion.
 *
 * Both tools use the code-mode pattern: the LLM writes JavaScript
 * async arrow functions that execute in a sandboxed Worker isolate.
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
 *         browser: this.env.BROWSER,
 *         loader: this.env.LOADER,
 *       }),
 *     };
 *   }
 * }
 * ```
 */
export function createBrowserTools(
  options: CreateBrowserToolsOptions
): ToolSet {
  const handlers = createBrowserToolHandlers({
    browser: options.browser,
    cdpUrl: options.cdpUrl,
    cdpHeaders: options.cdpHeaders,
    loader: options.loader,
    timeout: options.timeout
  });

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
