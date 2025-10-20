import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  WorkerTransport,
  type WorkerTransportOptions
} from "./worker-transport";
import { runWithAuthContext, type McpAuthContext } from "./auth-context";

export interface OAuthProvider {
  validateToken(token: string): Promise<{
    userId: string;
    clientId: string;
    scopes: string[];
    props: Record<string, unknown>;
  } | null>;
}

export interface CreateMcpHandlerOptions extends WorkerTransportOptions {
  oauthProvider?: OAuthProvider;
}

export function experimental_createMcpHandler(
  server: McpServer | Server,
  options: CreateMcpHandlerOptions = {}
): (
  request: Request,
  env: unknown,
  ctx: ExecutionContext
) => Promise<Response> {
  const { oauthProvider, ...transportOptions } = options;

  return async (
    request: Request,
    _env: unknown,
    _ctx: ExecutionContext
  ): Promise<Response> => {
    let authContext: McpAuthContext | undefined;

    if (oauthProvider) {
      const authHeader = request.headers.get("Authorization");
      if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        try {
          const tokenInfo = await oauthProvider.validateToken(token);
          if (tokenInfo) {
            authContext = {
              userId: tokenInfo.userId,
              clientId: tokenInfo.clientId,
              scopes: tokenInfo.scopes,
              props: tokenInfo.props
            };
          }
        } catch (error) {
          console.error("OAuth token validation error:", error);
        }
      }

      if (!authContext) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Unauthorized: Valid Bearer token required"
            },
            id: null
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const transport = new WorkerTransport(transportOptions);
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

      return response;
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
