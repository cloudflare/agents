# MCP Transports

This guide explains the different transport options for connecting to MCP servers with the Agents SDK.

For a primer on MCP Servers and how they are implemented in the Agents SDK with `McpAgent`[here](docs/mcp-servers.md)

## Streamable HTTP Transport (Recommended)

The **Streamable HTTP** transport is the recommended way to connect to MCP servers.

### How it works

When a client connects to your MCP server:

1. The client makes an HTTP request to your Worker with a JSON-RPC message in the body
2. Your Worker upgrades the connection to a WebSocket
3. The WebSocket connects to your `McpAgent` Durable Object which manages connection state
4. JSON-RPC messages flow bidirectionally over the WebSocket
5. Your Worker streams responses back to the client using Server-Sent Events (SSE)

This is all handled automatically by the `McpAgent.serve()` method:

```typescript
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export class MyMCP extends McpAgent {
  server = new McpServer({ name: "Demo", version: "1.0.0" });

  async init() {
    // Define your tools, resources, prompts
  }
}

// Serve with Streamable HTTP transport
export default MyMCP.serve("/mcp");
```

The `serve()` method returns a Worker with a `fetch` handler that:

- Handles CORS preflight requests
- Manages WebSocket upgrades
- Routes messages to your Durable Object

### Connection from clients

Clients connect using the `streamable-http` transport:

```typescript
await agent.addMcpServer("my-server", "https://your-worker.workers.dev/mcp");
```

## SSE Transport (Deprecated)

We also support the legacy **SSE (Server-Sent Events)** transport, but it's deprecated in favor of Streamable HTTP.

If you need SSE transport for compatibility:

```typescript
// Server
export default MyMCP.serveSSE("/sse");

// Client
await agent.addMcpServer("my-server", url, callbackHost);
```

## RPC Transport (Experimental)

The **RPC transport** is a custom transport designed for internal applications where your MCP server and agent are both running on Cloudflare. They can even run in the same Worker! It sends JSON-RPC messages directly over Cloudflare's RPC bindings without going over the public internet.

### Why use RPC transport?

- **Faster**: No network overhead - direct function calls
- **Simpler**: No HTTP endpoints, no connection management
- **Internal only**: Perfect for agents calling MCP servers within the same Worker

**Note**: RPC transport does not support authentication. Use HTTP/SSE for external connections that require OAuth.

### Connecting an Agent to an McpAgent via RPC

The RPC transport uses Durable Object bindings to connect your `Agent` (MCP client) directly to your `McpAgent` (MCP server).

#### Step 1: Define your MCP server

Create your `McpAgent` with the tools you want to expose:

```typescript
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type State = { counter: number };

export class MyMCP extends McpAgent<Env, State> {
  server = new McpServer({ name: "MyMCP", version: "1.0.0" });
  initialState: State = { counter: 0 };

  async init() {
    this.server.tool(
      "add",
      "Add to the counter",
      { amount: z.number() },
      async ({ amount }) => {
        this.setState({ counter: this.state.counter + amount });
        return {
          content: [
            {
              type: "text",
              text: `Added ${amount}, total is now ${this.state.counter}`
            }
          ]
        };
      }
    );
  }
}
```

#### Step 2: Connect your Agent to the MCP server

In your `Agent`, call `addMcpServer()` with the Durable Object binding in `onStart()`:

```typescript
import { AIChatAgent } from "agents/ai-chat-agent";

export class Chat extends AIChatAgent<Env> {
  async onStart(): Promise<void> {
    // Pass the DO namespace binding directly
    await this.addMcpServer("my-mcp", this.env.MyMCP);
  }

  async onChatMessage(onFinish) {
    const allTools = this.mcp.getAITools();

    const result = streamText({
      model,
      tools: allTools
      // ...
    });

    return createUIMessageStreamResponse({ stream: result });
  }
}
```

RPC connections are automatically restored after Durable Object hibernation, just like HTTP connections. The binding name and props are persisted to storage so the connection can be re-established without any extra code.

#### Step 3: Configure Durable Object bindings

In your `wrangler.jsonc`, define bindings for both Durable Objects:

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "Chat", "class_name": "Chat" },
      { "name": "MyMCP", "class_name": "MyMCP" }
    ]
  },
  "migrations": [
    {
      "new_sqlite_classes": ["MyMCP", "Chat"],
      "tag": "v1"
    }
  ]
}
```

#### Step 4: Set up your Worker fetch handler

Route requests to your Chat agent:

```typescript
import { routeAgentRequest } from "agents";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Optionally expose the MCP server via HTTP as well
    if (url.pathname.startsWith("/mcp")) {
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }

    const response = await routeAgentRequest(request, env);
    if (response) return response;

    return new Response("Not found", { status: 404 });
  }
};
```

### Passing props from client to server

Since RPC transport does not have an OAuth flow, you can pass user context (like userId, role, etc.) directly as props:

```typescript
await this.addMcpServer("my-mcp", this.env.MyMCP, {
  props: { userId: "user-123", role: "admin" }
});
```

Your `McpAgent` can then access these props:

```typescript
export class MyMCP extends McpAgent<
  Env,
  State,
  { userId?: string; role?: string }
> {
  async init() {
    this.server.tool("whoami", "Get current user info", {}, async () => {
      const userId = this.props?.userId || "anonymous";
      const role = this.props?.role || "guest";

      return {
        content: [{ type: "text", text: `User ID: ${userId}, Role: ${role}` }]
      };
    });
  }
}
```

The props are:

- **Type-safe**: TypeScript extracts the Props type from your McpAgent generic
- **Persistent**: Stored in Durable Object storage via `updateProps()`
- **Available immediately**: Set before any tool calls are made

This is useful for:

- User authentication context
- Tenant/organization IDs
- Feature flags or permissions
- Any per-connection configuration

### How RPC transport works under the hood

When you call `addMcpServer()` with a Durable Object binding, the SDK:

1. Creates an `RPCClientTransport` that wraps the DO stub
2. Calls `handleMcpMessage()` on the `McpAgent` for each JSON-RPC message
3. The `McpAgent` routes messages through its `RPCServerTransport` to the MCP server
4. Responses flow back synchronously through the RPC call

This happens entirely within your Worker's execution context using Cloudflare's RPC mechanism - no HTTP, no WebSockets, no public internet.

The RPC transport fully supports:

- JSON-RPC 2.0 validation (via the MCP SDK's schema)
- Batch requests
- Notifications (messages without `id` field)
- Automatic reconnection after Durable Object hibernation (when called from `onStart()`)

### Configuring RPC Transport Server Timeout

The RPC transport has a configurable timeout for waiting for tool responses. By default, the server will wait **60 seconds** for a tool handler to respond. You can customize this by overriding `getRpcTransportOptions()` in your `McpAgent`:

```typescript
export class MyMCP extends McpAgent<Env, State> {
  server = new McpServer({ name: "MyMCP", version: "1.0.0" });

  protected getRpcTransportOptions() {
    return { timeout: 120000 }; // 2 minutes
  }

  async init() {
    this.server.tool(
      "long-running-task",
      "A tool that takes a while",
      { input: z.string() },
      async ({ input }) => {
        await longRunningOperation(input);
        return {
          content: [{ type: "text", text: "Task completed" }]
        };
      }
    );
  }
}
```

## Choosing a transport

| Transport           | Use when                              | Pros                                     | Cons                            |
| ------------------- | ------------------------------------- | ---------------------------------------- | ------------------------------- |
| **Streamable HTTP** | External MCP servers, production apps | Standard protocol, secure, supports auth | Slight network overhead         |
| **RPC**             | Internal agents                       | Fastest, simplest setup                  | No auth, Service Bindings only  |
| **SSE**             | Legacy compatibility                  | Backwards compatible                     | Deprecated, use Streamable HTTP |

## Examples

- **Streamable HTTP**: See [`examples/mcp`](../examples/mcp)
- **RPC Transport**: See [`examples/mcp-rpc-transport`](../examples/mcp-rpc-transport)
- **MCP Client**: See [`examples/mcp-client`](../examples/mcp-client)
