import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { z } from "zod";
import { createMcpHandler } from "agents/mcp";
import { fetchAndBuildIndex, formatResults } from "./utils";
import { search } from "@orama/orama";
import { Effect } from "effect";

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
  query: z
    .string()
    .describe(
      "query string to search for eg. 'agent hibernate', 'schedule tasks'"
    ),
  k: z.number().optional().default(5).describe("number of results to return")
};

mcpServer.registerTool(
  "search-agent-docs",
  {
    description:
      "Token efficient search of the Cloudflare Agents SDK documentation",
    inputSchema
  },
  async ({ query, k }) => {
    const searchEffect = Effect.gen(function* () {
      console.log({ query, k });
      const term = query.trim();

      const docsDb = yield* fetchAndBuildIndex;

      const result = search(docsDb, { term, limit: k });
      const searchResult = yield* result instanceof Promise
        ? Effect.promise(() => result)
        : Effect.succeed(result);

      return {
        content: [
          {
            type: "text" as const,
            text: formatResults(searchResult, term, k)
          }
        ]
      };
    }).pipe(
      Effect.catchAll((error) => {
        console.error(error);
        return Effect.succeed({
          content: [
            {
              type: "text" as const,
              text: `There was an error with the search tool. Please try again later.`
            }
          ]
        });
      })
    );

    return await Effect.runPromise(searchEffect);
  }
);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return createMcpHandler(mcpServer)(request, env, ctx);
  }
};
