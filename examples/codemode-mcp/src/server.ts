import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { codeMcpServer } from "@cloudflare/codemode/mcp";
import { z } from "zod";

/**
 * Create an upstream MCP server with some demo tools.
 * In a real app, this could be any MCP server — GitHub, Stripe, etc.
 */
function createUpstreamServer() {
  const server = new McpServer({
    name: "demo-tools",
    version: "1.0.0"
  });

  server.registerTool(
    "add",
    {
      description: "Add two numbers together",
      inputSchema: {
        a: z.number().describe("First number"),
        b: z.number().describe("Second number")
      }
    },
    async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }]
    })
  );

  server.registerTool(
    "greet",
    {
      description: "Generate a greeting message",
      inputSchema: {
        name: z.string().describe("Name to greet"),
        language: z
          .enum(["en", "es", "fr"])
          .optional()
          .describe("Language for the greeting")
      }
    },
    async ({ name, language }) => {
      const greetings = {
        en: `Hello, ${name}!`,
        es: `¡Hola, ${name}!`,
        fr: `Bonjour, ${name}!`
      };
      const text = greetings[language ?? "en"];
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "list_items",
    {
      description: "List items with optional filtering",
      inputSchema: {
        category: z.string().optional().describe("Filter by category"),
        limit: z.number().optional().describe("Max items to return")
      }
    },
    async ({ category, limit }) => {
      const items = [
        { id: 1, name: "Widget", category: "hardware" },
        { id: 2, name: "Gadget", category: "hardware" },
        { id: 3, name: "Service A", category: "software" },
        { id: 4, name: "Service B", category: "software" },
        { id: 5, name: "Manual", category: "docs" }
      ];
      let filtered = category
        ? items.filter((i) => i.category === category)
        : items;
      if (limit) filtered = filtered.slice(0, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(filtered) }]
      };
    }
  );

  return server;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // /mcp — the original upstream MCP server (raw tools)
    if (url.pathname === "/mcp") {
      const upstream = createUpstreamServer();
      return createMcpHandler(upstream, { route: "/mcp" })(request, env, ctx);
    }

    // /codemode — the codemode-wrapped server (single code tool)
    if (url.pathname === "/codemode") {
      const upstream = createUpstreamServer();
      const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
      const server = await codeMcpServer(upstream, executor);
      return createMcpHandler(server, { route: "/codemode" })(
        request,
        env,
        ctx
      );
    }

    return new Response("Not found. Use /mcp or /codemode", { status: 404 });
  }
};
