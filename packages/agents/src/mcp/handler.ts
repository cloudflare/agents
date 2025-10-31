import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  WorkerTransport,
  type WorkerTransportOptions
} from "./worker-transport";
import { runWithAuthContext, type McpAuthContext } from "./auth-context";
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
   * These options are passed to the WorkerTransport which handles adding
   * CORS headers to all responses.
   *
   * Default values are:
   * - origin: "*"
   * - headers: "Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version"
   * - methods: "GET, POST, DELETE, OPTIONS"
   * - exposeHeaders: "mcp-session-id"
   * - maxAge: 86400
   *
   * Provided options will overwrite the defaults.
   */
  corsOptions?: CORSOptions;
  /**
   * An optional auth info to use for handling MCP requests.
   * If not provided, the handler will look for props in the execution context.
   */
  authContext?: McpAuthContext;
  /**
   * An optional transport to use for handling MCP requests.
   * If not provided, a new WorkerTransport will be created. Note if you override this you should set your
   */
  transport?: WorkerTransport;
}

export function createMcpHandler(
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
    const url = new URL(request.url);
    if (route && url.pathname !== route) {
      return new Response("Not Found", { status: 404 });
    }

    const transport = options.transport ?? new WorkerTransport();

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
      return await transport.handleRequest(request);
    };

    const authContext = buildAuthContext();

    if (!transport.started) {
      await server.connect(transport);
    }

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
  server: McpServer | Server,
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
  return createMcpHandler(server, options);
}
