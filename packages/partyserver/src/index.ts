import { DurableObject, env as defaultEnv } from "cloudflare:workers";
import { nanoid } from "nanoid";

import {
  DurableObjectLifecycle,
  type DurableObjectLifecycleComponent,
  type DurableObjectRequestContext,
  type DurableObjectStartContext
} from "./durable-object-lifecycle";
import {
  createLazyConnection,
  HibernatingConnectionManager,
  InMemoryConnectionManager,
  isPartyServerWebSocket
} from "./connection";

import { isBenignTeardownError } from "./transport-errors";

import type { ConnectionManager } from "./connection";
import type {
  Connection,
  ConnectionContext,
  ConnectionSetStateFn,
  ConnectionState
} from "./types";

export {
  DurableObjectLifecycle,
  type DurableObjectLifecycleComponent,
  type DurableObjectRequestContext,
  type DurableObjectStartContext
} from "./durable-object-lifecycle";
export * from "./types";

export type WSMessage = ArrayBuffer | ArrayBufferView | string;

const NAME_STORAGE_KEY = "__ps_name";

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
 * Used by both the hibernating and non-hibernating close handlers to
 * ensure the close handshake always completes when there is one to
 * complete.
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

// Let's cache the server namespace map
// so we don't call it on every request
const serverMapCache = new WeakMap<
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

export interface RoutingRetryEvent {
  error: unknown;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  name: string;
  className?: string;
}

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

function durableObjectGetOptions(
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

async function retryDurableObjectOperation<T>(
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
          "PartyServer routingRetry onRetry callback failed:",
          callbackError
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt = nextAttempt;
    }
  }
}

/**
 * Encode props for the `x-partykit-props` header.
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

function cloneRequest(request: Request): Request {
  // SAFETY: Workers Types v5 preserves an unconstrained `cf` generic from
  // clone(), while this public API intentionally uses the default Request
  // metadata shape. Cloning does not change the runtime Request representation.
  return request.clone() as Request;
}

/**
 * Decode props from the `x-partykit-props` header.
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

/**
 * For a given server namespace, create a server with a name.
 *
 * Makes an RPC that awaits the DO's `onStart()` before returning, so callers
 * can invoke user-defined RPC methods on the returned stub and trust that
 * `onStart()` has completed. (User-defined RPC methods don't
 * otherwise pass through `Server.fetch()`, which is where initialization
 * would normally be triggered.)
 *
 * `this.name` inside the DO is always populated from `ctx.id.name`, so
 * the RPC no longer needs to carry the name for bookkeeping; it exists
 * purely to synchronize `onStart()` and to deliver `props`.
 */
export async function getServerByName<
  Env extends Cloudflare.Env = Cloudflare.Env,
  T extends Server<Env> = Server<Env>,
  Props extends Record<string, unknown> = Record<string, unknown>
>(
  serverNamespace: DurableObjectNamespace<T>,
  name: string,
  options?: {
    jurisdiction?: DurableObjectJurisdiction;
    locationHint?: DurableObjectLocationHint;
    props?: Props;
    routingRetry?: false | RoutingRetryOptions;
  }
): Promise<DurableObjectStub<T>> {
  if (options?.jurisdiction) {
    serverNamespace = serverNamespace.jurisdiction(options.jurisdiction);
  }

  const id = serverNamespace.idFromName(name);
  const getOptions = durableObjectGetOptions(options);

  await retryDurableObjectOperation(
    () => serverNamespace.get(id, getOptions).setName(name, options?.props),
    { name },
    options?.routingRetry
  );

  return serverNamespace.get(id, getOptions);
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
export interface Lobby<Env = Cloudflare.Env> {
  /**
   * The kebab-case namespace from the URL path (e.g. `"my-agent"`).
   * @deprecated Use `className` instead, which returns the Durable Object class name.
   * In the next major version, `party` will return the class name instead of the kebab-case namespace.
   */
  party: string;
  /** The Durable Object class name / env binding name (e.g. `"MyAgent"`). */
  className: Extract<keyof Env, string>;
  /** The room / instance name extracted from the URL. */
  name: string;
}

export interface PartyServerOptions<
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
    lobby: Lobby<Env>
  ) => Response | Request | void | Promise<Response | Request | void>;
  onBeforeRequest?: (
    req: Request,
    lobby: Lobby<Env>
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

export async function routePartykitRequest<
  Env extends Cloudflare.Env = Cloudflare.Env,
  T extends Server<Env> = Server<Env>,
  Props extends Record<string, unknown> = Record<string, unknown>
>(
  req: Request,
  env: Env = defaultEnv as Env,
  options?: PartyServerOptions<Env, Props>
): Promise<Response | null> {
  if (!serverMapCache.has(env)) {
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
    serverMapCache.set(env, namespaceMap);
    bindingNameCache.set(env, bindingNames);
  }
  const map = serverMapCache.get(env) as unknown as Record<
    string,
    DurableObjectNamespace<T>
  >;
  const bindingNames = bindingNameCache.get(env) as Record<string, string>;

  const prefix = options?.prefix || "parties";
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
      if (namespace === "main") {
        console.warn(
          "You appear to be migrating a PartyKit project to PartyServer."
        );
        console.warn(
          `PartyServer doesn't have a "main" party by default. Try adding this to your PartySocket client:\n party: "${camelCaseToKebabCase(Object.keys(map)[0])}"`
        );
      } else {
        console.error(
          `The url ${req.url}  with namespace "${namespace}" and name "${name}" does not match any server namespace.\nDid you forget to add a durable object binding to the class ${namespace[0].toUpperCase() + namespace.slice(1)} in your wrangler.jsonc?`
        );
      }
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

    req = cloneRequest(req);
    req.headers.set("x-partykit-namespace", namespace);
    if (options?.jurisdiction) {
      req.headers.set("x-partykit-jurisdiction", options.jurisdiction);
    }

    const className = bindingNames[namespace] as Extract<keyof Env, string>;
    let partyDeprecationWarned = false;
    const lobby: Lobby<Env> = {
      get party() {
        if (!partyDeprecationWarned) {
          partyDeprecationWarned = true;
          console.warn(
            'lobby.party is deprecated and currently returns the kebab-case namespace (e.g. "my-agent"). ' +
              'Use lobby.className instead to get the Durable Object class name (e.g. "MyAgent"). ' +
              "In the next major version, lobby.party will return the class name."
          );
        }
        return namespace;
      },
      className,
      name
    };

    if (isWebSocket) {
      if (options?.onBeforeConnect) {
        const reqOrRes = await options.onBeforeConnect(req, lobby);
        if (reqOrRes instanceof Request) {
          req = reqOrRes;
        } else if (reqOrRes instanceof Response) {
          return reqOrRes;
        }
      }
    } else {
      if (options?.onBeforeRequest) {
        const reqOrRes = await options.onBeforeRequest(req, lobby);
        if (reqOrRes instanceof Request) {
          req = reqOrRes;
        } else if (reqOrRes instanceof Response) {
          return withCorsHeaders(reqOrRes);
        }
      }
    }

    // Attach props to the request after the hooks so that user-defined
    // onBeforeConnect / onBeforeRequest callbacks don't see the serialized
    // props header on the inspection request.
    if (options?.props !== undefined) {
      req.headers.set("x-partykit-props", encodeProps(options.props));
    }

    // Single RPC for both WS and HTTP: `this.name` is populated from
    // `ctx.id.name` inside the DO, so there's no need for a prior
    // `setName()` round-trip. Props (if any) travel in the request header
    // and are picked up in `Server.fetch()`.
    const response = await retryDurableObjectOperation(
      () => doNamespace.get(id, getOptions).fetch(cloneRequest(req)),
      { name, className },
      options?.routingRetry
    );
    return isWebSocket ? response : withCorsHeaders(response);
  } else {
    return null;
  }
}

type ServerOptions = { hibernate?: boolean };

function resolveServerOptions(serverClass: {
  options?: ServerOptions;
}): Required<ServerOptions> {
  let current: { options?: ServerOptions } | null = serverClass;
  while (current) {
    const hibernate = current.options?.hibernate;
    if (hibernate !== undefined) {
      return { hibernate };
    }
    current = Object.getPrototypeOf(current) as {
      options?: ServerOptions;
    } | null;
  }
  return { hibernate: false };
}

export class Server<
  Env extends Cloudflare.Env = Cloudflare.Env,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends DurableObject<Env> {
  static options: { hibernate?: boolean } = {
    hibernate: false
  };

  #status: "zero" | "starting" | "started" = "zero";

  #ParentClass: typeof Server = Object.getPrototypeOf(this).constructor;

  #options = resolveServerOptions(this.#ParentClass);

  #lifecycle = new DurableObjectLifecycle<Props>(
    () => this.lifecycleComponents
  );

  #connectionManager: ConnectionManager = this.#options.hibernate
    ? new HibernatingConnectionManager(this.ctx)
    : new InMemoryConnectionManager();

  /**
   * Execute SQL queries against the Server's database
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
      return [...this.ctx.storage.sql.exec(query, ...values)] as T[];
    } catch (e) {
      console.error(`failed to execute sql query: ${query}`, e);
      throw this.onException(e);
    }
  }

  // oxlint-disable-next-line no-useless-constructor
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // TODO: throw error if any of
    // broadcast/getConnection/getConnections/getConnectionTags
    // fetch/webSocketMessage/webSocketClose/webSocketError/alarm
    // have been overridden
  }

  /**
   * Handle incoming requests to the server.
   */
  async fetch(request: Request): Promise<Response> {
    try {
      // Set the props in-mem if the request included them.
      const props = request.headers.get("x-partykit-props");
      if (props) {
        this.#_props = decodeProps(props) as Props;
      }

      // Name resolution priority: ctx.id.name > x-partykit-room header
      // > legacy __ps_name storage record. Pre-populate from the header
      // BEFORE `#ensureInitialized()` so that `onStart()` sees the name
      // regardless of how it was supplied. `#ensureInitialized()` will
      // fall back to reading storage when neither ctx.id.name nor the
      // header has provided one.
      //
      // Deprecated: current callers should use idFromName()/getByName(),
      // which populate ctx.id.name without a header. This read remains for
      // mixed-version deployments and raw stub.fetch() callers.
      if (!this.ctx.id.name && !this.#_name) {
        const room = request.headers.get("x-partykit-room");
        if (room) this.#_name = room;
      }

      await this.#ensureInitialized();

      if (!this.ctx.id.name && !this.#_name) {
        throw new Error(`Cannot determine the name for ${this.#ParentClass.name}: this.ctx.id.name is undefined, no legacy __ps_name storage record is present, and no x-partykit-room header was supplied. Likely causes:
  1. The stub was built via idFromString()/newUniqueId(). PartyServer requires name-based addressing (idFromName/getByName).
  2. The workerd/wrangler runtime is too old to expose ctx.id.name — update to a recent wrangler release.
  3. You called stub.fetch() directly without going through routePartykitRequest()/getServerByName(). Prefer those; the x-partykit-room fallback is deprecated.`);
      }

      const url = new URL(request.url);

      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        const componentResponse = await this.runLifecycleRequest({ request });
        if (componentResponse !== undefined) return componentResponse;
        return await this.onRequest(request);
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
          server: this.name,
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

        const tags = await this.getConnectionTags(connection, ctx);

        // Accept the websocket connection
        connection = this.#connectionManager.accept(connection, { tags });

        if (!this.#options.hibernate) {
          this.#attachSocketEventHandlers(connection);
        }
        await this.onConnect(connection, ctx);

        return new Response(null, { status: 101, webSocket: clientWebSocket });
      }
    } catch (err) {
      console.error(
        `Error in ${this.#ParentClass.name}:${this.ctx.id.name ?? this.#_name ?? "<unnamed>"} fetch:`,
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

  async webSocketMessage(ws: WebSocket, message: WSMessage): Promise<void> {
    // Ignore websockets accepted outside PartyServer (e.g. via
    // `state.acceptWebSocket()` in user code). These sockets won't have the
    // `__pk` attachment namespace required to rehydrate a Connection.
    if (!isPartyServerWebSocket(ws)) {
      return;
    }

    try {
      const connection = createLazyConnection(ws);

      await this.#ensureInitialized();
      connection.server = this.name;

      return this.onMessage(connection, message);
    } catch (e) {
      console.error(
        `Error in ${this.#ParentClass.name}:${this.ctx.id.name ?? this.#_name ?? "<unnamed>"} webSocketMessage:`,
        e
      );
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    if (!isPartyServerWebSocket(ws)) {
      return;
    }

    try {
      const connection = createLazyConnection(ws);

      await this.#ensureInitialized();
      connection.server = this.name;

      await this.onClose(connection, code, reason, wasClean);
    } catch (e) {
      console.error(
        `Error in ${this.#ParentClass.name}:${this.ctx.id.name ?? this.#_name ?? "<unnamed>"} webSocketClose:`,
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

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    if (!isPartyServerWebSocket(ws)) {
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
      const connection = createLazyConnection(ws);

      await this.#ensureInitialized();
      connection.server = this.name;

      return this.onError(connection, error);
    } catch (e) {
      console.error(
        `Error in ${this.#ParentClass.name}:${this.ctx.id.name ?? this.#_name ?? "<unnamed>"} webSocketError:`,
        e
      );
    }
  }

  /**
   * Read the legacy `__ps_name` storage record as a fallback source of
   * `this.name` when `ctx.id.name` is unavailable. Covers:
   *
   *   1. Alarm handlers firing on alarm records that were scheduled by
   *      a workerd version that did not yet persist `name` into the
   *      alarm record (see the Durable Objects ID docs:
   *      https://developers.cloudflare.com/durable-objects/api/id/#name).
   *      The runtime contract for current workerd populates `ctx.id.name`
   *      in alarm handlers — see the "Raw runtime contract" tests — so
   *      this fallback exists primarily for stale on-disk alarm records
   *      and for defense-in-depth against future runtime changes.
   *   2. Legacy framework-level bootstrap patterns that write
   *      `__ps_name` directly (or call `setName()`) before triggering
   *      `__unsafe_ensureInitialized()` — typically DOs addressed via
   *      `idFromString()` / `newUniqueId()` plus a name override.
   *
   * Named Durable Objects no longer write this fallback. The runtime provides
   * ctx.id.name directly across fetch, alarm, and hibernating WebSocket wakes.
   * Existing records remain readable for backward compatibility.
   */
  async #hydrateNameFromLegacyStorage(): Promise<void> {
    if (this.#_name) return;
    const stored = await this.ctx.storage.get<string>(NAME_STORAGE_KEY);
    if (stored) {
      this.#_name = stored;
    }
  }

  /**
   * @internal — Do not use directly. This is an escape hatch for frameworks
   * (like Agents) that receive calls via native DO RPC, bypassing the
   * standard fetch/alarm/webSocket entry points where initialization
   * normally happens. Calling this from application code is unsupported
   * and may break without notice.
   */
  async __unsafe_ensureInitialized(): Promise<void> {
    await this.#ensureInitialized();
  }

  async #ensureInitialized(): Promise<void> {
    if (this.#status === "started") return;

    // Native names are available on every supported named-access entry point,
    // so do not duplicate them in storage. Retain the legacy read for raw-ID
    // bootstraps and alarm records created before the runtime carried names.
    if (this.ctx.id.name === undefined && !this.#_name) {
      await this.#hydrateNameFromLegacyStorage();
    }

    let error: unknown;
    await this.ctx.blockConcurrencyWhile(async () => {
      this.#status = "starting";
      try {
        await this.runLifecycleStart({ props: this.#_props });
        await this.onStart(this.#_props);
        this.#status = "started";
      } catch (e) {
        this.#status = "zero";
        error = e;
      }
    });
    // Re-throw outside blockConcurrencyWhile so the DO's input gate
    // isn't permanently broken, allowing subsequent requests to retry.
    if (error) throw error;
  }

  #attachSocketEventHandlers(connection: Connection) {
    const handleMessageFromClient = (event: MessageEvent) => {
      this.onMessage(connection, event.data)?.catch<void>((e) => {
        console.error("onMessage error:", e);
      });
    };

    const reciprocateClose = (event: CloseEvent) => {
      // Reciprocate the peer's Close frame. On compat dates
      // >= 2026-04-07 the runtime's `web_socket_auto_reply_to_close`
      // flag will already have done this before the close event
      // fired, in which case `closeQuietly` is a silent no-op. On
      // older compat dates this is the only way the client gets a
      // clean close back.
      closeQuietly(connection, event.code, event.reason);
    };

    const handleCloseFromClient = (event: CloseEvent) => {
      connection.removeEventListener("message", handleMessageFromClient);
      connection.removeEventListener("close", handleCloseFromClient);
      let result: void | Promise<void>;
      try {
        result = this.onClose(
          connection,
          event.code,
          event.reason,
          event.wasClean
        );
      } catch (e) {
        // Synchronous throw from `onClose`. Log it and still
        // reciprocate the close so the client doesn't observe a 1006
        // abnormal closure on top of the user error.
        console.error("onClose error:", e);
        reciprocateClose(event);
        return;
      }
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>)
          .catch((e) => {
            console.error("onClose error:", e);
          })
          .finally(() => reciprocateClose(event));
      } else {
        reciprocateClose(event);
      }
    };

    const handleErrorFromClient = (event: Event) => {
      connection.removeEventListener("message", handleMessageFromClient);
      connection.removeEventListener("error", handleErrorFromClient);
      const error = "error" in event ? event.error : event;
      // A transport-teardown error on an already closing/closed connection is
      // the socket going away during the close handshake, not an app error.
      if (isBenignTeardownError(connection, error)) return;
      this.onError(connection, error)?.catch((onErrorFailure) => {
        console.error("onError error:", onErrorFailure);
      });
    };

    connection.addEventListener("close", handleCloseFromClient);
    connection.addEventListener("error", handleErrorFromClient);
    connection.addEventListener("message", handleMessageFromClient);
  }

  // Public API

  /**
   * Components installed into this Durable Object's lifecycle.
   *
   * Override this getter to return components in startup order. The collection
   * is resolved lazily before the first startup phase and remains fixed until
   * the Durable Object is evicted.
   */
  protected get lifecycleComponents(): Iterable<
    DurableObjectLifecycleComponent<Props>
  > {
    return [];
  }

  /** Run component startup at the host-defined startup boundary. */
  protected runLifecycleStart(
    context: DurableObjectStartContext<Props>
  ): Promise<void> {
    return this.#lifecycle.start(context);
  }

  /** Offer a request to installed components at the host-defined boundary. */
  protected runLifecycleRequest(
    context: DurableObjectRequestContext
  ): Promise<Response | undefined> {
    return this.#lifecycle.request(context);
  }

  /** Run component alarm hooks at the host-defined alarm boundary. */
  protected runLifecycleAlarm(): Promise<void> {
    return this.#lifecycle.alarm();
  }

  /**
   * Dispose installed lifecycle components during explicit host teardown.
   *
   * Workers do not call this method when a Durable Object is evicted.
   */
  protected disposeLifecycle(): Promise<void> {
    return this.#lifecycle.dispose();
  }

  #_name: string | undefined;

  /**
   * The name for this server.
   *
   * Resolves from `this.ctx.id.name` — the native DO id name, populated
   * whenever the stub was created via `idFromName()` or `getByName()`.
   * This is available inside every entry point (including the constructor,
   * alarms, and hibernating websocket handlers).
   *
   * For alarm handlers firing on stale on-disk alarm records from
   * older workerd versions that didn't persist `name` into the alarm
   * record, the name is recovered from a storage fallback record.
   *
   * Throws if neither source is available — typically this means the DO
   * was addressed via `idFromString()` or `newUniqueId()`, which is not
   * supported by PartyServer.
   */
  get name(): string {
    const ctxName = this.ctx.id.name;
    if (ctxName !== undefined) return ctxName;
    if (this.#_name) return this.#_name;
    throw new Error(
      `Attempting to read .name on ${this.#ParentClass.name}, but this.ctx.id.name is not set and no ${NAME_STORAGE_KEY} fallback record is available. PartyServer requires DOs to be addressed via idFromName()/getByName(), or explicitly bootstrapped with setName() when using idFromString()/newUniqueId(). If this happens in an alarm handler firing on a stale pre-2026-03-15 alarm record, reschedule the alarm from a fetch or RPC handler where ctx.id.name is available.`
    );
  }

  /**
   * Establish this server's name and trigger `onStart()`.
   *
   * Two roles:
   *
   *   1. **Synchronizing `onStart()` and delivering initial props.**
   *      `getServerByName()` uses this role before returning a stub.
   *   2. **Legacy bootstrap for DOs where `ctx.id.name` is undefined.**
   *      For `idFromString()` / `newUniqueId()`, `setName()` stashes the
   *      name in memory and persists it under `__ps_name` for cold wakes.
   *
   * For DOs addressed via `idFromName()` / `getByName()`, calling
   * `setName()` is redundant for naming — `this.name` is available
   * automatically from `ctx.id.name` and no fallback record is persisted.
   * The method still synchronizes `onStart()` and delivers optional props.
   * Throws if `name` does not match `ctx.id.name`.
   *
   * **Not appropriate for facets.** Cloudflare Agents and any other
   * framework using `ctx.facets.get(...)` should pass an explicit
   * `id` in `FacetStartupOptions` so the facet has its own
   * `ctx.id.name`:
   *
   * ```ts
   * const stub = ctx.facets.get(facetKey, () => ({
   *   class: ChildClass,
   *   id: ctx.exports.SomeBoundDOClass.idFromName(facetName),
   * }));
   * ```
   *
   * Without an explicit `id`, the facet inherits the parent DO's
   * `ctx.id` (including `ctx.id.name`), and `setName()` will throw
   * the ctx.id.name-mismatch error because the facet's intended
   * name differs from the parent's. See
   * https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/
   * for the `FacetStartupOptions.id` semantics.
   *
   * @deprecated Using this method to establish a name for an
   * `idFromString()` / `newUniqueId()` object is deprecated. Address new
   * objects through `idFromName()` / `getByName()`. The synchronization and
   * props-delivery role used by `getServerByName()` remains supported.
   */
  async setName(name: string, props?: Props) {
    if (!name) {
      throw new Error("A name is required.");
    }
    const ctxName = this.ctx.id.name;
    if (ctxName !== undefined && ctxName !== name) {
      throw new Error(
        `This server's Durable Object id was created for name "${ctxName}", cannot setName to "${name}".`
      );
    }
    if (this.#_name && this.#_name !== name) {
      throw new Error(
        `This server already has a name: ${this.#_name}, attempting to set to: ${name}`
      );
    }
    if (props !== undefined) {
      this.#_props = props;
    }
    if (!this.#_name && ctxName === undefined) {
      // Legacy bootstrap path for a DO addressed without idFromName.
      // Persist to storage AND stash the
      // name in memory so that subsequent cold-wake invocations
      // (fetch, alarm, websocket handlers, RPC via
      // `__unsafe_ensureInitialized`) can recover the name through
      // `#ensureInitialized()`'s legacy fallback.
      //
      // Order matters: write storage first so that if it throws,
      // `#_name` stays undefined and a retry will re-attempt the
      // storage write (instead of silently no-op'ing because the
      // in-memory name was already set).
      await this.ctx.storage.put(NAME_STORAGE_KEY, name);
      this.#_name = name;
    }
    await this.#ensureInitialized();
  }

  /**
   * @internal
   * @deprecated Retained for backward compatibility with older callers.
   * `routePartykitRequest` no longer uses this method; it sends props via
   * the `x-partykit-props` header on the underlying `fetch()` request.
   */
  async _initAndFetch(
    name: string,
    props: Props | undefined,
    request: Request
  ): Promise<Response> {
    await this.setName(name, props);
    return this.fetch(request);
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

  /**
   * Get all connections. Optionally, you can provide a tag to filter returned connections.
   * Use `Server#getConnectionTags` to tag the connection on connect.
   */
  getConnections<TState = unknown>(tag?: string): Iterable<Connection<TState>> {
    return this.#connectionManager.getConnections<TState>(tag);
  }

  /**
   * You can tag a connection to filter them in Server#getConnections.
   * Each connection supports up to 9 tags, each tag max length is 256 characters.
   */
  getConnectionTags(
    // oxlint-disable-next-line no-unused-vars
    connection: Connection,
    // oxlint-disable-next-line no-unused-vars
    context: ConnectionContext
  ): string[] | Promise<string[]> {
    return [];
  }

  #_props?: Props;

  // Implemented by the user

  /**
   * Called when the server is started for the first time.
   */
  // oxlint-disable-next-line no-unused-vars
  onStart(props?: Props): void | Promise<void> {}

  /**
   * Called when a new connection is made to the server.
   */
  onConnect(
    // oxlint-disable-next-line no-unused-vars
    connection: Connection,
    // oxlint-disable-next-line no-unused-vars
    ctx: ConnectionContext
  ): void | Promise<void> {
    // console.log(
    //   `Connection ${connection.id} connected to ${this.#ParentClass.name}:${this.name}`
    // );
    // console.log(
    //   `Implement onConnect on ${this.#ParentClass.name} to handle websocket connections.`
    // );
  }

  /**
   * Called when a message is received from a connection.
   */
  // oxlint-disable-next-line no-unused-vars
  onMessage(connection: Connection, message: WSMessage): void | Promise<void> {
    // console.log(
    //   `Received message on connection ${this.#ParentClass.name}:${connection.id}`
    // );
    // console.info(
    //   `Implement onMessage on ${this.#ParentClass.name} to handle this message.`
    // );
  }

  /**
   * Called when a connection is closed.
   */
  onClose(
    // oxlint-disable-next-line no-unused-vars
    connection: Connection,
    // oxlint-disable-next-line no-unused-vars
    code: number,
    // oxlint-disable-next-line no-unused-vars
    reason: string,
    // oxlint-disable-next-line no-unused-vars
    wasClean: boolean
  ): void | Promise<void> {}

  /**
   * Called when an error occurs on a connection.
   */
  onError(connection: Connection, error: unknown): void | Promise<void> {
    console.error(
      `Error on connection ${connection.id} in ${this.#ParentClass.name}:${this.name}:`,
      error
    );
    console.info(
      `Implement onError on ${this.#ParentClass.name} to handle this error.`
    );
  }

  /**
   * Called when a request is made to the server.
   */
  onRequest(request: Request): Response | Promise<Response> {
    // default to 404

    console.warn(
      `onRequest hasn't been implemented on ${this.#ParentClass.name}:${this.name} responding to ${request.url}`
    );

    return new Response("Not implemented", { status: 404 });
  }

  /**
   * Called when an exception occurs.
   * @param error - The error that occurred.
   */
  onException(error: unknown): void | Promise<void> {
    console.error(
      `Exception in ${this.#ParentClass.name}:${this.name}:`,
      error
    );
    console.info(
      `Implement onException on ${this.#ParentClass.name} to handle this error.`
    );
  }

  onAlarm(): void | Promise<void> {
    console.log(
      `Implement onAlarm on ${this.#ParentClass.name} to handle alarms.`
    );
  }

  async alarm(): Promise<void> {
    await this.#ensureInitialized();
    await this.runLifecycleAlarm();
    await this.onAlarm();
  }
}
