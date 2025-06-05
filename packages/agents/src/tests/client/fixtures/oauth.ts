import { McpAgent } from "../../../mcp/index.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type Env = {
  MCP_OBJECT: DurableObjectNamespace<TestMcpAgent>;
};

type State = unknown;

type Props = {
  testValue: string;
};

export class TestMcpAgent extends McpAgent<Env, State, Props> {
  server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { logging: {} } }
  );

  async init() {
    this.server.tool(
      "greet",
      "A simple greeting tool",
      { name: z.string().describe("Name to greet") },
      async ({ name }): Promise<CallToolResult> => {
        return { content: [{ type: "text", text: `Hello, ${name}!` }] };
      }
    );

    this.server.tool(
      "getPropsTestValue",
      {},
      async (): Promise<CallToolResult> => {
        return {
          content: [{ type: "text", text: this.props.testValue }],
        };
      }
    );
  }
}

// Export the OAuth handler as the default
export default new OAuthProvider({
  apiRoute: "/sse",
  // TODO: fix these types
  apiHandlers: {
    // @ts-ignore
    "/sse": TestMcpAgent.serveSSE("/sse"),
    // @ts-ignore
    "/mcp": TestMcpAgent.serve("/mcp"),
  },
  defaultHandler: {
    // @ts-ignore
    fetch: async (
      req: Request,
      env: Env & { OAUTH_PROVIDER: OAuthHelpers },
      ctx: ExecutionContext
    ): Promise<Response> => {
      if (req.url.includes("/authorize")) {
        const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(req);
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: oauthReqInfo,
          userId: "example",
          metadata: {
            label: "Test User",
          },
          scope: oauthReqInfo.scope,
          props: {
            testValue: "example",
          },
        });
        return Response.redirect(redirectTo);
      }

      return new Response("Not found", { status: 404 });
    },
  },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
