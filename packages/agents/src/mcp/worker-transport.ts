/**
 * WorkerTransport — retained sessionful Legacy transport
 *
 * Thin Cloudflare-Workers wrapper around the official MCP SDK v1
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
 *  3. **SSE keepalive** — delegated to the SDK transport, which writes SSE
 *     comment frames and owns timer cleanup. Configure the cadence with the
 *     inherited `keepAliveMs` option.
 *
 * Stateless handlers do not import this module. Everything else (session
 * validation, SSE streaming, protocol-version
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
   * and finally appends CORS headers to whatever response comes back.
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
    // handleRequest.
    await this.captureInitializeParams(request, options);

    const response = await super.handleRequest(request, options);

    // State is persisted by the `onsessioninitialized` bridge, which the SDK
    // fires (and awaits) during `super.handleRequest` on the initialize path —
    // the only point session state actually changes. We deliberately do *not*
    // snapshot again here: that would write to storage on every request
    // (notifications, tool calls, GET, DELETE) where nothing changed, matching
    // neither the pre-refactor behaviour (one write at init) nor the intent of
    // the storage adapter.

    return this.withCorsHeaders(this.normalizeAllowHeader(response));
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
    this._closedRequestIds.add(requestId);
    super.closeSSEStream(requestId);
  }

  override async close(): Promise<void> {
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
