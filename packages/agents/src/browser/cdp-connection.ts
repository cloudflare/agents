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

/**
 * A CDP event: a message the browser sent on its own, with a `method` and
 * no `id`.
 */
export interface CdpEvent {
  /** The event's name, e.g. `"Page.frameNavigated"`. */
  method: string;
  /** The event's parameters; `{}` when the browser sent none. */
  params: Record<string, unknown>;
  /**
   * The CDP session (from `Target.attachToTarget` with `flatten: true`) the
   * event came from. Absent for browser-level events.
   */
  sessionId?: string;
}

/** Handles one {@link CdpEvent}. Runs synchronously; see {@link CdpConnection.on}. */
export type CdpEventHandler = (event: CdpEvent) => void;

/** Which CDP session's events a listener hears. */
export interface CdpEventFilter {
  /**
   * Omit to hear the event from every session and from the browser itself.
   * Pass a session id to hear only that session's, or `null` to hear only
   * browser-level events (the ones sent without a `sessionId`).
   */
  sessionId?: string | null;
}

/** {@link CdpConnection.waitFor}'s options. */
export interface CdpWaitForOptions extends CdpEventFilter {
  /** Wait for the first matching event this returns `true` for. */
  predicate?: (event: CdpEvent) => boolean;
  /** How long to wait. Defaults to the connection's command timeout. */
  timeoutMs?: number;
  /** Stop waiting when it aborts, rejecting with its reason. */
  signal?: AbortSignal;
}

interface CdpListener {
  handler: CdpEventHandler;
  sessionId: string | null | undefined;
  /** Cleared on unsubscribe, so a delivery already under way skips it. */
  active: boolean;
}

/** Construction options for {@link CdpConnection}. */
export interface CdpConnectionOptions {
  /** Default per-command timeout. Defaults to 10 seconds. */
  timeoutMs?: number;
  /**
   * Invoked exactly once when the session reaches a terminal state — an
   * explicit `close()`, peer closure, or a socket error.
   */
  onClose?: () => void;
  /** Browser Run session id, when connected to a session-scoped browser. */
  sessionId?: string;
  /** Invoked on every CDP command sent — an activity signal for idle tracking. */
  onActivity?: () => void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** JSON-RPC's "method not found" code, which Chrome also uses for CDP. */
export const CDP_METHOD_NOT_FOUND = -32601;

/** The browser answered a command with a JSON-RPC error. */
export class CdpProtocolError extends Error {
  override readonly name = "CdpProtocolError";
  /** JSON-RPC error code, e.g. {@link CDP_METHOD_NOT_FOUND}. */
  readonly code: number | undefined;
  /** The CDP method that failed. */
  readonly method: string;

  constructor(method: string, code: number | undefined, message: string) {
    super(`CDP error ${code ?? "unknown"}: ${message} for ${method}`);
    this.code = code;
    this.method = method;
  }
}
const MAX_DEBUG_ENTRIES = 400;

/**
 * One Chrome DevTools Protocol connection over an open WebSocket. Manages
 * command correlation, timeouts, per-tab CDP sessions, and a debug event
 * ring buffer.
 *
 * Used host-side (not in the sandbox) — the sandbox calls into this
 * via DynamicWorkerExecutor's ToolDispatcher RPC.
 */
export class CdpConnection {
  #socket: WebSocket;
  #nextId = 1;
  #pending = new Map<number, PendingCommand>();
  #listeners = new Map<string, CdpListener[]>();
  /** Rejects every pending {@link waitFor} when the connection ends. */
  #endWaits = new Set<(error: Error) => void>();
  /** Set once the connection has ended: closed, disconnected, or errored. */
  #ended = false;
  #debugLog: DebugEntry[] = [];
  #defaultTimeoutMs: number;
  #dispose?: () => void;
  #disposed = false;
  #onActivity?: () => void;
  readonly sessionId?: string;

  constructor(socket: WebSocket, options?: CdpConnectionOptions);
  /**
   * @deprecated Pass a {@link CdpConnectionOptions} object instead —
   * `new CdpConnection(socket, { timeoutMs, onClose, sessionId })`. The
   * positional form will be removed.
   */
  constructor(
    socket: WebSocket,
    timeoutMs?: number,
    onClose?: () => void,
    sessionId?: string
  );
  constructor(
    socket: WebSocket,
    optionsOrTimeoutMs?: CdpConnectionOptions | number,
    onClose?: () => void,
    sessionId?: string
  ) {
    const options: CdpConnectionOptions =
      typeof optionsOrTimeoutMs === "object"
        ? optionsOrTimeoutMs
        : { timeoutMs: optionsOrTimeoutMs, onClose, sessionId };
    this.#socket = socket;
    this.#defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#dispose = options.onClose;
    this.sessionId = options.sessionId;
    this.#onActivity = options.onActivity;

    socket.addEventListener("message", (event) => this.#handleMessage(event));
    socket.addEventListener("error", () => {
      this.#rejectAll(new Error("CDP socket error"));
      this.#end(new Error("CDP socket error"));
      this.#runDispose();
    });
    socket.addEventListener("close", () => {
      this.#rejectAll(new Error("CDP connection closed"));
      this.#end(new Error("CDP connection closed"));
      this.#runDispose();
    });
  }

  /**
   * Listen for a CDP event, e.g. `"Page.frameNavigated"`, and return a
   * function that stops listening. The browser sends an event only once its
   * domain is enabled in that session (`Page.enable`, `Network.enable`).
   *
   * Without `filter.sessionId` the handler hears the event from every CDP
   * session on this connection and from the browser itself. Pass a session
   * id to hear one session's, or `sessionId: null` for browser-level events
   * only. Browser Run, for example, sends `Cloudflare.handoffComplete` once
   * at browser level and once more in each attached session, so a listener
   * that wants it once passes `sessionId: null`.
   *
   * Handlers run synchronously, in the order they were added, as each event
   * arrives: an event is delivered before the next message is handled, so
   * code awaiting a command's reply has already seen the events sent before
   * it. A handler that throws is logged and doesn't stop the others. One
   * removed during a delivery isn't called for that event, and one added
   * during it is first called for the next.
   *
   * @experimental The API surface may change before stabilizing.
   */
  on(
    method: string,
    handler: CdpEventHandler,
    filter: CdpEventFilter = {}
  ): () => void {
    const listener: CdpListener = {
      handler,
      sessionId: filter.sessionId,
      active: true
    };
    const listeners = this.#listeners.get(method) ?? [];
    listeners.push(listener);
    this.#listeners.set(method, listeners);
    return () => {
      if (!listener.active) return;
      listener.active = false;
      const current = this.#listeners.get(method);
      if (!current) return;
      const remaining = current.filter((entry) => entry !== listener);
      if (remaining.length > 0) this.#listeners.set(method, remaining);
      else this.#listeners.delete(method);
    };
  }

  /**
   * Resolve with the next `method` event that matches `options`, heard as
   * {@link on} hears it. It starts listening when called, so call it before
   * sending the command that causes the event, and await it after:
   *
   * ```ts
   * const loaded = cdp.waitFor("Page.loadEventFired", { sessionId });
   * await cdp.send("Page.navigate", { url }, { sessionId });
   * await loaded;
   * ```
   *
   * Rejects when `timeoutMs` passes (by default the connection's command
   * timeout), when `signal` aborts, with its reason, when the connection
   * ends, and when `predicate` throws.
   *
   * @experimental The API surface may change before stabilizing.
   */
  waitFor(method: string, options: CdpWaitForOptions = {}): Promise<CdpEvent> {
    const { predicate, signal } = options;
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    if (this.#ended) {
      return Promise.reject(
        new Error(`CDP connection closed while waiting for ${method}`)
      );
    }
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<CdpEvent>((resolve, reject) => {
      const settle = (outcome: () => void) => {
        unsubscribe();
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        this.#endWaits.delete(onEnd);
        outcome();
      };
      const onAbort = () => settle(() => reject(signal?.reason));
      const onEnd = (error: Error) =>
        settle(() =>
          reject(new Error(`${error.message} while waiting for ${method}`))
        );
      const timeoutId = setTimeout(
        () =>
          settle(() =>
            reject(
              new Error(
                `Timed out after ${timeoutMs}ms waiting for CDP event ${method}`
              )
            )
          ),
        timeoutMs
      );
      const unsubscribe = this.on(
        method,
        (event) => {
          let matched: boolean;
          try {
            matched = predicate ? predicate(event) : true;
          } catch (error) {
            settle(() => reject(error));
            return;
          }
          if (matched) settle(() => resolve(event));
        },
        { sessionId: options.sessionId }
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#endWaits.add(onEnd);
    });
  }

  send(
    method: string,
    params?: unknown,
    options: CdpSendOptions = {}
  ): Promise<unknown> {
    this.#onActivity?.();
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
    try {
      this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    } catch (error) {
      // A closed socket throws on send: fail this command now rather than
      // leave it pending until it times out.
      const pending = this.#pending.get(id);
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.#pending.delete(id);
        pending.reject(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
    return result;
  }

  async attachToTarget(
    targetId: string,
    options: CdpAttachOptions = {}
  ): Promise<string> {
    if (typeof targetId !== "string" || !targetId) {
      throw new Error(
        "attachToTarget requires a targetId — list open tabs with " +
          "send('Target.getTargets') or create one with " +
          "send('Target.createTarget', { url })"
      );
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

  disconnect(): void {
    this.#rejectAll(new Error("CDP session disconnected"));
    this.#end(new Error("CDP session disconnected"));
    try {
      this.#socket.close(1000, "Done");
    } catch {
      // socket may already be closed
    }
  }

  close(): void {
    this.disconnect();
    this.#runDispose();
  }

  /**
   * Run the dispose callback exactly once, on the first terminal event —
   * an explicit {@link close}, peer closure, or a socket error.
   */
  #runDispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#dispose?.();
  }

  /** Stop delivering events, and reject every pending {@link waitFor}. */
  #end(error: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#listeners.clear();
    for (const endWait of [...this.#endWaits]) endWait(error);
  }

  /** Run the event's listeners, in order, each isolated from the others. */
  #deliver(event: CdpEvent): void {
    const listeners = this.#listeners.get(event.method);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      if (!listener.active) continue;
      const wanted = listener.sessionId;
      if (wanted !== undefined && wanted !== (event.sessionId ?? null)) {
        continue;
      }
      try {
        listener.handler(event);
      } catch (error) {
        console.error(
          `[agents/browser] A CDP event handler for ${event.method} threw`,
          error
        );
      }
    }
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
      if (typeof payload.method === "string" && !this.#ended) {
        this.#deliver({
          method: payload.method,
          params: isRecord(payload.params) ? payload.params : {},
          ...(typeof payload.sessionId === "string"
            ? { sessionId: payload.sessionId }
            : {})
        });
      }
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
      pending.reject(
        new CdpProtocolError(
          pending.method,
          typeof err.code === "number" ? err.code : undefined,
          err.message ?? "CDP error"
        )
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
): Promise<CdpConnection> {
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
    headers: { ...options?.headers, Upgrade: "websocket" }
  });
  const ws = wsResponse.webSocket;
  if (!ws) {
    throw new Error(
      `Failed to establish CDP WebSocket at ${fetchUrl} (status ${wsResponse.status})`
    );
  }
  ws.accept();

  return new CdpConnection(ws, { timeoutMs: options?.timeoutMs });
}

/** @deprecated Renamed to {@link CdpConnection}. */
export const CdpSession = CdpConnection;
/** @deprecated Renamed to {@link CdpConnection}. */
export type CdpSession = CdpConnection;
