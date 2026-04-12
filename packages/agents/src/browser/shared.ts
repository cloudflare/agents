import type { ResolvedProvider } from "@cloudflare/codemode";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { CdpSession, connectBrowser, connectUrl } from "./cdp-session";
import { truncateResponse } from "./truncate";

export interface BrowserToolsOptions {
  /** Browser Rendering binding (Fetcher) — used in production */
  browser?: Fetcher;
  /** Optional CDP base URL override (e.g. http://localhost:9222) */
  cdpUrl?: string;
  /** Headers to send with CDP URL discovery requests (e.g. Access headers) */
  cdpHeaders?: Record<string, string>;
  /** Loader binding for sandboxed code execution */
  loader: WorkerLoader;
  /** Execution timeout in milliseconds (default: 30000) */
  timeout?: number;
}

interface RawCdpCommand {
  name: string;
  description?: string;
}

interface RawCdpEvent {
  name: string;
  description?: string;
}

interface RawCdpType {
  id: string;
  description?: string;
}

/** Raw CDP protocol domain from `/json/protocol` */
interface RawCdpDomain {
  domain: string;
  description?: string;
  commands?: RawCdpCommand[];
  events?: RawCdpEvent[];
  types?: RawCdpType[];
}

interface SearchableCdpSpec {
  domains: Array<{
    name: string;
    description?: string;
    commands: Array<{ name: string; method: string; description?: string }>;
    events: Array<{ name: string; event: string; description?: string }>;
    types: Array<{ id: string; name: string; description?: string }>;
  }>;
}

const specCache = new Map<
  string,
  { spec: SearchableCdpSpec; cachedAt: number }
>();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const SEARCH_DESCRIPTION = `Search the Chrome DevTools Protocol spec using JavaScript code.

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

function normalizeCdpSpec(spec: {
  domains?: RawCdpDomain[];
}): SearchableCdpSpec {
  return {
    domains: (spec.domains ?? []).map((domain) => ({
      name: domain.domain,
      description: domain.description,
      commands: (domain.commands ?? []).map((command) => ({
        name: command.name,
        method: `${domain.domain}.${command.name}`,
        description: command.description
      })),
      events: (domain.events ?? []).map((event) => ({
        name: event.name,
        event: `${domain.domain}.${event.name}`,
        description: event.description
      })),
      types: (domain.types ?? []).map((type) => ({
        id: type.id,
        name: `${domain.domain}.${type.id}`,
        description: type.description
      }))
    }))
  };
}

function getSpecCacheKey(
  source: string,
  headers?: Record<string, string>
): string {
  const headerEntries = Object.entries(headers ?? {}).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `${source}:${JSON.stringify(headerEntries)}`;
}

async function getCachedSpec(
  key: string,
  load: () => Promise<{ domains?: RawCdpDomain[] }>
): Promise<SearchableCdpSpec> {
  const cached = specCache.get(key);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.spec;
  }

  const spec = normalizeCdpSpec(await load());
  specCache.set(key, { spec, cachedAt: Date.now() });
  return spec;
}

async function fetchCdpSpecFromUrl(
  cdpBaseUrl: string,
  headers?: Record<string, string>
): Promise<SearchableCdpSpec> {
  const endpoint = new URL("/json/protocol", cdpBaseUrl).toString();

  return getCachedSpec(getSpecCacheKey(endpoint, headers), async () => {
    const response = await fetch(endpoint, { headers });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch CDP spec from ${endpoint}: ${response.status}`
      );
    }

    return (await response.json()) as { domains?: RawCdpDomain[] };
  });
}

async function fetchCdpSpecFromBrowser(
  browser: Fetcher
): Promise<SearchableCdpSpec> {
  return getCachedSpec("browser-binding", async () => {
    const createResponse = await browser.fetch(
      "https://localhost/v1/devtools/browser",
      {
        method: "POST"
      }
    );

    if (!createResponse.ok) {
      throw new Error(
        "Failed to create Browser Rendering session for protocol fetch: " +
          `${createResponse.status}`
      );
    }

    const payload = (await createResponse.json()) as { sessionId?: string };
    const sessionId = payload.sessionId;
    if (!sessionId) {
      throw new Error(
        "Browser Rendering session response did not include a sessionId"
      );
    }

    try {
      const response = await browser.fetch(
        `https://localhost/v1/devtools/browser/${sessionId}/json/protocol`
      );

      if (!response.ok) {
        throw new Error(
          "Failed to fetch CDP spec from Browser Rendering: " +
            `${response.status}`
        );
      }

      return (await response.json()) as { domains?: RawCdpDomain[] };
    } finally {
      await browser.fetch(
        `https://localhost/v1/devtools/browser/${sessionId}`,
        {
          method: "DELETE"
        }
      );
    }
  });
}

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

For page-scoped commands such as Page.*, Runtime.*, and DOM.*, first create or select a target, call cdp.attachToTarget(targetId), and pass the returned sessionId in command options.

Example:
async () => {
  return await cdp.send("Browser.getVersion");
}

Page example:
async () => {
  const { targetId } = await cdp.send("Target.createTarget", {
    url: "about:blank"
  });
  const sessionId = await cdp.attachToTarget(targetId);
  await cdp.send("Page.enable", {}, { sessionId });
  await cdp.send(
    "Page.navigate",
    { url: "https://example.com" },
    { sessionId }
  );
  const { result } = await cdp.send(
    "Runtime.evaluate",
    { expression: "document.title" },
    { sessionId }
  );
  return result.value;
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

  async function search(code: string): Promise<ToolResult> {
    try {
      let specSource: SearchableCdpSpec;

      if (options.cdpUrl) {
        specSource = await fetchCdpSpecFromUrl(
          options.cdpUrl,
          options.cdpHeaders
        );
      } else if (options.browser) {
        specSource = await fetchCdpSpecFromBrowser(options.browser);
      } else {
        return {
          text: "Either 'browser' (Fetcher binding) or 'cdpUrl' must be provided",
          isError: true
        };
      }

      const providers: ResolvedProvider[] = [
        {
          name: "spec",
          fns: { get: async () => specSource }
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
