import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  WorkerTransport,
  type WorkerTransportOptions
} from "./worker-transport";
import { runWithAuthContext, type McpAuthContext } from "./auth-context";

/** Options for the retained SDK v1, sessionful handler. */
export interface CreateLegacyMcpHandlerOptions extends WorkerTransportOptions {
  /** Exact route handled by this handler. @default "/mcp" */
  route?: string;
  /** Application props exposed through {@link getMcpAuthContext}. */
  authContext?: McpAuthContext;
  /** Pre-created sessionful transport. */
  transport?: WorkerTransport;
}

export type CreateMcpHandlerOptions = CreateLegacyMcpHandlerOptions;

export type LegacyMcpHandler = (
  request: Request,
  env: unknown,
  ctx: ExecutionContext
) => Promise<Response>;

/**
 * Create a sessionful Legacy MCP handler backed by SDK v1.
 *
 * New Stateless servers should use `createMcpHandler` from
 * `agents/mcp/server` instead.
 */
export function createLegacyMcpHandler(
  server: McpServer | Server,
  options: CreateLegacyMcpHandlerOptions = {}
): LegacyMcpHandler {
  const route = options.route ?? "/mcp";
  const {
    route: _route,
    authContext,
    transport: providedTransport,
    ...transportOptions
  } = options;

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
      providedTransport ?? new WorkerTransport(transportOptions);
    const resolvedAuthContext =
      authContext ??
      (ctx.props && Object.keys(ctx.props).length > 0
        ? { props: ctx.props as Record<string, unknown> }
        : undefined);

    // A supplied sessionful transport may already be connected. A newly
    // created transport must never attach to a server owned by another
    // session/request.
    if (!transport.started) {
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

    const handleRequest = () => transport.handleRequest(request);
    try {
      return resolvedAuthContext
        ? await runWithAuthContext(resolvedAuthContext, handleRequest)
        : await handleRequest();
    } catch (error) {
      console.error("MCP handler error:", error);
      return Response.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message:
              error instanceof Error ? error.message : "Internal server error"
          },
          id: null
        },
        { status: 500 }
      );
    }
  };
}
