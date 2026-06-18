/**
 * WorkerTransport
 *
 * Thin Cloudflare-Workers wrapper around the official MCP SDK
 * `WebStandardStreamableHTTPServerTransport`. The wrapper layers a couple of
 * Workers-specific concerns on top of the SDK transport without forking it:
 *
 *  1. **CORS** — preflight handling and response-header injection,
 *     configurable via `corsOptions`.
 *  2. **Persistent transport state** — when a `storage` adapter
 *     (`MCPStorageApi`) is supplied, the wrapper persists
 *     `{sessionId, initialized, initializeParams}` so that an MCP session can
 *     survive DO hibernation / eviction. On the first request after a cold
 *     start, the saved initialize params are replayed through the `Server`
 *     so client capabilities are re-established.
 *  3. **SSE keepalive** — SSE responses are wrapped in a TransformStream that
 *     injects a `: keepalive\n\n` comment frame every 25s so the Cloudflare
 *     edge ~5min idle-stream watchdog doesn't kill long-running tool calls.
 *     Disabled on the standalone GET stream when an `eventStore` is
 *     configured — clients recover idle drops via `Last-Event-ID` instead.
 *     POST response streams always keepalive (no resumption path during a
 *     mid-flight tool call). See cloudflare/agents#1583.
 *
 * Everything else (session validation, SSE streaming, protocol-version
 * negotiation, event-store resumability, etc.) is delegated to the SDK
 * transport.
 */

import {
  WebStandardStreamableHTTPServerTransport,
  type WebStandardStreamableHTTPServerTransportOptions
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  isInitializeRequest,
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  type InitializeRequestParams,
  type JSONRPCMessage,
  type RequestId
} from "@modelcontextprotocol/sdk/types.js";
import type { CORSOptions } from "./types";
import { KEEPALIVE_FRAME, KEEPALIVE_INTERVAL_MS } from "./sse-keepalive";

/** Sentinel id used when replaying the persisted initialize request. */
const RESTORE_REQUEST_ID = "__worker_transport_restore__";

/**
 * Pluggable storage adapter for persisting `WorkerTransport` state across
 * Durable Object hibernation / restart cycles.
 *
 * A typical implementation reads/writes a single key on `this.ctx.storage`
 * inside a Durable Object or Agent.
 */
export interface MCPStorageApi {
  get(): Promise<TransportState | undefined> | TransportState | undefined;
  set(state: TransportState): Promise<void> | void;
}

/** Shape of the persisted transport state. */
export interface TransportState {
  sessionId?: string;
  initialized: boolean;
  initializeParams?: InitializeRequestParams;
}

const DEFAULT_CORS_OPTIONS: Required<
  Pick<
    CORSOptions,
    "origin" | "headers" | "methods" | "exposeHeaders" | "maxAge"
  >
> = {
  origin: "*",
  headers:
    "Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version",
  methods: "GET, POST, DELETE, OPTIONS",
  exposeHeaders: "mcp-session-id",
  maxAge: 86400
};

export interface WorkerTransportOptions extends WebStandardStreamableHTTPServerTransportOptions {
  /**
   * CORS options applied to every response and to OPTIONS preflight.
   * Defaults: `origin: *`, expose `mcp-session-id`, allow the standard MCP
   * methods/headers, max-age 86400.
   */
  corsOptions?: CORSOptions;
  /**
   * Optional storage adapter for persisting transport state across DO
   * hibernation / restart. Use this to keep an MCP session alive across
   * Durable Object wake-ups.
   */
  storage?: MCPStorageApi;
}

export class WorkerTransport extends WebStandardStreamableHTTPServerTransport {
  private readonly _corsOptions?: CORSOptions;
  private readonly _storage?: MCPStorageApi;
  private _stateRestored = false;
  private _capturedInitializeParams?: InitializeRequestParams;
  private _userOnSessionInitialized?: (
    sessionId: string
  ) => void | Promise<void>;
  private _bridgeInstalled = false;
  /**
   * Tracks keepalive interval cleanups so we can fire them eagerly when the
   * SDK closes the underlying SSE stream via `closeSSEStream(requestId)` or
   * `closeStandaloneSSEStream()`. Keyed by the JSON-RPC request id that
   * triggered the stream, or the sentinel for the standalone GET stream.
   */
  private readonly _keepaliveCleanups = new Map<
    RequestId | "_standalone",
    () => void
  >();
  /**
   * Most recent JSON-RPC request id seen on an incoming POST. Used to key
   * keepalive cleanups when the response is an SSE stream tied to that
   * request (so `closeSSEStream(id)` can find and clear the interval).
   */
  private _pendingRequestId?: RequestId;
  /**
   * Request ids whose SSE stream was deliberately torn down via
   * `closeSSEStream`. The SDK's `send()` throws "No connection established"
   * when a request id has no stream — a race that surfaces whenever the
   * server's tool handler resolves *after* the caller closed the stream
   * (e.g. polling-style early-close, or test fixtures closing mid-flight).
   * We swallow `send()` for these ids so the rejection doesn't bubble out
   * of the protocol layer as an unhandled rejection. Mirrors the
   * silent-noop behaviour of the pre-refactor `WorkerTransport`.
   */
  private readonly _closedRequestIds = new Set<RequestId>();

  constructor(options: WorkerTransportOptions = {}) {
    const { corsOptions, storage, onsessioninitialized, ...sdkOptions } =
      options;

    // `storage` is intentionally orthogonal to statefulness: stateful-vs-
    // stateless behaviour is driven solely by the SDK's `sessionIdGenerator`.
    // `storage` only persists whatever session state exists across DO
    // hibernation, so it's used alongside a `sessionIdGenerator`.
    //
    // We wrap onsessioninitialized so we can persist state to storage as soon
    // as the SDK transport assigns a session ID. The bridge gets installed
    // lazily on the first request so `this` is fully constructed when it fires.
    super({
      ...sdkOptions,
      onsessioninitialized: undefined
    });

    this._corsOptions = corsOptions;
    this._storage = storage;
    this._userOnSessionInitialized = onsessioninitialized;
  }

  /**
   * Backwards-compatible alias for the SDK's internal `_started` flag.
   * Several callers and tests check `transport.started` directly.
   */
  get started(): boolean {
    return (this as unknown as { _started: boolean })._started;
  }

  /**
   * Top-level request entry point. Handles CORS preflight, restores any
   * persisted state on first invocation, then delegates to the SDK transport
   * and finally appends CORS headers + keepalive to whatever response comes
   * back.
   */
  override async handleRequest(
    request: Request,
    options?: { parsedBody?: unknown; authInfo?: AuthInfo }
  ): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: this.getCorsHeaders({ forPreflight: true })
      });
    }

    await this.restoreState();
    this.installOnSessionInitializedBridge();

    // Capture the initialize params before delegating, so we can persist
    // them alongside the session id that the SDK assigns inside
    // handleRequest. Also captures the JSON-RPC request id of any POSTed
    // request so we can key the keepalive cleanup to it.
    await this.captureInitializeParams(request, options);
    const requestIdForKeepalive =
      request.method === "GET" ? "_standalone" : this._pendingRequestId;

    const response = await super.handleRequest(request, options);

    // State is persisted by the `onsessioninitialized` bridge, which the SDK
    // fires (and awaits) during `super.handleRequest` on the initialize path —
    // the only point session state actually changes. We deliberately do *not*
    // snapshot again here: that would write to storage on every request
    // (notifications, tool calls, GET, DELETE) where nothing changed, matching
    // neither the pre-refactor behaviour (one write at init) nor the intent of
    // the storage adapter.

    return this.withCorsHeaders(
      this.withKeepalive(
        this.normalizeAllowHeader(response),
        requestIdForKeepalive
      )
    );
  }

  /**
   * The SDK's 405 responses advertise `Allow: GET, POST, DELETE` because
   * OPTIONS is handled outside the SDK. Since our wrapper *does* handle
   * OPTIONS, advertise it in `Allow` so clients can probe accurately.
   */
  private normalizeAllowHeader(response: Response): Response {
    if (response.status !== 405) return response;
    const allow = response.headers.get("Allow");
    if (!allow || allow.includes("OPTIONS")) return response;
    const headers = new Headers(response.headers);
    headers.set("Allow", `${allow}, OPTIONS`);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  override closeSSEStream(requestId: RequestId): void {
    this._keepaliveCleanups.get(requestId)?.();
    this._keepaliveCleanups.delete(requestId);
    this._closedRequestIds.add(requestId);
    super.closeSSEStream(requestId);
  }

  override closeStandaloneSSEStream(): void {
    this._keepaliveCleanups.get("_standalone")?.();
    this._keepaliveCleanups.delete("_standalone");
    super.closeStandaloneSSEStream();
  }

  override async close(): Promise<void> {
    for (const cleanup of Array.from(this._keepaliveCleanups.values())) {
      cleanup();
    }
    this._keepaliveCleanups.clear();
    this._closedRequestIds.clear();
    await super.close();
  }

  /**
   * Swallow two classes of message that would otherwise surface as
   * unhandled rejections from the SDK transport's `send()`:
   *
   *   1. Replayed initialize responses (the `RESTORE_REQUEST_ID` sentinel)
   *      — we synthesise these in `restoreState()` to rebuild server
   *      capabilities; there's no real client waiting for the response.
   *   2. Sends for a request id whose SSE stream has been deliberately
   *      closed via `closeSSEStream`. The protocol layer's tool-handler
   *      promise may settle after the close, and the SDK's `send()` throws
   *      "No connection established" — a race the pre-refactor transport
   *      silently swallowed.
   *
   * Everything else is delegated. We use `await super.send(...)` rather
   * than `return super.send(...)` so any rejection is observed inside this
   * async frame; without the await, the test runner's
   * unhandled-rejection tracker can fire before the caller's own `await`
   * observes it.
   */
  override async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions
  ): Promise<void> {
    let requestId: RequestId | undefined = options?.relatedRequestId;
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      requestId = message.id;
    }
    if (requestId === RESTORE_REQUEST_ID) {
      return;
    }
    if (requestId !== undefined && this._closedRequestIds.has(requestId)) {
      return;
    }
    await super.send(message, options);
  }

  // ── SSE keepalive ──────────────────────────────────────────────────────

  /**
   * If the response is an SSE stream, tee the body through a TransformStream
   * that injects a `: keepalive\n\n` comment frame every 25s. The interval
   * is cleared when the wrapped stream closes — which happens both when the
   * SDK ends the underlying stream naturally and when `closeSSEStream` is
   * called.
   *
   * Keepalive policy:
   *   - POST response streams (`key` is a request id): always keepalive.
   *     In-progress tool calls have no recovery path — if the stream drops
   *     mid-execution the result is lost — so we keep it under the
   *     Cloudflare edge ~5min idle watchdog.
   *   - Standalone GET stream (`key === "_standalone"`): keepalive only
   *     when no `eventStore` is configured. When resumability is enabled,
   *     clients reconnect with `Last-Event-ID` after an idle drop, so we
   *     skip the keepalive and let the DO hibernate.
   *
   * Uses the shared `sse-keepalive` constants so both this wrapper and
   * `McpAgent.serve()` write identical frames at the same cadence.
   * See cloudflare/agents#1583.
   */
  private withKeepalive(
    response: Response,
    key: RequestId | "_standalone" | undefined
  ): Response {
    const contentType = response.headers.get("Content-Type") ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      return response;
    }

    // Skip keepalive on the standalone GET stream when an event store is
    // configured — the recovery path is Last-Event-ID reconnects, not
    // bytes-on-the-wire.
    if (key === "_standalone" && this.eventStoreConfigured()) {
      return response;
    }

    const encoder = new TextEncoder();
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let controllerRef: TransformStreamDefaultController<Uint8Array> | undefined;

    const clear = () => {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
      if (key !== undefined) this._keepaliveCleanups.delete(key);
    };

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      start: (controller) => {
        controllerRef = controller;
        intervalId = setInterval(() => {
          try {
            controllerRef?.enqueue(encoder.encode(KEEPALIVE_FRAME));
          } catch {
            clear();
          }
        }, KEEPALIVE_INTERVAL_MS);
        if (key !== undefined) this._keepaliveCleanups.set(key, clear);
      },
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
      flush() {
        clear();
      },
      cancel() {
        clear();
      }
    });

    const piped = response.body.pipeThrough(transform);
    return new Response(piped, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  /**
   * Does the SDK transport have an `eventStore`? Reaches into the SDK's
   * private field because the option isn't surfaced on the public API —
   * we only need a yes/no for keepalive policy.
   */
  private eventStoreConfigured(): boolean {
    return (
      (this as unknown as { _eventStore?: unknown })._eventStore !== undefined
    );
  }

  // ── CORS ───────────────────────────────────────────────────────────────

  private getCorsHeaders({
    forPreflight
  }: { forPreflight?: boolean } = {}): Record<string, string> {
    const merged = { ...DEFAULT_CORS_OPTIONS, ...this._corsOptions };
    if (forPreflight) {
      return {
        "Access-Control-Allow-Origin": merged.origin,
        "Access-Control-Allow-Headers": merged.headers,
        "Access-Control-Allow-Methods": merged.methods,
        "Access-Control-Max-Age": String(merged.maxAge)
      };
    }
    return {
      "Access-Control-Allow-Origin": merged.origin,
      "Access-Control-Expose-Headers": merged.exposeHeaders
    };
  }

  private withCorsHeaders(response: Response): Response {
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(this.getCorsHeaders())) {
      headers.set(k, v);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  // ── State persistence ──────────────────────────────────────────────────

  private installOnSessionInitializedBridge(): void {
    if (this._bridgeInstalled) return;
    const sdk = this as unknown as {
      _onsessioninitialized?: (id: string) => void | Promise<void>;
    };
    sdk._onsessioninitialized = async (sessionId: string): Promise<void> => {
      if (this._userOnSessionInitialized) {
        await Promise.resolve(this._userOnSessionInitialized(sessionId));
      }
      await this.saveState();
    };
    this._bridgeInstalled = true;
  }

  private async captureInitializeParams(
    request: Request,
    handleOptions?: { parsedBody?: unknown }
  ): Promise<void> {
    this._pendingRequestId = undefined;
    if (request.method !== "POST") return;
    try {
      const parsed =
        handleOptions?.parsedBody ?? (await request.clone().json());
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      const init = messages.find(
        (m): m is JSONRPCMessage =>
          typeof m === "object" && m !== null && isInitializeRequest(m)
      );
      if (init && isInitializeRequest(init)) {
        this._capturedInitializeParams = {
          capabilities: init.params.capabilities,
          clientInfo: init.params.clientInfo,
          protocolVersion: init.params.protocolVersion
        };
      }
      // Record the first JSON-RPC request id so we can key keepalive cleanup
      // to it. Batch requests share a single SSE stream in the SDK, so we
      // pick the first request id we see. Eager cleanup via `closeSSEStream`
      // only matches that first id; closing any other id in the batch tears
      // down the same shared stream, and the keepalive interval is cleared by
      // the TransformStream's flush/cancel when that stream actually closes.
      const firstRequest = messages.find(
        (m): m is JSONRPCMessage & { id: RequestId } =>
          typeof m === "object" && m !== null && "id" in m && "method" in m
      );
      if (firstRequest) {
        this._pendingRequestId = firstRequest.id;
      }
    } catch {
      // Body wasn't JSON or already consumed — the SDK transport will
      // surface a proper error response.
    }
  }

  private async restoreState(): Promise<void> {
    if (!this._storage || this._stateRestored) return;
    // Set the guard up-front so a re-entrant call (a second request reaching
    // this `await` before the first resolves) doesn't restore twice. If the
    // storage read throws we reset it so a transient failure can be retried
    // on the next request rather than leaving the session permanently
    // un-restored for this DO instance's lifetime.
    this._stateRestored = true;

    let state: TransportState | undefined;
    try {
      state = await Promise.resolve(this._storage.get());
    } catch (error) {
      this._stateRestored = false;
      throw error;
    }
    if (!state) return;

    // Restore SDK private state. We intentionally reach in here — the SDK
    // doesn't expose hooks for this, and the alternative (a fresh initialize
    // round-trip per cold start) would defeat the point of session
    // persistence.
    const sdk = this as unknown as {
      sessionId?: string;
      _initialized: boolean;
    };
    sdk.sessionId = state.sessionId;
    sdk._initialized = state.initialized;
    this._capturedInitializeParams = state.initializeParams;

    if (state.initializeParams && this.onmessage) {
      // Replay through the Server so `_clientCapabilities` etc. are
      // restored. `send()` filters out the resulting response by request id.
      this.onmessage({
        jsonrpc: "2.0",
        id: RESTORE_REQUEST_ID,
        method: "initialize",
        params: state.initializeParams
      });
    }
  }

  private async saveState(): Promise<void> {
    if (!this._storage) return;
    const sdk = this as unknown as {
      sessionId?: string;
      _initialized: boolean;
    };
    const state: TransportState = {
      sessionId: sdk.sessionId,
      initialized: sdk._initialized,
      initializeParams: this._capturedInitializeParams
    };
    await Promise.resolve(this._storage.set(state));
  }
}
