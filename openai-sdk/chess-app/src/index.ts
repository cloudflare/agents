import { McpAgent } from "agents/mcp";
import { routeAgentRequest } from "agents";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";

// Adapted from https://developers.openai.com/apps-sdk/build/examples
export class McpWidgetAgent extends McpAgent<Env> {
  server = new McpServer({ name: "Pizzaz", version: "v1.0.0" });

  constructor(
    ctx: DurableObjectState,
    public env: Env
  ) {
    super(ctx, env);
    this.server = new McpServer({ name: "Pizzaz", version: "v1.0.0" });
  }

  async init() {
    this.server.registerResource(
      "chess",
      "ui://widget/index.html",
      {},
      async (uri, extra) => ({
        contents: [
          {
            uri: "ui://widget/index.html",
            mimeType: "text/html+skybridge",
            text: `<div>
            ${await (await this.env.ASSETS.fetch("http://localhost/")).text()}
            </div>`
          }
        ]
      })
    );

    this.server.registerTool(
      "startChessGame",
      {
        title: "Starts or joins a chess game.",
        inputSchema: {
          gameId: z
            .string()
            .optional()
            .describe(
              "Optional game ID to join. If not provided, a new game will be started."
            )
        },
        annotations: { readOnlyHint: true },
        _meta: {
          "openai/outputTemplate": "ui://widget/index.html",
          "openai/toolInvocation/invoking": "Opening counter widget",
          "openai/toolInvocation/invoked": "Counter widget opened"
        }
      },
      async (params, extra) => {
        const gameId = params.gameId ?? crypto.randomUUID();
        return {
          content: [
            {
              type: "text",
              text: params.gameId ? "Joined game!" : "Started new game!"
            }
          ],
          structuredContent: {},
          _meta: {
            sessionId: this.name,
            gameId
          }
        };
      }
    );
  }
}

export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/mcp")) {
      return McpWidgetAgent.serve("/mcp").fetch(req, env, ctx);
    }

    return (
      (await routeAgentRequest(req, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};

export { ChessGame } from "./chess";
