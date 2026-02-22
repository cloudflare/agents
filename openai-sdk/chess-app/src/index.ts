import { createMcpHandler } from "agents/mcp";
import { routeAgentRequest } from "agents";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { env } from "cloudflare:workers";

const getWidgetHtml = async (host: string) => {
  let html = await (await env.ASSETS.fetch("http://localhost/")).text();
  html = html.replace(
    "<!--RUNTIME_CONFIG-->",
    `<script>window.HOST = \`${host}\`;</script>`
  );
  return html;
};

const server = new McpServer({ name: "Chess", version: "v1.0.0" });

// register a UI resource
server.registerResource(
  "chess",
  "ui://widget/index.html",
  {},
  async (_uri, extra) => {
    console.log("HEADERS", extra.requestInfo?.headers);
    return {
      contents: [
        {
          uri: "ui://widget/index.html",
          mimeType: "text/html+skybridge",
          text: await getWidgetHtml(extra.requestInfo?.headers.host as string)
        }
      ]
    };
  }
);

// register the tool to render the UI resource
server.registerTool(
  "playChess",
  {
    title: "Renders a chess game menu, ready to start or join a game.",
    annotations: { readOnlyHint: true }, // Tells ChatGPT that this tool is safe
    _meta: {
      "openai/outputTemplate": "ui://widget/index.html",
      "openai/toolInvocation/invoking": "Opening chess widget",
      "openai/toolInvocation/invoked": "Chess widget opened"
    }
  },
  async () => {
    return {
      content: [
        { type: "text" as const, text: "Successfully rendered chess game menu" }
      ]
    };
  }
);

// create the MCP handler to talk to our server
const mcpHandler = createMcpHandler(server);

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/mcp")) return mcpHandler(req, env, ctx);

    return (
      (await routeAgentRequest(req, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};

export { ChessGame } from "./chess";
