import type {
  Server,
  ServerOptions,
} from "@modelcontextprotocol/sdk/server/index.js";
import {
  type Implementation,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import MCPAgent from "agents/mcp-agent";
import { getAgentByName } from "agents";
import { WorkerEntrypoint } from "cloudflare:workers";

export class RandomMCPAgent extends MCPAgent<Env> {
  async onRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      return new Response(JSON.stringify({ data: await this.random() }));
    }
    return super.onRequest(request);
  }

  createServerParams(): [Implementation, ServerOptions] {
    return [
      { name: "random-example", version: "1.0.0" },
      {
        capabilities: {
          tools: { listChanged: true, random: true },
        },
      },
    ];
  }

  configureServer(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, () => {
      return {
        tools: [{ name: "random", description: "Random number generator" }],
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      if (params.name !== "random") throw new Error("Unknown tool");

      return {
        content: [{ type: "text", text: JSON.stringify(await this.random()) }],
      };
    });
  }

  /**
   *
   * @returns A random integer between 0 and 1000
   */
  async random() {
    return Math.floor(Math.random() * 1_000);
  }
}

export default class Worker extends WorkerEntrypoint<Env> {
  /**
   * @ignore
   **/
  async fetch(request: Request): Promise<Response> {
    const agent = await getAgentByName(this.env.RANDOM, "random");
    return await agent.fetch(request);
  }
}
