import { McpAgent } from "../../mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type AuthProps = { email?: string };

type Env = unknown;

type State = {};

export class OAuthMCP extends McpAgent<Env, State, AuthProps> {
  server = new McpServer({ name: "oauth-mcp", version: "0.1.0" });

  async init() {
    // Proves we kept email in the execution context
    this.server.tool(
      "whoami",
      "Return the authenticated email (from auth props)",
      {},
      async () => ({
        content: [{ type: "text", text: this.props?.email ?? "unknown" }]
      })
    );

    // Simple math tool
    this.server.tool(
      "add",
      "Add two numbers",
      { a: z.number(), b: z.number() },
      async ({ a, b }) => ({
        content: [{ type: "text", text: String(a + b) }]
      })
    );
  }
}

export default OAuthMCP;
