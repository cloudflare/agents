/**
 * The harness-neutral core of `browserTool`, shared by the adapters in
 * `tools/` (`agents/browser/ai-sdk`, `agents/browser/tanstack-ai`).
 * Internal — not an entry point.
 */
import {
  createCodemodeRuntime,
  DynamicWorkerExecutor,
  type ProxyToolOutput
} from "@cloudflare/codemode";
import { DEFAULT_BROWSER_SCOPE } from "./browser";
import {
  BROWSER_INSTRUCTIONS,
  BrowserSessionConnector,
  type BrowserExecutionReport,
  type BrowserNewTab,
  type BrowserSource
} from "./session-connector";
import { resolveCtx, transformBrowserResult } from "./tool-helpers";

export interface BrowserToolOptions {
  /**
   * The browser the tool drives — usually a `Browser` installed on the
   * host's Lifecycle. Tools built from the same `Browser` share it.
   */
  browser: BrowserSource;

  /**
   * WorkerLoader binding for sandboxed code execution.
   *
   * Requires `"worker_loaders": [{ "binding": "LOADER" }]` in wrangler.jsonc.
   */
  loader: WorkerLoader;

  /** Sandbox execution timeout in milliseconds. Defaults to 60000 (60s). */
  timeoutMs?: number;

  /**
   * Who is driving, when several chats or users share one `Browser`: runs
   * with the same scope share an active tab, and each scope keeps its own.
   * Cookies and logins are shared by every scope. Defaults to `"shared"`,
   * one active tab for every tool that leaves it out.
   */
  scope?: string;

  /**
   * Durable Object state for the codemode runtime facet. Optional inside an
   * Agent (resolved via `getCurrentAgent()`); pass it explicitly elsewhere.
   *
   * The worker must export the `CodemodeRuntime` class (the
   * `@cloudflare/codemode/vite` plugin does this automatically, or add
   * `export { CodemodeRuntime } from "@cloudflare/codemode"` to your entry).
   */
  ctx?: DurableObjectState;
}

/** The model's input to `browserTool`: JavaScript to run. */
export interface BrowserToolInput {
  code: string;
}

/**
 * The result of one `browserTool` run: the codemode execution result,
 * plus what happened to the browser.
 */
export type BrowserToolOutput = ProxyToolOutput & {
  /** The browser was replaced before this run; earlier tabs are gone. */
  restarted?: true;
  /**
   * Sentences telling the model what happened to its browser: it was
   * restarted, its tab was closed by someone else, or another scope is
   * working in its tab too.
   */
  notice?: string;
  /** Tabs the page opened itself (popups, `target=_blank` links). */
  newTabs?: BrowserNewTab[];
};

const DEFAULT_TIMEOUT_MS = 60_000;

const RESTARTED_NOTICE =
  "The browser was restarted before this run (it expired or was closed): earlier tabs, logins, and page state are gone. Your code ran in a fresh browser — navigate again before relying on page state.";

const TAB_CLOSED_NOTICE =
  "The tab you were working in was closed since your last run (by another conversation using this browser, or a person), so this run used a blank tab — navigate again before relying on page state.";

const TAB_SHARED_NOTICE =
  "Another conversation using this browser is also working in your tab, so its page may change between your runs. Open a tab of your own with Target.createTarget if you need one.";

/** Scopes whose runtime and connector stay built; older ones are rebuilt. */
const MAX_CACHED_SCOPES = 32;

/**
 * A codemode runtime name per browser. Browser names are host-chosen and
 * unrestricted; runtime names allow only `[a-zA-Z0-9_.-]`, so anything else
 * (including `.`, the escape) is hex-escaped.
 */
function browserRuntimeName(name: string): string {
  const escaped = name.replace(
    /[^a-zA-Z0-9_-]/g,
    (char) => `.${char.codePointAt(0)?.toString(16)}.`
  );
  return `browser-tool_${escaped}`;
}

/**
 * The latest run queued per browser and scope, so runs in one scope go one
 * at a time, even from tools built separately (one per turn, say). Per
 * isolate, which is per Durable Object.
 */
const runQueues = new WeakMap<BrowserSource, Map<string, Promise<unknown>>>();

function queued<T>(
  browser: BrowserSource,
  scope: string,
  run: () => Promise<T>
): Promise<T> {
  let queues = runQueues.get(browser);
  if (!queues) runQueues.set(browser, (queues = new Map()));
  const previous = queues.get(scope) ?? Promise.resolve();
  const next = previous.then(run, run);
  const settled = next.catch(() => undefined);
  queues.set(scope, settled);
  void settled.then(() => {
    if (queues.get(scope) === settled) queues.delete(scope);
  });
  return next;
}

/** Add what happened to the browser to the codemode result. */
function withBrowserReport(
  output: ProxyToolOutput,
  report: BrowserExecutionReport | undefined
): BrowserToolOutput {
  if (!report) return output;
  const notices = [
    report.restarted && RESTARTED_NOTICE,
    report.tabClosed && !report.restarted && TAB_CLOSED_NOTICE,
    report.tabShared && TAB_SHARED_NOTICE
  ].filter((notice) => typeof notice === "string");
  return {
    ...output,
    ...(report.restarted ? { restarted: true as const } : {}),
    ...(notices.length > 0 ? { notice: notices.join(" ") } : {}),
    ...(report.newTabs.length > 0 ? { newTabs: report.newTabs } : {})
  };
}

/** Report sentences that must survive a screenshot's text summary. */
export function browserReportNotes(output: BrowserToolOutput): string[] {
  const notes: string[] = [];
  if (output.notice) notes.push(output.notice);
  if (output.newTabs?.length) {
    notes.push(
      `New tabs opened by the page: ${JSON.stringify(output.newTabs)}`
    );
  }
  return notes;
}

/**
 * Build the codemode runtime and connector for one `browserTool`, and wrap
 * `execute` so each result carries the browser report.
 *
 * Each scope gets its own connector (which knows its scope) on the same
 * codemode runtime, built on first use. Runs in one scope wait for each
 * other, since they drive one tab; runs in different scopes go in parallel.
 */
export function createBrowserToolCore(
  options: BrowserToolOptions,
  adapter: {
    /** What the adapter does with screenshots, told to the model. */
    screenshotHint: string;
  }
) {
  const ctx = resolveCtx(options);
  if (!ctx) {
    throw new Error(
      "browserTool requires a Durable Object 'ctx' — pass it explicitly, or call from within an Agent so it can be resolved via getCurrentAgent()"
    );
  }

  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const executor = new DynamicWorkerExecutor({
    loader: options.loader,
    timeout
  });

  // Our own description, not codemode's generic one: that one tells the
  // model to search before every new connector (search doesn't cover CDP
  // commands), and describes approvals, snippets, and replay, which this
  // tool doesn't use.
  const rules = [
    BROWSER_INSTRUCTIONS,
    `Each run times out after ${Math.round(timeout / 1000)}s, so split long jobs (crawling a site, say) across runs.`,
    adapter.screenshotHint
  ]
    .join("\n")
    .split("\n")
    .map((rule) => `- ${rule}`)
    .join("\n");
  const description = [
    "Run JavaScript that drives a persistent Chrome browser over the Chrome DevTools Protocol (CDP).",
    "",
    "Write an async arrow function, `async () => { ... }`, and return a small JSON value. Use the `cdp` global to reach the browser. `fetch` is blocked and there is no file system or Node.js API.",
    "",
    "## cdp",
    "",
    "- `cdp.send({ method, params?, sessionId?, timeoutMs? })` sends a CDP command and returns its result without the JSON-RPC envelope: `Page.navigate` returns `{ frameId, errorText? }`, `Runtime.evaluate` returns `{ result: { value }, exceptionDetails? }`.",
    "- `cdp.attachToTarget({ targetId })` makes an open tab active and returns `{ sessionId }`.",
    '- `cdp.spec()` returns the whole protocol (about 650 KB) as `{ domains: [{ name, commands, events, types }] }`. Filter it in code, for example `spec.domains.find((d) => d.name === "Page").commands.find((c) => c.name === "navigate")`.',
    "- `cdp.getDebugLog()` returns recent protocol traffic, for when a command fails or times out.",
    "",
    "## Rules",
    "",
    rules,
    '- A `SyntaxError` from "Failed to start Worker" means your code didn\'t parse; its line number points into wrapper code, not yours. Check regex literals and escapes.'
  ].join("\n");
  type CodemodeTool = ReturnType<
    ReturnType<typeof createCodemodeRuntime>["tool"]
  >;
  interface ScopedTool {
    connector: BrowserSessionConnector;
    tool: CodemodeTool;
  }
  const durableCtx: DurableObjectState = ctx;
  const scopes = new Map<string, ScopedTool>();
  function scoped(scope: string): ScopedTool {
    const cached = scopes.get(scope);
    if (cached) {
      // Most recently used last, so the first entry is the one to drop.
      scopes.delete(scope);
      scopes.set(scope, cached);
      return cached;
    }
    const connector = new BrowserSessionConnector(durableCtx, {
      browser: options.browser,
      scope
    });
    const runtime = createCodemodeRuntime({
      ctx: durableCtx,
      executor,
      connectors: [connector],
      name: browserRuntimeName(options.browser.name),
      transformResult: transformBrowserResult
    });
    const built = { connector, tool: runtime.tool({ description }) };
    scopes.set(scope, built);
    if (scopes.size > MAX_CACHED_SCOPES) {
      const oldest = scopes.keys().next().value;
      if (oldest !== undefined) scopes.delete(oldest);
    }
    return built;
  }

  const defaultScope = options.scope ?? DEFAULT_BROWSER_SCOPE;
  const { inputSchema } = scoped(defaultScope).tool;

  return {
    description,
    inputSchema,
    /** Run `input` in `scope`, which defaults to the tool's `scope`. */
    execute: (
      input: BrowserToolInput,
      scope: string = defaultScope
    ): Promise<BrowserToolOutput> =>
      queued(options.browser, scope, async () => {
        const { connector, tool } = scoped(scope);
        const output = await tool.execute(input, undefined);
        return withBrowserReport(
          output,
          connector.takeReport(output.executionId)
        );
      })
  };
}
