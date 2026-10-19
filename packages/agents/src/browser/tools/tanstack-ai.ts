/**
 * `agents/browser/tanstack-ai` — the TanStack AI tool for a persistent
 * `Browser`.
 *
 * The older `createBrowserTools` lives in `../tanstack-ai.ts` and is
 * re-exported here until it's retired.
 */
import { toolDefinition } from "@tanstack/ai";
import {
  createBrowserToolCore,
  type BrowserToolOptions,
  type BrowserToolOutput
} from "../browser-tool";
import {
  browserExecuteModelOutput,
  browserScreenshotOutput
} from "../tool-helpers";

export type {
  BrowserToolInput,
  BrowserToolOptions,
  BrowserToolOutput
} from "../browser-tool";
export type { BrowserNewTab, BrowserSource } from "../session-connector";

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

export {
  createBrowserTools,
  type CreateBrowserToolsOptions
} from "../tanstack-ai";
