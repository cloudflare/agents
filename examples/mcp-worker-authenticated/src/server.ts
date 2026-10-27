import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { AuthHandler } from "./auth-handler";

function createServer() {
  const server = new McpServer({
    name: "Authenticated MCP Server",
    version: "1.0.0"
  });

  server.registerTool(
    "hello",
    {
      description: "Returns a greeting message",
      inputSchema: { name: z.string().optional() }
    },
    async ({ name }) => {
      const auth = getMcpAuthContext();
      const username = auth?.props?.username as string | undefined;

      return {
        content: [
          {
            text: `Hello, ${name ?? username ?? "World"}!`,
            type: "text"
          }
        ]
      };
    }
  );

  server.registerTool(
    "whoami",
    {
      description: "Returns information about the authenticated user"
    },
    async (context) => {
      const auth = getMcpAuthContext();

      if (!auth) {
        return {
          content: [
            {
              text: "No authentication context available",
              type: "text"
            }
          ]
        };
      }

      return {
        content: [
          {
            text: JSON.stringify(
              {
                userId: auth.props?.userId,
                username: auth.props?.username,
                email: auth.props?.email,
                clientId: context.http?.authInfo?.clientId,
                scopes: context.http?.authInfo?.scopes
              },
              null,
              2
            ),
            type: "text"
          }
        ]
      };
    }
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer);

const oauthProvider = new OAuthProvider<Env>({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",

  apiRoute: "/mcp",
  // OAuthProvider needs an object with a fetch method, not a function.
  apiHandler: {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
      return mcpHandler(request, env, ctx);
    }
  },

  defaultHandler: {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
      return AuthHandler.fetch(
        request,
        env as unknown as Record<string, unknown>,
        ctx
      );
    }
  },

  // The URL MCP clients connect to. Every token is bound to it.
  resourceMetadata: { resource: env.MCP_RESOURCE }
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Tokens only work on the origin in MCP_RESOURCE. If it still points at
    // localhost after a deploy, say so instead of failing every MCP request
    // with an audience error.
    const origin = new URL(request.url).origin;
    if (origin !== new URL(env.MCP_RESOURCE).origin) {
      return new Response(
        `MCP_RESOURCE is ${env.MCP_RESOURCE}, but this Worker is served from ${origin}. Set MCP_RESOURCE in wrangler.jsonc to ${origin}/mcp and deploy again.`,
        { status: 500 }
      );
    }
    return oauthProvider.fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
