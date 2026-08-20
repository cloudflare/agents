import { DurableObject, env as defaultEnv } from "cloudflare:workers";
import { nanoid } from "nanoid";

import {
  CapabilityRunner,
  type DurableObjectCapability
} from "./capability-runner";
import {
  createConnection,
  ConnectionManager,
  isManagedWebSocket
} from "./connection";

import { isBenignTeardownError } from "./transport-errors";

import type {
  Connection,
  ConnectionContext,
  ConnectionSetStateFn,
  ConnectionState
} from "./types";

export {
  type DurableObjectCapability,
  type CapabilityRequestContext,
  type CapabilityStartContext
} from "./capability-runner";
export * from "./types";

/** Payload delivered to a lifecycle-managed WebSocket callback. */
export type WSMessage = ArrayBuffer | ArrayBufferView | string;

const LEGACY_NAME_STORAGE_KEY = "__ps_name";

/**
 * Reserved WebSocket close codes the runtime synthesizes when there
 * was no real Close frame from the peer:
 *  - 1005 (NoStatusReceived) — peer's frame had no status code.
 *  - 1006 (AbnormalClosure)  — peer dropped the underlying transport
 *                              without sending a Close frame at all.
 *  - 1015 (TLSHandshake)     — TLS failure during connection setup.
 *
 * These cannot legally appear in an outgoing Close frame, and — more
 * importantly for our reciprocation path — there is no peer left to
 * receive a reciprocating Close frame. Trying to send one anyway can
 * succeed synchronously but fail asynchronously inside the runtime
 * with "WebSocket peer disconnected" / "Network connection lost",
 * which escapes a synchronous try/catch and surfaces as an unhandled
 * promise rejection.
 */
function isReservedCloseCode(code: number): boolean {
  return code === 1005 || code === 1006 || code === 1015;
}

/**
 * Reciprocate a peer-initiated Close frame to complete the handshake.
 *
 * Best-effort: swallows synchronous errors from invalid codes,
 * oversize reasons, or sockets that have already been closed by user
 * code. Skips the reciprocation entirely when the peer didn't
 * actually send a Close frame (reserved codes 1005/1006/1015) — in
 * those cases the underlying transport is already gone and writing
 * to it would fail asynchronously, which we can't catch here.
 *
 * Used by the hibernating close handler to complete real close handshakes.
 */
function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  // No real Close frame from the peer → nothing to reciprocate.
  // Calling `ws.close(...)` here would synchronously succeed but
  // schedule an outbound write on a dead transport, which the runtime
  // would later reject with "Network connection lost". That rejection
  // can't be observed from here (it's not thrown synchronously and
  // ws.close() doesn't return a Promise to attach a `.catch` to), so
  // it would surface as an unhandled rejection.
  if (isReservedCloseCode(code)) return;
  try {
    ws.close(code, reason);
  } catch {
    // Reasons we end up here:
    //   - the socket was already closed (user called `connection.close()`
    //     in `onClose`, or the runtime auto-replied on compat dates
    //     >= 2026-04-07 for the standard `accept()` API)
    //   - `reason` exceeds the 123-byte UTF-8 limit (compat date
    //     >= 2026-03-03)
    //   - some other invariant violation we don't want to crash the
    //     handler over
    // None of these are recoverable here; the handshake is either already
    // done or the runtime is out of our control.
  }
}

// Cache binding discovery per environment object.
const namespaceMapCache = new WeakMap<
  object,
  Record<string, DurableObjectNamespace>
>();

// Maps kebab-case namespace -> original env binding name (e.g. "my-agent" -> "MyAgent")
const bindingNameCache = new WeakMap<object, Record<string, string>>();

const DEFAULT_ROUTING_RETRY_OPTIONS = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 800
};

/** Details supplied before a routed Durable Object request is retried. */
export interface RoutingRetryEvent {
  /** The retryable platform error. */
  error: unknown;
  /** The next attempt number. */
  attempt: number;
  /** Maximum attempts, including the initial request. */
  maxAttempts: number;
  /** Delay before the next attempt. */
  delayMs: number;
  /** Named Durable Object instance. */
  name: string;
  /** Matched Durable Object binding name, when known. */
  className?: string;
}

/** Retry policy for routed Durable Object infrastructure failures. */
export interface RoutingRetryOptions {
  /** Max number of attempts, including the first. Default: 3 */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff. Default: 100 */
  baseDelayMs?: number;
  /** Max delay cap in ms. Default: 800 */
  maxDelayMs?: number;
  /** Optional callback invoked before each retry delay. */
  onRetry?: (event: RoutingRetryEvent) => void | Promise<void>;
}

interface ResolvedRoutingRetryOptions extends Required<
  Omit<RoutingRetryOptions, "onRetry">
> {
  onRetry?: RoutingRetryOptions["onRetry"];
}

interface RoutingRetryContext {
  name: string;
  className?: string;
}

/** @internal Convert public placement options for namespace.get(). */
export function durableObjectGetOptions(
  options: { locationHint?: DurableObjectLocationHint } | undefined
) {
  return options?.locationHint
    ? { locationHint: options.locationHint }
    : undefined;
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be >= 1`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
}

function validatePositiveNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be > 0`);
  }
}

function resolveRoutingRetryOptions(
  options: false | RoutingRetryOptions | undefined
): ResolvedRoutingRetryOptions | null {
  if (options === false) return null;

  const resolved = {
    maxAttempts:
      options?.maxAttempts ?? DEFAULT_ROUTING_RETRY_OPTIONS.maxAttempts,
    baseDelayMs:
      options?.baseDelayMs ?? DEFAULT_ROUTING_RETRY_OPTIONS.baseDelayMs,
    maxDelayMs: options?.maxDelayMs ?? DEFAULT_ROUTING_RETRY_OPTIONS.maxDelayMs,
    onRetry: options?.onRetry
  };

  validatePositiveInteger(resolved.maxAttempts, "routingRetry.maxAttempts");
  validatePositiveNumber(resolved.baseDelayMs, "routingRetry.baseDelayMs");
  validatePositiveNumber(resolved.maxDelayMs, "routingRetry.maxDelayMs");
  if (resolved.baseDelayMs > resolved.maxDelayMs) {
    throw new Error("routingRetry.baseDelayMs must be <= maxDelayMs");
  }

  return resolved;
}

function isRetryableDurableObjectError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const typed = error as { retryable?: boolean; overloaded?: boolean };
  return typed.retryable === true && typed.overloaded !== true;
}

function routingRetryDelayMs(
  attempt: number,
  options: ResolvedRoutingRetryOptions
): number {
  const upperBoundMs = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * 2 ** (attempt - 1)
  );
  return Math.floor(Math.random() * upperBoundMs);
}

/** @internal Retry a transient Durable Object routing operation. */
export async function retryDurableObjectOperation<T>(
  operation: () => Promise<T>,
  context: RoutingRetryContext,
  retryOptions: false | RoutingRetryOptions | undefined
): Promise<T> {
  const resolved = resolveRoutingRetryOptions(retryOptions);
  if (!resolved) return await operation();

  let attempt = 1;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      const nextAttempt = attempt + 1;
      if (
        nextAttempt > resolved.maxAttempts ||
        !isRetryableDurableObjectError(error)
      ) {
        throw error;
      }

      const delayMs = routingRetryDelayMs(attempt, resolved);
      try {
        await resolved.onRetry?.({
          error,
          attempt,
          maxAttempts: resolved.maxAttempts,
          delayMs,
          name: context.name,
          className: context.className
        });
      } catch (callbackError) {
        console.warn(
          "Durable Object routing retry callback failed:",
          callbackError
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt = nextAttempt;
    }
  }
}

/**
 * Encode props for the internal lifecycle props header.
 *
 * The value travels in an HTTP header, so it must be ASCII-safe. Raw
 * `JSON.stringify` output can contain non-ASCII characters (e.g. accented
 * names like "Usuário"), which makes workerd emit a "header value contains
 * non-ASCII characters" warning and throws in browser fetch implementations.
 * We UTF-8 encode the JSON and base64 it so the header is always ASCII.
 */
function encodeProps(props: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(props));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function mutableRequest(request: Request): Request {
  return new Request(request);
}

function cloneRequestForFetch(request: Request): Request {
  // SAFETY: Workers Types v5 preserves an unconstrained `cf` generic from
  // clone(). Cloning does not change the runtime Request representation.
  return request.clone() as Request;
}

/**
 * Decode props from the internal lifecycle props header.
 *
 * Handles both the base64 encoding produced by `encodeProps` and, for
 * backwards compatibility with stubs/requests created by older versions,
 * raw JSON. Base64 never starts with `{` or `[`, so a leading brace/bracket
 * unambiguously identifies the legacy raw-JSON form.
 */
function decodeProps(header: string): unknown {
  const trimmed = header.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  const binary = atob(header);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function camelCaseToKebabCase(str: string): string {
  // If string is all uppercase, convert to lowercase
  if (str === str.toUpperCase() && str !== str.toLowerCase()) {
    return str.toLowerCase().replace(/_/g, "-");
  }

  // Otherwise handle camelCase to kebab-case
  let kebabified = str.replace(
    /[A-Z]/g,
    (letter) => `-${letter.toLowerCase()}`
  );
  kebabified = kebabified.startsWith("-") ? kebabified.slice(1) : kebabified;
  // Convert any remaining underscores to hyphens and remove trailing -'s
  return kebabified.replace(/_/g, "-").replace(/-$/, "");
}
/** Named Durable Object route matched in the outer Worker. */
export interface DurableObjectRouteMatch<Env = Cloudflare.Env> {
  /** The Durable Object class name / environment binding name. */
  className: Extract<keyof Env, string>;
  /** The named Durable Object instance extracted from the URL. */
  name: string;
}

/** Options supported by `routeDurableObjectRequest`. */
export interface DurableObjectRouteOptions<
  Env = Cloudflare.Env,
  Props = Record<string, unknown>
> {
  prefix?: string;
  jurisdiction?: DurableObjectJurisdiction;
  locationHint?: DurableObjectLocationHint;
  props?: Props;
  /**
   * Whether to enable CORS for matched routes.
   *
   * When `true`, uses default permissive CORS headers:
   * - Access-Control-Allow-Origin: *
   * - Access-Control-Allow-Methods: GET, POST, HEAD, OPTIONS
   * - Access-Control-Allow-Headers: *
   * - Access-Control-Max-Age: 86400
   *
   * For credentialed requests, pass explicit headers with a specific origin:
   * ```ts
   * cors: {
   *   "Access-Control-Allow-Origin": "https://myapp.com",
   *   "Access-Control-Allow-Credentials": "true",
   *   "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
   *   "Access-Control-Allow-Headers": "Content-Type, Authorization"
   * }
   * ```
   *
   * When set to a `HeadersInit` value, uses those as the CORS headers instead.
   * CORS preflight (OPTIONS) requests are handled automatically for matched routes.
   * Non-WebSocket responses on matched routes will also have the CORS headers appended.
   */
  cors?: boolean | HeadersInit;
  /**
   * Retry transient Durable Object infrastructure errors thrown while routing
   * to the target DO. Enabled by default; pass `false` to disable.
   *
   * Only errors marked `retryable === true` are retried, and overloaded
   * errors (`overloaded === true`) are never retried.
   */
  routingRetry?: false | RoutingRetryOptions;
  onBeforeConnect?: (
    req: Request,
    route: DurableObjectRouteMatch<Env>
  ) => Response | Request | void | Promise<Response | Request | void>;
  onBeforeRequest?: (
    req: Request,
    route: DurableObjectRouteMatch<Env>
  ) =>
    | Response
    | Request
    | void
    | Promise<Response | Request | undefined | void>;
}
/**
 * Resolve CORS options into a concrete headers object (or null if CORS is disabled).
 */
function resolveCorsHeaders(
  cors: boolean | HeadersInit | undefined
): Record<string, string> | null {
  if (cors === true) {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400"
    };
  }
  if (cors && typeof cors === "object") {
    // Convert any HeadersInit shape to a plain record
    const h = new Headers(cors as HeadersInit);
    const record: Record<string, string> = {};
    h.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  return null;
}

/**
 * Route `/objects/:binding/:name` requests to named Durable Objects.
 *
 * @param req - Incoming Worker request.
 * @param env - Worker environment containing Durable Object bindings.
 * @param options - Route hooks, prefix, placement, CORS, props, and retries.
 * @returns The matched response, or `null` when the path does not match.
 */
export async function routeDurableObjectRequest<
  Env extends object = Cloudflare.Env,
  T extends DurableObject<Env> = DurableObject<Env>,
  Props extends Record<string, unknown> = Record<string, unknown>
>(
  req: Request,
  env: Env = defaultEnv as Env,
  options?: DurableObjectRouteOptions<Env, Props>
): Promise<Response | null> {
  if (!namespaceMapCache.has(env)) {
    const namespaceMap: Record<string, DurableObjectNamespace> = {};
    const bindingNames: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (
        v &&
        typeof v === "object" &&
        "idFromName" in v &&
        typeof v.idFromName === "function"
      ) {
        const kebab = camelCaseToKebabCase(k);
        namespaceMap[kebab] = v as DurableObjectNamespace;
        bindingNames[kebab] = k;
      }
    }
    namespaceMapCache.set(env, namespaceMap);
    bindingNameCache.set(env, bindingNames);
  }
  const map = namespaceMapCache.get(env) as unknown as Record<
    string,
    DurableObjectNamespace<T>
  >;
  const bindingNames = bindingNameCache.get(env) as Record<string, string>;

  const prefix = options?.prefix || "objects";
  const prefixParts = prefix.split("/");

  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean); // Remove empty strings

  // Check if the URL starts with the prefix
  const prefixMatches = prefixParts.every(
    (part, index) => parts[index] === part
  );
  if (!prefixMatches || parts.length < prefixParts.length + 2) {
    return null;
  }

  const namespace = parts[prefixParts.length];
  const name = parts[prefixParts.length + 1];

  if (name && namespace) {
    if (!map[namespace]) {
      console.error(
        `The URL ${req.url} with namespace "${namespace}" and name "${name}" does not match any Durable Object binding.`
      );
      // we should return a response with a status code that it's an invalid request
      return new Response("Invalid request", { status: 400 });
    }

    // Resolve CORS headers for this matched route
    const corsHeaders = resolveCorsHeaders(options?.cors);
    const isWebSocket =
      req.headers.get("Upgrade")?.toLowerCase() === "websocket";

    // Helper: append CORS headers to a response (skipped for WebSocket upgrades)
    function withCorsHeaders(response: Response): Response {
      if (!corsHeaders || isWebSocket) return response;
      const newResponse = new Response(response.body, response);
      for (const [key, value] of Object.entries(corsHeaders)) {
        newResponse.headers.set(key, value);
      }
      return newResponse;
    }

    // Handle CORS preflight requests for matched routes
    if (req.method === "OPTIONS" && corsHeaders) {
      return new Response(null, { headers: corsHeaders });
    }

    let doNamespace = map[namespace];
    if (options?.jurisdiction) {
      doNamespace = doNamespace.jurisdiction(options.jurisdiction);
    }

    const id = doNamespace.idFromName(name);
    const getOptions = durableObjectGetOptions(options);

    req = mutableRequest(req);

    const className = bindingNames[namespace] as Extract<keyof Env, string>;
    const route: DurableObjectRouteMatch<Env> = { className, name };

    if (isWebSocket) {
      if (options?.onBeforeConnect) {
        const reqOrRes = await options.onBeforeConnect(req, route);
        if (reqOrRes instanceof Request) {
          req = mutableRequest(reqOrRes);
        } else if (reqOrRes instanceof Response) {
          return reqOrRes;
        }
      }
    } else {
      if (options?.onBeforeRequest) {
        const reqOrRes = await options.onBeforeRequest(req, route);
        if (reqOrRes instanceof Request) {
          req = mutableRequest(reqOrRes);
        } else if (reqOrRes instanceof Response) {
          return withCorsHeaders(reqOrRes);
        }
      }
    }

    // Attach props to the request after the hooks so that user-defined
    // onBeforeConnect / onBeforeRequest callbacks don't see the serialized
    // props header on the inspection request.
    if (options?.props !== undefined) {
      req.headers.set("x-agents-lifecycle-props", encodeProps(options.props));
    }

    // Props travel with the request and are applied before startup.
    const response = await retryDurableObjectOperation(
      () => doNamespace.get(id, getOptions).fetch(cloneRequestForFetch(req)),
      { name, className },
      options?.routingRetry
    );
    return isWebSocket ? response : withCorsHeaders(response);
  } else {
    return null;
  }
}

type LifecycleHost<Props extends object> = {
  readonly ctx: DurableObjectState;
  readonly constructor: { readonly name: string };
  onStart?(props?: Props): void | Promise<void>;
  onRequest?(request: Request): Response | Promise<Response>;
  onAlarm?(): void | Promise<void>;
  onConnect?(
    connection: Connection,
    context: ConnectionContext
  ): void | Promise<void>;
  onMessage?(connection: Connection, message: WSMessage): void | Promise<void>;
  onClose?(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): void | Promise<void>;
  onError?(connection: Connection, error: unknown): void | Promise<void>;
  getConnectionTags?(
    connection: Connection,
    context: ConnectionContext
  ): string[] | Promise<string[]>;
};

/**
 * Installs and coordinates the runtime lifecycle for a Durable Object.
 *
 * Construct this as an instance field on a class that directly extends
 * `DurableObject`, then call {@link DurableObjectLifecycle.installHandlers}
 * from that class's constructor.
 */
export class DurableObjectLifecycle<
  Env extends object = Cloudflare.Env,
  Props extends Record<string, unknown> = Record<string, unknown>
> {
  readonly #host: LifecycleHost<Props>;
  readonly #ctx: DurableObjectState;
  readonly #parentClassName: string;
  readonly #capabilities: DurableObjectCapability<Props>[] = [];
  readonly #capabilityRunner = new CapabilityRunner<Props>(
    () => this.#capabilities
  );
  readonly #connectionManager: ConnectionManager;

  #status: "zero" | "starting" | "started" = "zero";
  #capabilitiesLocked = false;
  #handlersInstalled = false;

  /**
   * Construct and install a lifecycle in one explicit operation.
   *
   * @param host - The Durable Object whose runtime handlers the lifecycle owns.
   * @returns The installed lifecycle.
   */
  static install<
    Env extends object,
    Props extends Record<string, unknown> = Record<string, unknown>
  >(host: DurableObject<Env>): DurableObjectLifecycle<Env, Props> {
    const lifecycle = new DurableObjectLifecycle<Env, Props>(host);
    lifecycle.installHandlers();
    return lifecycle;
  }

  /**
   * Bind a lifecycle to a Durable Object instance without mutating its handlers.
   *
   * @param host - The Durable Object whose runtime lifecycle this object owns.
   */
  constructor(host: DurableObject<Env>) {
    // SAFETY: DurableObject exposes ctx as protected to subclasses. The
    // lifecycle is constructed by that subclass with `this`, so this boundary
    // accesses the same runtime-owned context without exposing it publicly.
    this.#host = host as unknown as LifecycleHost<Props>;
    this.#ctx = this.#host.ctx;
    this.#parentClassName = this.#host.constructor.name;
    this.#connectionManager = new ConnectionManager(this.#ctx);
  }

  /**
   * Install platform fetch, alarm, and hibernating WebSocket handlers.
   *
   * Existing handlers are preserved for framework-owned dispatch such as the
   * Agent's sub-agent router and alarm circuit breaker. Calling this method
   * more than once is an error.
   */
  installHandlers(): void {
    if (this.#handlersInstalled) {
      throw new Error(
        "Durable Object lifecycle handlers are already installed"
      );
    }
    this.#handlersInstalled = true;

    const handlers = {
      fetch: this.fetch.bind(this),
      alarm: this.alarm.bind(this),
      webSocketMessage: this.webSocketMessage.bind(this),
      webSocketClose: this.webSocketClose.bind(this),
      webSocketError: this.webSocketError.bind(this)
    };
    for (const [name, handler] of Object.entries(handlers)) {
      if (name in this.#host) continue;
      Object.defineProperty(this.#host, name, {
        value: handler,
        configurable: true
      });
    }
  }

  /**
   * Add a reusable capability before this lifecycle starts.
   *
   * @param capability - The capability to add in dispatch order.
   * @returns This lifecycle.
   */
  use(capability: DurableObjectCapability<Props>): this {
    if (this.#capabilitiesLocked) {
      throw new Error("Lifecycle capabilities must be added before startup");
    }
    this.#capabilities.push(capability);
    return this;
  }

  /**
   * Execute SQL queries against the Durable Object's database
   * @template T Type of the returned rows
   * @param strings SQL query template strings
   * @param values Values to be inserted into the query
   * @returns Array of query results
   */
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) {
    let query = "";
    try {
      // Construct the SQL query with placeholders
      query = strings.reduce(
        (acc, str, i) => acc + str + (i < values.length ? "?" : ""),
        ""
      );

      // Execute the SQL query with the provided values
      return [...this.#ctx.storage.sql.exec(query, ...values)] as T[];
    } catch (error) {
      console.error(`failed to execute sql query: ${query}`, error);
      throw error;
    }
  }

  /**
   * Handle an incoming request for the owning Durable Object.
   */
  async fetch(request: Request): Promise<Response> {
    try {
      const encodedProps = request.headers.get("x-agents-lifecycle-props");
      if (encodedProps) {
        this.#props = decodeProps(encodedProps) as Props;
        request = mutableRequest(request);
        request.headers.delete("x-agents-lifecycle-props");
      }

      await this.#ensureInitialized();

      const url = new URL(request.url);

      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        const capabilityResponse = await this.#capabilityRunner.request({
          request
        });
        if (capabilityResponse !== undefined) return capabilityResponse;
        if (this.#host.onRequest) return await this.#host.onRequest(request);
        return new Response("Not implemented", { status: 404 });
      } else {
        // Create the websocket pair for the client
        const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
        let connectionId = url.searchParams.get("_pk");
        if (!connectionId) {
          connectionId = nanoid();
        }

        let connection: Connection = Object.assign(serverWebSocket, {
          id: connectionId,
          uri: request.url,
          tags: [] as string[],
          state: null as unknown as ConnectionState<unknown>,
          setState<T = unknown>(setState: T | ConnectionSetStateFn<T>) {
            let state: T;
            if (setState instanceof Function) {
              state = setState(this.state as ConnectionState<T>);
            } else {
              state = setState;
            }

            // TODO: deepFreeze object?
            this.state = state as ConnectionState<T>;
            return this.state;
          }
        });

        const ctx = { request };

        const tags = this.#host.getConnectionTags
          ? await this.#host.getConnectionTags(connection, ctx)
          : [];

        // Hibernating WebSockets remain connected while the object is evicted.
        connection = this.#connectionManager.accept(connection, { tags });
        await this.#host.onConnect?.(connection, ctx);

        return new Response(null, { status: 101, webSocket: clientWebSocket });
      }
    } catch (err) {
      console.error(
        `Error in ${this.#parentClassName}:${this.#ctx.id.name ?? "<unnamed>"} fetch:`,
        err
      );
      if (!(err instanceof Error)) throw err;
      if (request.headers.get("Upgrade") === "websocket") {
        // Annoyingly, if we return an HTTP error in response to a WebSocket request, Chrome devtools
        // won't show us the response body! So... let's send a WebSocket response with an error
        // frame instead.
        const pair = new WebSocketPair();
        pair[1].accept();
        pair[1].send(JSON.stringify({ error: err.stack }));
        pair[1].close(1011, "Uncaught exception during session setup");
        return new Response(null, { status: 101, webSocket: pair[0] });
      } else {
        return new Response(err.stack, { status: 500 });
      }
    }
  }

  /** @internal Dispatch a hibernating WebSocket message. */
  async webSocketMessage(ws: WebSocket, message: WSMessage): Promise<void> {
    // Ignore WebSockets accepted outside this lifecycle (e.g. via
    // `state.acceptWebSocket()` in user code). These sockets do not have the
    // managed attachment required to rehydrate a Connection.
    if (!isManagedWebSocket(ws)) {
      return;
    }

    try {
      const connection = createConnection(ws);

      await this.#ensureInitialized();
      return this.#host.onMessage?.(connection, message);
    } catch (e) {
      console.error(
        `Error in ${this.#parentClassName}:${this.#ctx.id.name ?? "<unnamed>"} webSocketMessage:`,
        e
      );
    }
  }

  /** @internal Dispatch and reciprocate a hibernating WebSocket close. */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    if (!isManagedWebSocket(ws)) {
      return;
    }

    try {
      const connection = createConnection(ws);

      await this.#ensureInitialized();
      await this.#host.onClose?.(connection, code, reason, wasClean);
    } catch (e) {
      console.error(
        `Error in ${this.#parentClassName}:${this.#ctx.id.name ?? "<unnamed>"} webSocketClose:`,
        e
      );
    } finally {
      // Reciprocate the peer's Close frame to complete the handshake.
      // The Hibernation API requires applications to do this — without it,
      // clients stay in CLOSING and end up reporting 1006 abnormal closure.
      // The standard `accept()` API gets this for free on compat dates
      // >= 2026-04-07 via the `web_socket_auto_reply_to_close` flag, but the
      // Hibernation API contract is unchanged: see
      // https://developers.cloudflare.com/durable-objects/api/base/#websocketclose
      // Calling close() on an already-closed socket is a silent no-op, so
      // this is safe regardless of compat date or whether user code in
      // `onClose` already called `connection.close()`.
      closeQuietly(ws, code, reason);
    }
  }

  /** @internal Dispatch a hibernating WebSocket error. */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    if (!isManagedWebSocket(ws)) {
      return;
    }

    // Suppress retryable transport-teardown errors on an already closing/closed
    // socket — the connection going away during/after the close handshake, not
    // an application error. Genuine mid-connection (OPEN) errors still reach
    // onError below.
    if (isBenignTeardownError(ws, error)) {
      return;
    }

    try {
      const connection = createConnection(ws);

      await this.#ensureInitialized();
      return this.#host.onError?.(connection, error);
    } catch (e) {
      console.error(
        `Error in ${this.#parentClassName}:${this.#ctx.id.name ?? "<unnamed>"} webSocketError:`,
        e
      );
    }
  }

  /**
   * Start lifecycle capabilities and the owning Durable Object.
   *
   * Runtime fetch, alarm, and WebSocket entry points call this automatically.
   * RPC methods may call it explicitly because native RPC bypasses fetch.
   *
   * @param props - Optional properties supplied to capability and host startup.
   */
  async start(props?: Props): Promise<void> {
    if (props !== undefined) this.#props = props;
    await this.#ensureInitialized();
  }

  async #ensureInitialized(): Promise<void> {
    if (this.#status === "started") return;

    if (this.#ctx.id.name === undefined && this.#legacyName === undefined) {
      this.#legacyName = await this.#ctx.storage.get<string>(
        LEGACY_NAME_STORAGE_KEY
      );
    }
    // Fail before host startup if neither native nor migrated identity exists.
    void this.name;

    this.#capabilitiesLocked = true;
    let error: unknown;
    await this.#ctx.blockConcurrencyWhile(async () => {
      this.#status = "starting";
      try {
        await this.#capabilityRunner.start({ props: this.#props });
        await this.#host.onStart?.(this.#props);
        this.#status = "started";
      } catch (cause) {
        this.#status = "zero";
        error = cause;
      }
    });
    // Re-throw outside blockConcurrencyWhile so the input gate is not
    // permanently broken and a later invocation can retry startup.
    if (error) throw error;
  }

  #legacyName: string | undefined;

  /**
   * The name used to address this Durable Object.
   *
   * Native `ctx.id.name` is authoritative. A read-only legacy storage fallback
   * lets objects created by older PartyServer releases migrate without new
   * name writes.
   */
  get name(): string {
    const name = this.#ctx.id.name ?? this.#legacyName;
    if (name !== undefined) return name;
    throw new Error(
      `${this.#parentClassName} could not determine its Durable Object name. ` +
        "Address it with idFromName() or getByName(). In local development, " +
        "update Wrangler/workerd and use a current compatibility_date. " +
        "newUniqueId(), idFromString(), and names over 1,024 bytes do not " +
        "expose ctx.id.name. Alarms created before 2026-03-15 must be " +
        "rescheduled from a named fetch or RPC handler."
    );
  }

  #sendMessageToConnection(connection: Connection, message: WSMessage): void {
    try {
      connection.send(message);
    } catch (_e) {
      // close connection
      connection.close(1011, "Unexpected error");
    }
  }

  /** Send a message to all connected clients, except connection ids listed in `without` */
  broadcast(
    msg: string | ArrayBuffer | ArrayBufferView,
    without?: string[] | undefined
  ): void {
    for (const connection of this.#connectionManager.getConnections()) {
      if (!without || !without.includes(connection.id)) {
        this.#sendMessageToConnection(connection, msg);
      }
    }
  }

  /** Get a connection by connection id */
  getConnection<TState = unknown>(id: string): Connection<TState> | undefined {
    return this.#connectionManager.getConnection<TState>(id);
  }

  /** Get all managed connections, optionally filtered by tag. */
  getConnections<TState = unknown>(tag?: string): Iterable<Connection<TState>> {
    return this.#connectionManager.getConnections<TState>(tag);
  }

  #props?: Props;

  /** Dispatch lifecycle and host alarm callbacks after startup. */
  async alarm(): Promise<void> {
    await this.#ensureInitialized();
    await this.#capabilityRunner.alarm();
    await this.#host.onAlarm?.();
  }
}
