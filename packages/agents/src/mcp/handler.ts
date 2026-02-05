import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  WorkerTransport,
  type WorkerTransportOptions
} from "./worker-transport";
import { runWithAuthContext, type McpAuthContext } from "./auth-context";

export interface CreateMcpHandlerOptions extends WorkerTransportOptions {
  /**
   * The route path that this MCP handler should respond to.
   * If specified, the handler will only process requests that match this route.
   * @default "/mcp"
   */
  route?: string;
  /**
   * An optional auth context to use for handling MCP requests.
   * If not provided, the handler will look for props in the execution context.
   */
  authContext?: McpAuthContext;
  /**
   * An optional transport to use for handling MCP requests.
   * If not provided, a WorkerTransport will be created with the provided WorkerTransportOptions.
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

    const transport =
      options.transport ??
      new WorkerTransport({
        sessionIdGenerator: options.sessionIdGenerator,
        enableJsonResponse: options.enableJsonResponse,
        onsessioninitialized: options.onsessioninitialized,
        corsOptions: options.corsOptions,
        storage: options.storage
      });

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

    // Guard for stateful usage where a pre-connected transport is passed via options.
    // If someone passes a transport that's already connected to this server, skip reconnecting.
    // Note: If a developer incorrectly uses a global server with per-request transports,
    // the MCP SDK 1.26.0+ will throw an error when trying to connect an already-connected server.
    if (!transport.started) {
      // Check if server is already connected (McpServer has isConnected(), Server uses transport getter)
      const isServerConnected =
        server instanceof McpServer
          ? server.isConnected()
          : server.transport !== undefined;

      if (isServerConnected) {
        throw new Error(
          "Server is already connected to a transport. Create a new McpServer instance per request for stateless handlers."
        );
      }

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
