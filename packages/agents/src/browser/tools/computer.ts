/**
 * A persistent browser as a host module for `@cloudflare/computer`'s
 * JavaScript backend, so code the model runs with `exec` drives it:
 *
 * ```ts
 * import { Browser, browserRun } from "agents/browser";
 * import { createBrowserModule } from "agents/browser/computer";
 *
 * new WorkerJavaScriptBackend({
 *   loader: this.env.LOADER,
 *   modules: { "ws:browser": createBrowserModule({ browser: this.browser }) }
 * });
 * ```
 *
 * ```js
 * import { send } from "ws:browser";
 * export default async function () {
 *   await send({ method: "Page.navigate", params: { url }, sessionId: "active" });
 * }
 * ```
 */
import {
  BROWSER_FUNCTIONS,
  BrowserSessionDriver,
  browserInstructions,
  browserReportNotices,
  type BrowserExecutionReport,
  type BrowserFunctionName,
  type BrowserSource
} from "../session-driver";

export type { BrowserSource } from "../session-driver";

export interface BrowserModuleOptions {
  /**
   * The browser the module drives, usually a `Browser` installed on the
   * host's Lifecycle. Modules built from the same `Browser` share it.
   */
  browser: BrowserSource;
  /**
   * Who is driving, when several conversations share one `Browser`: runs
   * with the same scope share an active tab, and each scope keeps its own.
   * Cookies and logins are shared by every scope. Defaults to the
   * browser's default scope.
   */
  scope?: string;
}

/**
 * The part of `@cloudflare/computer`'s host module call context this module
 * uses. Declared here so `agents` doesn't depend on `@cloudflare/computer`.
 */
export interface BrowserModuleCallContext {
  /** The run making the call. Every call from one run has the same id. */
  readonly executionId: string;
  /** Write a line to the run's standard error. */
  log(text: string): void;
  /** Run `fn` once when the run ends. */
  defer(fn: () => unknown): void;
}

/** One function of the module, as `@cloudflare/computer` calls it. */
export type BrowserModuleFunction = (
  args: readonly unknown[],
  context: BrowserModuleCallContext
) => Promise<unknown>;

/**
 * A host module factory: pass it as `modules["ws:browser"]` on a
 * `WorkerJavaScriptBackend`. `description` tells the model how to use it.
 */
export interface BrowserModule {
  (host: unknown): Readonly<Record<BrowserFunctionName, BrowserModuleFunction>>;
  readonly description: string;
}

const DESCRIPTION = [
  "A persistent Chrome browser over the Chrome DevTools Protocol (CDP).",
  "- `send({ method, params?, sessionId?, timeoutMs? })` sends a CDP command and returns its result without the JSON-RPC envelope: `Page.navigate` returns `{ frameId, errorText? }`, `Runtime.evaluate` returns `{ result: { value }, exceptionDetails? }`.",
  "- `attachToTarget({ targetId })` makes an open tab active and returns `{ sessionId }`.",
  '- `spec()` returns the whole protocol (about 650 KB) as `{ domains: [{ name, commands, events, types }] }`. Filter it in code, for example `spec.domains.find((d) => d.name === "Page")`.',
  "- `getDebugLog({ limit? })` returns recent protocol traffic, for when a command fails or times out. `clearDebugLog()` clears it.",
  '- To look at the page, save a screenshot and open it with the `read` tool: `const { data } = await send({ method: "Page.captureScreenshot", sessionId: "active" }); await writeFile("/workspace/page.png", Buffer.from(data, "base64"));` with `writeFile` from `node:fs/promises` and `Buffer` from `node:buffer`.',
  browserInstructions("module")
    .split("\n")
    .map((rule) => `- ${rule}`)
    .join("\n")
].join("\n");

/** The report as lines for standard error. */
function reportLines(report: BrowserExecutionReport | undefined): string[] {
  if (!report) return [];
  const lines = browserReportNotices(report);
  if (report.newTabs.length > 0) {
    lines.push(
      `New tabs opened by the page: ${JSON.stringify(report.newTabs)}`
    );
  }
  return lines;
}

/**
 * Build the `ws:browser` module for a browser. Each run gets its own CDP
 * connection, opened on its first call. When the run ends, the module saves
 * the scope's active tab, closes the connection, and writes what happened
 * to the browser (a restart, tabs the page opened) to standard error. The
 * browser itself stays open.
 */
export function createBrowserModule(
  options: BrowserModuleOptions
): BrowserModule {
  const driver = new BrowserSessionDriver(options);
  const running = new Set<string>();

  function begin(context: BrowserModuleCallContext): void {
    const { executionId } = context;
    if (running.has(executionId)) return;
    running.add(executionId);
    context.defer(async () => {
      running.delete(executionId);
      try {
        await driver.end(executionId);
      } finally {
        for (const line of reportLines(driver.takeReport(executionId))) {
          context.log(line);
        }
      }
    });
  }

  const functions = {} as Record<BrowserFunctionName, BrowserModuleFunction>;
  for (const name of Object.keys(BROWSER_FUNCTIONS) as BrowserFunctionName[]) {
    functions[name] = async (args, context) => {
      begin(context);
      return driver.call(context.executionId, name, args[0]);
    };
  }
  Object.freeze(functions);

  return Object.assign(() => functions, { description: DESCRIPTION });
}
