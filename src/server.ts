import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

type Env = { ReproMcp: DurableObjectNamespace<ReproMcp> };

export class ReproMcp extends McpAgent<Env> {
  server = new McpServer({ name: "issue-1965-repro", version: "1.0.0" });

  async init() {
    this.server.registerTool(
      "ping",
      {
        description: "Minimal tool so tools/list has a deterministic response",
        inputSchema: { value: z.string().optional() }
      },
      async ({ value }) => ({
        content: [{ type: "text", text: value ?? "pong" }]
      })
    );
  }
}

const mcp = ReproMcp.serve("/mcp", { binding: "ReproMcp" });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const response = await mcp.fetch(request, env, ctx);
    const headers = new Headers(response.headers);
    const protocol = (request as Request & { cf?: { httpProtocol?: string } })
      .cf?.httpProtocol;
    headers.set("x-repro-http-protocol", protocol ?? "unknown");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
} satisfies ExportedHandler<Env>;
