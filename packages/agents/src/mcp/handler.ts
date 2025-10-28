import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  WorkerTransport,
  type WorkerTransportOptions
} from "./worker-transport";
import { runWithAuthContext, type McpAuthContext } from "./auth-context";
import { handleCORS, corsHeaders } from "./utils";
import type { CORSOptions } from "./types";

export interface CreateMcpHandlerOptions extends WorkerTransportOptions {
  /**
   * The route path that this MCP handler should respond to.
   * If specified, the handler will only process requests that match this route.
   * @default "/mcp"
   */
  route?: string;
  /**
   * CORS configuration options for handling cross-origin requests.
   * If provided, the handler will add appropriate CORS headers to responses
   * and handle OPTIONS preflight requests.
   */
  corsOptions?: CORSOptions;
}

export type OAuthExecutionContext = ExecutionContext & {
  props?: Record<string, unknown>;
};

export function experimental_createMcpHandler(
  server: McpServer | Server,
  options: CreateMcpHandlerOptions = {}
): (
  request: Request,
  env: unknown,
  ctx: ExecutionContext
) => Promise<Response> {
  const route = options.route ?? "/mcp";

  return async (
    request: Request,
    _env: unknown,
    ctx: ExecutionContext
  ): Promise<Response> => {
    // Check if the request path matches the configured route
    const url = new URL(request.url);
    if (route && url.pathname !== route) {
      return new Response("Not Found", { status: 404 });
    }

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      if (options.corsOptions) {
        const corsResponse = handleCORS(request, options.corsOptions);
        if (corsResponse) {
          return corsResponse;
        }
      } else {
        // No CORS configured, return a plain OPTIONS response without CORS headers
        return new Response(null, { status: 204 });
      }
    }

    const oauthCtx = ctx as OAuthExecutionContext;
    const authContext: McpAuthContext | undefined = oauthCtx.props
      ? { props: oauthCtx.props }
      : undefined;

    const transport = new WorkerTransport(options);
    await server.connect(transport);

    const handleRequest = async () => {
      return await transport.handleRequest(request);
    };

    try {
      let response: Response;

      if (authContext) {
        response = await runWithAuthContext(authContext, handleRequest);
      } else {
        response = await handleRequest();
      }

      // Add CORS headers if configured
      if (options.corsOptions) {
        const headers = new Headers(response.headers);
        const cors = corsHeaders(request, options.corsOptions);
        for (const [key, value] of Object.entries(cors)) {
          headers.set(key, value);
        }
        response = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      }

      return response;
    } catch (error) {
      console.error("MCP handler error:", error);

      const errorHeaders: HeadersInit = { "Content-Type": "application/json" };

      // Add CORS headers to error response if configured
      if (options.corsOptions) {
        Object.assign(errorHeaders, corsHeaders(request, options.corsOptions));
      }

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message:
              error instanceof Error ? error.message : "Internal server error"
          },
          id: null
        }),
        { status: 500, headers: errorHeaders }
      );
    }
  };
}
