import { toolDefinition } from "@tanstack/ai";
import type { ServerTool } from "@tanstack/ai";
import type { ProxyToolOutput } from "@cloudflare/codemode";
import { z } from "zod";
import { createBrowserRuntime, type CreateBrowserToolsOptions } from "./ai";

export type { CreateBrowserToolsOptions } from "./ai";

/**
 * Create TanStack AI tools for browser automation via CDP code mode.
 *
 * Returns an array with a single durable `browser_execute` `ServerTool`
 * backed by the same codemode runtime as `agents/browser/ai` — the model
 * writes TypeScript against the `cdp` connector and browser sessions
 * survive pauses.
 *
 * The stateless Quick Action tools are not surfaced through this TanStack
 * wrapper (it exposes only `browser_execute`); use `createQuickActionTools`
 * from `agents/browser/ai` if you want them.
 *
 * @example
 * ```ts
 * import { createBrowserTools } from "agents/browser/tanstack-ai";
 * import { chat } from "@tanstack/ai";
 *
 * // inside a Durable Object / Agent:
 * const browserTools = createBrowserTools({
 *   ctx: this.ctx,
 *   browser: this.env.BROWSER,
 *   loader: this.env.LOADER,
 * });
 *
 * const stream = chat({
 *   adapter: openaiText("gpt-4o"),
 *   tools: [...browserTools, ...otherTools],
 *   messages,
 * });
 * ```
 */
export function createBrowserTools(
  options: CreateBrowserToolsOptions
): ServerTool[] {
  // This wrapper only surfaces `browser_execute`, so don't build the default-on
  // Quick Action tools just to discard them.
  const { tools } = createBrowserRuntime({ ...options, quickActions: false });
  const executeTool = tools.browser_execute;

  const execute = toolDefinition({
    name: "browser_execute" as const,
    description: executeTool.description ?? "",
    inputSchema: z.object({
      code: z.string().meta({
        description:
          "TypeScript async arrow function that uses the cdp connector"
      })
    })
  }).server(async ({ code }) => {
    if (!executeTool.execute) {
      throw new Error("browser_execute tool is not executable");
    }
    const result = (await executeTool.execute(
      { code },
      { toolCallId: crypto.randomUUID(), messages: [] }
    )) as ProxyToolOutput;
    return result;
  });

  return [execute];
}
