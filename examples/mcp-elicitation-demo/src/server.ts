import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import {
  Agent,
  type AgentNamespace,
  routeAgentRequest,
  unstable_callable as callable
} from "agents";
import { MCPClientManager } from "agents/mcp/client";
import { z } from "zod";

type Env = {
  MyAgent: AgentNamespace<MyAgent>;
  McpServerAgent: DurableObjectNamespace<McpServerAgent>;
  HOST: string;
};

export class McpServerAgent extends McpAgent<Env, { counter: number }, {}> {
  server = new McpServer({
    name: "Elicitation Demo Server",
    version: "1.0.0"
  }) as any;

  initialState = { counter: 0 };

  async init() {
    // Simple counter tool with confirmation
    this.server.tool(
      "increment-counter",
      "Increment the counter with user confirmation",
      {
        amount: z.number().describe("Amount to increment by").default(1)
      },
      async ({ amount }: { amount: number }) => {
        const confirmation = await this.elicitInput({
          message: `Are you sure you want to increment the counter by ${amount}?`,
          requestedSchema: {
            type: "object",
            properties: {
              confirmed: {
                type: "boolean",
                title: "Confirm increment",
                description: "Check to confirm the increment"
              }
            },
            required: ["confirmed"]
          }
        });

        if (
          confirmation.action === "accept" &&
          confirmation.content?.confirmed
        ) {
          this.setState({
            counter: this.state.counter + amount
          });

          return {
            content: [
              {
                type: "text",
                text: `Counter incremented by ${amount}. New value: ${this.state.counter}`
              }
            ]
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Counter increment cancelled."
              }
            ]
          };
        }
      }
    );

    // User creation tool with form
    this.server.tool(
      "create-user",
      "Create a new user with form input",
      {
        username: z.string().describe("Username for the new user")
      },
      async ({ username }: { username: string }) => {
        const userInfo = await this.elicitInput({
          message: `Create user account for "${username}":`,
          requestedSchema: {
            type: "object",
            properties: {
              email: {
                type: "string",
                format: "email",
                title: "Email Address",
                description: "User's email address"
              },
              role: {
                type: "string",
                title: "Role",
                enum: ["viewer", "editor", "admin"],
                enumNames: ["Viewer", "Editor", "Admin"]
              },
              sendWelcome: {
                type: "boolean",
                title: "Send Welcome Email",
                description: "Send welcome email to user"
              }
            },
            required: ["email", "role"]
          }
        });

        if (userInfo.action === "accept" && userInfo.content) {
          const details = userInfo.content;
          return {
            content: [
              {
                type: "text",
                text: `User created:\n• Username: ${username}\n• Email: ${details.email}\n• Role: ${details.role}\n• Welcome email: ${details.sendWelcome ? "Yes" : "No"}`
              }
            ]
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: "User creation cancelled."
              }
            ]
          };
        }
      }
    );

    // Counter resource
    this.server.resource("counter", "mcp://resource/counter", (uri: URL) => {
      return {
        contents: [
          {
            text: `Current counter value: ${this.state.counter}`,
            uri: uri.href
          }
        ]
      };
    });
  }

  onStateUpdate(state: { counter: number }) {
    console.log({ stateUpdate: state });
  }
}

// MCP Client Agent - connects to other MCP servers
// Now uses built-in SDK elicitation support!
export class MyAgent extends Agent<Env, never> {
  async onRequest(request: Request): Promise<Response> {
    const reqUrl = new URL(request.url);

    if (reqUrl.pathname.endsWith("add-mcp") && request.method === "POST") {
      const mcpServer = (await request.json()) as { url: string; name: string };
      await this.addMcpServer(mcpServer.name, mcpServer.url, this.env.HOST);
      return new Response("Ok", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  }

  // Add RPC method to call MCP tools
  @callable()
  async callMcpTool(
    serverId: string,
    toolName: string,
    args: any
  ): Promise<any> {
    try {
      console.log(
        `Calling tool ${toolName} on server ${serverId} with args:`,
        args
      );
      const result = await this.mcp.callTool({
        serverId,
        name: toolName,
        arguments: args
      });
      console.log("Tool call result:", result);
      return result;
    } catch (error) {
      console.error("Error calling MCP tool:", error);
      throw error;
    }
  }
}

// Create a direct MCP server export for /mcp-server path
export const mcpServer = McpServerAgent.serve("/mcp-server", {
  binding: "McpServerAgent"
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    console.log(`Request: ${request.method} ${url.pathname}`);

    // Route MCP server requests to the dedicated MCP server
    if (url.pathname.startsWith("/mcp-server")) {
      console.log("Routing to MCP server");
      (ctx as any).props = {};
      return mcpServer.fetch(request, env, ctx);
    }

    // Route other requests to the client agent
    console.log("Routing to regular agent request handler");
    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
