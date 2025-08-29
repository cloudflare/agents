# McpAgent

The `McpAgent` class is an abstract base class that provides a robust foundation for building MCP (Model Context Protocol) agents in Cloudflare Workers. It extends `DurableObject` and integrates with the Agents framework to provide a powerful, scalable solution for AI agent development.

## Overview

`McpAgent` combines the power of Cloudflare Workers' Durable Objects with the Model Context Protocol, enabling you to build stateful, persistent AI agents that can handle complex workflows, maintain context across requests, and integrate with various MCP-compatible tools and services.

## Key Features

- **Durable State Management**: Persistent state that survives across requests and hibernation
- **MCP Integration**: Full Model Context Protocol support with tool calling and resource management
- **Request Context Tracking**: Access to request headers and metadata in your agent logic
- **Authentication Support**: Built-in authentication handling with customizable auth resolution
- **Multiple Transport Support**: SSE and Streamable HTTP transport options
- **Hibernation Safe**: Efficient resource usage with automatic hibernation and wake-up (including during requests like elicitations and sampling)

## Basic Usage

```typescript
import { McpAgent } from "@cloudflare/agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";

export class MyAgent extends McpAgent<Env, State, Props> {
  // Define your MCP server
  server = new McpServer(
    { name: "my-agent", version: "1.0.0" },
    { capabilities: { logging: {} } }
  );

  // Initialize your agent
  async init() {
    // Register tools, resources, etc.
    this.server.tool(
      "hello",
      "Say hello to someone",
      { name: "string" },
      async (params) => {
        return {
          content: [{ text: `Hello, ${params.name}!`, type: "text" }]
        };
      }
    );
  }

  // Handle state updates
  onStateUpdate(state: State | undefined, source: Connection | "server") {
    // React to state changes
  }

  // Handle incoming messages
  async onMessage(connection: Connection, message: WSMessage) {
    // Process WebSocket messages
  }
}
```

## Request Context and Authentication

### Request Information

`McpAgent` automatically tracks request context, providing access to request headers and metadata in your tool handlers and other methods.

```typescript
export class MyAgent extends McpAgent<Env, State, Props> {
  async init() {
    this.server.tool(
      "getUserAgent",
      "Get the user agent from the request",
      {},
      async (params, extra) => {
        // Access request information
        const userAgent = extra.requestInfo?.headers["user-agent"];
        return {
          content: [{ text: `User Agent: ${userAgent}`, type: "text" }]
        };
      }
    );
  }
}
```

Per the MCP SDK, the `extra.requestInfo` object contains:

- `headers`: Request headers as a key-value object

### Authentication

`McpAgent` provides built-in authentication support through the `resolveAuthInfo` method. Use this method to resolve the MCP SDK `RequestInfo` into a MCP SDK `AuthInfo` object.

```typescript
export class MyAgent extends McpAgent<Env, State, Props, CustomAuthInfo> {
  async resolveAuthInfo(
    requestInfo: RequestInfo
  ): Promise<CustomAuthInfo | null> {
    const authHeader = requestInfo.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.substring(7);

    // Validate token and return auth info
    try {
      const user = await validateToken(token);
      return {
        userId: user.id,
        email: user.email,
        permissions: user.permissions,
        token
      };
    } catch {
      return null;
    }
  }

  async init() {
    this.server.tool(
      "getUserProfile",
      "Get the current user's profile",
      {},
      async (params, extra) => {
        // Access authentication information
        if (!extra.authInfo) {
          throw new Error("Authentication required");
        }

        const user = await getUserById(extra.authInfo.userId);
        return {
          content: [{ text: JSON.stringify(user), type: "text" }]
        };
      }
    );
  }
}
```

### Custom Auth Info Types

You can define custom authentication information types by extending the generic parameters:

```typescript
type Env = {
  // your env
};
type State = {
  // your state
};
type Props = {
  // your props
};

type CustomAuthInfo = {
  userId: string;
  email: string;
  permissions: string[];
  token: string;
  expiresAt: number;
};

export class MyAgent extends McpAgent<Env, State, Props, CustomAuthInfo> {
  // Now this.authInfo is typed as CustomAuthInfo
  // NOTE: the authInfo you get in tool handlers is still the MCP SDK AuthInfo type
}
```

## User Input Elicitation

`McpAgent` supports eliciting user input through the `elicitInput` method:

```typescript
export class MyAgent extends McpAgent<Env, State, Props> {
  async init() {
    this.server.tool(
      "getUserPreference",
      "Get user preference with validation",
      {},
      async () => {
        const result = await this.elicitInput({
          message: "What is your favorite color?",
          requestedSchema: {
            type: "string",
            enum: ["red", "green", "blue", "yellow"]
          }
        });

        if (result.status === "accepted") {
          return {
            content: [{ text: `You chose: ${result.value}`, type: "text" }]
          };
        } else {
          return {
            content: [{ text: "No preference selected", type: "text" }]
          };
        }
      }
    );
  }
}
```

## Lifecycle Methods

### `init()`

Called during agent initialization. Use this method to:

- Register MCP tools and resources
- Set up initial state
- Configure capabilities

### `onStateUpdate()`

Called whenever the agent's state changes. Use this to:

- React to state changes
- Log state updates
- Trigger side effects
