import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent, type ElicitResult } from "agents/mcp";
import {
  Agent,
  type AgentNamespace,
  routeAgentRequest,
  unstable_callable as callable,
  type Connection,
  type WSMessage
} from "agents";
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

  // Track active session for cross-agent elicitation (demo-specific pattern)
  private activeSession: string | null = null;

  /**
   * Cross-agent elicitation implementation for demo architecture
   *
   * In this demo, we have Browser ↔ MyAgent ↔ McpServerAgent
   * This method forwards elicitation requests from McpServerAgent to MyAgent,
   * which then communicates with the browser client.
   *
   * Note: In typical MCP setups, elicitation works directly without this complexity.
   */
  async elicitInput(params: {
    message: string;
    requestedSchema: {
      type: string;
      properties?: Record<
        string,
        {
          type: string;
          title?: string;
          description?: string;
          format?: string;
          enum?: string[];
          enumNames?: string[];
        }
      >;
      required?: string[];
    };
  }): Promise<ElicitResult> {
    if (!this.activeSession) {
      throw new Error("No active client session found for elicitation");
    }

    // Get the MyAgent instance that handles browser communication
    const myAgentId = this.env.MyAgent.idFromName(this.activeSession);
    const myAgent = this.env.MyAgent.get(myAgentId);

    // Create MCP-compliant elicitation request
    const requestId = `elicit_${Math.random().toString(36).substring(2, 11)}`;
    const elicitRequest = {
      jsonrpc: "2.0" as const,
      id: requestId,
      method: "elicitation/create",
      params: {
        message: params.message,
        requestedSchema: params.requestedSchema
      }
    };

    // Forward request to MyAgent which communicates with browser
    const response = await myAgent.fetch(
      new Request("https://internal/elicit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(elicitRequest)
      })
    );

    if (!response.ok) {
      throw new Error("Failed to send elicitation request");
    }

    return (await response.json()) as ElicitResult;
  }

  async init() {
    // Counter tool with user confirmation via elicitation
    this.server.tool(
      "increment-counter",
      "Increment the counter with user confirmation",
      {
        amount: z.number().describe("Amount to increment by").default(1),
        __clientSession: z
          .string()
          .optional()
          .describe("Internal client session ID")
      },
      async ({
        amount,
        __clientSession
      }: {
        amount: number;
        __clientSession?: string;
      }) => {
        // Store session for cross-agent elicitation (demo-specific)
        if (__clientSession) {
          this.activeSession = __clientSession;
        }

        // Request user confirmation via elicitation
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

    // User creation tool with form-based elicitation
    this.server.tool(
      "create-user",
      "Create a new user with form input",
      {
        username: z.string().describe("Username for the new user"),
        __clientSession: z
          .string()
          .optional()
          .describe("Internal client session ID")
      },
      async ({
        username,
        __clientSession
      }: {
        username: string;
        __clientSession?: string;
      }) => {
        // Store session for cross-agent elicitation (demo-specific)
        if (__clientSession) {
          this.activeSession = __clientSession;
        }

        // Request user details via form-based elicitation
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

  async onRequest(request: Request): Promise<Response> {
    const reqUrl = new URL(request.url);

    // Handle session storage for cross-agent elicitation (demo-specific)
    if (
      (reqUrl.pathname.endsWith("store-session") ||
        reqUrl.hostname === "internal") &&
      request.method === "POST"
    ) {
      const { sessionId } = (await request.json()) as { sessionId: string };
      this.activeSession = sessionId;
      return new Response("Ok", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  }

  onStateUpdate(_state: { counter: number }) {
    // Override to handle state updates if needed
  }
}

/**
 * Browser-facing agent that handles MCP client connections and elicitation forwarding
 *
 * This agent serves as a bridge between the browser client and MCP servers,
 * handling the cross-agent elicitation pattern required for this demo architecture.
 */
export class MyAgent extends Agent<Env, never> {
  async onRequest(request: Request): Promise<Response> {
    const reqUrl = new URL(request.url);

    // Handle MCP server registration
    if (reqUrl.pathname.endsWith("add-mcp") && request.method === "POST") {
      const mcpServer = (await request.json()) as { url: string; name: string };
      await this.addMcpServer(mcpServer.name, mcpServer.url, this.env.HOST);
      return new Response("Ok", { status: 200 });
    }

    // Health check endpoint
    if (reqUrl.pathname.endsWith("ping") && request.method === "GET") {
      return new Response("pong", { status: 200 });
    }

    // Session status check (for debugging)
    if (
      reqUrl.pathname.endsWith("check-active-session") &&
      request.method === "GET"
    ) {
      const storedSession = await this.ctx.storage.get<string>(
        "currentActiveSession"
      );
      const isActive = storedSession === this.name;
      return new Response(
        JSON.stringify({
          sessionId: this.name,
          storedSession,
          isActive
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    // Handle elicitation forwarding from McpServerAgent to browser
    if (reqUrl.pathname.endsWith("elicit") && request.method === "POST") {
      const elicitRequest = (await request.json()) as {
        id: string;
        method: string;
        params: {
          message: string;
          requestedSchema: Record<string, unknown>;
        };
      };

      // Broadcast elicitation request to connected browser clients
      this.broadcast(JSON.stringify(elicitRequest));

      // Set up response handling for this specific request
      const elicitationResolvers = new Map<
        string,
        (result: ElicitResult) => void
      >();

      return new Promise<Response>((resolve) => {
        const timeout = setTimeout(() => {
          elicitationResolvers.delete(elicitRequest.id);
          resolve(
            new Response(
              JSON.stringify({
                action: "reject",
                content: {}
              } as ElicitResult),
              {
                status: 200,
                headers: { "Content-Type": "application/json" }
              }
            )
          );
        }, 60000);

        // Store resolver for this request ID
        elicitationResolvers.set(elicitRequest.id, (result: ElicitResult) => {
          clearTimeout(timeout);
          elicitationResolvers.delete(elicitRequest.id);
          resolve(
            new Response(JSON.stringify(result), {
              status: 200,
              headers: { "Content-Type": "application/json" }
            })
          );
        });

        // Make resolvers accessible to onMessage handler
        (
          this as {
            _elicitationResolvers?: Map<string, (result: ElicitResult) => void>;
          }
        )._elicitationResolvers = elicitationResolvers;
      });
    }

    return new Response("Not found", { status: 404 });
  }

  /**
   * Handle incoming messages from browser clients
   * Primarily used to route elicitation responses back to waiting requests
   */
  async onMessage(
    _connection: Connection<unknown>,
    message: WSMessage
  ): Promise<void> {
    try {
      const messageData =
        typeof message === "string" ? message : message.toString();

      const data = JSON.parse(messageData) as {
        id?: string;
        result?: ElicitResult;
      };

      // Check if this is an elicitation response
      if (data.id && data.result) {
        const elicitationResolvers = (
          this as {
            _elicitationResolvers?: Map<string, (result: ElicitResult) => void>;
          }
        )._elicitationResolvers;
        if (elicitationResolvers?.has(data.id)) {
          const resolver = elicitationResolvers.get(data.id);
          if (resolver) {
            resolver(data.result);
          }
          return;
        }
      }
    } catch {
      // Not an elicitation response or parsing failed, ignore
    }

    // Call parent handler for other message types if it exists
    // Note: Agent base class may not have onMessage method
  }

  /**
   * RPC method to call MCP tools with session tracking
   *
   * This method automatically injects the current session ID into tool arguments
   * to enable cross-agent elicitation in this demo architecture.
   */
  @callable()
  async callMcpTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    try {
      // Inject session ID for cross-agent elicitation (demo-specific)
      const enhancedArgs = {
        ...args,
        __clientSession: this.name // Used by McpServerAgent for elicitation routing
      };

      const result = await this.mcp.callTool({
        serverId,
        name: toolName,
        arguments: enhancedArgs
      });

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

    // Route MCP server requests to the dedicated MCP server
    if (url.pathname.startsWith("/mcp-server")) {
      // Handle session setting for cross-agent elicitation (demo-specific)
      if (url.pathname.endsWith("/set-session") && request.method === "POST") {
        const { sessionId } = (await request.json()) as { sessionId: string };
        const mcpServerAgentId = env.McpServerAgent.idFromName("default");
        const mcpServerAgent = env.McpServerAgent.get(mcpServerAgentId);

        await mcpServerAgent.fetch(
          new Request("https://internal/set-session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId })
          })
        );

        return new Response("Ok", { status: 200 });
      }

      (ctx as { props?: Record<string, unknown> }).props = {};
      return mcpServer.fetch(request, env, ctx);
    }

    // Route other requests to browser-facing agent
    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
