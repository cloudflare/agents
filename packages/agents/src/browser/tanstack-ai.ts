import { toolDefinition } from "@tanstack/ai";
import type { ServerTool } from "@tanstack/ai";
import type { ProxyToolOutput } from "@cloudflare/codemode";
import { z } from "zod";
import { createBrowserRuntime, type CreateBrowserToolsOptions } from "./ai";
import {
  createBrowserToolCore,
  type BrowserToolOptions,
  type BrowserToolOutput
} from "./browser-tool";
import {
  browserExecuteModelOutput,
  browserScreenshotOutput
} from "./tool-helpers";

export type { CreateBrowserToolsOptions } from "./ai";
export type {
  BrowserToolInput,
  BrowserToolOptions,
  BrowserToolOutput
} from "./browser-tool";
export type { BrowserNewTab, BrowserSource } from "./session-connector";

export interface TanStackBrowserToolOptions<
  TName extends string = "browser"
> extends BrowserToolOptions {
  /** The tool's name. TanStack AI tools carry it in the definition. */
  name?: TName;
}

/**
 * What the model sees from one run. TanStack AI has one return channel, so
 * the host gets this too: no `calls` log, bounded `logs`, and a screenshot
 * replaced by a sentence saying it was left out.
 */
function browserToolModelResult(output: BrowserToolOutput): unknown {
  const screenshot = browserScreenshotOutput(output);
  if (!screenshot) return browserExecuteModelOutput(output).value;
  const bytes = Math.floor((screenshot.data.length * 3) / 4);
  // Keep the rest of the result (status, restarted, notice, newTabs).
  return browserExecuteModelOutput({
    ...output,
    result: `Screenshot captured (${screenshot.mediaType}, approximately ${bytes.toLocaleString()} bytes), but this tool can't return images, so neither you nor the user can see it. Read the page with Runtime.evaluate instead.`
  }).value;
}

/**
 * Create a TanStack AI tool that lets the model drive a persistent browser
 * with JavaScript and the Chrome DevTools Protocol.
 *
 * Works like `browserTool` in `agents/browser/ai-sdk`: tabs, cookies, and
 * logins carry over between runs, `sessionId: "active"` addresses the tab the
 * model last worked in, and a replaced browser is reported as
 * `restarted: true`. The tool is named `browser` unless you pass `name`.
 *
 * Unlike the AI SDK tool, the host gets the same output as the model, and
 * screenshots aren't supported: a returned screenshot is replaced by a
 * sentence saying it was left out.
 *
 * @example
 * ```ts
 * import { Browser, browserRun } from "agents/browser";
 * import { browserTool } from "agents/browser/tanstack-ai";
 * import { chat } from "@tanstack/ai";
 *
 * export class MyAgent extends Agent<Env> {
 *   browser = new Browser({ provider: browserRun(this.env.BROWSER) });
 *
 *   constructor(ctx: AgentContext, env: Env) {
 *     super(ctx, env);
 *     this.lifecycle.use(this.browser);
 *   }
 *
 *   async onChatMessage() {
 *     const stream = chat({
 *       adapter,
 *       tools: [browserTool({ browser: this.browser, loader: this.env.LOADER })],
 *       messages
 *     });
 *   }
 * }
 * ```
 */
export function browserTool<TName extends string = "browser">(
  options: TanStackBrowserToolOptions<TName>
) {
  const core = createBrowserToolCore(options, {
    screenshotHint:
      "This tool can't return images, so don't take screenshots; read the page with Runtime.evaluate (for example document.body.innerText) instead."
  });
  return toolDefinition({
    name: options.name ?? ("browser" as TName),
    description: core.description,
    inputSchema: core.inputSchema
  }).server(async (input) => browserToolModelResult(await core.execute(input)));
}

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
    description:
      typeof executeTool.description === "function"
        ? ""
        : (executeTool.description ?? ""),
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
    const result = (await executeTool.execute({ code }, {
      toolCallId: crypto.randomUUID(),
      messages: [],
      context: {}
    } as never)) as ProxyToolOutput;
    // TanStack has a single return channel, so what the host sees is what the
    // model sees: apply the AI SDK path's `toModelOutput` projection so a
    // screenshot's base64 cannot reach the model and the durable `calls` log
    // stays out of its context. The execution envelope (status, executionId)
    // is preserved either way.
    const modelOutput = await executeTool.toModelOutput?.({
      toolCallId: crypto.randomUUID(),
      input: { code },
      output: result
    });
    if (modelOutput?.type === "error-text") {
      throw new Error(modelOutput.value);
    }
    if (modelOutput?.type === "text") {
      return { ...result, result: modelOutput.value };
    }
    if (modelOutput?.type === "json") {
      return modelOutput.value;
    }
    return result;
  });

  return [execute];
}
