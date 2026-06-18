import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  createCodemodeRuntime,
  DynamicWorkerExecutor,
  truncateResult,
  type CodemodeRuntimeHandle
} from "@cloudflare/codemode";
import { __DO_NOT_USE_WILL_BREAK__agentContext as agentContext } from "../internal_context";
import type { BrowserBinding } from "./browser-run";
import {
  browserContent,
  browserExtract,
  browserLinks,
  browserMarkdown,
  browserScrape,
  type QuickActionBinding,
  type QuickActionCommonOptions,
  type QuickActionPage
} from "./quick-actions";
import {
  BrowserConnector,
  type BrowserConnectorOptions,
  type BrowserConnectorSessionOptions
} from "./connector";
import {
  DurableBrowserSessionStore,
  type BrowserSessionStore
} from "./session-manager";

export interface CreateBrowserToolsOptions {
  /**
   * Durable Object state. The codemode runtime that backs the browser tool
   * lives in a facet of this DO, and browser session ids are stored in its
   * storage — so the tool must be created from inside a Durable Object
   * (e.g. an Agent).
   *
   * Optional: when omitted, it is resolved from the current Agent via
   * `getCurrentAgent()`, so inside an Agent method you can just pass `browser`
   * and `loader`. Pass it explicitly outside an Agent context.
   *
   * The worker must export the `CodemodeRuntime` class (the
   * `@cloudflare/codemode/vite` plugin does this automatically, or add
   * `export { CodemodeRuntime } from "@cloudflare/codemode"` to your entry).
   */
  ctx?: DurableObjectState;

  /**
   * WorkerLoader binding for sandboxed code execution.
   *
   * Requires `"worker_loaders": [{ "binding": "LOADER" }]` in wrangler.jsonc.
   */
  loader: WorkerLoader;

  /**
   * Browser Rendering binding (Fetcher).
   *
   * This is the primary way to connect — works both locally in
   * `wrangler dev` and when deployed to Cloudflare Workers.
   *
   * Requires `"browser": { "binding": "BROWSER" }` in wrangler.jsonc.
   */
  browser?: BrowserBinding;

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
   * Browser session lifecycle (binding-backed only). Defaults to one fresh
   * session per codemode execution (`one-shot`).
   */
  session?: BrowserConnectorSessionOptions;

  /**
   * Durable store for Browser Run session ids. Defaults to a
   * {@link DurableBrowserSessionStore} over `ctx.storage`.
   */
  store?: BrowserSessionStore;

  /**
   * Sandbox execution timeout in milliseconds. Defaults to 30000 (30s).
   * Also used as the per-CDP-command timeout.
   */
  timeout?: number;

  /**
   * Codemode runtime name — the durable identity of the tool's executions
   * and snippets. Defaults to `"browser"`.
   */
  name?: string;

  /**
   * Also expose stateless {@link createQuickActionTools | Quick Action} tools
   * (`browser_markdown`, `browser_extract`, …) alongside the durable
   * `browser_execute` tool.
   *
   * Enabled by default whenever a Browser Run `browser` binding is available
   * (they share it). Pass an object to configure them, or `false` to disable.
   * The Quick Action binding defaults to `browser`; override it via
   * `quickActions.browser`. When only `cdpUrl` is set (no binding), the
   * defaults are skipped silently — pass `quickActions: { browser }` to force
   * them.
   */
  quickActions?:
    | boolean
    | {
        browser?: QuickActionBinding;
        actions?: QuickActionToolName[];
        maxChars?: number;
        options?: QuickActionCommonOptions;
      };
}

/**
 * The browser tool's moving parts, for hosts that need more than the tools:
 *
 * - `runtime` — the codemode runtime handle (approve/reject paused runs,
 *   `expirePaused`, audit via `executions()`, snippets).
 * - `connector` — host-side session helpers: `sessionInfo()`,
 *   `closeSession()`, and `sweep()` for a recurring cleanup task.
 * - `tools` — what `createBrowserTools` returns.
 */
export interface BrowserRuntime {
  runtime: CodemodeRuntimeHandle;
  connector: BrowserConnector;
  tools: ToolSet;
}

let didWarnExperimental = false;
let didDebugQuickActionSkip = false;

/**
 * The Durable Object state to build the runtime in: the explicit `ctx` if
 * given, otherwise the current Agent's `ctx` (via `getCurrentAgent()`), so
 * `createBrowserRuntime` can be called from an Agent method without threading
 * `this.ctx` through.
 */
function resolveCtx(
  options: CreateBrowserToolsOptions
): DurableObjectState | undefined {
  if (options.ctx) return options.ctx;
  const agent = agentContext.getStore()?.agent as
    | { ctx?: DurableObjectState }
    | undefined;
  return agent?.ctx;
}

function connectorOptions(
  options: CreateBrowserToolsOptions,
  ctx: DurableObjectState
): BrowserConnectorOptions {
  if (options.cdpUrl) {
    return {
      cdpUrl: options.cdpUrl,
      cdpHeaders: options.cdpHeaders,
      timeout: options.timeout
    };
  }
  if (!options.browser) {
    throw new Error(
      "Either 'browser' (Fetcher binding) or 'cdpUrl' must be provided"
    );
  }
  return {
    browser: options.browser,
    store: options.store ?? new DurableBrowserSessionStore(ctx.storage),
    session: options.session,
    timeout: options.timeout
  };
}

/**
 * Create the browser codemode runtime: the `browser_execute` tool plus the
 * runtime handle and connector for host-side wiring (approvals, session info,
 * sweeps).
 *
 * @example
 * ```ts
 * export class MyAgent extends Agent<Env> {
 *   get browser() {
 *     return createBrowserRuntime({
 *       ctx: this.ctx,
 *       browser: this.env.BROWSER,
 *       loader: this.env.LOADER,
 *       session: { mode: "dynamic" }
 *     });
 *   }
 *
 *   @callable()
 *   async closeBrowserSession() {
 *     await this.browser.connector.closeSession();
 *   }
 * }
 * ```
 */
export function createBrowserRuntime(
  options: CreateBrowserToolsOptions
): BrowserRuntime {
  if (!didWarnExperimental) {
    didWarnExperimental = true;
    console.warn(
      "[agents/browser] Browser tools are experimental and may change in a future release."
    );
  }

  const ctx = resolveCtx(options);
  if (!ctx) {
    throw new Error(
      "createBrowserRuntime requires a Durable Object 'ctx' — pass it explicitly, or call from within an Agent so it can be resolved via getCurrentAgent()"
    );
  }

  const connector = new BrowserConnector(ctx, connectorOptions(options, ctx));
  const runtime = createCodemodeRuntime({
    ctx,
    executor: new DynamicWorkerExecutor({
      loader: options.loader,
      timeout: options.timeout
    }),
    connectors: [connector],
    name: options.name ?? "browser",
    transformResult: truncateResult
  });

  const tools: ToolSet = { browser_execute: runtime.tool() };

  // Quick Actions ride the same `browser` binding, so they are on by default.
  // `env.BROWSER` satisfies both the CDP `BrowserBinding` (fetch) and the
  // `QuickActionBinding` (quickAction) surfaces; our narrower option type only
  // sees the former, so reuse it here unless an explicit binding wins.
  if (options.quickActions !== false) {
    const qa =
      options.quickActions == null || options.quickActions === true
        ? {}
        : options.quickActions;
    const quickActionBrowser =
      qa.browser ??
      (options.browser as unknown as QuickActionBinding | undefined);
    if (quickActionBrowser) {
      Object.assign(
        tools,
        createQuickActionTools({
          browser: quickActionBrowser,
          actions: qa.actions,
          maxChars: qa.maxChars,
          options: qa.options
        })
      );
    } else if (options.quickActions) {
      // Explicitly requested but no binding to back them.
      throw new Error(
        "quickActions requires a Browser Run binding — set 'browser' (env.BROWSER) or 'quickActions.browser'"
      );
    } else if (!didDebugQuickActionSkip) {
      // Defaulted on, but only `cdpUrl` is set: there is no binding to call
      // Quick Actions through, so they are skipped. Surface it once so a user
      // expecting `browser_markdown` et al. isn't left wondering.
      didDebugQuickActionSkip = true;
      console.debug(
        "[agents/browser] Quick Action tools skipped — no Browser Run binding (only 'cdpUrl' is set). Pass 'browser' or 'quickActions.browser' to enable them."
      );
    }
  }

  return { runtime, connector, tools };
}

/**
 * Create AI SDK tools for browser automation via CDP code mode.
 *
 * Returns a `ToolSet` with a single durable `browser_execute` tool backed by
 * a codemode runtime: the model writes TypeScript against the `cdp` connector
 * (`cdp.send`, `cdp.attachToTarget`, `cdp.spec`, …), executions are recorded
 * for abort-and-replay, and browser sessions survive pauses.
 *
 * @example
 * ```ts
 * import { createBrowserTools } from "agents/browser/ai";
 * import { generateText } from "ai";
 *
 * // inside a Durable Object / Agent:
 * const browserTools = createBrowserTools({
 *   ctx: this.ctx,
 *   browser: this.env.BROWSER,
 *   loader: this.env.LOADER,
 * });
 *
 * const result = await generateText({
 *   model,
 *   tools: { ...browserTools, ...otherTools },
 *   messages,
 * });
 * ```
 */
export function createBrowserTools(
  options: CreateBrowserToolsOptions
): ToolSet {
  return createBrowserRuntime(options).tools;
}

/** A Quick Action exposed as an AI SDK tool. */
export type QuickActionToolName =
  | "markdown"
  | "extract"
  | "links"
  | "scrape"
  | "content";

export interface CreateQuickActionToolsOptions {
  /**
   * Browser Run binding with Quick Actions support (`env.BROWSER`). Requires a
   * Worker `compatibility_date` of `2026-03-24`+ and `remote: true` for local
   * `wrangler dev`.
   */
  browser: QuickActionBinding;

  /**
   * Which tools to expose. Defaults to the text-returning, model-friendly set
   * (`markdown`, `extract`, `links`, `scrape`). `content` (raw HTML) is opt-in
   * since it is large and rarely what a model wants.
   */
  actions?: QuickActionToolName[];

  /**
   * Bound every result to roughly this many characters before returning it to
   * the model, to protect the context window, preserving each result's shape:
   * text (markdown/content) is truncated to a string, oversized arrays
   * (links/scrape) are trimmed but stay arrays, and only an opaque oversized
   * object degrades to a truncated-preview summary. Set to `0` to disable.
   * Defaults to 50000.
   */
  maxChars?: number;

  /**
   * Common Browser Run options merged into every request — e.g. `cookies`,
   * `authenticate`, or `setExtraHTTPHeaders` for authenticated pages, and
   * `gotoOptions` / `viewport` for JavaScript-heavy pages. The model only ever
   * supplies the page (`url`/`html`) and action-specific fields; these
   * host-supplied options are never exposed to it.
   */
  options?: QuickActionCommonOptions;
}

const DEFAULT_QUICK_ACTION_TOOLS: QuickActionToolName[] = [
  "markdown",
  "extract",
  "links",
  "scrape"
];

const DEFAULT_QUICK_ACTION_MAX_CHARS = 50_000;

const pageInputSchema = z
  .object({
    url: z.string().url().optional().describe("URL of the page to load"),
    html: z
      .string()
      .optional()
      .describe("Raw HTML to render instead of loading a URL")
  })
  .refine((value) => Boolean(value.url) || Boolean(value.html), {
    message: "Provide either 'url' or 'html'"
  });

function toPage(
  input: { url?: string; html?: string },
  options?: QuickActionCommonOptions
): QuickActionPage {
  const page = input.url ? { url: input.url } : { html: input.html as string };
  return { ...options, ...page } as QuickActionPage;
}

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} characters]`;
}

/**
 * Keep a tool result within a rough character budget so a single browse cannot
 * blow the model's context window — while preserving the result's shape so the
 * model sees a consistent type across calls:
 *
 * - strings (markdown/content) are truncated to a string;
 * - arrays (links/scrape) are trimmed from the end but stay arrays;
 * - only an opaque oversized object (e.g. a sprawling `extract`) degrades to a
 *   `{ truncated, note, preview }` summary, since it cannot be trimmed safely.
 */
function boundResult(value: unknown, maxChars: number): unknown {
  if (maxChars <= 0) return value;
  if (typeof value === "string") return truncate(value, maxChars);
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return value;
  }
  if (json.length <= maxChars) return value;
  if (Array.isArray(value)) {
    const trimmed = boundArray(value, maxChars);
    // If even the first element overflows the budget, `trimmed` is empty —
    // returning `[]` would read as "no results" rather than "too large", so
    // fall through to the explicit truncated-preview summary instead.
    if (trimmed.length > 0) return trimmed;
  }
  return {
    truncated: true,
    note: `Result is too large (${json.length} characters); narrow the request.`,
    preview: `${json.slice(0, maxChars)}…`
  };
}

/**
 * Take as many leading items as fit within `maxChars` (measured against their
 * JSON length), returning a trimmed array of the same element type. Silent by
 * design: the model gets fewer, valid items rather than a reshaped result.
 */
function boundArray(value: unknown[], maxChars: number): unknown[] {
  const out: unknown[] = [];
  let size = 2; // the enclosing "[]"
  for (const item of value) {
    const itemSize = JSON.stringify(item).length + 1; // + a separating comma
    if (size + itemSize > maxChars) break;
    out.push(item);
    size += itemSize;
  }
  return out;
}

/**
 * Create AI SDK tools for Browser Run [Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/):
 * stateless one-shot browsing (read a page as Markdown, extract structured
 * data with AI, list links, scrape elements). Unlike `createBrowserTools`,
 * these need only the `browser` binding — no Durable Object, loader, or
 * sandbox — so they work from any Worker.
 *
 * @example
 * ```ts
 * import { createQuickActionTools } from "agents/browser/ai";
 *
 * const tools = createQuickActionTools({ browser: this.env.BROWSER });
 * const result = await generateText({ model, tools, messages });
 * ```
 */
export function createQuickActionTools(
  options: CreateQuickActionToolsOptions
): ToolSet {
  const { browser } = options;
  const requestOptions = options.options;
  const enabled = new Set(options.actions ?? DEFAULT_QUICK_ACTION_TOOLS);
  const maxChars = options.maxChars ?? DEFAULT_QUICK_ACTION_MAX_CHARS;
  const tools: ToolSet = {};

  if (enabled.has("markdown")) {
    tools.browser_markdown = tool({
      description:
        "Load a web page (or render raw HTML) and return its content as Markdown. Best for reading articles, docs, or any page as text.",
      inputSchema: pageInputSchema,
      execute: async (input) =>
        boundResult(
          await browserMarkdown(browser, toPage(input, requestOptions)),
          maxChars
        )
    });
  }

  if (enabled.has("extract")) {
    tools.browser_extract = tool({
      description:
        "Extract structured data from a web page using AI. Describe what you want in 'prompt'. Passing a JSON Schema in 'schema' is strongly recommended — without one the extractor often fails to produce JSON.",
      inputSchema: z
        .object({
          url: z.string().url().optional().describe("URL of the page to load"),
          html: z
            .string()
            .optional()
            .describe("Raw HTML to render instead of loading a URL"),
          prompt: z
            .string()
            .optional()
            .describe("What to extract, in natural language"),
          schema: z
            .unknown()
            .optional()
            .describe("Optional JSON Schema describing the desired output")
        })
        .refine((value) => Boolean(value.url) || Boolean(value.html), {
          message: "Provide either 'url' or 'html'"
        })
        .refine((value) => Boolean(value.prompt) || Boolean(value.schema), {
          message: "Provide either 'prompt' or 'schema'"
        }),
      execute: async (input) =>
        boundResult(
          await browserExtract(browser, {
            ...toPage(input, requestOptions),
            prompt: input.prompt,
            response_format: input.schema
              ? { type: "json_schema", schema: input.schema }
              : undefined
          }),
          maxChars
        )
    });
  }

  if (enabled.has("links")) {
    tools.browser_links = tool({
      description:
        "Return every link found on a web page (including ones not visible). Useful for discovering pages to follow.",
      inputSchema: pageInputSchema,
      execute: async (input) =>
        boundResult(
          await browserLinks(browser, toPage(input, requestOptions)),
          maxChars
        )
    });
  }

  if (enabled.has("scrape")) {
    tools.browser_scrape = tool({
      description:
        "Scrape specific elements from a web page by CSS selector. Returns the matched elements' text, HTML, and attributes.",
      inputSchema: z
        .object({
          url: z.string().url().optional().describe("URL of the page to load"),
          html: z
            .string()
            .optional()
            .describe("Raw HTML to render instead of loading a URL"),
          selectors: z
            .array(z.string())
            .min(1)
            .describe("CSS selectors to extract")
        })
        .refine((value) => Boolean(value.url) || Boolean(value.html), {
          message: "Provide either 'url' or 'html'"
        }),
      execute: async (input) =>
        boundResult(
          await browserScrape(browser, {
            ...toPage(input, requestOptions),
            elements: input.selectors.map((selector) => ({ selector }))
          }),
          maxChars
        )
    });
  }

  if (enabled.has("content")) {
    tools.browser_content = tool({
      description:
        "Load a web page and return its fully rendered HTML (after JavaScript runs). Prefer 'browser_markdown' unless you need the raw HTML.",
      inputSchema: pageInputSchema,
      execute: async (input) =>
        boundResult(
          await browserContent(browser, toPage(input, requestOptions)),
          maxChars
        )
    });
  }

  return tools;
}
