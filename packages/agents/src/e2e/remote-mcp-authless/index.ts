import { McpAgent } from "../../mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Props = { echoAvailable: boolean };
// Define our MCP agent with tools
export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "Authless Calculator",
    version: "1.0.0"
  });

  async init() {
    const { echoAvailable } = this.props as Props;
    // Simple echo tool that's gated behind a feature flag
    if (echoAvailable) {
      this.server.registerTool(
        "echo",
        {
          description: "Echo a message",
          inputSchema: { msg: z.string() }
        },
        async ({ msg }) => ({
          content: [{ type: "text", text: msg }]
        })
      );
    }

    // Simple addition tool
    this.server.registerTool(
      "add",
      {
        description: "Add two numbers",
        inputSchema: { a: z.number(), b: z.number() }
      },
      async ({ a, b }) => {
        return { content: [{ type: "text", text: String(a + b) }] };
      }
    );

    // Calculator tool with multiple operations
    this.server.registerTool(
      "calculate",
      {
        description: "Calculate a mathematical operation",
        inputSchema: {
          operation: z.enum(["add", "subtract", "multiply", "divide"]),
          a: z.number(),
          b: z.number()
        }
      },
      async ({ operation, a, b }) => {
        let result: number;
        switch (operation) {
          case "add":
            result = a + b;
            break;
          case "subtract":
            result = a - b;
            break;
          case "multiply":
            result = a * b;
            break;
          case "divide":
            if (b === 0)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: Cannot divide by zero"
                  }
                ]
              };
            result = a / b;
            break;
        }
        return { content: [{ type: "text", text: String(result) }] };
      }
    );
  }
}

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Handle custom props
    const props: Props = {
      echoAvailable: !!request.headers.get("x-my-feature-flag")
    };

    // We're not using OAuthProvider so we're fine setting our own props
    ctx.props = props;

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }

    if (url.pathname === "/health") {
      return new Response("OK");
    }

    return new Response("Not found", { status: 404 });
  }
};
