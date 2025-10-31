import { createMcpHandler, getMcpAuthContext } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { AuthHandler } from "./auth-handler";

const server = new McpServer({
  name: "Authenticated MCP Server",
  version: "1.0.0"
});

server.tool(
  "hello",
  "Returns a greeting message",
  { name: z.string().optional() },
  async ({ name }, extra) => {
    const auth = getMcpAuthContext();
    const username = auth?.props?.username as string | undefined;

    const requestHeaders = new URL(extra.requestInfo);

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

server.tool(
  "whoami",
  "Returns information about the authenticated user",
  {},
  async (_, extra) => {
    const auth = extra.authInfo;

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
              userId: auth.extra?.userId,
              username: auth.extra?.username,
              email: auth.extra?.email
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

/**
 * API Handler - handles authenticated MCP requests
 * This handler will receive requests that have a valid access token
 */
const apiHandler = {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    return createMcpHandler(server)(request, env, ctx);
  }
};

export default new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",

  apiRoute: "/mcp",
  apiHandler: apiHandler,

  //@ts-expect-error
  defaultHandler: AuthHandler
});
