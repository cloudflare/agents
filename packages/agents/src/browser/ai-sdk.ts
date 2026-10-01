/**
 * `agents/browser/ai-sdk` — the AI SDK tool for a persistent `Browser`.
 *
 * The older `createBrowserTools` stays in `agents/browser/ai`.
 */
import type { FlexibleSchema } from "ai";
import {
  createCodemodeRuntime,
  DynamicWorkerExecutor,
  type ProxyToolOutput
} from "@cloudflare/codemode";
import {
  BrowserSessionConnector,
  type BrowserExecutionReport,
  type BrowserNewTab,
  type BrowserSource
} from "./session-connector";
import {
  browserExecuteModelOutput,
  resolveCtx,
  transformBrowserResult,
  type BrowserModelOutput
} from "./tool-helpers";

export type { BrowserNewTab, BrowserSource } from "./session-connector";

// Stateless Quick Action tools, so one import covers both.
export {
  createQuickActionTools,
  type CreateQuickActionToolsOptions,
  type QuickActionToolName
} from "./ai";

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

  /** Sandbox execution timeout in milliseconds. Defaults to 30000 (30s). */
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

/** The model's input to {@link browserTool}: JavaScript to run. */
export interface BrowserToolInput {
  code: string;
}

/**
 * The result of one {@link browserTool} run: the codemode execution result,
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
function browserReportNotes(output: BrowserToolOutput): string[] {
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
  const ctx = resolveCtx(options);
  if (!ctx) {
    throw new Error(
      "browserTool requires a Durable Object 'ctx' — pass it explicitly, or call from within an Agent so it can be resolved via getCurrentAgent()"
    );
  }

  const connector = new BrowserSessionConnector(ctx, {
    browser: options.browser
  });
  const runtime = createCodemodeRuntime({
    ctx,
    executor: new DynamicWorkerExecutor({
      loader: options.loader,
      timeout: options.timeoutMs
    }),
    connectors: [connector],
    name: browserRuntimeName(options.browser.name),
    transformResult: transformBrowserResult
  });

  const codemodeTool = runtime.tool({
    connectorHints: {
      cdp: "A persistent browser over CDP — tabs and logins carry over between runs. Use sessionId: \"active\" for page commands. Return screenshots as { type: 'browser_screenshot', mediaType: 'image/png', data: screenshot.data }; the UI keeps the image while the model receives a compact summary."
    }
  });

  return {
    description: codemodeTool.description,
    inputSchema: codemodeTool.inputSchema,
    execute: async (input, executeOptions) => {
      const output = await codemodeTool.execute(input, executeOptions);
      return withBrowserReport(
        output,
        connector.takeReport(output.executionId)
      );
    },
    toModelOutput: ({ output }) =>
      browserExecuteModelOutput(output, browserReportNotes(output))
  };
}
