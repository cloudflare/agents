import type { ToolProvider } from "@cloudflare/codemode";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createBrowserSessionManager } from "./session-manager";
import type {
  BrowserSessionManager,
  BrowserSessionOptions
} from "./session-manager";

export type BrowserToolsOptions = BrowserProviderOptions & {
  /** Loader binding for sandboxed code execution */
  loader: WorkerLoader;
  /** Execution timeout in milliseconds (default: 30000) */
  timeout?: number;
};

type BrowserProviderConnectionOptions =
  | {
      /** Browser Rendering binding (Fetcher) — used in production */
      browser: Fetcher;
      cdpUrl?: never;
      cdpHeaders?: never;
      /** Optional browser session lifecycle. Defaults to one fresh session per runtime. */
      session?: BrowserSessionOptions;
    }
  | {
      /** Optional CDP base URL override (e.g. http://localhost:9222) */
      cdpUrl: string;
      /** Headers to send with CDP URL discovery requests (e.g. Access headers) */
      cdpHeaders?: Record<string, string>;
      browser?: never;
      /** cdpUrl sessions are externally managed and cannot use SDK-owned reuse. */
      session?: { mode?: "one-shot" };
    };

export type BrowserProviderOptions = BrowserProviderConnectionOptions & {
  /** CDP command timeout in milliseconds (default: 10000) */
  timeout?: number;
};

export type BrowserProvider = ToolProvider & {
  name: "cdp";
  sessionManager: BrowserSessionManager;
};

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

const MISSING_BROWSER_CONFIG =
  "Either 'browser' (Fetcher binding) or 'cdpUrl' must be provided";

const specCache = new Map<
  string,
  { spec: SearchableCdpSpec; cachedAt: number }
>();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
      try {
        await browser.fetch(
          `https://localhost/v1/devtools/browser/${sessionId}`,
          {
            method: "DELETE"
          }
        );
      } catch {
        // Cleanup failure should not mask the original result or error
      }
    }
  });
}

const CDP_BASE_TYPES = `
type CdpSendOptions = {
	timeoutMs?: number;
	sessionId?: string;
};

type CdpAttachOptions = {
	timeoutMs?: number;
};

type CdpSpec = {
	domains: Array<{
		name: string;
		description?: string;
		commands: Array<{ name: string; method: string; description?: string }>;
		events: Array<{ name: string; event: string; description?: string }>;
		types: Array<{ id: string; name: string; description?: string }>;
	}>;
};
`.trim();

const CDP_SESSION_TYPES = `
type BrowserSessionInfo = {
	sessionId: string;
	targets?: Array<{
		id: string;
		type?: string;
		url?: string;
		title?: string;
		description?: string;
		devtoolsFrontendUrl?: string;
		webSocketDebuggerUrl?: string;
	}>;
	webSocketDebuggerUrl?: string;
};
`.trim();

const CDP_BASE_METHOD_TYPES = `
declare const cdp: {
	/**
	 * Fetch and inspect the live Chrome DevTools Protocol metadata.
	 * Use this before unfamiliar CDP work to discover domains, commands,
	 * events, parameter names, and result shapes. The returned command
	 * entries include fully qualified method names such as "Page.navigate".
	 */
	spec: () => Promise<CdpSpec>;
	/**
	 * Send a Chrome DevTools Protocol command to the browser-level CDP session.
	 * This lazily creates/connects the Browser Run session on first use.
	 * Browser.* and Target.* commands usually do not need options.sessionId.
	 * Page.*, Runtime.*, DOM.*, Network.*, and other target-scoped commands must
	 * pass options.sessionId from cdp.attachToTarget(); without it, Chrome may
	 * report the command as not found on the browser session.
	 */
	send: (method: string, params?: unknown, options?: CdpSendOptions) => Promise<unknown>;
	/**
	 * Attach to a target and return the CDP session id for target-scoped commands.
	 * Use this after Target.createTarget or Target.getTargets before calling Page.*,
	 * Runtime.*, DOM.*, Network.*, or other target-scoped domains.
	 * Example: const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
	 * const sessionId = await cdp.attachToTarget(targetId);
	 * await cdp.send("Page.navigate", { url }, { sessionId });
	 */
	attachToTarget: (targetId: string, options?: CdpAttachOptions) => Promise<string>;
	/**
	 * Return recent CDP debug entries from this code block's browser connection.
	 * Use this to diagnose command timeouts, target-session mistakes, and CDP errors.
	 */
	getDebugLog: (limit?: number) => Promise<unknown[]>;
	/**
	 * Clear this code block's CDP debug log.
	 */
	clearDebugLog: () => Promise<void>;
`.trimEnd();

const CDP_SESSION_METHOD_TYPES = `
	/**
	 * Start or ensure a reusable Browser Run session and return its metadata.
	 * In dynamic mode, browser calls are one-shot until this is called. Use this
	 * only when the task needs browser tabs, cookies, localStorage, or navigation
	 * state to persist across multiple execute calls.
	 */
	startSession: () => Promise<BrowserSessionInfo>;
	/**
	 * Return metadata for the reusable Browser Run session, including active
	 * targets and page URLs. This releases the current CDP WebSocket lease before
	 * reading session metadata, but keeps the Browser Run session alive.
	 * It is safe to call this to check whether a reusable session is active.
	 * For human-in-the-loop flows such as login, MFA, CAPTCHA, or sensitive form
	 * entry, share a page target's devtoolsFrontendUrl with the user so they can control
	 * the live browser, then poll or wait for navigation before resuming.
	 * This does not create a session. It returns { status: "none" } before the
	 * first browser command, or after cdp.closeSession(). Use cdp.resetSession()
	 * if you need to create a fresh session before issuing commands.
	 */
	sessionInfo: () => Promise<BrowserSessionInfo | { status: "none" }>;
	/**
	 * Close the reusable Browser Run session and clear stored session state.
	 * Call this when the browsing task is complete or the user asks to close the
	 * browser, otherwise Browser Run may continue until its inactivity timeout.
	 */
	closeSession: () => Promise<{ status: "closed" }>;
	/**
	 * Close the current reusable Browser Run session and create a fresh one.
	 * Use this when stale tabs, cookies, storage, or page state are interfering
	 * with the task.
	 */
	resetSession: () => Promise<BrowserSessionInfo>;
`.trimEnd();

function createCdpTypes(reusableSession: boolean): string {
  return [
    CDP_BASE_TYPES,
    reusableSession ? CDP_SESSION_TYPES : undefined,
    reusableSession
      ? `${CDP_BASE_METHOD_TYPES}\n${CDP_SESSION_METHOD_TYPES}\n};`
      : `${CDP_BASE_METHOD_TYPES}\n};`
  ]
    .filter(Boolean)
    .join("\n\n");
}

let didWarnExperimental = false;

function warnExperimentalBrowserProvider(): void {
  if (didWarnExperimental) return;
  didWarnExperimental = true;
  console.warn(
    "[agents/browser] Browser code-mode provider is experimental and may change in a future release."
  );
}

async function loadCdpSpec(
  options: BrowserProviderOptions
): Promise<SearchableCdpSpec> {
  if (options.cdpUrl) {
    return fetchCdpSpecFromUrl(options.cdpUrl, options.cdpHeaders);
  }
  if (options.browser) {
    return fetchCdpSpecFromBrowser(options.browser);
  }
  throw new Error(MISSING_BROWSER_CONFIG);
}

function createCdpRuntime(
  sessionManager: BrowserSessionManager,
  reusableSession: boolean
) {
  let lease: Awaited<ReturnType<BrowserSessionManager["acquire"]>> | undefined;
  let leasePromise: ReturnType<BrowserSessionManager["acquire"]> | undefined;
  let disposed = false;

  const assertLive = () => {
    if (disposed) {
      throw new Error("Browser runtime has been disposed");
    }
  };

  const getSession = async () => {
    assertLive();
    leasePromise ??= sessionManager.acquire();
    const acquiredLease = await leasePromise;
    lease = acquiredLease;
    if (disposed) {
      lease = undefined;
      leasePromise = undefined;
      await acquiredLease.release();
      assertLive(); // throw an error after releasing lease
    }
    return acquiredLease.session;
  };

  const releaseLease = async () => {
    const currentLease =
      lease ??
      (leasePromise ? await leasePromise.catch(() => undefined) : undefined);
    lease = undefined;
    leasePromise = undefined;
    await currentLease?.release();
  };

  const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    send: async (method: unknown, params: unknown, opts: unknown) => {
      const session = await getSession();
      return session.send(
        method as string,
        params,
        opts as { timeoutMs?: number; sessionId?: string }
      );
    },
    attachToTarget: async (targetId: unknown, opts: unknown) => {
      const session = await getSession();
      return session.attachToTarget(
        targetId as string,
        opts as { timeoutMs?: number }
      );
    },
    getDebugLog: async (limit: unknown) => {
      const session = await getSession();
      return session.getDebugLog(limit as number | undefined);
    },
    clearDebugLog: async () => {
      const session = await getSession();
      return session.clearDebugLog();
    }
  };

  if (reusableSession) {
    fns.startSession = async () => {
      assertLive();
      await releaseLease();
      return sessionManager.start();
    };
    fns.sessionInfo = async () => {
      assertLive();
      await releaseLease();
      return (await sessionManager.info()) ?? { status: "none" };
    };
    fns.closeSession = async () => {
      assertLive();
      await releaseLease();
      await sessionManager.close();
      return { status: "closed" };
    };
    fns.resetSession = async () => {
      assertLive();
      await releaseLease();
      return sessionManager.reset();
    };
  }

  return {
    fns,
    dispose: async () => {
      disposed = true;
      await releaseLease();
    }
  };
}

/**
 * Create a codemode provider for browser automation via Chrome DevTools Protocol.
 *
 * Exposes a `cdp` namespace inside code mode for protocol discovery and live
 * browser commands.
 */
export function createBrowserProvider(
  options: BrowserProviderOptions
): BrowserProvider {
  warnExperimentalBrowserProvider();
  const sessionManager = createBrowserSessionManager(options);
  const sessionMode = options.session?.mode;
  const reusableSession = sessionMode === "reuse" || sessionMode === "dynamic";
  return {
    name: "cdp",
    sessionManager,
    types: createCdpTypes(reusableSession),
    tools: {
      spec: {
        description: "Search and inspect Chrome DevTools Protocol metadata",
        execute: async () => loadCdpSpec(options)
      }
    },
    createRuntime: () => createCdpRuntime(sessionManager, reusableSession)
  };
}

export function createBrowserExecutor(options: BrowserToolsOptions) {
  return new DynamicWorkerExecutor({
    loader: options.loader,
    timeout: options.timeout
  });
}
