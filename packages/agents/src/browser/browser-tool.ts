/**
 * The harness-neutral core of `browserTool`, shared by the AI SDK
 * (`agents/browser/ai-sdk`) and TanStack AI (`agents/browser/tanstack-ai`)
 * adapters. Internal — not an entry point.
 */
import {
  createCodemodeRuntime,
  DynamicWorkerExecutor,
  type ProxyToolOutput
} from "@cloudflare/codemode";
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
  /** A sentence telling the model what `restarted` means for it. */
  notice?: string;
  /** Tabs the page opened itself (popups, `target=_blank` links). */
  newTabs?: BrowserNewTab[];
};

const DEFAULT_TIMEOUT_MS = 60_000;

const RESTARTED_NOTICE =
  "The browser was restarted before this run (it expired or was closed): earlier tabs, logins, and page state are gone. Your code ran in a fresh browser — navigate again before relying on page state.";

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

/** Add what happened to the browser to the codemode result. */
function withBrowserReport(
  output: ProxyToolOutput,
  report: BrowserExecutionReport | undefined
): BrowserToolOutput {
  if (!report) return output;
  return {
    ...output,
    ...(report.restarted
      ? { restarted: true as const, notice: RESTARTED_NOTICE }
      : {}),
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
  const connector = new BrowserSessionConnector(ctx, {
    browser: options.browser
  });
  const runtime = createCodemodeRuntime({
    ctx,
    executor: new DynamicWorkerExecutor({
      loader: options.loader,
      timeout
    }),
    connectors: [connector],
    name: browserRuntimeName(options.browser.name),
    transformResult: transformBrowserResult
  });

  // The connector rules go in the description itself. Otherwise the model
  // only finds them with codemode.describe("cdp"), and codemode.search
  // indexes the cdp.* methods, not CDP commands, so its queries come up empty.
  const rules = [
    BROWSER_INSTRUCTIONS,
    `Each run times out after ${Math.round(timeout / 1000)}s, so split long jobs (such as crawling a site) across several runs.`,
    adapter.screenshotHint
  ]
    .join("\n")
    .split("\n")
    .map((rule) => `  - ${rule}`)
    .join("\n");
  const codemodeTool = runtime.tool({
    connectorHints: {
      cdp: `A persistent browser over the Chrome DevTools Protocol. Its rules are below, so you don't need codemode.search or codemode.describe for it; codemode.search doesn't cover CDP commands such as Page.navigate (use cdp.spec() to look those up).\n${rules}`
    }
  });

  return {
    description: codemodeTool.description,
    inputSchema: codemodeTool.inputSchema,
    execute: async (
      input: BrowserToolInput,
      executeOptions?: unknown
    ): Promise<BrowserToolOutput> => {
      const output = await codemodeTool.execute(input, executeOptions);
      return withBrowserReport(
        output,
        connector.takeReport(output.executionId)
      );
    }
  };
}
