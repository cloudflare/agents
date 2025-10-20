import { experimental_createMcpHandler as createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Env = {};

const server = new McpServer({
  name: "Hello MCP Server",
  version: "1.0.0"
});

server.tool(
  "hello",
  "Returns a greeting message",
  { name: z.string().optional() },
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

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
    const handler = createMcpHandler(server);
    return handler(request, env, ctx);
  }
};
