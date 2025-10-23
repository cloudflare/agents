import { McpAgent } from "agents/mcp";
import { routeAgentRequest } from "agents";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
      async (_uri, _extra) => ({
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
        title: "Renders a chess game menu, ready to start or join a game.",
        annotations: { readOnlyHint: true },
        _meta: {
          "openai/outputTemplate": "ui://widget/index.html",
          "openai/toolInvocation/invoking": "Opening chess widget",
          "openai/toolInvocation/invoked": "Chess widget opened"
        }
      },
      async (_, _extra) => {
        return {
          content: [
            {
              type: "text",
              text: "Successfully rendered chess game menu"
            }
          ],
          structuredContent: {}
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
