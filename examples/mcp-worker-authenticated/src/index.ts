import { createMcpHandler, getMcpAuthContext } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

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
    async () => {
      const auth = getMcpAuthContext();

      if (!auth) {
        return {
          content: [
            {
              text: "No authentication context available",
              type: "text" as const
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
                email: auth.props?.email
              },
              null,
              2
            ),
            type: "text" as const
          }
        ]
      };
    }
  );

  return server;
}

/**
 * API Handler - handles authenticated MCP requests
 * This handler will receive requests that have a valid access token
 */
const apiHandler = {
  fetch: createMcpHandler(createServer, { route: "/mcp" })
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: apiHandler,
  provider: AccessProvider({
    id: "app-id",
    secret: "app-secret",
    redirectUri: "https://your-app.com/oauth/callback"
  })
});
