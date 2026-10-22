/**
 * The harness-neutral core of `browserTool`, shared by the adapters
 * in `tools/` (`agents/browser/ai-sdk`, `agents/browser/tanstack-ai`,
 * `agents/browser/pi`). Internal — not an entry point.
 */
import { DEFAULT_BROWSER_SCOPE } from "./browser";
import {
  BROWSER_FUNCTION_DOCS,
  BROWSER_RULES,
  browserFunctions
} from "./module";
import { runBrowserCode } from "./sandbox";
import {
  BrowserSession,
  type BrowserSessionReport,
  type BrowserSource
} from "./session";
import { transformBrowserResult } from "./tool-helpers";

export interface BrowserToolOptions {
  /**
   * The browser the tool drives — usually a `Browser` installed on the
   * host's Lifecycle. Tools built from the same `Browser` share it.
   */
  browser: BrowserSource;

  /**
   * Worker Loader binding the model's code runs in. Each run gets a fresh
   * Dynamic Worker with no network access.
   *
   * Requires `"worker_loaders": [{ "binding": "LOADER" }]` in wrangler.jsonc.
   */
  loader: WorkerLoader;

  /** How long one run may take, in milliseconds. Defaults to 60000 (60s). */
  timeoutMs?: number;

  /**
   * Who is driving, when several chats or users share one `Browser`: runs
   * with the same scope share an active tab, and each scope keeps its own.
   * Cookies and logins are shared by every scope. Defaults to `"shared"`,
   * one active tab for every tool that leaves it out.
   */
  scope?: string;

  /**
   * @deprecated Not needed any more: the tool no longer runs on a codemode
   * facet. Ignored.
   */
  ctx?: DurableObjectState;
}

/** The model's input to `browserTool`: JavaScript to run. */
export interface BrowserToolInput {
  code: string;
}

/** What happened to the browser during a run, added to its result. */
interface BrowserReportFields {
  /**
   * Sentences telling the model what happened to its browser: it was
   * restarted, its tab was closed by someone else, another scope is working
   * in its tab too, or the page opened new tabs.
   */
  notice?: string;
}

/**
 * The result of one `browserTool` run: the code's result, or the
 * error it threw, plus what happened to the browser. Errors are returned,
 * not thrown, so the model can read them and try again.
 */
export type BrowserToolOutput = (
  | {
      status: "completed";
      /** Identifies the run, for logs and UIs. */
      executionId: string;
      result: unknown;
      /** What the code wrote to the console. */
      logs?: string[];
    }
  | {
      status: "error";
      executionId: string;
      error: string;
      logs?: string[];
    }
) &
  BrowserReportFields;

const DEFAULT_TIMEOUT_MS = 60_000;

const RESTARTED_NOTICE =
  "The browser was restarted before this run (it expired or was closed): earlier tabs, logins, and page state are gone. Your code ran in a fresh browser — navigate again before relying on page state.";

const TAB_CLOSED_NOTICE =
  'The tab you were working in was closed (by another conversation using this browser, or a person). `sessionId: "active"` now opens a blank tab — navigate again before relying on page state.';

const TAB_SHARED_NOTICE =
  "Another conversation using this browser is also working in your tab, so its page may change between your runs. Open a tab of your own with Target.createTarget if you need one.";

/**
 * The model's input schema, as a Standard Schema with a JSON Schema view,
 * so the AI SDK and TanStack AI both accept it without zod.
 */
const inputJsonSchema = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description:
        "An async arrow function that drives the browser with `browser`"
    }
  },
  required: ["code"],
  additionalProperties: false
};

const browserToolInputSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "agents",
    types: undefined as
      | { readonly input: BrowserToolInput; readonly output: BrowserToolInput }
      | undefined,
    validate: (
      value: unknown
    ):
      | { readonly value: BrowserToolInput }
      | { readonly issues: ReadonlyArray<{ readonly message: string }> } =>
      typeof value === "object" &&
      value !== null &&
      "code" in value &&
      typeof value.code === "string"
        ? { value: { code: value.code } }
        : {
            issues: [
              { message: "Expected an object with a string code property" }
            ]
          },
    jsonSchema: {
      input: (_options: { readonly target: string }) => inputJsonSchema,
      output: (_options: { readonly target: string }) => inputJsonSchema
    }
  }
};

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

/** The report as a notice on the result, in sentences the model reads. */
function reportFields(
  report: BrowserSessionReport | undefined
): BrowserReportFields {
  if (!report) return {};
  const notices = [
    report.restarted && RESTARTED_NOTICE,
    report.tabClosed && !report.restarted && TAB_CLOSED_NOTICE,
    report.tabShared && TAB_SHARED_NOTICE,
    report.newTabs.length > 0 &&
      `New tabs opened by the page: ${JSON.stringify(report.newTabs)}`
  ].filter((notice) => typeof notice === "string");
  return notices.length > 0 ? { notice: notices.join(" ") } : {};
}

/**
 * Build the description and `execute` for one `browserTool`.
 *
 * Each run opens a session on the browser in its scope, runs the model's
 * code in a fresh Dynamic Worker with `browser` bound to that session, closes
 * the session, and adds its report to the result. Runs in one scope wait
 * for each other, since they drive one tab; runs in different scopes go in
 * parallel.
 */
export function createBrowserToolCore(
  options: BrowserToolOptions,
  adapter: {
    /** What the adapter does with screenshots, told to the model. */
    screenshotHint: string;
  }
) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rules = [
    ...BROWSER_RULES,
    "Results over about 24,000 characters are cut short.",
    `Each run times out after ${Math.round(timeoutMs / 1000)}s, so split long jobs (crawling a site, say) across runs.`,
    adapter.screenshotHint,
    "If your code doesn't parse, the line number in the error counts from wrapper code, not yours. Check regex literals and escapes."
  ]
    .map((rule) => `- ${rule}`)
    .join("\n");
  const description = [
    "Run JavaScript that drives a persistent Chrome browser over the Chrome DevTools Protocol (CDP).",
    "",
    "Write an async arrow function, `async () => { ... }`, and return a small JSON value. Use the `browser` global to reach the browser. `fetch` is blocked and there is no file system or Node.js API.",
    "",
    "## browser",
    "",
    ...BROWSER_FUNCTION_DOCS.map((doc) => `- ${doc}`),
    "",
    "## Rules",
    "",
    rules
  ].join("\n");

  const defaultScope = options.scope ?? DEFAULT_BROWSER_SCOPE;

  async function run(input: BrowserToolInput, scope: string) {
    const executionId = crypto.randomUUID();
    const session = new BrowserSession(options.browser, { scope });
    let output: BrowserToolOutput;
    try {
      const ran = await runBrowserCode({
        loader: options.loader,
        code: input.code,
        functions: browserFunctions(session),
        timeoutMs
      });
      const logs = ran.logs.length > 0 ? { logs: ran.logs } : {};
      output =
        "error" in ran
          ? { status: "error", executionId, error: ran.error, ...logs }
          : {
              status: "completed",
              executionId,
              result: transformBrowserResult(ran.result),
              ...logs,
              ...(ran.notice ? { notice: ran.notice } : {})
            };
    } catch (error) {
      output = {
        status: "error",
        executionId,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    const report = reportFields(await session.close());
    const notice = [output.notice, report.notice].filter(Boolean).join(" ");
    return { ...output, ...report, ...(notice ? { notice } : {}) };
  }

  return {
    description,
    inputSchema: browserToolInputSchema,
    /** Run `input` in `scope`, which defaults to the tool's `scope`. */
    execute: (
      input: BrowserToolInput,
      scope: string = defaultScope
    ): Promise<BrowserToolOutput> =>
      queued(options.browser, scope, () => run(input, scope))
  };
}
