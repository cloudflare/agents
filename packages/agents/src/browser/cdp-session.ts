interface PendingCommand {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  method: string;
  sessionId?: string;
  startedAt: number;
}

interface DebugEntry {
  at: string;
  type: string;
  [key: string]: unknown;
}

export interface CdpSendOptions {
  timeoutMs?: number;
  sessionId?: string;
}

export interface CdpAttachOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_DEBUG_ENTRIES = 400;

/**
 * A CDP session over an open WebSocket. Manages command correlation,
 * timeouts, target sessions, and a debug event ring buffer.
 *
 * Used host-side (not in the sandbox) — the sandbox calls into this
 * via DynamicWorkerExecutor's ToolDispatcher RPC.
 */
export class CdpSession {
  #socket: WebSocket;
  #nextId = 1;
  #pending = new Map<number, PendingCommand>();
  #debugLog: DebugEntry[] = [];
  #defaultTimeoutMs: number;
  #dispose?: () => void;

  constructor(
    socket: WebSocket,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    dispose?: () => void
  ) {
    this.#socket = socket;
    this.#defaultTimeoutMs = defaultTimeoutMs;
    this.#dispose = dispose;

    socket.addEventListener("message", (event) => this.#handleMessage(event));
    socket.addEventListener("error", () => {
      this.#rejectAll(new Error("CDP socket error"));
    });
    socket.addEventListener("close", () => {
      this.#rejectAll(new Error("CDP connection closed"));
    });
  }

  send(
    method: string,
    params?: unknown,
    options: CdpSendOptions = {}
  ): Promise<unknown> {
    const id = this.#nextId++;
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    const sessionId =
      typeof options.sessionId === "string" && options.sessionId.length > 0
        ? options.sessionId
        : undefined;

    const domain = typeof method === "string" ? method.split(".")[0] : "";
    if (!sessionId && domain && !["Browser", "Target"].includes(domain)) {
      this.#recordDebug("warning", {
        id,
        method,
        reason: "target-scoped method sent without sessionId"
      });
    }

    const result = new Promise<unknown>((resolve, reject) => {
      const startedAt = performance.now();
      const timeoutId = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(`CDP command timed out after ${timeoutMs}ms: ${method}`)
        );
      }, timeoutMs);
      this.#pending.set(id, {
        resolve,
        reject,
        timeoutId,
        method,
        sessionId,
        startedAt
      });
    });

    this.#recordDebug("send", { id, method, sessionId, timeoutMs });
    this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    return result;
  }

  async attachToTarget(
    targetId: string,
    options: CdpAttachOptions = {}
  ): Promise<string> {
    if (typeof targetId !== "string" || !targetId) {
      throw new Error("attachToTarget requires a targetId");
    }

    const result = (await this.send(
      "Target.attachToTarget",
      {
        targetId,
        flatten: true
      },
      { timeoutMs: options.timeoutMs }
    )) as { sessionId?: string };

    const sessionId = result?.sessionId ?? "";
    if (!sessionId) {
      throw new Error(
        `Target.attachToTarget did not return a sessionId for target ${targetId}`
      );
    }

    this.#recordDebug("attach", { targetId, sessionId });
    return sessionId;
  }

  getDebugLog(limit = 50): DebugEntry[] {
    const normalized = Number.isFinite(limit)
      ? Math.max(1, Math.floor(limit))
      : 50;
    return this.#debugLog.slice(-normalized);
  }

  clearDebugLog(): void {
    this.#debugLog = [];
  }

  close(): void {
    this.#rejectAll(new Error("CDP session closed"));
    try {
      this.#socket.close(1000, "Done");
    } catch {
      // socket may already be closed
    }
    this.#dispose?.();
  }

  #rejectAll(error: Error): void {
    for (const [id, pending] of this.#pending.entries()) {
      clearTimeout(pending.timeoutId);
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  #handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }

    this.#recordDebug("receive", {
      id: payload.id,
      method: payload.method,
      sessionId: payload.sessionId,
      hasError: !!payload.error
    });

    if (typeof payload.id !== "number") {
      return;
    }

    const pending = this.#pending.get(payload.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutId);
    this.#pending.delete(payload.id);

    if (payload.error) {
      const err = payload.error as { code?: unknown; message?: string };
      const code = err.code ?? "unknown";
      const message = err.message ?? "CDP error";
      pending.reject(
        new Error(`CDP error ${code}: ${message} for ${pending.method}`)
      );
      return;
    }

    pending.resolve(payload.result);
  }

  #recordDebug(type: string, data: Record<string, unknown>): void {
    this.#debugLog.push({
      at: new Date().toISOString(),
      type,
      ...data
    });
    if (this.#debugLog.length > MAX_DEBUG_ENTRIES) {
      this.#debugLog.splice(0, this.#debugLog.length - MAX_DEBUG_ENTRIES);
    }
  }
}

/**
 * Connect to a browser via the Browser Rendering binding (Fetcher).
 * Establishes a CDP WebSocket through the binding's fetch interface.
 */
export async function connectBrowser(
  browser: Fetcher,
  timeoutMs?: number
): Promise<CdpSession> {
  const response = await browser.fetch(
    "https://localhost/v1/devtools/browser",
    {
      headers: { Upgrade: "websocket" }
    }
  );

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
  return new CdpSession(ws, timeoutMs, () => {
    void browser.fetch(`https://localhost/v1/devtools/browser/${sessionId}`, {
      method: "DELETE"
    });
  });
}

const LOCALHOST_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]"
]);

/**
 * Connect to a browser via a CDP base URL (e.g. http://localhost:9222).
 * Discovers the WebSocket debugger URL via /json/version,
 * rewrites localhost URLs to the base URL host, and opens the WebSocket.
 *
 * Useful for local development with `chrome --remote-debugging-port=9222`
 * or when connecting through a tunnel.
 */
export async function connectUrl(
  baseUrl: string,
  options?: { timeoutMs?: number; headers?: Record<string, string> }
): Promise<CdpSession> {
  const endpoint = new URL("/json/version", baseUrl).toString();
  const response = await fetch(endpoint, {
    headers: options?.headers
  });
  if (!response.ok) {
    throw new Error(
      `Failed to discover CDP endpoint at ${endpoint}: ${response.status}`
    );
  }

  const payload = (await response.json()) as {
    webSocketDebuggerUrl?: string;
  };
  if (!payload.webSocketDebuggerUrl) {
    throw new Error("CDP /json/version did not include webSocketDebuggerUrl");
  }

  let wsUrl = payload.webSocketDebuggerUrl;
  const parsed = new URL(wsUrl);
  if (LOCALHOST_HOSTS.has(parsed.hostname)) {
    const base = new URL(baseUrl);
    parsed.hostname = base.hostname;
    parsed.port = base.port;
    parsed.protocol = base.protocol;
  } else {
    // Workers runtime requires fetch + Upgrade header for outbound WebSockets
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  }
  const fetchUrl = parsed.toString();

  const wsResponse = await fetch(fetchUrl, {
    headers: { Upgrade: "websocket" }
  });
  const ws = wsResponse.webSocket;
  if (!ws) {
    throw new Error(
      `Failed to establish CDP WebSocket at ${fetchUrl} (status ${wsResponse.status})`
    );
  }
  ws.accept();

  return new CdpSession(ws, options?.timeoutMs);
}
