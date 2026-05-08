import { CdpSession } from "./cdp-session";

export interface BrowserTargetInfo {
  id: string;
  type?: string;
  url?: string;
  title?: string;
  description?: string;
  devtoolsFrontendUrl?: string;
  webSocketDebuggerUrl?: string;
}

export interface BrowserSessionInfo {
  sessionId: string;
  targets?: BrowserTargetInfo[];
  webSocketDebuggerUrl?: string;
}

export interface ConnectBrowserOptions {
  timeoutMs?: number;
  keepAliveMs?: number;
  includeTargets?: boolean;
}

function browserSessionEndpoint(
  sessionId?: string,
  options?: { keepAliveMs?: number; includeTargets?: boolean }
): string {
  const path = sessionId
    ? `/v1/devtools/browser/${sessionId}`
    : "/v1/devtools/browser";
  const url = new URL(`https://localhost${path}`);
  if (options?.keepAliveMs !== undefined) {
    url.searchParams.set("keep_alive", String(options.keepAliveMs));
  }
  if (options?.includeTargets) {
    url.searchParams.set("targets", "true");
  }
  return url.toString();
}

async function parseBrowserSessionInfo(
  response: Response
): Promise<BrowserSessionInfo> {
  const payload = (await response.json()) as {
    sessionId?: unknown;
    targets?: unknown;
    webSocketDebuggerUrl?: unknown;
  };
  const sessionId =
    typeof payload.sessionId === "string" ? payload.sessionId : "";
  if (!sessionId) {
    throw new Error("Browser Rendering response did not include a sessionId");
  }
  return {
    sessionId,
    targets: Array.isArray(payload.targets)
      ? (payload.targets as BrowserTargetInfo[])
      : undefined,
    webSocketDebuggerUrl:
      typeof payload.webSocketDebuggerUrl === "string"
        ? payload.webSocketDebuggerUrl
        : undefined
  };
}

export async function createBrowserSession(
  browser: Fetcher,
  options?: { keepAliveMs?: number; includeTargets?: boolean }
): Promise<BrowserSessionInfo> {
  const response = await browser.fetch(
    browserSessionEndpoint(undefined, options),
    {
      method: "POST"
    }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to create Browser Rendering session: ${response.status}`
    );
  }
  return parseBrowserSessionInfo(response);
}

export async function listBrowserTargets(
  browser: Fetcher,
  sessionId: string
): Promise<BrowserTargetInfo[]> {
  const response = await browser.fetch(
    `https://localhost/v1/devtools/browser/${sessionId}/json/list`
  );
  if (!response.ok) {
    throw new Error(
      `Failed to list Browser Rendering targets for ${sessionId}: ${response.status}`
    );
  }
  const payload = (await response.json()) as unknown;
  return Array.isArray(payload) ? (payload as BrowserTargetInfo[]) : [];
}

export async function deleteBrowserSession(
  browser: Fetcher,
  sessionId: string
): Promise<void> {
  const response = await browser.fetch(
    `https://localhost/v1/devtools/browser/${sessionId}`,
    { method: "DELETE" }
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Failed to delete Browser Rendering session ${sessionId}: ${response.status}`
    );
  }
}

/**
 * Connect to a browser via the Browser Rendering binding (Fetcher).
 * Establishes a CDP WebSocket through the binding's fetch interface.
 */
export async function connectBrowser(
  browser: Fetcher,
  options?: number | ConnectBrowserOptions
): Promise<CdpSession> {
  const normalizedOptions =
    typeof options === "number" ? { timeoutMs: options } : (options ?? {});
  const endpoint = browserSessionEndpoint(undefined, {
    keepAliveMs: normalizedOptions.keepAliveMs,
    includeTargets: normalizedOptions.includeTargets
  });
  const response = await browser.fetch(endpoint, {
    headers: { Upgrade: "websocket" }
  });

  const ws = response.webSocket;
  if (!ws) {
    throw new Error(
      "Browser Rendering binding did not return a WebSocket. " +
        "Ensure the 'browser' binding is configured in wrangler.jsonc."
    );
  }

  const sessionId = response.headers.get("cf-browser-session-id");
  if (!sessionId) {
    throw new Error(
      "Browser Rendering binding did not include a session ID when opening the CDP WebSocket"
    );
  }

  ws.accept();
  return new CdpSession(
    ws,
    normalizedOptions.timeoutMs,
    () => {
      void deleteBrowserSession(browser, sessionId);
    },
    sessionId
  );
}

export async function connectBrowserSession(
  browser: Fetcher,
  sessionId: string,
  timeoutMs?: number
): Promise<CdpSession> {
  const response = await browser.fetch(browserSessionEndpoint(sessionId), {
    headers: { Upgrade: "websocket" }
  });

  const ws = response.webSocket;
  if (!ws) {
    throw new Error(
      `Browser Rendering binding did not return a WebSocket for session ${sessionId}`
    );
  }

  ws.accept();
  return new CdpSession(ws, timeoutMs, undefined, sessionId);
}
