import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const server = new McpServer({
  name: "Hello MCP Server",
  version: "1.0.0"
});

server.registerTool(
  "hello",
  {
    description: "Returns a greeting message",
    inputSchema: { name: z.string().optional() }
  },
  async ({ name }) => {
    return {
      content: [
        {
          text: `Hello, ${name ?? "World"}!`,
          type: "text"
        }
      ]
    };
  }
);

const transport = new WebStandardStreamableHTTPServerTransport();
server.connect(transport);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, mcp-session-id, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id",
  "Access-Control-Max-Age": "86400"
};

function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}

export default {
  fetch: async (request: Request, _env: Env, _ctx: ExecutionContext) => {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    return withCors(await transport.handleRequest(request));
  }
};
