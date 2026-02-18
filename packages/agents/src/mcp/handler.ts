import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { runWithAuthContext, type McpAuthContext } from "./auth-context";
import type { CORSOptions } from "./types";
import { corsHeaders, handleCORS } from "./utils";

export interface CreateMcpHandlerOptions {
  /**
   * The route path that this MCP handler should respond to.
   * If specified, the handler will only process requests that match this route.
   * @default "/mcp"
   */
  route?: string;
  /**
   * CORS options for the handler.
   */
  corsOptions?: CORSOptions;
  /**
   * An optional auth context to use for handling MCP requests.
   * If not provided, the handler will look for props in the execution context.
   */
  authContext?: McpAuthContext;
}

export function createMcpHandler(
  serverFactory: () => McpServer | Server,
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
    const url = new URL(request.url);
    if (route && url.pathname !== route) {
      return new Response("Not Found", { status: 404 });
    }

    // Handle CORS preflight
    const corsResponse = handleCORS(request, options.corsOptions);
    if (corsResponse) {
      return corsResponse;
    }

    const buildAuthContext = () => {
      if (options.authContext) {
        return options.authContext;
      }

      if (ctx.props && Object.keys(ctx.props).length > 0) {
        return {
          props: ctx.props as Record<string, unknown>
        };
      }

      return undefined;
    };

    const handleRequest = async () => {
      // Create a fresh server + transport per request (stateless mode)
      const server = serverFactory();
      const transport = new WebStandardStreamableHTTPServerTransport();

      await server.connect(transport);
      const response = await transport.handleRequest(request);
      // Add CORS headers to the response
      const headers = corsHeaders(request, options.corsOptions);
      for (const [key, value] of Object.entries(headers)) {
        response.headers.set(key, value);
      }
      return response;
    };

    const authContext = buildAuthContext();

    try {
      if (authContext) {
        return await runWithAuthContext(authContext, handleRequest);
      } else {
        return await handleRequest();
      }
    } catch (error) {
      console.error("MCP handler error:", error);

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
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  };
}

let didWarnAboutExperimentalCreateMcpHandler = false;

/**
 * @deprecated This has been renamed to createMcpHandler, and experimental_createMcpHandler will be removed in the next major version
 */
export function experimental_createMcpHandler(
  serverFactory: () => McpServer | Server,
  options: CreateMcpHandlerOptions = {}
): (
  request: Request,
  env: unknown,
  ctx: ExecutionContext
) => Promise<Response> {
  if (!didWarnAboutExperimentalCreateMcpHandler) {
    didWarnAboutExperimentalCreateMcpHandler = true;
    console.warn(
      "experimental_createMcpHandler is deprecated, use createMcpHandler instead. experimental_createMcpHandler will be removed in the next major version."
    );
  }
  return createMcpHandler(serverFactory, options);
}
