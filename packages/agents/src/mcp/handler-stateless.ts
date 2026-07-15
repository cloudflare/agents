import {
  createMcpHandler as createSdkMcpHandler,
  isLegacyRequest,
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
import { createStatelessLegacyRequestHandler } from "./handler-stateless-legacy";
import type { CORSOptions } from "./types";

export interface CreateStatelessMcpHandlerOptions extends SdkCreateMcpHandlerOptions {
  /** Exact pathname handled by this Worker wrapper. @default "/mcp" */
  route?: string;
  /** CORS headers applied by the Worker wrapper. Pass `false` to disable. */
  corsOptions?: CORSOptions | false;
  /**
   * Hostnames accepted from a present `Origin` header. Requests without an
   * Origin (including non-browser MCP clients) remain valid.
   * @default ["localhost", "127.0.0.1", "[::1]"]
   */
  allowedOriginHostnames?: string[];
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

function emptyExecutionContext(): ExecutionContext {
  return {
    props: {},
    waitUntil() {},
    passThroughOnException() {}
  } as unknown as ExecutionContext;
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
    allowedOriginHostnames = localhostAllowedOrigins(),
    authContext,
    legacy = "stateless",
    ...sdkOptions
  } = options;

  const sdkHandler = createSdkMcpHandler(factory, {
    ...sdkOptions,
    legacy: "reject"
  });
  const statelessLegacyHandler =
    legacy === "stateless"
      ? createStatelessLegacyRequestHandler(factory, route, sdkOptions.onerror)
      : undefined;
  let closed = false;

  const serve = async (
    request: Request,
    requestOptions?: McpHandlerRequestOptions,
    workerCtx?: ExecutionContext
  ): Promise<Response> => {
    if (closed) throw new Error("This MCP handler has been closed");

    if (new URL(request.url).pathname !== route) {
      return withCors(new Response("Not Found", { status: 404 }), corsOptions);
    }

    const originRejection = originValidationResponse(
      request,
      allowedOriginHostnames
    );
    if (originRejection) {
      return withCors(originRejection, corsOptions);
    }

    if (request.method === "OPTIONS" && corsOptions !== false) {
      return new Response(null, { headers: corsHeaders(corsOptions) });
    }

    const legacyRequest =
      statelessLegacyHandler !== undefined &&
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
        if (legacyRequest && statelessLegacyHandler) {
          return statelessLegacyHandler.fetch(
            request,
            upstreamOptions,
            resolvedAuthContext,
            workerCtx ?? emptyExecutionContext()
          );
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
      await Promise.all([sdkHandler.close(), statelessLegacyHandler?.close()]);
    }
  }) as StatelessMcpHandler;
}
