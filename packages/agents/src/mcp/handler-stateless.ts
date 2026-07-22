import {
  createMcpHandler as createSdkMcpHandler,
  hostHeaderValidationResponse,
  isLegacyRequest,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  type AuthInfo,
  type CreateMcpHandlerOptions as SdkCreateMcpHandlerOptions,
  type McpHandlerRequestOptions,
  type McpHttpHandler,
  type McpServerFactory
} from "@modelcontextprotocol/server";
import {
  getVerifiedOAuthAuthInfo,
  runWithAuthContext,
  type McpAuthContext
} from "./auth-context";
import { internalErrorResponse, reportHandlerError } from "./handler-errors";
import { createLegacyCompatibilityRequestHandler } from "./handler-legacy-compat";
import type { CORSOptions } from "./types";

export interface CreateStatelessMcpHandlerOptions extends SdkCreateMcpHandlerOptions {
  /** Exact pathname handled by this Worker wrapper. @default "/mcp" */
  route?: string;
  /** CORS headers applied by the Worker wrapper. Pass `false` to disable. */
  corsOptions?: CORSOptions | false;
  /**
   * Restrict `Host` headers to these hostnames. Localhost and `workers.dev`
   * endpoints receive matching defaults; custom domains rely on Cloudflare
   * routing unless this option is set.
   */
  allowedHostnames?: string[];
  /**
   * Restrict present browser `Origin` headers to these hostnames. Requests
   * without an Origin (including non-browser MCP clients) remain valid. The
   * default includes localhost-class Origins, the endpoint's `workers.dev`
   * hostname, and a concrete `corsOptions.origin` hostname. Pass `"*"` only
   * when equivalent Origin validation runs in trusted middleware upstream.
   */
  allowedOriginHostnames?: string[] | "*";
  /** Application props exposed through {@link getMcpAuthContext}. */
  authContext?: McpAuthContext;
}

export type StatelessMcpHandler = Omit<McpHttpHandler, "fetch"> & {
  (request: Request, env: unknown, ctx: ExecutionContext): Promise<Response>;
  fetch: {
    (request: Request, options?: McpHandlerRequestOptions): Promise<Response>;
    (request: Request, env: unknown, ctx: ExecutionContext): Promise<Response>;
  };
};

export type StatelessMcpServerInput = McpServerFactory;

const DEFAULT_CORS_OPTIONS: Required<CORSOptions> = {
  origin: "*",
  headers:
    "Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
  methods: "GET, POST, DELETE, OPTIONS",
  exposeHeaders: "mcp-session-id",
  maxAge: 86400
};

function corsHeaders(options: CORSOptions = {}): Headers {
  const merged = { ...DEFAULT_CORS_OPTIONS, ...options };
  return new Headers({
    "Access-Control-Allow-Headers": merged.headers,
    "Access-Control-Allow-Methods": merged.methods,
    "Access-Control-Allow-Origin": merged.origin,
    "Access-Control-Expose-Headers": merged.exposeHeaders,
    "Access-Control-Max-Age": String(merged.maxAge)
  });
}

function withCors(response: Response, options: CORSOptions | false): Response {
  const headers = new Headers(response.headers);
  if (options === false) {
    for (const name of Array.from(headers.keys())) {
      if (name.toLowerCase().startsWith("access-control-")) {
        headers.delete(name);
      }
    }
  } else {
    for (const [name, value] of corsHeaders(options)) {
      headers.set(name, value);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function wrapResponseBodyWithAuthContext(
  response: Response,
  authContext: McpAuthContext | undefined
): Response {
  if (!authContext || !response.body) return response;

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      return runWithAuthContext(authContext, async () => {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          controller.error(error);
        }
      });
    },
    cancel(reason) {
      return runWithAuthContext(authContext, () => reader.cancel(reason));
    }
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

export function createStatelessMcpHandler(
  factory: StatelessMcpServerInput,
  options: CreateStatelessMcpHandlerOptions = {}
): StatelessMcpHandler {
  const optionRecord = options as Record<string, unknown>;
  const legacyOnlyOption = [
    "transport",
    "storage",
    "sessionIdGenerator",
    "onsessioninitialized",
    "onsessionclosed",
    "enableJsonResponse",
    "eventStore",
    "allowedHosts",
    "allowedOrigins",
    "enableDnsRebindingProtection",
    "retryInterval"
  ].find((key) => optionRecord[key] !== undefined);
  if (legacyOnlyOption) {
    throw new TypeError(
      `createMcpHandler option "${legacyOnlyOption}" is only supported with an MCP SDK v1 server. The managed SDK v2 handler is stateless; remove this option or keep the v1 server during migration.`
    );
  }

  const {
    route = "/mcp",
    corsOptions = {},
    allowedHostnames,
    allowedOriginHostnames,
    authContext,
    legacy = "stateless",
    ...sdkOptions
  } = options;

  const sdkHandler = createSdkMcpHandler(factory, {
    ...sdkOptions,
    legacy: "reject"
  });
  const legacyCompatibilityHandler =
    legacy === "stateless"
      ? createLegacyCompatibilityRequestHandler(factory, sdkOptions.onerror)
      : undefined;
  let closed = false;

  const serve = async (
    request: Request,
    requestOptions?: McpHandlerRequestOptions,
    workerCtx?: ExecutionContext
  ): Promise<Response> => {
    if (closed) throw new Error("This MCP handler has been closed");

    const requestUrl = new URL(request.url);
    if (requestUrl.pathname !== route) {
      return withCors(new Response("Not Found", { status: 404 }), corsOptions);
    }

    // The SDK app factories can distinguish their bind address from an
    // attacker-controlled Host header. A bare Worker cannot. Use defaults we
    // can establish independently: localhost-class names, a standard
    // workers.dev route, and any concrete CORS Origin the application chose.
    // Custom-domain deployments can provide explicit Host and Origin lists.
    const localEndpoint = localhostAllowedHostnames().includes(
      requestUrl.hostname
    );
    const workersDevEndpoint = requestUrl.hostname.endsWith(".workers.dev");
    const acceptedHostnames =
      allowedHostnames ??
      (localEndpoint
        ? localhostAllowedHostnames()
        : workersDevEndpoint
          ? [requestUrl.hostname]
          : undefined);
    const hostRejection = acceptedHostnames
      ? hostHeaderValidationResponse(request, acceptedHostnames)
      : undefined;
    if (hostRejection) {
      return withCors(hostRejection, corsOptions);
    }
    if (allowedOriginHostnames !== "*") {
      let acceptedOriginHostnames = allowedOriginHostnames;
      if (acceptedOriginHostnames === undefined) {
        const defaults = new Set(localhostAllowedOrigins());
        if (workersDevEndpoint) defaults.add(requestUrl.hostname);
        if (corsOptions !== false && corsOptions.origin !== undefined) {
          try {
            const configuredOrigin = new URL(corsOptions.origin);
            if (
              (configuredOrigin.protocol === "http:" ||
                configuredOrigin.protocol === "https:") &&
              configuredOrigin.hostname
            ) {
              defaults.add(configuredOrigin.hostname);
            }
          } catch {
            // A wildcard or malformed CORS value does not expand the allowlist.
          }
        }
        acceptedOriginHostnames = [...defaults];
      }
      const originRejection = originValidationResponse(
        request,
        acceptedOriginHostnames ?? []
      );
      if (originRejection) {
        return withCors(originRejection, corsOptions);
      }
    }

    if (request.method === "OPTIONS" && corsOptions !== false) {
      return new Response(null, { headers: corsHeaders(corsOptions) });
    }

    const legacyRequest =
      legacyCompatibilityHandler !== undefined &&
      (await isLegacyRequest(request, requestOptions?.parsedBody));
    if (closed) throw new Error("This MCP handler has been closed");

    try {
      const verified = workerCtx
        ? getVerifiedOAuthAuthInfo(workerCtx)
        : undefined;
      const explicitAuthInfo = requestOptions?.authInfo;
      if (
        verified &&
        explicitAuthInfo &&
        explicitAuthInfo.clientId !== verified.authInfo.clientId
      ) {
        throw new TypeError("Conflicting verified OAuth client identity");
      }

      const authInfo: AuthInfo | undefined =
        explicitAuthInfo ?? verified?.authInfo;
      const resolvedAuthContext =
        authContext ??
        (verified
          ? { props: verified.props }
          : workerCtx?.props && Object.keys(workerCtx.props).length > 0
            ? { props: workerCtx.props as Record<string, unknown> }
            : undefined);
      const upstreamOptions: McpHandlerRequestOptions | undefined =
        requestOptions || authInfo
          ? { ...requestOptions, ...(authInfo && { authInfo }) }
          : undefined;
      const invoke = async () => {
        if (legacyRequest && legacyCompatibilityHandler) {
          return legacyCompatibilityHandler.fetch(request, upstreamOptions);
        }
        return sdkHandler.fetch(request, upstreamOptions);
      };
      const response = resolvedAuthContext
        ? await runWithAuthContext(resolvedAuthContext, invoke)
        : await invoke();
      return withCors(
        wrapResponseBodyWithAuthContext(response, resolvedAuthContext),
        corsOptions
      );
    } catch (error) {
      reportHandlerError(sdkOptions.onerror, error);
      return withCors(internalErrorResponse(), corsOptions);
    }
  };

  const callable = (request: Request, _env: unknown, ctx: ExecutionContext) =>
    serve(request, undefined, ctx);
  const fetch = (
    request: Request,
    optionsOrEnv?: McpHandlerRequestOptions | unknown,
    ctx?: ExecutionContext
  ) =>
    ctx
      ? serve(request, undefined, ctx)
      : serve(request, optionsOrEnv as McpHandlerRequestOptions | undefined);

  return Object.assign(callable, {
    fetch,
    notify: sdkHandler.notify,
    bus: sdkHandler.bus,
    close: async () => {
      closed = true;
      await Promise.all([
        sdkHandler.close(),
        legacyCompatibilityHandler?.close()
      ]);
    }
  }) as StatelessMcpHandler;
}
