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

In your `Agent`, call `addRpcMcpServer()` in the `onStart()` method:

```typescript
import { AIChatAgent } from "agents/ai-chat-agent";

export class Chat extends AIChatAgent<Env> {
  async onStart(): Promise<void> {
    // Connect to MyMCP via RPC
    await this.addRpcMcpServer("my-mcp", "MyMCP");
    //                          ▲         ▲
    //                          │         └─ Binding name (from wrangler.jsonc)
    //                          └─ Server ID (any unique string)
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

The `addRpcMcpServer()` method:

1. Gets the Durable Object stub from `env.MyMCP.get(id)`
2. Creates an RPC transport that calls `stub.handleMcpMessage(message)`
3. Connects your agent's MCP client to this transport

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
        "name": "MyMCP", // This is the binding name you pass to addRpcMcpServer
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

When you call `addRpcMcpServer()`, the SDK creates an RPC transport that calls the `handleMcpMessage()` method on your `McpAgent`:

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

### Advanced: Custom RPC function names

By default, the RPC transport calls the `handleMcpMessage` function. You can customize this:

```typescript
await this.addRpcMcpServer("my-server", "MyMCP", {
  functionName: "customHandler"
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
