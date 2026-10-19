import {
  Type,
  type ImageContent,
  type TextContent
} from "@earendil-works/pi-ai";
import type {
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration
} from "@earendil-works/pi-durable";
import {
  createBrowserToolCore,
  type BrowserToolOptions,
  type BrowserToolOutput
} from "../browser-tool";
import type { BrowserNewTab } from "../session-connector";
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

export interface PiBrowserToolOptions<
  TName extends string = "browser"
> extends Omit<BrowserToolOptions, "scope"> {
  /** The tool's name. Default `"browser"`. */
  name?: TName;
  /**
   * Which calls share an active tab: a string for every call, or a function
   * of the call. Defaults to `conversation:<id>` for the calling
   * conversation, so each
   * conversation (and each fork or subagent) on the Durable Object keeps its
   * own tab, while cookies and logins stay shared.
   */
  scope?: string | ((api: ToolExecutionApi) => string);
}

const browserToolParameters = Type.Object({
  code: Type.String({
    description: "An async arrow function that drives the browser with `cdp`"
  })
});

/**
 * What a UI can show about a run without reading the content: the run's
 * outcome and what happened to the browser.
 */
export type PiBrowserToolDetails = {
  executionId: string;
  status: BrowserToolOutput["status"];
  restarted?: true;
  newTabs?: { targetId: string; url?: string; title?: string }[];
};

export type PiBrowserTool<TName extends string = "browser"> = ToolRegistration<
  typeof browserToolParameters,
  PiBrowserToolDetails
> & {
  readonly name: TName;
};

function details(output: BrowserToolOutput): PiBrowserToolDetails {
  return {
    executionId: output.executionId,
    status: output.status,
    ...(output.restarted ? { restarted: true as const } : {}),
    ...(output.newTabs
      ? {
          newTabs: output.newTabs.map((tab: BrowserNewTab) => ({
            targetId: tab.targetId,
            ...(tab.url === undefined ? {} : { url: tab.url }),
            ...(tab.title === undefined ? {} : { title: tab.title })
          }))
        }
      : {})
  };
}

function text(value: unknown): TextContent {
  return {
    type: "text",
    text: typeof value === "string" ? value : JSON.stringify(value)
  };
}

/**
 * The tool result pi stores and sends: the model projection of the run as
 * JSON (no `calls` log, bounded `logs`), and a screenshot as an image part
 * after it. pi-ai only sends the image to models that accept images.
 */
function browserToolResult(
  output: BrowserToolOutput
): ToolExecutionResult<PiBrowserToolDetails> {
  const isError = output.status === "error";
  const screenshot = browserScreenshotOutput(output);
  if (!screenshot) {
    return {
      content: [text(browserExecuteModelOutput(output).value)],
      details: details(output),
      ...(isError ? { isError } : {})
    };
  }

  // No size check: a screenshot comes from one cdp.send result, which
  // codemode caps at 1 MB, well under what model providers accept.
  const bytes = Math.floor((screenshot.data.length * 3) / 4).toLocaleString();
  // Keep the rest of the result (status, restarted, notice, newTabs) around
  // the sentence that replaces the screenshot.
  const summary = browserExecuteModelOutput({
    ...output,
    result: `Screenshot attached as an image (${screenshot.mediaType}, approximately ${bytes} bytes). If you can't see it, read the page with Runtime.evaluate instead.`
  }).value;
  const image: ImageContent = {
    type: "image",
    data: screenshot.data,
    mimeType: screenshot.mediaType
  };
  return {
    content: [text(summary), image],
    details: details(output)
  };
}

function conversationScope(api: ToolExecutionApi): string {
  return `conversation:${api.conversationId}`;
}

/**
 * Create a pi-durable tool that lets the model drive a persistent browser
 * with JavaScript and the Chrome DevTools Protocol.
 *
 * Works like `browserTool` in `agents/browser/ai-sdk`: tabs, cookies, and
 * logins carry over between runs, `sessionId: "active"` addresses the tab the
 * model last worked in, and a replaced browser is reported as
 * `restarted: true`. A returned screenshot comes back as an image part that
 * the model sees, when its model accepts images.
 *
 * Each conversation gets its own active tab (see
 * {@link PiBrowserToolOptions.scope}). A conversation's calls run one at a
 * time, since they share its tab, and the tool doesn't rerun after an
 * eviction (its code may have clicked or
 * submitted something): pi gives the model an interrupted result instead.
 * Pass `ctx` unless the tool is built inside an Agent.
 *
 * @example
 * ```ts
 * import { Browser, browserRun } from "agents/browser";
 * import { browserTool } from "agents/browser/pi";
 *
 * export class MyAgent extends DurableObject<Env> {
 *   readonly browser = new Browser({ provider: browserRun(this.env.BROWSER) });
 *   readonly registry = createRegistry();
 *   readonly harness = new PiHarness({
 *     harness: ({ storage, context }) => {
 *       this.registry.install({
 *         name: "browser",
 *         tools: [
 *           browserTool({
 *             ctx: this.ctx,
 *             browser: this.browser,
 *             loader: this.env.LOADER
 *           })
 *         ]
 *       });
 *       return Harness.open(storage, { models, registry: this.registry }, context);
 *     }
 *   });
 *   readonly lifecycle = Lifecycle.install(this)
 *     .use(this.browser)
 *     .use(this.harness);
 * }
 * ```
 */
export function browserTool<TName extends string = "browser">(
  options: PiBrowserToolOptions<TName>
): PiBrowserTool<TName> {
  const { scope = conversationScope, ...coreOptions } = options;
  const core = createBrowserToolCore(coreOptions, {
    screenshotHint:
      "To see a screenshot, return { type: 'browser_screenshot', mediaType, data } with data from Page.captureScreenshot and mediaType 'image/png', or 'image/jpeg' if you captured with format: 'jpeg'. The image is attached to the result."
  });
  return {
    name: options.name ?? ("browser" as TName),
    description: core.description,
    parameters: browserToolParameters,
    // A conversation's calls share its tab, so they must not interleave.
    executionMode: "sequential",
    // The code may have clicked or submitted something; don't run it twice.
    replay: "unsafe",
    async execute(args, api) {
      const callScope = typeof scope === "string" ? scope : scope(api);
      return browserToolResult(
        await core.execute({ code: args.code }, callScope)
      );
    }
  };
}
