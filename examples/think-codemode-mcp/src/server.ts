import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Think } from "@cloudflare/think";
import { McpAgent } from "agents/mcp";
import { routeAgentRequest } from "agents";
import { z } from "zod";

/** A local MCP server whose tools stay behind the `catalog.*` namespace. */
export class CatalogMcp extends McpAgent<Env> {
  server = new McpServer({ name: "catalog", version: "1.0.0" });

  async init() {
    this.server.registerTool(
      "search_products",
      {
        description: "Search the demo product catalog.",
        inputSchema: {
          query: z.string(),
          limit: z.number().int().min(1).max(10).default(5)
        },
        outputSchema: {
          products: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              price: z.number()
            })
          )
        }
      },
      async ({ query, limit }) => {
        const products = [
          { id: "p1", name: "Workers mug", price: 18 },
          { id: "p2", name: "Durable Objects notebook", price: 12 },
          { id: "p3", name: "Code Mode hoodie", price: 54 }
        ]
          .filter((product) =>
            product.name.toLowerCase().includes(query.toLowerCase())
          )
          .slice(0, limit);
        return {
          content: [{ type: "text", text: JSON.stringify({ products }) }],
          structuredContent: { products }
        };
      }
    );

    this.server.registerTool(
      "get_product",
      {
        description: "Get one demo product by id.",
        inputSchema: { id: z.string() }
      },
      async ({ id }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id,
              name: id === "p3" ? "Code Mode hoodie" : "Workers mug",
              price: id === "p3" ? 54 : 18
            })
          }
        ]
      })
    );
  }
}

export class Assistant extends Think<Env> {
  override waitForMcpConnections = true;

  override async onStart() {
    await this.addMcpServer("catalog", this.env.CatalogMcp, {
      id: "catalog"
    });
  }

  override getModel() {
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  override getSystemPrompt() {
    return [
      "You are a concise product assistant.",
      "Your direct built-in tools are read, write, edit, and code.",
      "Use code for product questions. Search with codemode.search(), inspect methods with codemode.describe(), then call catalog.* from JavaScript.",
      "Do not guess catalog method names or product data."
    ].join(" ");
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/mcp")) {
      return CatalogMcp.serve("/mcp", { binding: "CatalogMcp" }).fetch(
        request,
        env,
        ctx
      );
    }
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};
