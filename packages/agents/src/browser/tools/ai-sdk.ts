/**
 * `agents/browser/ai-sdk` — the AI SDK tool for a persistent `Browser`.
 *
 * The older `createBrowserTools` stays in `agents/browser/ai`.
 */
import type { FlexibleSchema } from "ai";
import {
  browserReportNotes,
  createBrowserToolCore,
  type BrowserToolInput,
  type BrowserToolOptions,
  type BrowserToolOutput
} from "../browser-tool";
import {
  browserExecuteModelOutput,
  type BrowserModelOutput
} from "../tool-helpers";

export type {
  BrowserToolInput,
  BrowserToolOptions,
  BrowserToolOutput
} from "../browser-tool";
export type { BrowserNewTab, BrowserSource } from "../session-connector";

// Stateless Quick Action tools, so one import covers both.
export {
  createQuickActionTools,
  type CreateQuickActionToolsOptions,
  type QuickActionToolName
} from "../ai";

/**
 * The AI SDK tool {@link browserTool} returns. Assignable to the AI SDK's
 * `Tool`, and `execute` / `toModelOutput` are always present.
 */
export interface BrowserTool {
  description: string;
  inputSchema: FlexibleSchema<BrowserToolInput>;
  execute(
    input: BrowserToolInput,
    options: unknown
  ): Promise<BrowserToolOutput>;
  toModelOutput(options: { output: BrowserToolOutput }): BrowserModelOutput;
}

/**
 * Create an AI SDK tool that lets the model drive a persistent browser with
 * JavaScript and the Chrome DevTools Protocol.
 *
 * The browser outlives each run: tabs, cookies, and logins carry over. The
 * model never starts, closes, or resets it, and `sessionId: "active"`
 * addresses the tab it last worked in. If the browser had to be replaced
 * (it expired or was closed), the code still runs in the new browser and the
 * result says `restarted: true`.
 *
 * Browser Run only (Chromium). Guardrails, `keepAliveMs`, and recording are
 * set on the `Browser`'s provider.
 *
 * @example
 * ```ts
 * import { Browser, browserRun } from "agents/browser";
 * import { browserTool } from "agents/browser/ai-sdk";
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
 *     const tools = {
 *       browser: browserTool({ browser: this.browser, loader: this.env.LOADER })
 *     };
 *     // …pass `tools` to streamText / generateText
 *   }
 * }
 * ```
 */
export function browserTool(options: BrowserToolOptions): BrowserTool {
  const core = createBrowserToolCore(options, {
    screenshotHint:
      "To show a screenshot, return { type: 'browser_screenshot', mediaType, data } with data from Page.captureScreenshot and mediaType 'image/png', or 'image/jpeg' if you captured with format: 'jpeg'. The user sees the image; you get a short text summary."
  });
  return {
    description: core.description,
    inputSchema: core.inputSchema,
    execute: core.execute,
    toModelOutput: ({ output }) =>
      browserExecuteModelOutput(output, browserReportNotes(output))
  };
}
