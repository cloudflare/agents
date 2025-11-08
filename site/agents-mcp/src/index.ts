import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { z } from "zod";
import { createMcpHandler } from "agents/mcp";
import { fetchAndBuildIndex, formatResults } from "./utils";
import { search } from "@orama/orama";

// TODO: instrument this server for observability
const mcpServer = new McpServer(
  {
    name: "agents-mcp",
    version: "0.0.1"
  },
  {
    capabilities: {},
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator()
  }
);

const inputSchema = {
  query: z.string(),
  k: z.number().optional().default(10)
};

mcpServer.registerTool(
  "search-agent-docs",
  {
    inputSchema
  },
  async ({ query, k }) => {
    try {
      console.log({ query, k });
      const docsDb = await fetchAndBuildIndex();
      const results = await search(docsDb, {
        term: query,
        limit: k
      });
      return {
        content: [
          {
            type: "text",
            text: formatResults(results, query, k)
          }
        ]
      };
    } catch (error) {
      console.error(error);
      return {
        content: [
          {
            type: "text",
            text: `There was an error with the search tool. Please try again later.`
          }
        ]
      };
    }
  }
);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return createMcpHandler(mcpServer as any)(request, env, ctx);
  }
};
