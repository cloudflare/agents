import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

function createServer() {
  const server = new McpServer({
    name: "hello-server",
    version: "1.0.0"
  });

  server.registerTool(
    "hello",
    {
      description: "Returns a greeting",
      inputSchema: z.object({
        name: z.string().optional()
      })
    },
    async ({ name }) => ({
      content: [
        {
          type: "text",
          text: `Hello, ${name ?? "World"}!`
        }
      ]
    })
  );

  return server;
}

// A fresh server is created for each request. By default, the same handler
// serves Stateless clients and the Legacy compatibility lane.
export default createMcpHandler(createServer);
