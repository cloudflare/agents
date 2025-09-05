# MCP Elicitation Demo

This is a MCP client-server example that shows how to use elicitation support using the Agents SDK.

- **Full MCP compliance** with https://modelcontextprotocol.io/specification/draft/client/elicitation

### MCP Server (`McpServerAgent`)

Here's the actual working code from our demo:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent, type ElicitResult } from "agents/mcp";
import {
  Agent,
  type AgentNamespace,
  routeAgentRequest,
  callable,
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
  })

  initialState = { counter: 0 };

  // Track active session for cross-agent elicitation
  private activeSession: string | null = null;

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
        // Store session for cross-agent elicitation
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
        // Store session for cross-agent elicitation
        if (__clientSession) {
          this.activeSession = __clientSession;
        }

        // Request user details via elicitation
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
  }
```

## Getting Started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the development server:

   ```bash
   npm start
   ```

3. Open your browser (typically http://localhost:5173/)

4. The demo auto-connects to the local MCP server

5. Try the elicitation tools:
   - **Increment Counter**: Click to see boolean confirmation elicitation
   - **Create User**: Click to see complex form elicitation

### In production, your MCP server typically connects directly to clients, making elicitation much simpler:

```typescript
// Direct MCP connection
export class MyMcpServer extends McpAgent {
  async init() {
    this.server.tool(
      "my-tool",
      "My tool",
      { input: z.string() },
      async ({ input }) => {
        // elicitInput() works directly
        const result = await this.elicitInput({
          message: "Confirm this action?",
          requestedSchema: {
            type: "object",
            properties: {
              confirmed: { type: "boolean", title: "Confirm" }
            },
            required: ["confirmed"]
          }
        });

        if (result.action === "accept" && result.content?.confirmed) {
          return { content: [{ type: "text", text: "Action completed!" }] };
        }
        return { content: [{ type: "text", text: "Action cancelled." }] };
      }
    );
  }
}
```
