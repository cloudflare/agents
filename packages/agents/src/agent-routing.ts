import type { Agent } from "./index";
import { camelCaseToKebabCase } from "./utils";

const namespaceMapCache = new WeakMap<
  object,
  Record<string, DurableObjectNamespace>
>();
const bindingNameCache = new WeakMap<object, Record<string, string>>();

const DEFAULT_ROUTING_RETRY_OPTIONS = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 800
};

interface RoutingRetryEvent {
  error: unknown;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  name: string;
  className?: string;
}

/** Retry policy for Agent routing infrastructure failures. */
export interface RoutingRetryOptions {
  /** Max number of attempts, including the first. Default: 3. */
  maxAttempts?: number;
  /** Base delay in milliseconds for exponential backoff. Default: 100. */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds. Default: 800. */
  maxDelayMs?: number;
  /** Optional callback invoked before each retry delay. */
  onRetry?: (event: RoutingRetryEvent) => void | Promise<void>;
}

interface AgentRouteMatch<Env = Cloudflare.Env> {
  /** The Durable Object environment binding name. */
  className: Extract<keyof Env, string>;
  /** The named Durable Object instance extracted from the URL. */
  name: string;
}

interface AgentRouteOptions<
  Env = Cloudflare.Env,
  Props extends Record<string, unknown> = Record<string, unknown>
> {
  /** URL prefix before the binding and instance name. Default: `agents`. */
  prefix?: string;
  jurisdiction?: DurableObjectJurisdiction;
  locationHint?: DurableObjectLocationHint;
  /** Properties supplied before lifecycle startup. */
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
   * For credentialed requests, pass explicit headers with a specific origin.
   * When set to a `HeadersInit` value, uses those as the CORS headers instead.
   * CORS preflight requests are handled automatically for matched routes.
   */
  cors?: boolean | HeadersInit;
  /**
   * Retry transient Durable Object infrastructure errors thrown while routing.
   * Enabled by default; pass `false` to disable.
   */
  routingRetry?: false | RoutingRetryOptions;
  onBeforeConnect?: (
    request: Request,
    route: AgentRouteMatch<Env>
  ) => Response | Request | void | Promise<Response | Request | void>;
  onBeforeRequest?: (
    request: Request,
    route: AgentRouteMatch<Env>
  ) =>
    | Response
    | Request
    | void
    | Promise<Response | Request | undefined | void>;
}

/** Configuration options for {@link routeAgentRequest}. */
export type AgentOptions<Env> = AgentRouteOptions<Env>;

/** Options for resolving and starting a named Agent. */
export type AgentGetOptions<
  Env,
  Props extends Record<string, unknown> = Record<string, unknown>
> = Pick<
  AgentRouteOptions<Env, Props>,
  "jurisdiction" | "locationHint" | "props" | "routingRetry"
>;

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
  // SAFETY: Cloudflare's retryable and overloaded error flags are optional
  // runtime properties not represented on the base Error type.
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
          "Durable Object routing retry callback failed:",
          callbackError
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt = nextAttempt;
    }
  }
}

function encodeLifecycleProps(props: unknown): string {
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
    const headers = new Headers(cors);
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  return null;
}

/**
 * Route `/agents/:binding/:name` HTTP and WebSocket requests to a named
 * Durable Object. The target may extend `Agent` or compose `Lifecycle`
 * directly into a plain `DurableObject`.
 *
 * @param request - Incoming Worker request.
 * @param env - Worker environment containing Durable Object bindings.
 * @param options - Routing options.
 * @returns The matched response, or `null` when the path does not match.
 */
export async function routeAgentRequest<Env>(
  request: Request,
  env: Env,
  options?: AgentOptions<Env>
): Promise<Response | null> {
  // SAFETY: Worker environments are object records. The unconstrained Env
  // generic is retained for compatibility with the previously published API.
  const environment = env as object;
  if (!namespaceMapCache.has(environment)) {
    const namespaceMap: Record<string, DurableObjectNamespace> = {};
    const bindingNames: Record<string, string> = {};
    for (const [key, value] of Object.entries(environment)) {
      if (
        value &&
        typeof value === "object" &&
        "idFromName" in value &&
        typeof value.idFromName === "function"
      ) {
        const kebab = camelCaseToKebabCase(key);
        // SAFETY: The structural idFromName check above identifies a Durable
        // Object namespace at the Worker environment boundary.
        namespaceMap[kebab] = value as DurableObjectNamespace;
        bindingNames[kebab] = key;
      }
    }
    namespaceMapCache.set(environment, namespaceMap);
    bindingNameCache.set(environment, bindingNames);
  }

  const map = namespaceMapCache.get(environment) as Record<
    string,
    DurableObjectNamespace
  >;
  const bindingNames = bindingNameCache.get(environment) as Record<
    string,
    string
  >;
  const prefixParts = (options?.prefix || "agents").split("/");
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const prefixMatches = prefixParts.every(
    (part, index) => parts[index] === part
  );
  if (!prefixMatches || parts.length < prefixParts.length + 2) return null;

  const namespaceName = parts[prefixParts.length];
  const name = parts[prefixParts.length + 1];
  if (!name || !namespaceName) return null;

  const boundNamespace = map[namespaceName];
  if (!boundNamespace) {
    console.error(
      `The URL ${request.url} with namespace "${namespaceName}" and name "${name}" does not match any Durable Object binding.`
    );
    return new Response("Invalid request", { status: 400 });
  }

  const corsHeaders = resolveCorsHeaders(options?.cors);
  const isWebSocket =
    request.headers.get("Upgrade")?.toLowerCase() === "websocket";
  const withCorsHeaders = (response: Response): Response => {
    if (!corsHeaders || isWebSocket) return response;
    const nextResponse = new Response(response.body, response);
    for (const [key, value] of Object.entries(corsHeaders)) {
      nextResponse.headers.set(key, value);
    }
    return nextResponse;
  };

  if (request.method === "OPTIONS" && corsHeaders) {
    return new Response(null, { headers: corsHeaders });
  }

  const namespace = options?.jurisdiction
    ? boundNamespace.jurisdiction(options.jurisdiction)
    : boundNamespace;
  const id = namespace.idFromName(name);
  const getOptions = durableObjectGetOptions(options);
  request = mutableRequest(request);

  // SAFETY: binding names come directly from Object.entries(env), so they are
  // string keys of Env.
  const className = bindingNames[namespaceName] as Extract<keyof Env, string>;
  const route: AgentRouteMatch<Env> = { className, name };

  if (isWebSocket) {
    const requestOrResponse = await options?.onBeforeConnect?.(request, route);
    if (requestOrResponse instanceof Request) {
      request = mutableRequest(requestOrResponse);
    } else if (requestOrResponse instanceof Response) {
      return requestOrResponse;
    }
  } else {
    const requestOrResponse = await options?.onBeforeRequest?.(request, route);
    if (requestOrResponse instanceof Request) {
      request = mutableRequest(requestOrResponse);
    } else if (requestOrResponse instanceof Response) {
      return withCorsHeaders(requestOrResponse);
    }
  }

  if (options?.props !== undefined) {
    request.headers.set(
      "x-agents-lifecycle-props",
      encodeLifecycleProps(options.props)
    );
  }

  const response = await retryDurableObjectOperation(
    () => namespace.get(id, getOptions).fetch(cloneRequestForFetch(request)),
    { name, className },
    options?.routingRetry
  );
  return isWebSocket ? response : withCorsHeaders(response);
}

/**
 * Get a named Agent stub after its lifecycle startup has completed.
 *
 * @param namespace - Agent Durable Object namespace.
 * @param name - Agent instance name.
 * @param options - Placement, startup properties, and retry options.
 * @returns The initialized Agent stub.
 */
export async function getAgentByName<
  Env extends Cloudflare.Env = Cloudflare.Env,
  T extends Agent<Env> = Agent<Env>,
  Props extends Record<string, unknown> = Record<string, unknown>
>(
  namespace: DurableObjectNamespace<T>,
  name: string,
  options?: AgentGetOptions<Env, Props>
): Promise<DurableObjectStub<T>> {
  const target = options?.jurisdiction
    ? namespace.jurisdiction(options.jurisdiction)
    : namespace;
  const id = target.idFromName(name);
  const stub = target.get(id, durableObjectGetOptions(options));

  // SAFETY: Agent exposes this internal initializer specifically for native
  // RPC calls, which bypass the lifecycle-installed fetch handler.
  const lifecycleStub = stub as unknown as {
    __unsafe_ensureInitialized(props?: Props): Promise<void>;
  };
  await retryDurableObjectOperation(
    () => lifecycleStub.__unsafe_ensureInitialized(options?.props),
    { name },
    options?.routingRetry
  );

  return stub;
}
