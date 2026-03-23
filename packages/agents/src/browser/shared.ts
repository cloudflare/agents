import type { ResolvedProvider } from "@cloudflare/codemode";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { CdpSession, connectBrowser, connectUrl } from "./cdp-session";
import { truncateResponse } from "./truncate";
import spec from "./data/cdp/spec.json";
import summary from "./data/cdp/summary.json";
import { CDP_DOMAINS } from "./data/cdp/domains";

export interface BrowserToolsOptions {
  /** Browser Rendering binding (Fetcher) — used in production */
  browser?: Fetcher;
  /** CDP base URL (e.g. http://localhost:9222) — used for local dev */
  cdpUrl?: string;
  /** Headers to send with CDP URL discovery requests (e.g. Access headers) */
  cdpHeaders?: Record<string, string>;
  loader: WorkerLoader;
  timeout?: number;
}

export const SEARCH_DESCRIPTION = `Search the Chrome DevTools Protocol spec using JavaScript code.

Source totals: ${summary.totals.domains} domains, ${summary.totals.commands} commands, ${summary.totals.events} events, ${summary.totals.types} types.
Top domains: ${CDP_DOMAINS.slice(0, 20).join(", ")}...

Available in your code:

declare const spec: {
  get(): Promise<{
    domains: Array<{
      name: string;
      description?: string;
      commands: Array<{ name: string; method: string; description?: string }>;
      events: Array<{ name: string; event: string; description?: string }>;
      types: Array<{ id: string; name: string; description?: string }>;
    }>;
  }>;
};

Write an async arrow function in JavaScript. Do NOT use TypeScript syntax.

Example:
async () => {
  const s = await spec.get();
  return s.domains
    .find(d => d.name === "Network")
    .commands.filter(c => c.description?.toLowerCase().includes("intercept"))
    .map(c => ({ method: c.method, description: c.description }));
}`;

export const EXECUTE_DESCRIPTION = `Execute CDP commands against a live browser session using JavaScript code.

Available in your code:

declare const cdp: {
  send(method: string, params?: unknown, options?: {
    timeoutMs?: number;
    sessionId?: string;
  }): Promise<unknown>;
  attachToTarget(targetId: string, options?: {
    timeoutMs?: number;
  }): Promise<string>;
  getDebugLog(limit?: number): Promise<unknown[]>;
  clearDebugLog(): Promise<void>;
};

Write an async arrow function in JavaScript. Do NOT use TypeScript syntax.

Example:
async () => {
  return await cdp.send("Browser.getVersion");
}`;

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

let didWarnExperimental = false;

export function createBrowserToolHandlers(options: BrowserToolsOptions) {
  if (!didWarnExperimental) {
    didWarnExperimental = true;
    console.warn(
      "[agents/browser] Browser tools are experimental and may change in a future release."
    );
  }
  const executor = new DynamicWorkerExecutor({
    loader: options.loader,
    timeout: options.timeout
  });
  const specData = spec;

  async function search(code: string): Promise<ToolResult> {
    try {
      const providers: ResolvedProvider[] = [
        {
          name: "spec",
          fns: { get: async () => specData }
        }
      ];
      const result = await executor.execute(code, providers);
      if (result.error) {
        return { text: result.error, isError: true };
      }
      return { text: truncateResponse(result.result) };
    } catch (error) {
      return { text: formatError(error), isError: true };
    }
  }

  async function execute(code: string): Promise<ToolResult> {
    let session: CdpSession | undefined;
    try {
      if (options.cdpUrl) {
        session = await connectUrl(options.cdpUrl, {
          timeoutMs: options.timeout,
          headers: options.cdpHeaders
        });
      } else if (options.browser) {
        session = await connectBrowser(options.browser, options.timeout);
      } else {
        return {
          text: "Either 'browser' (Fetcher binding) or 'cdpUrl' must be provided",
          isError: true
        };
      }

      const providers: ResolvedProvider[] = [
        {
          name: "cdp",
          fns: {
            send: async (method: unknown, params: unknown, opts: unknown) =>
              session!.send(
                method as string,
                params,
                opts as { timeoutMs?: number; sessionId?: string }
              ),
            attachToTarget: async (targetId: unknown, opts: unknown) =>
              session!.attachToTarget(
                targetId as string,
                opts as { timeoutMs?: number }
              ),
            getDebugLog: async (limit: unknown) =>
              session!.getDebugLog(limit as number | undefined),
            clearDebugLog: async () => session!.clearDebugLog()
          },
          positionalArgs: true
        }
      ];

      const result = await executor.execute(code, providers);
      if (result.error) {
        return { text: result.error, isError: true };
      }
      return { text: truncateResponse(result.result) };
    } catch (error) {
      return { text: formatError(error), isError: true };
    } finally {
      session?.close();
    }
  }

  return { search, execute };
}
