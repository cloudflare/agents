import {
  McpServer,
  Server,
  createMcpHandler as createSdkMcpHandler,
  isJSONRPCRequest,
  isLegacyRequest,
  type AuthInfo,
  type CreateMcpHandlerOptions as SdkCreateMcpHandlerOptions,
  type McpHandlerRequestOptions,
  type McpHttpHandler,
  type McpRequestContext,
  type McpServerFactory
} from "@modelcontextprotocol/server";
import {
  getVerifiedOAuthAuthInfo,
  runWithAuthContext,
  type McpAuthContext
} from "./auth-context";
import { createLegacyMcpHandler } from "./handler-legacy";
import {
  WorkerTransport,
  withoutLegacyTransportWarning
} from "./worker-transport";
import type { CORSOptions } from "./types";

export interface CreateStatelessMcpHandlerOptions extends SdkCreateMcpHandlerOptions {
  /** Exact pathname handled by this Worker wrapper. @default "/mcp" */
  route?: string;
  /** CORS headers applied by the Worker wrapper. Pass `false` to disable. */
  corsOptions?: CORSOptions | false;
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

export type StatelessMcpServerInput = McpServer | Server | McpServerFactory;

const DEFAULT_CORS_OPTIONS: Required<CORSOptions> = {
  origin: "*",
  headers:
    "Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version",
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

function internalErrorResponse(id: string | number | null = null): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id
    },
    { status: 500 }
  );
}

function requestIdFromParsedBody(body: unknown): string | number | null {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !("method" in body) ||
    typeof body.method !== "string" ||
    !("id" in body)
  ) {
    return null;
  }
  return typeof body.id === "string" || typeof body.id === "number"
    ? body.id
    : null;
}

function reportError(
  onerror: ((error: Error) => void) | undefined,
  error: unknown
): void {
  try {
    onerror?.(error instanceof Error ? error : new Error(String(error)));
  } catch {
    // Error reporting must not change the response.
  }
}

function isV2Server(value: unknown): value is McpServer | Server {
  return value instanceof McpServer || value instanceof Server;
}

function unsupportedFactoryProduct(value: unknown): TypeError {
  const name =
    typeof value === "object" && value !== null
      ? value.constructor?.name
      : typeof value;
  return new TypeError(
    `createMcpHandler factory returned unsupported ${name ?? "value"}. ` +
      'Return the McpServer or Server exported by "@modelcontextprotocol/server".'
  );
}

function wrapFactory(factory: McpServerFactory): McpServerFactory {
  return async (context: McpRequestContext) => {
    const product = await factory(context);
    if (!isV2Server(product)) throw unsupportedFactoryProduct(product);
    return product;
  };
}

const STATELESS_LEGACY_REVERSE_REQUEST_ERROR =
  "Server-to-client requests are unavailable in stateless legacy mode. " +
  "Use inputRequired(...) for MCP 2026-07-28 clients, or route 2025-era " +
  "traffic to a sessionful transport.";

function emptyExecutionContext(): ExecutionContext {
  return {
    props: {},
    waitUntil() {},
    passThroughOnException() {}
  } as unknown as ExecutionContext;
}

function createLegacyRequestHandler(
  factory: McpServerFactory,
  route: string,
  onerror?: (error: Error) => void
) {
  return async (
    request: Request,
    options: McpHandlerRequestOptions | undefined,
    authContext: McpAuthContext | undefined,
    workerCtx: ExecutionContext | undefined
  ): Promise<Response> => {
    let product: McpServer | Server | undefined;
    let transport: WorkerTransport | undefined;
    let toreDown = false;
    const teardown = () => {
      if (toreDown) return;
      toreDown = true;
      void transport?.close().catch(() => {});
      void product?.close().catch(() => {});
    };

    try {
      product = await factory({
        era: "legacy",
        ...(options?.authInfo !== undefined && {
          authInfo: options.authInfo
        }),
        requestInfo: request
      });
      transport = withoutLegacyTransportWarning(
        () => new WorkerTransport({ sessionIdGenerator: undefined })
      );

      const send = transport.send.bind(transport);
      transport.send = async (message, sendOptions) => {
        if (isJSONRPCRequest(message)) {
          transport?.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32603,
              message: STATELESS_LEGACY_REVERSE_REQUEST_ERROR
            }
          });
          return;
        }
        await send(message, sendOptions);
      };

      const handler = createLegacyMcpHandler(
        product as never,
        {
          route,
          transport,
          ...(authContext !== undefined && { authContext })
        },
        {
          ...(options?.authInfo !== undefined && {
            authInfo: options.authInfo
          }),
          ...(options?.parsedBody !== undefined && {
            parsedBody: options.parsedBody
          })
        }
      );
      request.signal.addEventListener("abort", teardown, { once: true });
      const response = await handler(
        request,
        undefined,
        workerCtx ?? emptyExecutionContext()
      );

      if (
        response.body === null ||
        !response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        teardown();
        return response;
      }

      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              teardown();
              controller.close();
            } else if (value !== undefined) {
              controller.enqueue(value);
            }
          } catch (error) {
            teardown();
            controller.error(error);
          }
        },
        cancel(reason) {
          teardown();
          return reader.cancel(reason).catch(() => {});
        }
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (error) {
      teardown();
      reportError(onerror, error);
      return internalErrorResponse(
        requestIdFromParsedBody(options?.parsedBody)
      );
    }
  };
}

const CONCURRENT_INSTANCE_ERROR =
  "createMcpHandler received concurrent requests for one McpServer instance.\n" +
  "Cloudflare Workers can run requests concurrently within an isolate. Pass a\n" +
  "factory (() => new McpServer(...)) to create an isolated server per request.";

type InstanceLease = {
  begin(): void;
  factory: McpServerFactory;
  releaseUnused(): void;
  closeActive(): Promise<void>;
};

function createInstanceLease(instance: McpServer | Server): InstanceLease {
  let active = false;
  let consumed = false;
  let closeActive: (() => Promise<void>) | undefined;

  return {
    begin() {
      if (active) throw new Error(CONCURRENT_INSTANCE_ERROR);
      active = true;
      consumed = false;
    },
    factory: async () => {
      if (!active || consumed) {
        throw new Error("MCP server instance lease was not available");
      }
      consumed = true;

      const protocol =
        instance instanceof McpServer ? instance.server : instance;
      const previousOnClose = protocol.onclose;
      const originalClose = instance.close.bind(instance);
      let released = false;

      const release = () => {
        if (released) return;
        released = true;
        active = false;
        consumed = false;
        closeActive = undefined;
        protocol.onclose = previousOnClose;
        const mutableInstance = instance as unknown as {
          close?: () => Promise<void>;
        };
        delete mutableInstance.close;
      };

      protocol.onclose = () => {
        release();
        previousOnClose?.();
      };

      const close = async () => {
        try {
          await originalClose();
        } finally {
          release();
        }
      };
      Object.defineProperty(instance, "close", {
        value: close,
        writable: true,
        configurable: true
      });
      closeActive = close;
      return instance;
    },
    releaseUnused() {
      if (active && !consumed) active = false;
    },
    async closeActive() {
      await closeActive?.();
    }
  };
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
  serverOrFactory: StatelessMcpServerInput,
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
    authContext,
    legacy = "stateless",
    ...sdkOptions
  } = options;

  const lease =
    typeof serverOrFactory === "function"
      ? undefined
      : createInstanceLease(serverOrFactory);
  const factory =
    typeof serverOrFactory === "function"
      ? wrapFactory(serverOrFactory)
      : lease!.factory;
  const sdkHandler = createSdkMcpHandler(factory, {
    ...sdkOptions,
    legacy: "reject"
  });
  const statelessLegacyHandler =
    legacy === "stateless"
      ? createLegacyRequestHandler(factory, route, sdkOptions.onerror)
      : undefined;

  const serve = async (
    request: Request,
    requestOptions?: McpHandlerRequestOptions,
    workerCtx?: ExecutionContext
  ): Promise<Response> => {
    if (new URL(request.url).pathname !== route) {
      return withCors(new Response("Not Found", { status: 404 }), corsOptions);
    }

    if (request.method === "OPTIONS" && corsOptions !== false) {
      return new Response(null, { headers: corsHeaders(corsOptions) });
    }

    const legacyRequest =
      statelessLegacyHandler !== undefined &&
      (await isLegacyRequest(request, requestOptions?.parsedBody));

    lease?.begin();

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
          return statelessLegacyHandler(
            request,
            upstreamOptions,
            resolvedAuthContext,
            workerCtx
          );
        }
        return sdkHandler.fetch(request, upstreamOptions);
      };
      const response = resolvedAuthContext
        ? await runWithAuthContext(resolvedAuthContext, invoke)
        : await invoke();
      lease?.releaseUnused();
      return withCors(
        wrapResponseBodyWithAuthContext(response, resolvedAuthContext),
        corsOptions
      );
    } catch (error) {
      lease?.releaseUnused();
      reportError(sdkOptions.onerror, error);
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
      await sdkHandler.close();
      await lease?.closeActive();
    }
  }) as StatelessMcpHandler;
}
