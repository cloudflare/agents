import { McpAgent } from "../../mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type AuthProps = { email?: string };

type Env = unknown;

type State = {};

export class WhoamiMCP extends McpAgent<Env, State, AuthProps> {
  server = new McpServer({ name: "whoami-mcp", version: "0.1.0" });

  async init() {
    // Proves we kept the email from the execution context
    const email = this.props?.email;
    this.server.tool(
      "whoami",
      "Return the authenticated email (from auth props)",
      {},
      async () => ({
        content: [{ type: "text", text: email ?? "unknown" }]
      })
    );
  }
}

export class AddMCP extends McpAgent<
  Env,
  State,
  AuthProps & { echoAvailable: boolean }
> {
  server = new McpServer({ name: "add-mcp", version: "0.1.0" });

  async init() {
    // Simple echo tool that's gated behind a feature flag
    if (this.props?.echoAvailable) {
      this.server.tool("echo", { msg: z.string() }, async ({ msg }) => ({
        content: [{ type: "text", text: msg }]
      }));
    }

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
