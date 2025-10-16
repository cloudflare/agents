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

✅ **Faster**: No network overhead - direct function calls
✅ **Simpler**: No HTTP endpoints, no connection management
✅ **Internal only**: Perfect for agents calling MCP servers within the same Worker

⚠️ **No authentication**: Not suitable for public APIs - use HTTP/SSE for external connections

### Connecting an Agent to an McpAgent via RPC

The RPC transport uses [Cloudflare Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) to connect your `Agent` (MCP client) directly to your `McpAgent` (MCP server) using Durable Object RPC calls.

#### Step 1: Define your MCP server

First, create your `McpAgent` with the tools you want to expose:

```typescript
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export class MyMCP extends McpAgent<Env, State, {}> {
  server = new McpServer({
    name: "MyMCP",
    version: "1.0.0"
  });

  initialState: State = {
    counter: 0
  };

  async init() {
    // Define a tool
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

In your `Agent`, call `addMcpServer()` with RPC transport in the `onStart()` method:

```typescript
import { AIChatAgent } from "agents/ai-chat-agent";

export class Chat extends AIChatAgent<Env> {
  async onStart(): Promise<void> {
    // Connect to MyMCP via RPC using binding directly
    await this.addMcpServer("my-mcp", this.env.MyMCP, {
      transport: { type: "rpc" }
    });

    // Or using binding name string
    await this.addMcpServer("my-mcp", "MyMCP", {
      transport: { type: "rpc" }
    });
    //                      ▲         ▲
    //                      │         └─ Binding name (from wrangler.jsonc) or namespace
    //                      └─ Server ID (any unique string)
  }

  async onChatMessage(onFinish) {
    // MCP tools are now available!
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

Note that in production you would not connect to MCP servers in `onStart` but in standalone method you could add error handling. See this [MCP client example](examples/mcp-client)

### Passing props from client to server

Since RPC transport doesn't have an OAuth flow, you can pass user context (like userId, role, etc.) directly as props:

```typescript
// Pass props to provide user context to the MCP server
await this.addMcpServer("my-mcp", this.env.MyMCP, {
  transport: { type: "rpc", props: { userId: "user-123", role: "admin" } }
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

#### How RPC transport works

The RPC transport:

1. Validates the binding exists in your environment
2. Gets the Durable Object stub from `env.MyMCP.get(id)`
3. Creates an RPC transport that calls `stub.handleMcpMessage(message)`
4. Connects your agent's MCP client to this transport

#### Step 3: Configure Durable Object bindings

In your `wrangler.jsonc`, define bindings for both Durable Objects:

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "Chat",
        "class_name": "Chat"
      },
      {
        "name": "MyMCP", // This is the binding name you pass to addMcpServer
        "class_name": "MyMCP"
      }
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

    // Serve MCP server via streamable-http on /mcp endpoint
    if (url.pathname.startsWith("/mcp")) {
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }

    // Route other requests to agents
    const response = await routeAgentRequest(request, env);
    if (response) return response;

    return new Response("Not found", { status: 404 });
  }
};
```

Optionally, you can also expose your MCP server via streamable-http.

That's it! When your agent makes an MCP call, it:

1. Serializes the JSON-RPC message
2. Calls `stub.handleMcpMessage(message)` over RPC
3. The `McpAgent` processes it and returns the response
4. Your agent receives the result - all without any network calls

### How RPC transport works under the hood

When you call `addMcpServer()` with RPC transport, the SDK creates an RPC transport that calls the `handleMcpMessage()` method on your `McpAgent`:

```typescript
// Built into the McpAgent base class
async handleMcpMessage(
  message: JSONRPCMessage
): Promise<JSONRPCMessage | JSONRPCMessage[] | undefined> {
  // Recreate transport if needed (e.g., after hibernation)
  if (!this._transport) {
    const server = await this.server;
    this._transport = new RPCServerTransport();
    await server.connect(this._transport);
  }

  return await this._transport.handle(message);
}
```

This happens entirely within your Worker's execution context using Cloudflare's RPC mechanism - no HTTP, no WebSockets, no public internet.

The RPC transport is minimal by design (~350 lines) and fully supports:

- JSON-RPC 2.0 validation (with helpful error messages)
- Batch requests
- Notifications (messages without `id` field)
- Automatic reconnection after Durable Object hibernation

### Configuring RPC Transport Server Timeout

The RPC transport has a configurable timeout for waiting for tool responses. By default, the server will wait **60 seconds** for a tool handler to call `send()`. You can customize this by overriding the `getRpcTransportOptions()` method in your `McpAgent`:

```typescript
export class MyMCP extends McpAgent<Env, State, {}> {
  server = new McpServer({
    name: "MyMCP",
    version: "1.0.0"
  });

  // Configure RPC transport timeout
  protected getRpcTransportOptions() {
    return {
      timeout: 120000 // 2 minutes (default is 60000)
    };
  }

  async init() {
    this.server.tool(
      "long-running-task",
      "A tool that takes a while to complete",
      { input: z.string() },
      async ({ input }) => {
        // This tool has up to 2 minutes to complete
        await longRunningOperation(input);
        return {
          content: [{ type: "text", text: "Task completed" }]
        };
      }
    );
  }
}
```

The timeout ensures that if a tool handler fails to respond (e.g., due to an infinite loop or forgotten `send()` call), the request will fail with a clear timeout error rather than hanging indefinitely.

### Advanced: Custom RPC function names

By default, the RPC transport calls the `handleMcpMessage` function. You can customize this:

```typescript
await this.addMcpServer("my-server", "MyMCP", {
  transport: { type: "rpc", functionName: "customHandler" }
});
```

Your `McpAgent` would then need to implement:

```typescript
async customHandler(
  message: JSONRPCMessage
): Promise<JSONRPCMessage | JSONRPCMessage[] | undefined> {
  // Your custom logic
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
