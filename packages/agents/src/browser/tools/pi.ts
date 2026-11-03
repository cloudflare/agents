import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
  JsonObject,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration
} from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str, unknown } from "@earendil-works/pi-schema";
import {
  createBrowserToolCore,
  type BrowserToolOptions,
  type BrowserToolOutput
} from "../browser-tool";
import { conversationScope } from "../scope";
import {
  browserExecuteModelOutput,
  browserScreenshotOutput
} from "../tool-helpers";

export type {
  BrowserToolInput,
  BrowserToolOptions,
  BrowserToolOutput
} from "../browser-tool";
export type { BrowserNewTab, BrowserSource } from "../session";

export interface PiBrowserToolOptions<
  TName extends string = "browser"
> extends Omit<BrowserToolOptions, "scope"> {
  /** The tool's name. Default `"browser"`. */
  name?: TName;
  /**
   * Which calls share an active tab: a string for every call, or a function
   * of the call. Defaults to `conversation:<id>` for the calling
   * conversation (`conversationScope` from `agents/browser`), so each
   * conversation (and each fork or subagent) on the Durable Object keeps its
   * own tab, while cookies and logins stay shared.
   */
  scope?: string | ((api: ToolExecutionApi) => string);
}

const browserToolParameters = obj(
  {
    code: str({
      description:
        "An async arrow function that drives the browser with `browser`"
    })
  },
  { open: true }
);

/**
 * What a script gets from `tools.browser()` in pi's code mode: the run as an
 * object, with a screenshot as an image block it can pass to `image()`.
 */
const browserToolOutputSchema = obj(
  {
    status: oneOf(["completed", "error"]),
    executionId: str(),
    result: opt(
      unknown({
        description:
          "What the code returned. A screenshot is an image block: pass it to `image()`."
      })
    ),
    error: opt(str({ description: "Why the code failed." })),
    logs: opt(unknown({ description: "What the code wrote to the console." })),
    notice: opt(
      str({ description: "What happened to the browser and its tabs." })
    )
  },
  { open: true }
);

/**
 * What a UI can show about a run without reading the content: its id and
 * outcome.
 */
export type PiBrowserToolDetails = {
  executionId: string;
  status: BrowserToolOutput["status"];
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
    status: output.status
  };
}

function text(value: unknown): TextContent {
  return {
    type: "text",
    text: typeof value === "string" ? value : JSON.stringify(value)
  };
}

/**
 * The model projection of the run (no `calls` log, bounded `logs`) as an
 * object, for scripts.
 */
function structuredOf(output: unknown, executionId: string): JsonObject {
  const model = browserExecuteModelOutput(output);
  return model.type === "json" &&
    typeof model.value === "object" &&
    model.value !== null &&
    !Array.isArray(model.value)
    ? (model.value as JsonObject)
    : {
        status: "error",
        executionId,
        // Only when the run couldn't be serialized: `value` says so.
        error: typeof model.value === "string" ? model.value : "No result."
      };
}

/**
 * The tool result pi stores and sends: the model projection of the run as
 * JSON (no `calls` log, bounded `logs`), and a screenshot as an image part
 * after it. pi-ai only sends the image to models that accept images. Scripts
 * get the same projection as an object, with the screenshot in `result`.
 */
function browserToolResult(
  output: BrowserToolOutput
): ToolExecutionResult<PiBrowserToolDetails> {
  const isError = output.status === "error";
  const screenshot = browserScreenshotOutput(output);
  if (!screenshot) {
    return {
      output: [text(browserExecuteModelOutput(output).value)],
      structuredOutput: structuredOf(output, output.executionId),
      details: details(output),
      ...(isError ? { isError } : {})
    };
  }

  // No size check: browserScreenshotOutput only accepts images up to 1 MB,
  // well under what model providers accept.
  const bytes = Math.floor((screenshot.data.length * 3) / 4).toLocaleString();
  // Keep the rest of the result (status, notice) around
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
    output: [text(summary), image],
    structuredOutput: {
      ...structuredOf({ ...output, result: undefined }, output.executionId),
      result: { type: "image", data: image.data, mimeType: image.mimeType }
    },
    details: details(output)
  };
}

/** The default scope: the calling conversation's. */
function callConversationScope(api: ToolExecutionApi): string {
  return conversationScope(String(api.conversationId));
}

/**
 * Create a pi-durable tool that lets the model drive a persistent browser
 * with JavaScript and the Chrome DevTools Protocol.
 *
 * Works like `browserTool` in `agents/browser/ai-sdk`: tabs, cookies, and
 * logins carry over between runs, `sessionId: "active"` addresses the tab the
 * model last worked in, and a replaced browser is reported in the
 * result's `notice`. A returned screenshot comes back as an image part that
 * the model sees, when its model accepts images.
 *
 * Scripts in pi's code mode call it as `tools.browser({ code })`, which
 * resolves to the run as an object (`status`, `result`, `error`, `notice`),
 * on errors too. A screenshot's `result` is an image block, for `image()`.
 *
 * Each conversation gets its own active tab (see
 * {@link PiBrowserToolOptions.scope}). A conversation's calls run one at a
 * time, since they share its tab, and the tool doesn't rerun after an
 * eviction (its code may have clicked or
 * submitted something): pi gives the model an interrupted result instead.
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
 *     harness: ({ storage, context, onWake }) => {
 *       this.registry.install({
 *         name: "browser",
 *         tools: [
 *           browserTool({
 *             browser: this.browser,
 *             loader: this.env.LOADER
 *           })
 *         ]
 *       });
 *       return Harness.open(
 *         storage,
 *         { models, registry: this.registry, onWake },
 *         context
 *       );
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
  const { scope = callConversationScope, ...coreOptions } = options;
  const core = createBrowserToolCore(coreOptions, {
    screenshotHint:
      "To see a screenshot, return { type: 'browser_screenshot', mediaType, data } with data from Page.captureScreenshot and mediaType 'image/png', or 'image/jpeg' if you captured with format: 'jpeg'. The image is attached to the result. In a codemode script, `tools.browser()` resolves to the result as an object, and the screenshot in its `result` is an image block: pass it to `image()`."
  });
  return {
    name: options.name ?? ("browser" as TName),
    description: core.description,
    parameters: browserToolParameters,
    structuredOutputSchema: browserToolOutputSchema,
    // A conversation's calls share its tab, so they must not interleave.
    executionMode: "sequential",
    // The code may have clicked or submitted something; don't run it twice.
    replay: "unsafe",
    async execute(args, api, context) {
      const callScope = typeof scope === "string" ? scope : scope(api);
      return browserToolResult(
        await core.execute(
          { code: args.code },
          { scope: callScope, signal: context.abortSignal }
        )
      );
    }
  };
}
